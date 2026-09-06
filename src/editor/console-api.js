import { GitWorktreeAdapter } from '../adapters/git-worktree.js';

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

function text(value, label, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum) {
    throw invalid(`${label} must be a trimmed nonempty string (maximum ${maximum} characters).`);
  }
  return value;
}

function readCommand(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

export async function handleConsoleApi({ app, req, url, sendJson }) {
  const state = app.fwaConsole;
  if (!state) throw invalid('FWA console must be launched with the guarded editor entry point.', 'editor-not-configured', 503);
  try {
    if (req.method === 'GET' && url.pathname === '/api/fwa/session') {
      sendJson(200, { protocol: state.protocol, fingerprint: state.fingerprint,
        projectId: state.projectId, projectRoot: state.projectRoot, allowWrite: state.allowWrite,
        csrfToken: state.csrfToken, fweVersion: state.fweVersion, launchRevision: state.launchRevision,
        commands: state.allowWrite ? ['goal.create', 'plan.load', 'node.retry'] : [] });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/fwa/status') {
      const status = await state.application.getStatus();
      if (status.projectId !== state.projectId || status.projectRoot !== state.projectRoot) throw invalid('Project identity changed; restart the console.', 'editor-project-changed', 409);
      const fence = await new GitWorktreeAdapter(state.projectRoot).inspectProcessFence();
      const lease = await state.application.lease.inspect();
      sendJson(200, { ...status, operational: { gitProcessFence: fence, workspaceLease: lease } });
      return true;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/fwa/commands') return false;
    // Defense in depth: the server guard authenticates requests; this handler
    // independently requires the launch capability and only fixed application calls.
    if (!state.allowWrite) throw invalid('Console is read-only.', 'editor-readonly', 403);
    const body = await readCommand(req);
    exactFields(body, ['type', 'commandId', 'payload']);
    const commandId = text(body.commandId, 'commandId', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(commandId)) throw invalid('commandId contains unsupported characters.');
    const payload = body.payload;
    let execute;
    if (body.type === 'goal.create') {
      exactFields(payload, ['title'], ['request']);
      const title = text(payload.title, 'title', 512);
      const request = payload.request === undefined ? title : text(payload.request, 'request', 16384);
      execute = () => state.application.createGoal({ title, request, commandId });
    } else if (body.type === 'plan.load') {
      exactFields(payload, ['goalId', 'plan']);
      const goalId = text(payload.goalId, 'goalId', 256);
      // FwaApplication canonicalizes/validates this JSON; no file path is accepted.
      execute = () => state.application.loadPlan({ goalId, plan: payload.plan, commandId });
    } else if (body.type === 'node.retry') {
      exactFields(payload, ['nodeId', 'reason']);
      const nodeId = text(payload.nodeId, 'nodeId', 256);
      const reason = text(payload.reason, 'reason');
      execute = () => state.application.retryNode({ nodeId, reason, commandId });
    } else throw invalid('Unsupported command. Execution, evaluation, integration and recovery remain CLI operations.');
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
