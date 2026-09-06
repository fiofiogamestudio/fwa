import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FwaApplication } from '../application/fwa-application.js';

export const CONSOLE_PROTOCOL = 'fwa-console-v1';
const require = createRequire(import.meta.url);
const appPath = fileURLToPath(new URL('./app/fwe.app.json', import.meta.url));
const expectedContract = {
  version: 1,
  requestGuard: 'await-before-routing-v1',
  extensions: 'sync-setup-async-handlers-v1',
  launchRevision: 'fwe-launch-v1',
  runtimeFingerprint: 'fwe-runtime-v1'
};
const fwaRoot = fileURLToPath(new URL('../../', import.meta.url));
async function fwaRuntimeFingerprint() {
  const files = [path.join(fwaRoot, 'package.json')];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw failure(`Linked runtime sources cannot be fingerprinted: ${file}`, 'editor-source-changed', 503);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  for (const directory of ['src', 'bin']) await visit(path.join(fwaRoot, directory));
  const hash = createHash('sha256').update('fwa-runtime-v1\0');
  for (const file of files.sort()) hash.update(path.relative(fwaRoot, file).replace(/\\/g, '/')).update('\0').update(await readFile(file)).update('\0');
  return hash.digest('hex');
}
const loadedFwaFingerprint = await fwaRuntimeFingerprint();

function failure(message, code = 'editor-incompatible-fwe', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Load one explicitly selected, trusted FWE checkout. No npm resolution/fallback. */
export async function startEditor({ projectRoot, fwePath, port = 3220, allowWrite = false, signal } = {}) {
  if (typeof fwePath !== 'string' || !path.isAbsolute(fwePath)) {
    throw failure('--fwe-path must be an absolute path to a compatible FWE checkout.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || typeof allowWrite !== 'boolean') {
    throw failure('Editor port must be an integer from 0 to 65535; allowWrite must be boolean.', 'invalid-editor-options');
  }
  signal?.throwIfAborted();
  const selectedFwePath = await realpath(fwePath);
  const metadata = JSON.parse(await readFile(path.join(selectedFwePath, 'package.json'), 'utf8'));
  if (metadata.name !== 'fwe' || metadata.version !== '0.2.0') {
    throw failure('This console requires FWE 0.2.0 with server integration contract v1.');
  }
  const fwe = require(path.join(selectedFwePath, 'src', 'server.js'));
  if (!fwe.SERVER_INTEGRATION_CONTRACT
    || Object.entries(expectedContract).some(([key, value]) => fwe.SERVER_INTEGRATION_CONTRACT[key] !== value)
    || typeof fwe.loadAppConfig !== 'function' || typeof fwe.startServer !== 'function'
    || typeof fwe.getServerRuntimeFingerprint !== 'function'
    || !/^fwe-runtime-v1:[a-f0-9]{64}$/.test(fwe.SERVER_RUNTIME_FINGERPRINT || '')) {
    throw failure('Selected FWE lacks the required guarded-server contract; update that checkout explicitly.');
  }
  let drifted = false;
  const assertSourcesUnchanged = async () => {
    try {
      if (drifted || await fwaRuntimeFingerprint() !== loadedFwaFingerprint
        || fwe.getServerRuntimeFingerprint() !== fwe.SERVER_RUNTIME_FINGERPRINT) {
        throw new Error('Runtime fingerprint no longer matches loaded sources.');
      }
    } catch {
      drifted = true;
      throw failure('FWA/FWE runtime sources changed or became unreadable. Stop and start a fresh process; hot reload is disabled.', 'editor-source-changed', 503);
    }
  };
  await assertSourcesUnchanged();
  const application = new FwaApplication(projectRoot, { actor: 'fwa-console' });
  // Does not init or repair a project. A read-only launch must not write state.
  const initialStatus = await application.getStatus();
  const app = fwe.loadAppConfig(appPath);
  if (!/^fwe-launch-v1:[a-f0-9]{64}$/.test(app.launchRevision || '')) {
    throw failure('Selected FWE did not provide its source launch fingerprint.');
  }
  // workspaceDir is a public programmatic App property consumed by sourceContext.
  // The launch fingerprint is combined with this fixed project and capability below.
  app.workspaceDir = application.projectRoot;
  app.domains[0].source.expectedProjectId = initialStatus.projectId;
  const fingerprint = createHash('sha256').update(JSON.stringify({
    protocol: CONSOLE_PROTOCOL, contract: expectedContract, launchRevision: app.launchRevision,
    fwaRuntime: loadedFwaFingerprint, fweRuntime: fwe.SERVER_RUNTIME_FINGERPRINT,
    projectId: initialStatus.projectId, projectRoot: application.projectRoot, allowWrite
  })).digest('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const state = Object.freeze({ application, projectId: initialStatus.projectId,
    projectRoot: application.projectRoot, allowWrite, fingerprint, protocol: CONSOLE_PROTOCOL,
    csrfToken, fweVersion: metadata.version, fwePath: selectedFwePath, launchRevision: app.launchRevision });
  app.fwaConsole = state;
  app.labels.fwaConsole = { protocol: CONSOLE_PROTOCOL, fingerprint };
  const guard = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const host = `127.0.0.1:${req.socket.localPort}`;
    const origin = `http://${host}`;
    if (req.headers.host !== host || !req.url?.startsWith('/') || req.url.startsWith('//')
      || (req.headers.origin !== undefined && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') {
      throw failure('Host or Origin rejected.', 'editor-origin-rejected', 403);
    }
    await assertSourcesUnchanged();
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    // Even an authorized client cannot use generic CRUD, app stop, or recovery APIs.
    if (req.method !== 'POST' || req.url !== '/api/fwa/commands') {
      throw failure('Generic mutations are disabled; use a supported FWA command.', 'editor-route-readonly', 405);
    }
    if (!allowWrite) throw failure('Console is read-only. Restart with --allow-write to enable commands.', 'editor-readonly', 403);
    if (req.headers.origin !== origin || !equalSecret(req.headers['x-fwa-csrf'], csrfToken)) {
      throw failure('Command requires same-origin CSRF credentials.', 'editor-csrf-rejected', 403);
    }
    if (req.headers['x-fwa-fingerprint'] !== fingerprint) {
      throw failure('Console fingerprint changed. Reload before issuing a command.', 'editor-fingerprint-mismatch', 409);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      throw failure('Commands require application/json.', 'editor-invalid-content-type', 415);
    }
    return true;
  };
  await assertSourcesUnchanged();
  const server = await fwe.startServer(app, '127.0.0.1', port, { requestGuard: guard, quiet: true });
  const url = `http://127.0.0.1:${server.address().port}`;
  const closed = new Promise((resolve) => server.once('close', resolve));
  const close = () => { server.close(); server.closeIdleConnections?.(); return closed; };
  signal?.addEventListener('abort', close, { once: true });
  closed.then(() => signal?.removeEventListener('abort', close));
  if (signal?.aborted) await close();
  return { server, url, projectRoot: application.projectRoot, projectId: initialStatus.projectId,
    allowWrite, fingerprint, protocol: CONSOLE_PROTOCOL, fwePath: selectedFwePath, closed, close };
}
