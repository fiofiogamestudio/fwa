import { createHash, randomUUID } from 'node:crypto';
import { CommandEvaluator } from '../adapters/command-evaluator.js';
import { GitExperimentWorkspace } from '../adapters/git-experiment-workspace.js';
import { computeDependencyInvalidation, computeInvalidation } from '../core/invalidation.js';
import { isRefId } from '../core/refs.js';
import { matchesEffectPattern } from '../core/effects.js';
import { hashCanonicalValue } from '../storage/file-event-store.js';
import { retryUnstartedLeaseOperation } from './lease-guard-retry.js';

const fail = (message, code = 'experiment-invalid', details) => Object.assign(new Error(message), { code, details });
const clone = value => JSON.parse(JSON.stringify(value));
const empty = value => value === undefined || value === null;

export function normalizeExperimentConfig(value) {
  if (empty(value)) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['profile', 'conditions'].includes(key))) throw fail('Experiment configuration requires profile and conditions.');
  const profile = new CommandEvaluator().normalizeProfile(value.profile);
  if (profile.checks.length > 8) throw fail('An experiment supports at most eight checks per side.');
  if (JSON.stringify(profile).length > 65536 || profile.checks.some(check => (check.expectedArtifacts?.length ?? 0) > 64)) throw fail('The experiment profile or artifact list is too large.');
  if (!value.conditions || typeof value.conditions !== 'object' || Array.isArray(value.conditions)
    || !Object.keys(value.conditions).length || JSON.stringify(value.conditions).length > 16384) {
    throw fail('Record fixed scene, input, seed, camera or other experiment conditions.');
  }
  for (const [key, setting] of Object.entries(value.conditions)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || !['string', 'number', 'boolean'].includes(typeof setting)
      || (typeof setting === 'number' && !Number.isFinite(setting))) throw fail('Experiment conditions must be named scalar values.');
  }
  return clone({ profile, conditions: value.conditions });
}

/** Conservative exclusion analysis over the current integrated outputs. */
export function inspectExperimentChange(status, changeSetId, targetRef) {
  const changeSet = status.changeSets?.find(item => item.id === changeSetId);
  const node = status.nodes?.find(item => item.id === changeSet?.nodeId);
  const integration = status.integrations?.find(item => item.id === node?.integrationIds?.at(-1));
  if (!changeSet || changeSet.kind !== 'execution' || !node || !integration
    || !empty(changeSet.revertedByReversionId) || integration.status !== 'integrated'
    || !empty(integration.activeReversionId) || !empty(node.activeIntegrationId)
    || integration.changeSetId !== changeSetId || integration.targetRef !== targetRef
    || node.integratedChangeSetId !== changeSetId || node.integratedTargetRef !== targetRef
    || node.integratedRevision !== integration.integratedRevision || node.validity !== 'valid'
    || node.status !== 'accepted' || node.integrationStatus !== 'integrated') {
    throw fail('Choose the current valid, adopted change of this task.', 'experiment-change-unavailable');
  }
  const nodes = status.nodes;
  const dependency = computeDependencyInvalidation(nodes, [node.id]).affectedNodeIds;
  const logical = computeInvalidation(nodes, (node.writes ?? []).filter(isRefId), { excludeNodeIds: [node.id] }).affectedNodeIds;
  const pathConsumers = nodes.filter(item => item.id !== node.id && (item.reads ?? []).some(pattern => !isRefId(pattern)
    && (changeSet.changedFiles ?? []).some(file => matchesEffectPattern(pattern, file, { ignoreCase: process.platform === 'win32' })))).map(item => item.id);
  const pathDependents = pathConsumers.length ? computeDependencyInvalidation(nodes, pathConsumers).affectedNodeIds : [];
  const affected = new Set([...dependency, ...logical, ...pathConsumers, ...pathDependents]);
  const blockers = nodes.filter(item => affected.has(item.id) && item.integrationStatus === 'integrated'
    && item.integratedTargetRef === targetRef).map(item => ({ nodeId: item.id, title: item.title ?? item.id, changeSetId: item.integratedChangeSetId }));
  return { changeSetId, nodeId: node.id, title: node.title ?? node.id, excludedRevision: integration.integratedRevision, blockers };
}

function captureImages(evaluation) {
  const media = [];
  let remaining = 2 * 1024 * 1024;
  for (const check of evaluation.checks) for (const item of check.expectedArtifacts ?? []) {
    if (!item.passed || !/\.(png|jpe?g|webp)$/i.test(item.path)) continue;
    if (typeof item.bytesBase64 !== 'string' || item.size > remaining) continue;
    const bytes = Buffer.from(item.bytesBase64, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length > remaining || item.size !== bytes.length || item.digest !== digest) throw fail('Experiment image bytes do not match validation.');
    remaining -= bytes.length;
    media.push({ checkId: check.id, path: item.path, sha256: digest, size: bytes.length,
      mime: /\.png$/i.test(item.path) ? 'image/png' : /\.webp$/i.test(item.path) ? 'image/webp' : 'image/jpeg', base64: bytes.toString('base64') });
  }
  return media;
}

/** Durable experiment jobs are separate from adoption/reversion: neither side is promoted. */
export class ChangeExperiments {
  constructor(application, { targetRef, config, jobs, signal } = {}) {
    this.application = application;
    this.targetRef = targetRef?.startsWith('refs/heads/') ? targetRef : `refs/heads/${targetRef ?? 'main'}`;
    this.config = normalizeExperimentConfig(config);
    this.jobs = jobs;
    this.signal = signal;
    this.workspace = new GitExperimentWorkspace(application.projectRoot);
  }

  async inspect(changeSetId) {
    if (!this.config) return { available: false, reason: 'Configure a trusted experiment runner and fixed conditions in review-config.' };
    const selected = inspectExperimentChange(await this.application.getStatus(), changeSetId, this.targetRef);
    const baselineRevision = await this.workspace.target(this.targetRef);
    const state = { ...selected, targetRef: this.targetRef, baselineRevision, conditions: this.config.conditions,
      profileId: this.config.profile.id, profileHash: hashCanonicalValue(this.config.profile) };
    return { ...state, available: !selected.blockers.length, reviewToken: hashCanonicalValue(state),
      reason: selected.blockers.length ? '已采用的后续变化依赖这一项，当前不能形成单变量比较。' : null };
  }

  async dispatch({ changeSetId, reviewToken, commandId }) {
    if (typeof changeSetId !== 'string' || !/^[a-f0-9]{64}$/.test(reviewToken ?? '')) throw fail('Invalid experiment request.');
    return this.jobs.start({ commandId, type: 'experiment.run', payload: { changeSetId, reviewToken } },
      async () => {
        const current = await this.inspect(changeSetId);
        if (!current.available) throw fail(current.reason, 'experiment-not-isolated', { blockers: current.blockers });
        if (reviewToken !== current.reviewToken) throw fail('The comparison baseline changed; refresh before starting.', 'experiment-stale');
        return this.run({ ...current, experimentId: `exp-${randomUUID().replaceAll('-', '')}` });
      });
  }

  async run(request) {
    const lease = await retryUnstartedLeaseOperation(this.application.lease, () => this.application.lease.acquire({ ownerKind: 'evaluation', ownerId: request.experimentId, ttlMs: 30000 }));
    let mayRelease = true;
    try {
      const fresh = await this.inspect(request.changeSetId);
      if (!fresh.available || fresh.reviewToken !== request.reviewToken) throw fail('Experiment inputs changed while queued.', 'experiment-stale');
      const pair = await this.workspace.createPair(request);
      const base = { schemaVersion: 1, experimentId: request.experimentId, changeSetId: request.changeSetId,
        targetRef: request.targetRef, baselineRevision: request.baselineRevision, excludedRevision: request.excludedRevision,
        conditions: clone(this.config.conditions), profile: clone(this.config.profile), createdAt: new Date().toISOString() };
      if (pair.status === 'conflict') return { ...base, ...pair, comparison: 'blocked', reason: '排除此项产生 Git 冲突；未运行对照。' };
      const evaluator = new CommandEvaluator({ outputLimitBytes: 32 * 1024,
        env: { ...process.env, FWA_EXPERIMENT_CONDITIONS: JSON.stringify(this.config.conditions) } });
      const sides = {};
      for (const key of ['a', 'b']) {
        await this.workspace.inspectSide(pair[key]);
        const evaluation = await evaluator.evaluate({ workspaceRoot: pair[key].workspacePath, manifest: this.config.profile, signal: this.signal });
        if (evaluation.checks.some(check => check.terminationConfirmed === false)) {
          mayRelease = false;
          throw fail('Experiment runner termination is unconfirmed; inspect its retained workspace before lease recovery.', 'experiment-runner-unconfirmed');
        }
        await this.workspace.inspectSide(pair[key]);
        const media = captureImages(evaluation);
        // The bounded durable job keeps image previews once and all artifact hashes;
        // large original artifacts remain in the explicitly retained worktrees.
        const report = { ...evaluation, checks: evaluation.checks.map(check => ({ ...check,
          expectedArtifacts: check.expectedArtifacts.map(({ bytesBase64, ...artifact }) => artifact) })) };
        sides[key] = { ...pair[key], evaluation: report, media };
      }
      if (hashCanonicalValue(sides.a.evaluation.environmentFingerprint) !== hashCanonicalValue(sides.b.evaluation.environmentFingerprint)) {
        throw fail('Experiment runner environments differ.', 'experiment-environment-mismatch');
      }
      const passed = sides.a.evaluation.passed && sides.b.evaluation.passed;
      return { ...base, changedFiles: pair.changedFiles, patch: pair.patch.slice(0, 256 * 1024),
        patchTruncated: pair.patch.length > 256 * 1024, ...sides,
        comparison: passed ? 'ready' : 'failed',
        reason: passed ? '两个版本已按同一配置执行；结果差异需结合场景判读。' : '至少一个版本未通过运行检查，不能作为有效对照。',
        sourceIsolation: 'one-integrated-change', humanConclusion: 'not-reviewed' };
    } catch (error) {
      if (['git-process-termination-unconfirmed', 'FWA_PROCESS_TERMINATION_UNCONFIRMED'].includes(error.code)) mayRelease = false;
      throw error;
    } finally {
      if (mayRelease) await retryUnstartedLeaseOperation(this.application.lease, () => this.application.lease.release({ leaseId: lease.lease.leaseId, ownerToken: lease.ownerToken }));
    }
  }

  async list(changeSetId) {
    return (await this.jobs.list()).filter(job => job.type === 'experiment.run'
      && (!changeSetId || job.payload.changeSetId === changeSetId));
  }
}
