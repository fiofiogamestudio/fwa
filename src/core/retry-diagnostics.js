import { createHash } from 'node:crypto';
import { stableStringify } from './events.js';
import { classifyFailure } from './failure-diagnostics.js';

const list = value => value instanceof Map ? [...value.values()] : value ?? [];
const logical = node => node.logicalId ?? node.id;
const hash = value => createHash('sha256').update(stableStringify(value)).digest('hex');

function outcome(run, projection) {
  const change = list(projection.changeSets).find(item => item.id === run.changeSetId);
  const evaluation = list(projection.evaluations).filter(item => item.runId === run.id).at(-1);
  const evidence = list(projection.evidence).find(item => item.id === evaluation?.evidenceId);
  const rejected = evaluation?.status === 'rejected';
  if (!run.failure && !rejected) return null;
  const failure = run.failure ?? { code: 'evaluation-rejected', message: 'Candidate checks failed.' };
  const classification = classifyFailure(failure);
  // Hash observable output, not fresh commit/run IDs or event counts. Empty
  // captured patches and unchanged patches must not manufacture progress.
  const output = change?.patchArtifact?.digest
    ? { base: change.baseRevision, patch: change.patchArtifact.digest }
    : { base: run.baseRevision, output: 'no-captured-output' };
  const checks = rejected ? (evidence?.criteria ?? []).filter(item => item.result !== 'pass')
    .map(item => ({ id: item.id, result: item.result })).sort((a, b) => a.id.localeCompare(b.id)) : [];
  return { classification, fingerprint: hash({ failure: classification.fingerprint, output, checks }),
    at: evaluation?.finishedAt ?? run.failedAt ?? run.producedAt ?? run.createdAt };
}

function repairsCapturedBudget(node, run, projection) {
  if (run?.failure?.code !== 'CHANGESET_INVALID') return false;
  const change = list(projection.changeSets).find(item => item.id === run.changeSetId);
  if (change?.runId !== run.id || change.valid !== false
    || !Array.isArray(change.violations) || change.violations.length === 0) return false;
  // A declared limit can be corrected without changing the requested output.
  // Admit only when every recorded violation is one of these concrete limits
  // and the new contract covers the actual capture. Revisions and unrelated
  // budget edits alone are not evidence of a repair.
  return change.violations.every(violation => {
    const field = violation.code === 'MAX_FILES_EXCEEDED' ? 'maxFiles'
      : violation.code === 'MAX_DIFF_LINES_EXCEEDED' ? 'maxDiffLines' : null;
    const { actual, limit } = violation.details ?? {};
    const current = field && node.budget?.[field];
    return field !== null && Number.isSafeInteger(actual) && Number.isSafeInteger(limit)
      && limit >= 0 && actual > limit && Number.isSafeInteger(current)
      && current > limit && current >= actual;
  });
}

/** Admission policy only. Old event streams are replayed without retroactive mutation. */
export function diagnoseNodeRetry(node, projection, next = undefined) {
  const nodes = list(projection.nodes);
  const family = new Set(nodes.filter(item => item.goalId === node.goalId && logical(item) === logical(node)).map(item => item.id));
  const runs = list(projection.runs).filter(item => family.has(item.nodeId))
    .sort((a, b) => a.createdSequence - b.createdSequence);
  const integrations = list(projection.integrations).filter(item => family.has(item.nodeId) && item.status === 'integrated');
  const integratedRunIds = new Set(integrations.map(item => list(projection.changeSets).find(change => change.id === item.changeSetId)?.runId));
  // A verified integration advances the logical deliverable. A plan revision,
  // changed instruction, heartbeat or restored checkpoint never resets it.
  const lastIntegratedIndex = runs.findLastIndex(item => integratedRunIds.has(item.id));
  const pending = runs.slice(lastIntegratedIndex + 1);
  const latest = pending.at(-1), latestOutcome = latest && outcome(latest, projection);
  let repeatedFailureCount = 0;
  if (latestOutcome) {
    for (const run of [...pending].reverse()) {
      if (outcome(run, projection)?.fingerprint !== latestOutcome.fingerprint) break;
      repeatedFailureCount++;
    }
  }
  const seenOutputs = new Set();
  const useful = runs.filter(run => {
    const change = list(projection.changeSets).find(item => item.id === run.changeSetId);
    const identity = change && `${change.baseRevision}:${change.patchArtifact?.digest}`;
    if (change?.valid !== true || !(change.patchArtifact?.size > 0) || seenOutputs.has(identity)) return false;
    seenOutputs.add(identity);
    return true;
  }).at(-1);
  const lastIntegration = integrations.at(-1);
  const report = { nodeId: node.id, logicalId: logical(node), goalId: node.goalId,
    attempts: runs.length, attemptsSinceIntegration: pending.length,
    maxAttempts: (node.budget?.maxRetries ?? 0) + 1, repeatedFailureCount,
    lastFailureAt: latestOutcome?.at ?? null,
    lastProgressAt: [useful?.producedAt, lastIntegration?.integratedAt].filter(Boolean).sort().at(-1) ?? null,
    blocked: false, code: null, message: null, nextAction: null };
  const blocked = (code, message, nextAction) => Object.assign(report, { blocked: true, code, message, nextAction });
  if (list(projection.nodeFeedback).some(item => item.goalId === node.goalId && item.status === 'pending')) {
    return blocked('pending-node-feedback', 'Pending feedback must be resolved before another attempt.', 'Review the feedback and apply the scoped plan revision; preserve the current candidate.');
  }
  if (pending.length >= report.maxAttempts) {
    return blocked('logical-node-retry-budget-exhausted', 'This logical task exhausted its attempt budget across plan revisions.', 'Diagnose the repeated failure before explicitly revising the repair scope and budget.');
  }
  const changedInput = next && latest && (next.inputHash !== latest.inputHash
    || (next.baseRevision && next.baseRevision !== latest.baseRevision)
    || (next.executor && (next.executor.id !== latest.executor?.id || next.executor.version !== latest.executor?.version)));
  if (!changedInput && latestOutcome?.classification.retryDisposition === 'repair-input') {
    return blocked('retry-input-repair-required', 'The previous attempt failed on deterministic executor input or output limits.', 'Correct and validate the execution input or adapter configuration before trying again.');
  }
  if (!changedInput && repeatedFailureCount >= 2 && !repairsCapturedBudget(node, latest, projection)) {
    return blocked('retry-no-progress', 'Repeated failures produced the same patch and failure outcome.', 'Change the repair input, source baseline or executor after diagnosis; replaying the checkpoint is not progress.');
  }
  return report;
}

export function buildRetryDiagnostics(projection) {
  return list(projection.nodes).filter(node => node.supersededByRevision == null)
    .map(node => diagnoseNodeRetry(node, projection));
}
