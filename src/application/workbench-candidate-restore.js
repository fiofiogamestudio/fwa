import path from 'node:path';
import { stableStringify } from '../core/events.js';
import { resolveNodeEffects } from '../core/refs.js';
import { nodeHasUnsettledWorkspace } from '../core/scheduling.js';
import { buildWorkbenchRepairContext } from './workbench-repair-context.js';

const fail = message => Object.assign(new Error(message), { code: 'FWA_WORKSPACE_RESTORATION_FAILED' });
const workspaceKey = value => {
  const resolved = typeof value === 'string' ? path.resolve(value) : '';
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function assertActive(state, request, expectedRunId) {
  request.signal?.throwIfAborted();
  const node = state.nodes.find(item => item.id === request.node.id);
  const goal = state.goals.find(item => item.id === request.goal.id);
  const matches = state.runs.filter(item => item.nodeId === node?.id && item.goalId === goal?.id
    && item.status === 'running' && workspaceKey(item.workspacePath) === workspaceKey(request.workspaceRoot));
  const run = matches.length === 1 ? matches[0] : null;
  const refs = (state.refs ?? []).map(({ id, kind, uri, version, hash, metadata }) => ({ id, kind, uri, version, hash, metadata }));
  if (!run || node.status !== 'running' || node.validity !== 'valid' || goal.status !== 'active'
    || expectedRunId && run.id !== expectedRunId || run.baseRevision !== request.baseRevision
    || stableStringify(run.effects?.resolvedWrites) !== stableStringify(request.node.writes)
    || stableStringify(resolveNodeEffects(node, refs).writes) !== stableStringify(run.effects.resolvedWrites)) {
    throw fail('The repair no longer owns its active Run, target baseline or declared write scope.');
  }
  if ([...(state.nodeFeedback ?? []), ...(state.workflow?.feedback ?? [])]
    .some(item => item.goalId === goal.id && item.status === 'pending')) {
    throw fail('Resolve pending feedback before continuing candidate restoration.');
  }
  return { run, node };
}

/** Workbench composition only; runs inside the existing Run lease and deadline. */
export function createWorkbenchRepairExecutor(delegate, { application, workspace, changeSetId }) {
  return {
    schemaVersion: delegate.schemaVersion, id: delegate.id, version: delegate.version,
    capabilities: delegate.capabilities,
    ...(typeof delegate.validateInput === 'function' ? { validateInput: input => delegate.validateInput(input) } : {}),
    async execute(request) {
      let restoration;
      try {
        const state = await application.getStatus();
        const { run, node } = assertActive(state, request);
        // The currently executing Run has no result yet. It must not mask the
        // prior failure, and the prompt must not select an arbitrary old record.
        const prior = { ...state, runs: state.runs.filter(item => item.id !== run.id) };
        const repair = buildWorkbenchRepairContext(prior, node);
        const source = prior.changeSets.find(item => item.id === changeSetId);
        if (!repair || repair.references.changeSetId !== changeSetId || !source
          || source.kind !== 'execution' || source.runId !== repair.references.runId
          || repair.summary.retryDisposition !== 'retry'
          || repair.summary.violations.some(item => item.code !== 'EXECUTION_FAILED')
          || prior.nodes.some(item => item.acceptedChangeSetId === source.id || item.integratedChangeSetId === source.id)
          || prior.evaluations.some(item => item.changeSetId === source.id && item.status === 'passed')
          || nodeHasUnsettledWorkspace(node, prior)
          || nodeHasUnsettledWorkspace(prior.nodes.find(item => item.id === source.nodeId) ?? node, prior)) {
          throw fail('Only the latest settled ordinary failure of this logical node can be restored.');
        }
        if (typeof application.artifacts?.get !== 'function' || typeof application.artifacts?.verify !== 'function'
          || typeof workspace.restoreCandidate !== 'function') {
          throw fail('Candidate restoration requires verified artifact and Git workspace adapters.');
        }
        const patch = await application.artifacts.get(source.patchArtifact);
        const execution = await application.artifacts.verify(source.executionArtifact);
        if ((!Buffer.isBuffer(patch) && !(patch instanceof Uint8Array)) || execution?.ok !== true) {
          throw fail('Candidate artifacts could not be verified.');
        }
        assertActive(await application.getStatus(), request, run.id);
        restoration = await workspace.restoreCandidate({ workspacePath: request.workspaceRoot, runId: run.id,
          baseRevision: run.baseRevision, changeSet: source, patch: Buffer.from(patch), writes: run.effects.resolvedWrites });
        if (!['restored', 'baseline-changed'].includes(restoration?.status)
          || restoration.changeSetId !== source.id || restoration.baseRevision !== run.baseRevision
          || restoration.candidateRevision !== source.headRevision) {
          throw fail('The workspace adapter returned an invalid restoration result.');
        }
        assertActive(await application.getStatus(), request, run.id);
      } catch (error) {
        // Keep restoration problems out of the ordinary implementation retry
        // loop, and preserve an unconfirmed process for the core batch fence.
        const unconfirmed = error?.code?.includes('termination-unconfirmed')
          || error?.details?.terminationConfirmed === false || error?.details?.process?.terminationConfirmed === false;
        throw Object.assign(fail(`Candidate restoration stopped: ${String(error?.message ?? error).slice(0, 512)}`), {
          cause: error, details: { changeSetId, reason: error?.code ?? 'restoration-failed',
            ...(unconfirmed ? { terminationConfirmed: false } : {}) }
        });
      }
      const instruction = restoration.status === 'restored'
        ? 'FWA has already restored the verified failed candidate into this worktree. Continue from its current files; do not apply the old patch again. The Run base and final scope/budget checks are unchanged.'
        : 'FWA did not restore the old candidate because the target baseline changed. Inspect the retained candidate and recover only useful, in-scope changes into this current baseline; do not replace the baseline or overwrite newer work.';
      const input = typeof request.input?.prompt === 'string'
        ? { ...request.input, prompt: `${instruction}\n${request.input.prompt}` } : request.input;
      const result = await delegate.execute({ ...request, input, repairRestoration: restoration });
      return { ...result, repairRestoration: restoration };
    }
  };
}
