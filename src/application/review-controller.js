import { CommandEvaluator } from '../adapters/command-evaluator.js';
import { GitWorktreeAdapter } from '../adapters/git-worktree.js';
import { GitIntegrationAdapter } from '../adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from '../adapters/git-integration-workspace.js';
import { computeDependencyInvalidation, computeInvalidation } from '../core/invalidation.js';
import { hashCanonicalValue } from '../storage/file-event-store.js';
import { retryUnstartedLeaseOperation } from './lease-guard-retry.js';

export const REVIEW_COMMANDS = ['change.validate', 'change.accept', 'change.integrate', 'change.finish', 'change.revert'];
// Internal policy jobs are deliberately absent from the public/HTTP command list.
const REVIEW_JOB_TYPES = [...REVIEW_COMMANDS, 'change.auto-finish', 'change.policy-accept'];
const FINISH_NOTE = '用户确认当前候选及验证证据并请求收束';
const fail = (message, code = 'review-unavailable') => Object.assign(new Error(message), { code });
const internal = (commandId, step) => `review-${hashCanonicalValue(commandId).slice(0, 32)}-${step}`;
const requiredCriteria = node => typeof node.acceptance === 'string' ? [] : [...(node.acceptance?.commands || []), ...(node.acceptance?.checks || [])];

export function profileMatchesNode(profile, node) {
  if (typeof node.acceptance === 'string') return node.acceptance === profile.id;
  const required = requiredCriteria(node), available = profile.checks.map(check => check.id);
  return required.length > 0 && required.length === available.length
    && required.every(id => available.includes(id))
    && (!node.acceptance.evaluators?.length || node.acceptance.evaluators.includes('command-evaluator'));
}

function automaticPolicy(config, node, evidence) {
  const configuredMode = config?.completionPolicy?.mode ?? 'manual';
  const profiles = node ? (config?.validationProfiles || []).filter(profile => profileMatchesNode(profile, node)) : [];
  const profile = profiles.length === 1 ? profiles[0] : null;
  const profileHash = profile ? `sha256:${hashCanonicalValue(profile)}` : null;
  const reason = !config ? 'review-not-configured'
    : configuredMode !== 'automatic' ? 'review-manual-policy'
    : !profiles.length ? 'review-profile-mismatch'
    : profiles.length !== 1 ? 'review-profile-ambiguous'
    : config.completionPolicy.manualProfiles.includes(profile.id) ? 'review-profile-manual'
    : !evidence || evidence.kind !== 'command-evaluation' || evidence.result !== 'pass'
      || `sha256:${evidence.profileArtifact?.digest}` !== profileHash ? 'review-policy-evidence-mismatch'
    : null;
  // A busy or not-yet-validated candidate still has its configured policy.
  // A manual exception or a different validation contract requires human review.
  const completionMode = configuredMode === 'automatic' && profile
    && !config.completionPolicy.manualProfiles.includes(profile.id)
    && (!evidence || (evidence.kind === 'command-evaluation' && `sha256:${evidence.profileArtifact?.digest}` === profileHash))
    ? 'automatic' : 'manual';
  return { completionMode, profileId: profile?.id ?? null, profileHash, reason };
}

/** Human and policy acceptance records supplement real, immutable core Evidence. */
export class ReviewController {
  constructor(application, { config = null, jobs, signal } = {}) {
    this.application = application;
    this.config = config;
    this.jobs = jobs;
    this.signal = signal;
  }
  capabilities() {
    return { configured: Boolean(this.config), targetRef: this.config?.targetRef ?? null,
      fingerprint: this.config?.fingerprint ?? null,
      completionMode: this.config?.completionPolicy?.mode ?? 'manual',
      manualProfiles: [...(this.config?.completionPolicy?.manualProfiles || [])],
      validationProfiles: (this.config?.validationProfiles || []).map(profile => ({ id: profile.id,
        checks: profile.checks.map(check => ({ id: check.id, kind: check.kind })) })),
      setup: '启动时使用 --review-config <配置.json>；验证配置必须逐项覆盖任务验收条件，采用与撤销另行运行 compile 和 test。' };
  }
  async inspect(changeSetId) {
    const state = await this.application.getStatus(), jobs = await this.jobs.list();
    const change = state.changeSets.find(item => item.id === changeSetId);
    if (!change) throw fail('变更不存在。', 'review-change-not-found');
    const node = state.nodes.find(item => item.id === change.nodeId);
    const integration = state.integrations.find(item => item.id === node?.integrationIds?.at(-1) && item.changeSetId === change.id);
    const evidence = state.evidence.find(item => item.id === node?.acceptanceEvidenceIds?.[0]
      && item.changeSetId === change.id && item.headRevision === change.headRevision && item.result === 'pass');
    const policy = automaticPolicy(this.config, node, evidence);
    const acceptance = jobs.findLast(job => (job.type === 'change.accept'
      || (job.type === 'change.policy-accept' && !policy.reason && job.result?.acceptedByPolicy === true
        && job.result?.acceptanceKind === 'policy' && job.result?.policy?.mode === 'automatic'
        && job.result?.policy?.profileId === policy.profileId && job.result?.policy?.profileHash === policy.profileHash))
      && job.state === 'succeeded' && job.result?.ok === true
      && job.result?.headRevision === change.headRevision && job.result?.changeSetId === change.id
      && job.result?.evidenceId === evidence?.id && job.result?.configFingerprint === this.config?.fingerprint);
    const pendingFeedback = state.workflow?.feedback.filter(item => item.status === 'pending' && item.goalId === node?.goalId) || [];
    const current = Boolean(node && node.supersededByRevision == null && node.validity === 'valid'
      && node.changeSetIds.at(-1) === change.id && change.valid && change.kind === 'execution'
      && change.changedFiles.length > 0 && !change.revertedByReversionId && !pendingFeedback.length);
    const profiles = node ? (this.config?.validationProfiles || []).filter(profile => profileMatchesNode(profile, node))
      .map(profile => ({ id: profile.id, checks: profile.checks.map(check => ({ id: check.id, kind: check.kind })) })) : [];
    const integrated = Boolean(integration?.status === 'integrated' && node?.integratedChangeSetId === change.id);
    const impact = node ? ((change.changedRefIds || []).length
      ? computeInvalidation(state.nodes, change.changedRefIds, { excludeNodeIds: [node.id] })
      : computeDependencyInvalidation(state.nodes, [node.id])) : { affectedNodeIds: [], recomputeRootNodeIds: [] };
    const affected = impact.affectedNodeIds.map(id => state.nodes.find(item => item.id === id)).map(item => ({
      id: item.id, title: item.title, status: item.status, validity: item.validity,
      willBecomeStale: item.validity === 'valid' && ['produced', 'accepted'].includes(item.status) && item.runIds.length > 0
    }));
    const operational = await retryUnstartedLeaseOperation(this.application.lease, () => this.application.lease.inspect());
    const blocked = operational.held || jobs.some(job => REVIEW_JOB_TYPES.includes(job.type) && job.state === 'running');
    const actions = {
      validate: Boolean(this.config && current && !blocked && node.status === 'produced' && profiles.length),
      accept: Boolean(this.config && current && !blocked && evidence && node.status === 'accepted' && !integrated && !acceptance),
      integrate: Boolean(this.config && current && !blocked && evidence && acceptance && !integrated),
      finish: Boolean(this.config && current && !blocked && evidence && node.status === 'accepted' && !integrated),
      revert: Boolean(this.config && current && !blocked && integrated && integration.targetRef === this.config.targetRef)
    };
    const result = { changeSetId, nodeId: node?.id, nodeStatus: node?.status, title: node?.title, instruction: node?.instruction,
      acceptanceCriteria: node?.acceptance, headRevision: change.headRevision, baseRevision: change.baseRevision,
      targetRef: this.config?.targetRef ?? integration?.targetRef ?? null,
      evidenceId: evidence?.id ?? null, accepted: Boolean(acceptance),
      completionMode: policy.completionMode,
      autoFinishAllowed: Boolean(!policy.reason && current && !blocked && evidence && node.status === 'accepted' && !integrated),
      autoFinishReason: policy.reason,
      acceptedByPolicy: acceptance?.type === 'change.policy-accept',
      acceptanceRecord: acceptance ? { commandId: acceptance.commandId,
        kind: acceptance.type === 'change.policy-accept' ? 'policy' : 'human',
        ...(acceptance.result.note === undefined ? {} : { note: acceptance.result.note }), recordedAt: acceptance.finishedAt,
        headRevision: acceptance.result.headRevision, evidenceId: acceptance.result.evidenceId,
        configFingerprint: acceptance.result.configFingerprint,
        ...(acceptance.result.policy ? { policy: acceptance.result.policy } : {}) } : null,
      integrated, current, reverted: Boolean(change.revertedByReversionId), kind: change.kind,
      integrationId: integration?.id ?? null, integratedRevision: integration?.integratedRevision ?? null,
      configured: Boolean(this.config), profiles, actions,
      impact: { nodes: affected, recomputeRootNodeIds: impact.recomputeRootNodeIds,
        explanation: '撤销将在当前版本追加反向提交并保留后续无关修改。下列声明依赖可能失效；物理冲突和回归失败会阻止采用。' },
      jobs: jobs.filter(job => REVIEW_JOB_TYPES.includes(job.type) && job.payload?.changeSetId === change.id),
      blockers: [...(!this.config ? [this.capabilities().setup] : []),
        ...(this.config && !profiles.length ? [`没有逐项匹配的验证配置。任务条件：${requiredCriteria(node).join('、') || node?.acceptance}。`] : []),
        ...(!current ? ['此变更已过期、无实际改动、已撤销，或存在待处理反馈。'] : []),
        ...(blocked ? ['工程正在执行操作，完成后刷新。'] : [])] };
    result.reviewToken = hashCanonicalValue({ changeSetId, sequence: state.lastSequence, headRevision: change.headRevision,
      evidenceId: result.evidenceId, acceptedBy: acceptance?.commandId ?? null, config: this.config?.fingerprint ?? null,
      integratedRevision: result.integratedRevision });
    return result;
  }
  async dispatch(type, { commandId, changeSetId, reviewToken, profileId, note } = {}) {
    if (!REVIEW_COMMANDS.includes(type)) throw fail('无效的审查请求。', 'review-invalid-request');
    return this.#dispatch(type, { commandId, changeSetId, reviewToken, profileId, note });
  }
  // Wait only for this operation: settling every workbench job would wait for our parent.
  async #awaitJob(request) {
    const active = this.jobs.active.get(request.id);
    if (active) await active;
    const job = (await this.jobs.list()).find(item => item.commandId === request.commandId);
    if (job?.state !== 'succeeded') {
      const error = fail(job?.error?.message || '审查操作尚未确认完成，请检查记录后重试。', job?.error?.code || 'review-job-unconfirmed');
      if (job?.error?.details) error.details = job.error.details;
      throw error;
    }
    return job.result;
  }
  /** Run only trusted, exact candidate checks; never supply human acceptance. */
  async validateCandidate({ changeSetId, commandId } = {}) {
    const previous = (await this.jobs.list()).find(job => job.commandId === commandId);
    if (previous) {
      if (previous.type !== 'change.validate' || previous.payload.changeSetId !== changeSetId) throw fail('命令 ID 已用于不同的操作。', 'command-id-conflict');
      return this.#awaitJob(await this.dispatch(previous.type, { commandId, ...previous.payload }));
    }
    const review = await this.inspect(changeSetId);
    const pending = (phase, code) => ({ ok: false, changeSetId, phase, code, blockers: review.blockers, profiles: review.profiles });
    if (!this.config) return pending('needs-review-config', 'review-not-configured');
    if (!review.current) return pending('needs-current-candidate', 'review-change-stale');
    if (review.evidenceId && review.nodeStatus === 'accepted') return { ok: true, changeSetId,
      headRevision: review.headRevision, evidenceId: review.evidenceId, phase: 'already-validated' };
    if (review.nodeStatus !== 'produced') return pending('needs-repair', 'review-not-produced');
    if (!review.profiles.length) return pending('needs-validation-profile', 'review-profile-mismatch');
    if (review.profiles.length !== 1) return pending('needs-profile-selection', 'review-profile-ambiguous');
    if (!review.actions.validate) return pending('operation-active', 'review-operation-active');
    return this.#awaitJob(await this.dispatch('change.validate', { commandId, changeSetId,
      reviewToken: review.reviewToken, profileId: review.profiles[0].id }));
  }
  /** Trusted coordinator entry point: policy acceptance never impersonates a user. */
  async finishCandidate({ changeSetId, commandId } = {}) {
    const previous = (await this.jobs.list()).find(job => job.commandId === commandId);
    if (previous) {
      if (previous.type !== 'change.auto-finish' || previous.payload.changeSetId !== changeSetId) throw fail('命令 ID 已用于不同的操作。', 'command-id-conflict');
      return this.#awaitJob(await this.#dispatch(previous.type, { commandId, ...previous.payload }));
    }
    const review = await this.inspect(changeSetId);
    const pending = (phase, code) => ({ ok: false, finished: false, changeSetId, phase, code });
    if (!this.config) return pending('needs-review-config', 'review-not-configured');
    if (!review.current) return pending('needs-current-candidate', 'review-change-stale');
    if (review.integrated) return { ok: true, finished: true, changeSetId, phase: 'integrated',
      integrationId: review.integrationId, acceptanceCommandId: review.acceptanceRecord?.commandId ?? null,
      acceptedByPolicy: review.acceptedByPolicy };
    if (!review.evidenceId || review.nodeStatus !== 'accepted') return pending('needs-validation', 'review-not-validated');
    if (review.autoFinishReason) return { ok: true, finished: false, changeSetId,
      phase: 'awaiting-human-acceptance', reason: review.autoFinishReason };
    if (!review.autoFinishAllowed) return pending('operation-active', 'review-operation-active');
    return this.#awaitJob(await this.#dispatch('change.auto-finish', { commandId, changeSetId,
      reviewToken: review.reviewToken, profileId: review.profiles[0].id }));
  }
  async #dispatch(type, { commandId, changeSetId, reviewToken, profileId, note }, parentCommandId = null) {
    if (!REVIEW_JOB_TYPES.includes(type) || typeof changeSetId !== 'string' || !/^[a-f0-9]{64}$/.test(reviewToken || '')) throw fail('无效的审查请求。', 'review-invalid-request');
    if (!this.config) throw fail(this.capabilities().setup, 'review-not-configured');
    if (['change.accept', 'change.revert'].includes(type) && (typeof note !== 'string' || !note.trim() || note.length > 4000)) throw fail('请记录验收结论或撤销原因（最多 4000 字）。', 'review-note-required');
    if (type === 'change.finish') {
      if (note !== undefined && (typeof note !== 'string' || note.length > 4000)) throw fail('验收说明最多 4000 字。', 'review-note-required');
      note = note?.trim() || FINISH_NOTE;
    }
    const payload = { changeSetId, reviewToken, ...(profileId === undefined ? {} : { profileId }), ...(note === undefined ? {} : { note: note.trim() }) };
    // Resolve durable replays before examining a state changed by the first execution.
    return this.jobs.start({ commandId, type, payload }, async () => {
      const review = await this.inspect(changeSetId);
      if (review.reviewToken !== reviewToken) throw fail('候选、证据或工程状态已改变。请刷新审查后重试。', 'review-stale');
      // This job itself appears as running. Core leases still serialize actual mutations.
      const state = await this.application.getStatus();
      const other = (await this.jobs.list()).some(job => REVIEW_JOB_TYPES.includes(job.type) && job.state === 'running'
        && job.commandId !== commandId && job.commandId !== parentCommandId);
      if (other || (await retryUnstartedLeaseOperation(this.application.lease, () => this.application.lease.inspect())).held) throw fail('其他操作尚未完成。', 'review-operation-active');
      const node = state.nodes.find(item => item.id === review.nodeId), change = state.changeSets.find(item => item.id === changeSetId);
      if (!node || node.supersededByRevision != null || node.validity !== 'valid' || node.changeSetIds.at(-1) !== changeSetId
        || !change.valid || change.kind !== 'execution' || !change.changedFiles.length || change.revertedByReversionId
        || state.workflow?.feedback.some(item => item.goalId === node.goalId && item.status === 'pending')) throw fail('变更已不适用于当前任务。', 'review-change-stale');
      const evaluator = new CommandEvaluator(), workspace = new GitWorktreeAdapter(this.application.projectRoot);
      if (type === 'change.validate') {
        const profile = this.config.validationProfiles.find(item => item.id === profileId && profileMatchesNode(item, node));
        if (!profile || node.status !== 'produced') throw fail('验证配置不覆盖此候选的全部验收条件，或候选已验证。', 'review-profile-mismatch');
        const result = await this.application.evaluateChangeSet({ changeSetId, profile, evaluator, workspace,
          commandId: internal(commandId, 'evaluate'), signal: this.signal });
        return { ok: result.ok, changeSetId, headRevision: review.headRevision, evidenceId: result.evidence?.id ?? null,
          evaluationId: result.evaluation?.id ?? null, phase: result.ok ? 'awaiting-human-acceptance' : 'validation-failed', cleanup: result.cleanup };
      }
      if (['change.accept', 'change.policy-accept'].includes(type)) {
        if (!review.evidenceId || node.status !== 'accepted' || review.integrated || review.accepted) throw fail('只能验收已通过验证、尚未采用的当前候选。', 'review-not-validated');
        await workspace.verifyChangeSet(change);
        const evidence = state.evidence.find(item => item.id === review.evidenceId);
        await this.application.artifacts.verify(evidence.resultArtifact);
        if (type === 'change.policy-accept') {
          const policy = automaticPolicy(this.config, node, evidence);
          if (policy.reason || policy.profileId !== profileId) throw fail('当前策略不能自动接受此候选及证据。', policy.reason || 'review-profile-mismatch');
          await this.application.artifacts.verify(evidence.profileArtifact);
          return { ok: true, phase: 'accepted-by-policy', acceptanceKind: 'policy', acceptedByPolicy: true,
            changeSetId, headRevision: review.headRevision, evidenceId: review.evidenceId, configFingerprint: this.config.fingerprint,
            policy: { mode: 'automatic', profileId: policy.profileId, profileHash: policy.profileHash } };
        }
        return { ok: true, phase: 'accepted', changeSetId, headRevision: review.headRevision,
          evidenceId: review.evidenceId, note: payload.note, acceptanceKind: 'human', acceptedByPolicy: false,
          configFingerprint: this.config.fingerprint };
      }
      if (['change.finish', 'change.auto-finish'].includes(type)) {
        if (!review.evidenceId || node.status !== 'accepted' || review.integrated) throw fail('只能收束已通过验证、尚未采用的当前候选。', 'review-not-validated');
        const automatic = type === 'change.auto-finish';
        if (automatic) {
          const policy = automaticPolicy(this.config, node, state.evidence.find(item => item.id === review.evidenceId));
          if (policy.reason || policy.profileId !== profileId) throw fail('当前策略不能自动收束此候选及证据。', policy.reason || 'review-profile-mismatch');
        }
        if (!review.accepted) {
          await this.#awaitJob(await this.#dispatch(automatic ? 'change.policy-accept' : 'change.accept', {
            commandId: internal(commandId, automatic ? 'policy-accept' : 'accept'),
            changeSetId, reviewToken, ...(automatic ? { profileId } : { note: payload.note }) }, commandId));
        }
        // Acceptance changes the review token. Bind integration to the fresh durable record.
        const accepted = await this.inspect(changeSetId);
        const result = await this.#awaitJob(await this.#dispatch('change.integrate', {
          commandId: internal(commandId, 'integrate-job'), changeSetId, reviewToken: accepted.reviewToken }, commandId));
        return { ...result, finished: result.ok && result.phase === 'integrated',
          acceptanceCommandId: accepted.acceptanceRecord?.commandId ?? null, acceptedByPolicy: accepted.acceptedByPolicy };
      }
      if (type === 'change.integrate' && (!review.accepted || !review.evidenceId || review.integrated)) throw fail('先通过人工或已授权策略接受此候选及证据。', 'review-not-accepted');
      if (type === 'change.revert' && (!review.integrated || !node.integratedTargetRef || node.integratedTargetRef !== this.config.targetRef)) throw fail('只能撤销当前目标中已采用的变更。', 'review-not-integrated');
      const result = await this.application[type === 'change.revert' ? 'revertChangeSet' : 'integrateChangeSetGated']({
        changeSetId, targetRef: this.config.targetRef, profile: this.config.regressionProfile, evaluator,
        candidateWorkspace: new GitIntegrationWorkspaceAdapter(this.application.projectRoot),
        promotion: new GitIntegrationAdapter(this.application.projectRoot), evaluationWorkspace: workspace,
        commandId: internal(commandId, type === 'change.revert' ? 'revert' : 'integrate'), signal: this.signal });
      return { ok: result.ok, changeSetId, phase: result.reversion?.status ?? result.integration?.status,
        integrationId: result.integration?.id ?? null, reversionId: result.reversion?.id ?? null,
        revertChangeSetId: result.revertChangeSet?.id ?? null, cleanup: result.cleanup,
        ...(type === 'change.revert' ? { note: payload.note, reviewedImpact: review.impact } : {}) };
    });
  }
}
