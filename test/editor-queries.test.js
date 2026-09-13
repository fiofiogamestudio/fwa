import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { CommandEvaluator } from '../src/adapters/command-evaluator.js';
import { FileOperationsExecutor, FILE_OPERATIONS_CAPABILITY } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { CONSOLE_READ_LIMITS } from '../src/editor/console-queries.js';
import { startEditor } from '../src/editor/server.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwePath = path.resolve(process.env.FWA_TEST_FWE_PATH || path.join(repositoryRoot, '..', 'fwe'));
const integration = { skip: !existsSync(path.join(fwePath, 'src', 'server.js')) && 'Sibling FWE unavailable; set FWA_TEST_FWE_PATH for real HTTP integration.' };

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-console-query-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}
async function fixture(t) {
  const root = await temporary(t);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'FWA Query Test']);
  git(root, ['config', 'user.email', 'query@example.invalid']);
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n');
  await writeFile(path.join(root, 'seed.txt'), 'seed\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'test: query fixture']);
  const application = new FwaApplication(root);
  await application.init();
  const artifacts = new ArtifactStore(root);
  return { root, application, artifacts };
}
async function editor(t, root) {
  const instance = await startEditor({ projectRoot: root, fwePath, port: 0 });
  t.after(() => instance.close());
  return instance;
}
async function get(instance, route, options = {}) {
  const response = await fetch(instance.url + route, { signal: AbortSignal.timeout(15000), ...options });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes,
    body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : bytes.toString('utf8') };
}
function refRoute(id, raw = false) { return `/api/fwa/refs/content?id=${encodeURIComponent(id)}${raw ? '&raw=1' : ''}`; }
function artifactRoute(ref) { return `/api/fwa/artifacts?digest=${ref.digest}`; }

test('history-authorized image artifacts are immutable media previews and arbitrary raw files remain forbidden', integration, async t => {
  const { root, application, artifacts } = await fixture(t);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=', 'base64');
  const image = await artifacts.put(bytes), orphan = await artifacts.put(Buffer.from('unreachable'));
  const text = await artifacts.put('not executable media');
  await register(application, 'media-fixture', 'seed.txt', Buffer.from('seed\n'), { image, text });
  const instance = await editor(t, root);
  const preview = await get(instance, artifactRoute(image)); assert.equal(preview.status, 200); assert.equal(preview.body.format, 'image');
  const raw = await get(instance, preview.body.url); assert.equal(raw.status, 200); assert.deepEqual(raw.bytes, bytes);
  assert.equal(raw.headers.get('content-type'), 'image/png'); assert.match(raw.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await get(instance, artifactRoute(text) + '&raw=1')).status, 415);
  assert.equal((await get(instance, artifactRoute(orphan) + '&raw=1')).status, 404);
  assert.equal((await get(instance, artifactRoute(image) + '&raw=2')).status, 400);
});
async function register(application, id, uri, bytes, metadata = {}) {
  const ref = { id: `ref://asset/${id}`, kind: 'asset', uri, version: 'fixture:v1',
    hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, metadata };
  await application.registerRef({ ref, commandId: `register-${id}` });
  return ref;
}
async function stateSnapshot(root) {
  const entries = {};
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else {
        const stats = await lstat(file);
        entries[path.relative(root, file)] = { hash: createHash('sha256').update(await readFile(file)).digest('hex'),
          size: stats.size, mtimeMs: stats.mtimeMs, nlink: stats.nlink };
      }
    }
  }
  await visit(path.join(root, '.fwa'));
  return entries;
}

test('console events are paginated by global sequence, filter node relations and never rewrite state', integration, async (t) => {
  const { root, application } = await fixture(t);
  const { goal } = await application.createGoal({ title: 'Timeline', commandId: 'goal' });
  const node = (id, dependsOn) => ({ id, title: id, dependsOn, reads: ['seed.txt'], writes: [`${id}.txt`],
    capabilities: [FILE_OPERATIONS_CAPABILITY], acceptance: { checks: ['test'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 30 } });
  await application.loadPlan({ goalId: goal.id, commandId: 'plan', plan: { schemaVersion: 1, nodes: [node('first', []), node('second', ['first'])] } });
  const before = await stateSnapshot(root);
  const instance = await editor(t, root);
  const all = await application.listEvents();
  const first = await get(instance, '/api/fwa/events?after=0&limit=2');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.events, all.slice(0, 2));
  assert.equal(first.body.nextSequence, 2);
  assert.equal(first.body.hasMore, true);
  const rest = await get(instance, `/api/fwa/events?after=${first.body.nextSequence}&limit=100`);
  assert.deepEqual([...first.body.events, ...rest.body.events], all);
  assert.equal(rest.body.nextSequence, all.at(-1).sequence);
  assert.equal(rest.body.hasMore, false);
  const filtered = (await get(instance, '/api/fwa/events?nodeId=second&limit=1')).body;
  assert.equal(filtered.events[0].type, 'PlanLoaded');
  const last = (await get(instance, `/api/fwa/events?nodeId=second&after=${filtered.nextSequence}`)).body;
  assert.deepEqual(last.events.map((event) => event.type), ['NodePlanned']);
  assert.equal(last.nextSequence, all.at(-1).sequence, 'Cursor advances past unmatched events when caught up.');
  assert.equal((await get(instance, '/api/fwa/events?nodeId=missing')).status, 404);
  for (const query of ['after=-1', 'after=1.1', 'after=9007199254740992', 'limit=0', 'limit=501', 'after=0&after=1', 'path=../secret']) {
    assert.equal((await get(instance, `/api/fwa/events?${query}`)).status, 400, query);
  }
  assert.deepEqual(await stateSnapshot(root), before);
});

test('registered text and image previews are exact current bytes with explicit version/hash and sandboxed raw SVG', integration, async (t) => {
  const { root, application } = await fixture(t);
  await mkdir(path.join(root, 'brief'));
  const text = '# 原始文档\r\n<script>alert(1)</script>\r\n\r\n';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="5" height="5"/></svg>';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/fooAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, 'brief/design.md'), text);
  await writeFile(path.join(root, 'brief/flow.svg'), svg);
  await writeFile(path.join(root, 'brief/art.png'), png);
  const design = await register(application, 'design', 'brief/design.md', text);
  const flow = await register(application, 'flow', 'brief/flow.svg', svg);
  const art = await register(application, 'art', 'brief/art.png', png);
  const glob = await register(application, 'set', 'brief/**', 'set');
  const instance = await editor(t, root);
  const before = await stateSnapshot(root);
  const preview = await get(instance, refRoute(design.id));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.kind, 'text');
  assert.equal(preview.body.text, text, 'JSON text is not interpreted as HTML or normalized.');
  assert.equal(preview.body.matchesRegisteredHash, true);
  assert.match(preview.body.versionLabel, /Current workspace.*fixture:v1/);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  await writeFile(path.join(root, 'brief/design.md'), 'changed');
  const changed = (await get(instance, refRoute(design.id))).body;
  assert.equal(changed.text, 'changed');
  assert.equal(changed.matchesRegisteredHash, false);
  assert.equal(changed.ref.hash, design.hash, 'Preview must not refresh the registered Ref.');
  const image = (await get(instance, refRoute(art.id))).body;
  assert.equal(image.kind, 'image'); assert.equal(image.mime, 'image/png');
  assert.deepEqual((await get(instance, image.url)).bytes, png);
  await writeFile(path.join(root, 'brief/art.png'), Buffer.concat([png, Buffer.from('changed')]));
  assert.equal((await get(instance, image.url)).body.code, 'editor-resource-changed', 'Image bytes must stay bound to the metadata hash badge.');
  const rawSvg = await get(instance, refRoute(flow.id, true));
  assert.equal(rawSvg.status, 200); assert.equal(rawSvg.body, svg);
  assert.equal(rawSvg.headers.get('content-type'), 'image/svg+xml');
  assert.match(rawSvg.headers.get('content-security-policy'), /sandbox; default-src 'none'/);
  assert.equal(rawSvg.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(rawSvg.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get(instance, refRoute(glob.id))).body.kind, 'unsupported');
  assert.equal((await get(instance, refRoute(glob.id, true))).status, 415);
  assert.equal((await get(instance, refRoute(design.id, true))).status, 415);
  assert.deepEqual(await stateSnapshot(root), before);
});

test('Ref previews reject arbitrary paths, missing/linked files, binary data and oversize bodies', integration, async (t) => {
  const { root, application } = await fixture(t);
  const outside = await temporary(t);
  await writeFile(path.join(outside, 'secret.md'), 'outside secret');
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await register(application, 'linked', 'linked/secret.md', 'outside secret');
  const missing = await register(application, 'missing', 'missing.md', 'absent');
  await writeFile(path.join(root, 'big.md'), Buffer.alloc(CONSOLE_READ_LIMITS.textBytes + 1, 65));
  const big = await register(application, 'big', 'big.md', 'large');
  await writeFile(path.join(root, 'binary.md'), Buffer.from([0, 255, 240]));
  const binary = await register(application, 'binary', 'binary.md', 'binary');
  const instance = await editor(t, root);
  assert.equal((await get(instance, refRoute(linked.id))).status, 403);
  assert.equal((await get(instance, refRoute(missing.id))).status, 404);
  assert.equal((await get(instance, refRoute(big.id))).status, 413);
  assert.equal((await get(instance, refRoute(binary.id))).body.kind, 'unsupported');
  assert.equal((await get(instance, refRoute('ref://asset/unknown'))).status, 404);
  for (const suffix of ['?id=../secret.md', '?id=C%3A%2Fsecret.md', `?id=${encodeURIComponent(missing.id)}&path=../secret`, '?id=ref%3A%2F%2Fasset%2Fmissing&id=ref%3A%2F%2Fasset%2Flinked']) {
    assert.equal((await get(instance, `/api/fwa/refs/content${suffix}`)).status, 400);
  }
  assert.equal((await get(instance, refRoute(linked.id), { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal(await readFile(path.join(outside, 'secret.md'), 'utf8'), 'outside secret');
});

test('artifact previews require reachable verified references and leave published temp links untouched', integration, async (t) => {
  const { root, application, artifacts } = await fixture(t);
  const child = await artifacts.put('nested stdout\n');
  const parent = await artifacts.put(JSON.stringify({ stdoutArtifact: child }));
  const unrelated = await artifacts.put('unreferenced secret');
  await register(application, 'artifacts', 'seed.txt', 'seed\n', { resultArtifact: parent });
  const childPath = path.join(root, '.fwa/artifacts/sha256', child.digest.slice(0, 2), child.digest);
  const temporaryLink = path.join(path.dirname(childPath), `.artifact-${child.digest}-${randomUUID()}.tmp`);
  await link(childPath, temporaryLink);
  const before = await stateSnapshot(root);
  const instance = await editor(t, root);
  const result = await get(instance, artifactRoute(child));
  assert.equal(result.status, 200); assert.equal(result.body.text, 'nested stdout\n');
  assert.equal(result.body.size, child.size); assert.equal(result.body.format, 'text');
  assert.equal((await get(instance, artifactRoute(parent))).body.format, 'json');
  assert.equal((await get(instance, artifactRoute(unrelated))).status, 404);
  assert.equal((await get(instance, '/api/fwa/artifacts?digest=../seed.txt')).status, 400);
  assert.equal((await get(instance, `${artifactRoute(child)}&path=../secret`)).status, 400);
  assert.deepEqual(await stateSnapshot(root), before, 'Reads must not perform ArtifactStore recovery or acquire a lease.');
  await writeFile(childPath, 'tampered stdout');
  assert.equal((await get(instance, artifactRoute(child))).body.code, 'editor-artifact-corruption');
  await writeFile(childPath, 'nested stdout\n');
  await writeFile(path.join(root, '.fwa/artifacts/sha256', parent.digest.slice(0, 2), parent.digest), JSON.stringify({ stdoutArtifact: unrelated }));
  const rejected = await get(instance, artifactRoute(unrelated));
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'editor-artifact-corruption', 'Corrupt parent cannot authorize a new nested digest.');
});

test('real Git Run/evaluation events expose execution, diff and failing command stdout as read-only artifacts', integration, async (t) => {
  const { root, application } = await fixture(t);
  const { goal } = await application.createGoal({ title: 'Evidence chain', commandId: 'goal' });
  await application.loadPlan({ goalId: goal.id, commandId: 'plan', plan: { schemaVersion: 1, nodes: [{
    id: 'rules', title: 'Rules', dependsOn: [], reads: ['seed.txt'], writes: ['result.txt'], capabilities: [FILE_OPERATIONS_CAPABILITY],
    acceptance: { checks: ['test'] }, budget: { maxRetries: 1, maxFiles: 1, maxDiffLines: 30 }
  }] } });
  const workspace = new GitWorktreeAdapter(root);
  const produced = await application.runNext({ nodeId: 'rules', commandId: 'run', executor: new FileOperationsExecutor(), workspace,
    input: { schemaVersion: 1, operations: [{ type: 'write', path: 'result.txt', content: 'candidate\n' }] } });
  assert.equal(produced.ok, true);
  await application.evaluateChangeSet({ changeSetId: produced.changeSet.id, commandId: 'evaluate', workspace,
    evaluator: new CommandEvaluator(), profile: { schemaVersion: 1, id: 'query-evaluation', checks: [{ id: 'test', kind: 'test',
      command: process.execPath, args: ['-e', 'console.log("RULES_FAILED"); process.exit(7)'], timeoutMs: 10000, expectedExitCodes: [0] }] } });
  const status = await application.getStatus();
  assert.equal(status.nodes[0].status, 'rejected');
  const before = await stateSnapshot(root);
  const instance = await editor(t, root);
  const events = (await get(instance, '/api/fwa/events?nodeId=rules')).body.events;
  for (const type of ['NodePlanned', 'RunCreated', 'ChangeSetCaptured', 'EvidenceRecorded', 'NodeRejected']) {
    assert.ok(events.some((event) => event.type === type), type);
  }
  const changeSet = status.changeSets[0];
  assert.match((await get(instance, artifactRoute(changeSet.patchArtifact))).body.text, /\+candidate/);
  assert.equal((await get(instance, artifactRoute(changeSet.executionArtifact))).body.format, 'json');
  const evidence = status.evidence[0];
  assert.match((await get(instance, artifactRoute(evidence.criteria[0].stdoutArtifact))).body.text, /RULES_FAILED/);
  assert.equal((await get(instance, artifactRoute(evidence.resultArtifact))).body.format, 'json');
  assert.deepEqual(await stateSnapshot(root), before);
});

test('artifact previews verify full bytes before truncation and reject incorrect size, binary, oversized and linked artifacts', integration, async (t) => {
  const { root, application, artifacts } = await fixture(t);
  const long = await artifacts.put('x'.repeat(CONSOLE_READ_LIMITS.textBytes + 16));
  const binary = await artifacts.put(Buffer.from([0xff, 0, 1]));
  const tooBig = await artifacts.put('y'.repeat(CONSOLE_READ_LIMITS.fileBytes + 1));
  const wrong = await artifacts.put('correct hash, wrong claimed size');
  await register(application, 'bounded', 'seed.txt', 'seed\n', { artifacts: [long, binary, tooBig, { ...wrong, size: wrong.size + 1 }] });
  const instance = await editor(t, root);
  const result = await get(instance, artifactRoute(long));
  assert.equal(result.status, 200);
  assert.equal(result.body.size, CONSOLE_READ_LIMITS.textBytes + 16);
  assert.equal(result.body.text.length, CONSOLE_READ_LIMITS.textBytes);
  assert.equal(result.body.truncated, true);
  assert.equal((await get(instance, artifactRoute(binary))).status, 415);
  assert.equal((await get(instance, artifactRoute(tooBig))).status, 413);
  assert.equal((await get(instance, artifactRoute(wrong))).body.code, 'editor-artifact-corruption');

  // The registered digest stays the same; substituting a linked shard must
  // still fail even when the external file has the expected hash and size.
  const outside = await temporary(t);
  const shard = path.join(root, '.fwa/artifacts/sha256', binary.digest.slice(0, 2));
  await writeFile(path.join(outside, binary.digest), Buffer.from([0xff, 0, 1]));
  await rm(shard, { recursive: true }); // This exact shard belongs to this test's OS-temp fixture.
  await symlink(outside, shard, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await get(instance, artifactRoute(binary));
  assert.equal(linked.status, 403);
  assert.equal(linked.body.code, 'editor-unsafe-resource');
});

test('unrelated unreadable artifact roots do not hide a separately verified nested result', integration, async (t) => {
  const { root, application, artifacts } = await fixture(t);
  const child = await artifacts.put('independent valid stdout');
  const parent = await artifacts.put(JSON.stringify({ stdoutArtifact: child }));
  const damaged = await artifacts.put('damaged root');
  const oversized = { schemaVersion: 1, algorithm: 'sha256', digest: 'a'.repeat(64), size: CONSOLE_READ_LIMITS.fileBytes + 1 };
  await register(application, 'independent', 'seed.txt', 'seed\n', { artifacts: [parent, oversized, damaged] });
  await writeFile(path.join(root, '.fwa/artifacts/sha256', damaged.digest.slice(0, 2), damaged.digest), 'corruption');
  const before = await stateSnapshot(root);
  const instance = await editor(t, root);
  const result = await get(instance, artifactRoute(child));
  assert.equal(result.status, 200);
  assert.equal(result.body.text, 'independent valid stdout');
  assert.equal((await get(instance, artifactRoute(damaged))).body.code, 'editor-artifact-corruption');
  assert.equal((await get(instance, artifactRoute(oversized))).status, 413);
  assert.deepEqual(await stateSnapshot(root), before);
});
