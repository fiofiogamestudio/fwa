import { createHash } from 'node:crypto';
import { stableStringify } from '../core/events.js';
import { boundedDiagnosticText, classifyFailure } from '../core/failure-diagnostics.js';

const list = value => value instanceof Map ? [...value.values()] : value ?? [];
const logical = node => node.logicalId ?? node.id;
const LIMITS = Object.freeze({ checks: 16, violations: 8, files: 16, artifacts: 8 });
export const MAX_REPAIR_DIAGNOSTICS_BYTES = 8 * 1024;
const DIAGNOSTIC_CHECKS = 3;
const DIAGNOSTIC_STREAM_BYTES = Math.floor((MAX_REPAIR_DIAGNOSTICS_BYTES - 7) / (DIAGNOSTIC_CHECKS * 2));
const hash = value => `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
const text = value => boundedDiagnosticText(value, 160);

function artifact(value) {
  return value?.schemaVersion === 1 && value.algorithm === 'sha256'
    && /^[a-f0-9]{64}$/u.test(value.digest ?? '') && Number.isSafeInteger(value.size) && value.size >= 0
    ? { schemaVersion: 1, algorithm: 'sha256', digest: value.digest, size: value.size } : null;
}

function failureSummary(failure, identifiers) {
  if (!failure) return null;
  // Never copy arbitrary details, nested failures, command output or timestamps.
  let message = boundedDiagnosticText(failure.message || failure.code || 'Unknown failure', 512);
  for (const id of identifiers.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(id).join('<record>');
  }
  message = message.replace(/\b\d{4}-\d\d-\d\dT[^\s]+/gu, '<time>')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/giu, '<record>');
  const { fingerprint: ignoredFingerprint, ...classification } = classifyFailure(failure);
  const details = {};
  for (const field of ['reason', 'actual', 'limit', 'path', 'failedCheckId', 'timeoutMs',
    'terminationConfirmed', 'timedOut', 'aborted', 'signal']) {
    const value = failure.details?.[field];
    if (typeof value === 'string') details[field] = text(value);
    else if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) details[field] = value;
  }
  if (Array.isArray(failure.details?.expected)) {
    details.expected = failure.details.expected.slice(0, 16).filter(Number.isSafeInteger);
  }
  return { code: text(failure.code || 'UNKNOWN_FAILURE'), message, ...classification,
    ...(typeof failure.phase === 'string' ? { phase: text(failure.phase) } : {}),
    ...(Object.keys(details).length ? { details } : {}) };
}

function inspectionReason(check) {
  if (check.failure?.code === 'FAIL_FAST') return null; // This command never started.
  if (check.terminationConfirmed === false || /termination[-_]unconfirmed/iu.test(check.failure?.code ?? '')) return 'process-termination';
  if (check.timedOut || /timeout|deadline/iu.test(check.failure?.code ?? '')) return 'execution-timeout';
  if (check.signal || /abort/iu.test(check.failure?.code ?? '') || check.failure?.details?.aborted) return 'execution-aborted';
  return null;
}

function executionInspectionReason(run, change) {
  if ((change?.violations ?? []).some(item => item.code !== 'EXECUTION_FAILED')
    || run.failure?.code === 'CHANGESET_INVALID') return 'execution-policy';
  if (!run.failure) return null;
  // Real RunFailed records always carry a phase. Only verification follows a
  // captured executor result; setup/capture/artifact/reconciliation and future
  // infrastructure phases require inspection, not another producer attempt.
  const phase = run.failure.phase;
  if (phase != null && phase !== 'verification') return 'execution-infrastructure';
  let current = run.failure;
  for (let depth = 0; current && depth < 16; depth++) {
    if (/(?:^|[-_])(?:lease|heartbeat|lock(?:ed)?|capture|artifact|worktree|workspace)(?:[-_]|$)/iu.test(current.code ?? '')
      || ['FWA_CODEX_INPUT_STREAM_FAILED', 'FWA_CODEX_OUTPUT_STREAM_FAILED'].includes(current.code)) {
      return 'execution-infrastructure';
    }
    current = current.code === 'EXECUTION_FAILED' ? current.details?.failure : null;
  }
  const captured = change && typeof change.baseRevision === 'string' && typeof change.headRevision === 'string'
    && artifact(change.patchArtifact) && artifact(change.executionArtifact);
  if (!captured && (phase != null || ['preserved', 'setup-unknown', 'cleanup-pending', 'cleanup-failed'].includes(run.workspaceStatus))) {
    return 'candidate-recovery';
  }
  return null;
}

function attemptContext(run, projection) {
  const change = list(projection.changeSets).find(item => item.id === run.changeSetId
    && item.runId === run.id && item.nodeId === run.nodeId);
  const evaluation = list(projection.evaluations).filter(item => item.runId === run.id
    && item.nodeId === run.nodeId && item.changeSetId === change?.id).at(-1);
  const evidence = list(projection.evidence).find(item => item.id === evaluation?.evidenceId
    && item.runId === run.id && item.nodeId === run.nodeId && item.changeSetId === change?.id);
  if (!run.failure && !evaluation?.failure && evaluation?.status !== 'rejected'
    && evidence?.result !== 'fail' && change?.valid !== false) return null;
  const identifiers = [run.id, change?.id, evaluation?.id, evidence?.id, run.baseRevision, change?.headRevision];
  const failure = value => failureSummary(value, identifiers);
  const failedCriteria = (evidence?.criteria ?? []).filter(item => item.result !== 'pass');
  const checks = failedCriteria.map(item => ({
    id: text(item.id), kind: text(item.kind), result: item.result,
    exitCode: item.exitCode ?? null, signal: item.signal ?? null,
    timedOut: item.timedOut === true, terminationConfirmed: item.terminationConfirmed !== false,
    failure: failure(item.failure),
    missingArtifacts: (item.expectedArtifacts ?? []).filter(expected => expected.failure)
      .map(expected => ({ path: text(expected.path), failure: failure(expected.failure) }))
  })).sort((a, b) => a.id.localeCompare(b.id));
  const violations = [...(change?.violations ?? []), ...(evidence?.policyViolations ?? [])]
    .map(failure).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const failures = { execution: failure(run.failure), evaluation: failure(evaluation?.failure) };
  // Match the workflow's explicit review signal before treating a failed check
  // as an implementation problem. A model must not manufacture its own review.
  const independentReview = [run.failure?.code, run.failure?.message, evaluation?.failure?.code,
    evaluation?.failure?.message, evaluation?.reason,
    ...(evidence?.criteria ?? []).flatMap(item => [item.code, item.message, item.summary,
      item.failure?.code, item.failure?.message])]
    .some(value => typeof value === 'string' && /REVIEW_REQUIRED|review-required/u.test(value));
  const unsafeCheck = checks.map(inspectionReason).find(Boolean);
  const unsafeExecution = executionInspectionReason(run, change);
  const category = independentReview ? 'independent-review' : evidence?.policyViolations?.length ? 'validation-policy'
    : unsafeCheck ?? unsafeExecution ?? (evaluation?.failure ? 'validation-infrastructure'
      : failures.execution?.category ?? 'validation');
  const retryDisposition = independentReview || unsafeCheck || unsafeExecution || evidence?.policyViolations?.length || evaluation?.failure
    ? 'inspect' : failures.execution?.retryDisposition ?? 'retry';
  const patchArtifact = artifact(change?.patchArtifact);
  // Artifact/record ids, Git revisions and logs containing volatile output must
  // not turn identical failed code into progress. Only captured code and failure
  // content participate; the separate references retain all exact provenance.
  const signature = hash({ failures, checks, violations, ...(independentReview ? { independentReview: true } : {}),
    patch: patchArtifact?.digest ?? 'no-captured-output' });
  const summary = {
    phase: evaluation?.failure || evaluation?.status === 'rejected' || evidence?.result === 'fail'
      ? 'validation' : 'execution',
    category, retryDisposition, failures,
    failedChecks: checks.slice(0, LIMITS.checks).map(item => ({ ...item,
      missingArtifacts: item.missingArtifacts.slice(0, LIMITS.artifacts),
      omittedArtifactCount: Math.max(0, item.missingArtifacts.length - LIMITS.artifacts) })),
    omittedCheckCount: Math.max(0, checks.length - LIMITS.checks),
    violations: violations.slice(0, LIMITS.violations),
    omittedViolationCount: Math.max(0, violations.length - LIMITS.violations),
    changedFiles: (change?.changedFiles ?? []).slice(0, LIMITS.files).map(text),
    omittedFileCount: Math.max(0, (change?.changedFiles.length ?? 0) - LIMITS.files),
    patchDigest: patchArtifact?.digest ?? null
  };
  const references = {
    runId: run.id, changeSetId: change?.id ?? null, evaluationId: evaluation?.id ?? null,
    evidenceId: evidence?.id ?? null,
    baseRevision: change?.baseRevision ?? run.baseRevision ?? null,
    candidateRevision: change?.headRevision ?? null,
    candidateValid: change?.valid ?? null,
    changedFiles: (change?.changedFiles ?? []).slice(0, LIMITS.files).map(text),
    omittedFileCount: Math.max(0, (change?.changedFiles.length ?? 0) - LIMITS.files),
    patchArtifact, executionArtifact: artifact(change?.executionArtifact),
    executionFailureArtifact: artifact(run.failure?.details?.artifactRef),
    evaluationFailureArtifact: artifact(evaluation?.failure?.details?.artifactRef),
    profileArtifact: artifact(evidence?.profileArtifact ?? evaluation?.profileArtifact),
    resultArtifact: artifact(evidence?.resultArtifact),
    // The complete result artifact retains every criterion and full log ref.
    // This selection is bounded; no referenced artifact is recursively loaded.
    failedCheckLogs: failedCriteria.filter(item => item.failure?.code !== 'FAIL_FAST').slice(0, LIMITS.checks).map(item => ({
      id: text(item.id), stdoutArtifact: artifact(item.stdoutArtifact), stderrArtifact: artifact(item.stderrArtifact),
      failureArtifact: artifact(item.failure?.details?.artifactRef),
      expectedArtifacts: (item.expectedArtifacts ?? []).slice(0, LIMITS.artifacts)
        .map(expected => ({ path: text(expected.path), artifact: artifact(expected.artifact) }))
    })),
    omittedCheckLogCount: Math.max(0, failedCriteria.filter(item => item.failure?.code !== 'FAIL_FAST').length - LIMITS.checks)
  };
  return { summary, references, signature };
}

/**
 * Pure, bounded repair context from an already validated FWA projection.
 * `summary` is suitable for a stable repair instruction. `references` contains
 * exact evidence/candidate provenance and must not be treated as progress.
 * Controllers must check repeatedFailureCount independently of inputHash: fresh
 * record ids or log references in a prompt are not a correction to failed code.
 */
export function buildWorkbenchRepairContext(projection, node) {
  const family = new Set(list(projection.nodes).filter(item => item.goalId === node.goalId
    && logical(item) === logical(node)).map(item => item.id));
  family.add(node.id);
  const runs = list(projection.runs).filter(item => item.goalId === node.goalId && family.has(item.nodeId))
    .sort((a, b) => a.createdSequence - b.createdSequence);
  const integratedChanges = new Set(list(projection.integrations).filter(item => family.has(item.nodeId)
    && item.status === 'integrated').map(item => item.changeSetId));
  const lastIntegrated = runs.findLastIndex(run => integratedChanges.has(run.changeSetId));
  const pending = runs.slice(lastIntegrated + 1);
  if (!pending.length) return null;
  const latest = attemptContext(pending.at(-1), projection);
  if (!latest) return null;
  let repeatedFailureCount = 0;
  for (let index = pending.length - 1; index >= 0; index--) {
    if (attemptContext(pending[index], projection)?.signature !== latest.signature) break;
    repeatedFailureCount++;
  }
  return { ...latest, repeatedFailureCount };
}

/**
 * Small, verified log tails for the executor only. They never participate in
 * the pure repair signature, and JSON-looking output remains uninterpreted text.
 * ArtifactStore.get verifies the complete selected artifact before returning it;
 * failures are intentionally propagated instead of hiding damaged evidence.
 */
export async function loadWorkbenchRepairDiagnostics(artifactStore, repair) {
  if (typeof artifactStore?.get !== 'function') return [];
  const logs = (repair?.references?.failedCheckLogs ?? []).filter(item =>
    item.stderrArtifact != null || item.stdoutArtifact != null).slice(0, DIAGNOSTIC_CHECKS);
  const diagnostics = [];
  for (const log of logs) {
    for (const stream of ['stderr', 'stdout']) {
      const reference = log[`${stream}Artifact`];
      if (reference == null) continue;
      const value = await artifactStore.get(reference);
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        throw new TypeError('ArtifactStore.get must return verified artifact bytes.');
      }
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (!bytes.length) continue;
      let offset = Math.max(0, bytes.length - 2048);
      while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
      const characters = Array.from(bytes.subarray(offset).toString('utf8'));
      const record = start => ({ checkId: text(log.id), stream, text: characters.slice(start).join(''),
        truncated: offset > 0 || start > 0, artifact: reference });
      // Bound the serialized record as well as its text: quotes, control bytes,
      // Unicode and provenance metadata must not expand the prompt past 8 KiB.
      let lower = 0, upper = characters.length;
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        if (Buffer.byteLength(JSON.stringify(record(middle))) > DIAGNOSTIC_STREAM_BYTES) lower = middle + 1;
        else upper = middle;
      }
      const diagnostic = record(lower);
      if (Buffer.byteLength(JSON.stringify(diagnostic)) > DIAGNOSTIC_STREAM_BYTES) {
        throw new TypeError('Repair diagnostic metadata exceeds its bounded record size.');
      }
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}
