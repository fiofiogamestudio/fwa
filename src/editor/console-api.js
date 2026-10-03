import { GitWorktreeAdapter } from '../adapters/git-worktree.js';
import { queryArtifact, queryEvents, queryRefContent } from './console-queries.js';
import { assertProjectWorkScope } from '../application/workbench-policy.js';
import { validateInteractionField } from '../core/interaction-contract.js';
import { REVIEW_COMMANDS } from '../application/review-controller.js';
import { queryExperiments } from './experiment-api.js';
import { retryUnstartedLeaseOperation } from '../application/lease-guard-retry.js';
import { buildWorkflow } from '../core/workflow.js';
import { summarizeStatus } from './status-summary.js';

const MAX_BODY_BYTES = 128 * 1024;

function invalid(message, code = 'editor-invalid-command', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function exactFields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw invalid(`Expected fields: ${required.join(', ')}${optional.length ? ` (optional: ${optional.join(', ')})` : ''}.`);
  }
}

function field(value, name) {
  try { return validateInteractionField(name, value); }
  catch (error) { throw invalid(error.message); }
}

function readCommand(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(invalid('Command body is too large.', 'editor-body-too-large', 413));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(invalid('Command body must be valid JSON.')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(invalid('Command request was aborted.')));
  });
}

export async function handleConsoleApi({ app, req, res, url, sendJson }) {
  const state = app.fwaConsole;
  if (!state) throw invalid('FWA console must be launched with the guarded editor entry point.', 'editor-not-configured', 503);
  try {
    // Previews describe current local state and must not be cached across edits.
    res?.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && url.pathname === '/api/fwa/session') {
      sendJson(200, { protocol: state.protocol, fingerprint: state.fingerprint,
        projectId: state.projectId, projectRoot: state.projectRoot, allowWrite: state.allowWrite,
        csrfToken: state.csrfToken, fweVersion: state.fweVersion, launchRevision: state.launchRevision,
        workflow: state.workbench?.capabilities(),
        review: state.review?.capabilities(), reviewCommands: state.allowWrite ? [...REVIEW_COMMANDS, 'experiment.run'] : [],
        workflowCommands: state.allowWrite ? ['library.import', 'library.permission', 'workflow.plan', 'workflow.work', 'workflow.finish', 'workflow.revise', 'node.feedback', 'plan.revise'] : [],
        commands: state.allowWrite ? ['goal.create', 'plan.load', 'node.retry'] : [] });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/status') {
      const view = url.searchParams.get('view');
      if (view !== null && view !== 'summary' && view !== 'full') throw invalid('Status view must be summary or full.');
      const status = await state.application.getStatus();
      if (status.projectId !== state.projectId || status.projectRoot !== state.projectRoot) throw invalid('Project identity changed; restart the console.', 'editor-project-changed', 409);
      const fence = await new GitWorktreeAdapter(state.projectRoot).inspectProcessFence();
      const lease = await retryUnstartedLeaseOperation(state.application.lease, () => state.application.lease.inspect());
      const operational = { gitProcessFence: fence, workspaceLease: lease };
      const projection = { ...status, operational,
        workflow: buildWorkflow({ ...status, operational, nodeFeedback: status.workflow?.feedback ?? [] }) };
      sendJson(200, view === 'summary' ? summarizeStatus(projection) : projection);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/events') {
      sendJson(200, await queryEvents(state, url.searchParams));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/workbench') {
      sendJson(200, await state.workbench.status()); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/review') {
      if ([...url.searchParams.keys()].some(key => key !== 'changeSetId')) throw invalid('Only changeSetId is accepted.');
      sendJson(200, await state.review.inspect(url.searchParams.get('changeSetId'))); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/experiments') {
      sendJson(200, await queryExperiments(state.experiments, url.searchParams)); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/library/tree') {
      sendJson(200, await state.workbench.library.tree({ libraryId: url.searchParams.get('libraryId'),
        ...(url.searchParams.has('versionId') ? { versionId: url.searchParams.get('versionId') } : {}) })); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/library/content') {
      const file = await state.workbench.library.readFile({ libraryId: url.searchParams.get('libraryId'),
        ...(url.searchParams.has('versionId') ? { versionId: url.searchParams.get('versionId') } : {}),
        path: url.searchParams.get('path'), maxBytes: 16 * 1024 * 1024 });
      if (url.searchParams.get('raw') === '1') {
        res.setHeader('Content-Type', file.contentType);
        res.setHeader('Content-Length', file.bytes.length);
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'");
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (!/^(image\/(png|jpeg|gif|webp|svg\+xml)|video\/(mp4|webm)|audio\/(mpeg|wav)|text\/plain|application\/pdf)$/.test(file.contentType)) res.setHeader('Content-Disposition', 'attachment');
        res.writeHead(200); res.end(file.bytes);
      } else {
        const { bytes, ...metadata } = file;
        sendJson(200, { ...metadata, ...(file.size <= 256 * 1024 && /\.(md|txt|json|csv|gd|cs|js|ts|svg|yaml|yml)$/i.test(file.path) ? { text: bytes.toString('utf8') } : {}) });
      }
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/refs/content') {
      const preview = await queryRefContent(state, url.searchParams);
      if (preview.bytes) {
        // Raw SVG is an image resource, never trusted inline markup or an HTML
        // document. The sandbox also applies when its URL is opened directly.
        res.setHeader('Content-Type', preview.mime);
        res.setHeader('Content-Length', preview.bytes.length);
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'");
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.writeHead(200);
        res.end(preview.bytes);
      } else sendJson(200, preview.body);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/artifacts') {
      const artifact = await queryArtifact(state, url.searchParams);
      if (artifact.bytes) {
        res.setHeader('Content-Type', artifact.mime); res.setHeader('Content-Length', artifact.bytes.length);
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); res.setHeader('X-Content-Type-Options', 'nosniff');
        res.writeHead(200); res.end(artifact.bytes);
      } else sendJson(200, artifact);
      return true;
    }
    if (req.method !== 'POST' || !['/api/fwa/commands', '/api/fwa/import'].includes(url.pathname)) return false;
    // Defense in depth: the server guard authenticates requests; this handler
    // independently requires the launch capability and only fixed application calls.
    if (!state.allowWrite) throw invalid('Console is read-only.', 'editor-readonly', 403);
    const uploading = url.pathname === '/api/fwa/import';
    const body = await readCommand(req, uploading ? 48 * 1024 * 1024 : MAX_BODY_BYTES);
    exactFields(body, ['type', 'commandId', 'payload']);
    const commandId = field(body.commandId, 'commandId');
    const payload = body.payload;
    let execute;
    if (uploading) {
      if (body.type !== 'library.import') throw invalid('The import route only accepts library.import.');
      exactFields(payload, ['label'], ['libraryId', 'files', 'directories', 'format', 'base64']);
      field(payload.label, 'libraryLabel');
      if (payload.label !== payload.label.trim()) throw invalid('Import label must be trimmed.');
      if (payload.files !== undefined && (payload.format !== undefined || payload.base64 !== undefined)) throw invalid('Choose files or one ZIP archive, not both.');
      execute = async () => {
        await state.workbench.library.init();
        return payload.files !== undefined
          ? state.workbench.library.importFiles({ ...payload, commandId })
          : state.workbench.library.importArchive({ ...payload, commandId });
      };
    } else if (body.type === 'experiment.run') {
      exactFields(payload, ['changeSetId', 'reviewToken']);
      execute = () => state.experiments.dispatch({ ...payload, commandId });
    } else if (REVIEW_COMMANDS.includes(body.type)) {
      exactFields(payload, ['changeSetId', 'reviewToken'], body.type === 'change.validate' ? ['profileId']
        : ['change.accept', 'change.revert', 'change.finish'].includes(body.type) ? ['note'] : []);
      execute = () => state.review.dispatch(body.type, { ...payload, commandId });
    } else if (body.type === 'goal.create') {
      exactFields(payload, ['title'], ['request']);
      const title = field(payload.title, 'title');
      const request = payload.request === undefined ? title : field(payload.request, 'goalRequest');
      execute = () => state.application.createGoal({ title, request, commandId });
    } else if (body.type === 'plan.load') {
      exactFields(payload, ['goalId', 'plan']);
      const goalId = field(payload.goalId, 'goalId');
      field(payload.plan, 'plan');
      // FwaApplication canonicalizes/validates this JSON; no file path is accepted.
      execute = () => state.application.loadPlan({ goalId, plan: payload.plan, commandId });
    } else if (body.type === 'node.retry') {
      exactFields(payload, ['nodeId', 'reason']);
      const nodeId = field(payload.nodeId, 'nodeId');
      const reason = field(payload.reason, 'reason');
      execute = () => state.application.retryNode({ nodeId, reason, commandId });
    } else if (body.type === 'library.permission') {
      exactFields(payload, ['libraryId', 'path', 'access']);
      field(payload.access, 'permission');
      execute = () => state.workbench.library.setPermission({ ...payload, commandId });
    } else if (body.type === 'workflow.plan') {
      exactFields(payload, ['libraryIds', 'mode'], ['request']);
      field(payload.mode, 'mode');
      if (payload.request !== undefined) field(payload.request, 'request');
      execute = () => state.workbench.plan({ ...payload, commandId });
    } else if (body.type === 'workflow.work') {
      exactFields(payload, ['goalId'], ['nodeId']);
      field(payload.goalId, 'goalId');
      if (payload.nodeId !== undefined) field(payload.nodeId, 'nodeId');
      execute = () => state.workbench.work({ ...payload, commandId });
    } else if (body.type === 'workflow.finish') {
      exactFields(payload, ['changeSetId', 'reviewToken'], ['note']);
      execute = () => state.workbench.finish({ ...payload, commandId });
    } else if (body.type === 'workflow.revise') {
      exactFields(payload, ['goalId', 'expectedRevision', 'feedbackIds']);
      execute = () => state.workbench.revise({ ...payload, commandId });
    } else if (body.type === 'node.feedback') {
      exactFields(payload, ['nodeId', 'text']);
      field(payload.nodeId, 'nodeId'); field(payload.text, 'feedback');
      execute = () => state.application.submitNodeFeedback({ ...payload, commandId });
    } else if (body.type === 'plan.revise') {
      exactFields(payload, ['goalId', 'plan', 'expectedRevision', 'reason'], ['feedbackIds']);
      field(payload.reason, 'revisionReason');
      field(payload.plan, 'plan');
      execute = async () => {
        const status = await state.application.getStatus();
        for (const node of payload.plan.nodes || []) assertProjectWorkScope(node, status.refs);
        return state.application.revisePlan({ ...payload, commandId });
      };
    } else throw invalid('Unsupported command. Recovery requires an explicit CLI operation.');
    const current = await state.application.getStatus();
    if (current.projectId !== state.projectId || current.projectRoot !== state.projectRoot) throw invalid('Project identity changed; restart the console.', 'editor-project-changed', 409);
    const fence = await new GitWorktreeAdapter(state.projectRoot).inspectProcessFence();
    if (fence.held) throw invalid('Git safety fence is held; inspect and recover explicitly through the CLI.', 'editor-git-fenced', 409);
    const result = await execute();
    sendJson(200, { ok: true, commandId, type: body.type, result });
    return true;
  } catch (error) {
    sendJson(error.status ?? (error.code === 'invalid-command' ? 400 : 409), {
      error: error.message, code: error.code ?? 'editor-command-failed',
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.errors === undefined ? {} : { errors: error.errors })
    });
    return true;
  }
}
