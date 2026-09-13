import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hashCanonicalValue } from './file-event-store.js';

const fail = (message, code = 'workbench-job-invalid') => Object.assign(new Error(message), { code });
async function directory(target, create = false) {
  if (create) await mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Job storage contains a non-directory or link.');
}
async function read(target) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw fail('Invalid job record.');
  return JSON.parse(await readFile(target, 'utf8'));
}
async function publish(target, value) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, target); } finally { await unlink(temporary); }
}

/** Immutable requests/results; restart never silently replays a possibly dispatched job. */
export class WorkbenchJobs {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.root = path.join(this.projectRoot, '.fwa', 'workbench-jobs');
    this.session = randomUUID();
    this.active = new Map();
  }
  async assertStorage(create = false) {
    await directory(this.projectRoot);
    await directory(path.join(this.projectRoot, '.fwa'));
    await directory(this.root, create);
  }
  async list() {
    try { await this.assertStorage(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const rows = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}\.request\.json$/.test(entry.name)) continue;
      const request = await read(path.join(this.root, entry.name));
      const id = entry.name.slice(0, 64);
      if (hashCanonicalValue(request.commandId) !== id || request.intentHash !== hashCanonicalValue({ type: request.type, payload: request.payload })) throw fail('Job request integrity mismatch.');
      let outcome;
      try { outcome = await read(path.join(this.root, `${id}.result.json`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (outcome && outcome.intentHash !== request.intentHash) throw fail('Job result does not match its request.');
      if (outcome) {
        const { resultHash, ...body } = outcome;
        if (resultHash !== hashCanonicalValue(body)) throw fail('Job result integrity mismatch.');
      }
      rows.push({ ...request, ...outcome, state: outcome?.state ?? (this.active.has(id) ? 'running' : 'interrupted'),
        ...(outcome || this.active.has(id) ? {} : { error: { code: 'workbench-job-interrupted', message: 'Coordinator stopped or outcome is unconfirmed. Inspect Run history before explicitly submitting a new operation.' } }) });
    }
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async start({ commandId, type, payload }, execute) {
    if (typeof commandId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(commandId)) throw fail('Invalid command ID.');
    await this.assertStorage(true);
    const id = hashCanonicalValue(commandId), intentHash = hashCanonicalValue({ type, payload });
    const request = { id, commandId, type, payload, intentHash, session: this.session, createdAt: new Date().toISOString() };
    try { await publish(path.join(this.root, `${id}.request.json`), request); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await read(path.join(this.root, `${id}.request.json`));
      if (previous.intentHash !== intentHash) throw fail('Command ID was already used with different content.', 'command-id-conflict');
      return { id, commandId, appended: false };
    }
    const task = Promise.resolve().then(execute).then(
      result => ({ state: 'succeeded', result }),
      error => ({ state: 'failed', error: { code: error.code ?? 'workbench-operation-failed', message: error.message, ...(error.details ? { details: error.details } : {}) } })
    ).then(async outcome => {
      await this.assertStorage();
      const record = { ...outcome, intentHash, finishedAt: new Date().toISOString() };
      await publish(path.join(this.root, `${id}.result.json`), { ...record, resultHash: hashCanonicalValue(record) });
    }).finally(() => this.active.delete(id));
    // A failed publication remains an interrupted durable request; never report success.
    this.active.set(id, task);
    task.catch(() => {});
    return { id, commandId, appended: true };
  }
  async settle() { await Promise.allSettled([...this.active.values()]); }
}
