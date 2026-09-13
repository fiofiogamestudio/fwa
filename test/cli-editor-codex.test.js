import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';

async function fixture(t) {
  const root = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'fwa-cli-native-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function invoke(root, args) {
  const calls = []; let stdout = ''; let stderr = '';
  const signal = new AbortController().signal;
  const code = await runCli(['editor', '--fwe-path', root, '--project', root, '--json', ...args], {
    cwd: root, signal, stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } },
    startEditor: async (options) => {
      calls.push(options);
      return { ...options, projectId: 'project-test', protocol: 'fwa-console-v1', fingerprint: 'a'.repeat(64),
        url: 'http://127.0.0.1:3220', closed: Promise.resolve() };
    }
  });
  return { code, stdout, stderr, calls, signal };
}

test('editor passes only canonical executable selection to both default workflow adapters', async (t) => {
  const root = await fixture(t);
  const result = await invoke(root, ['--allow-write', '--codex-path', process.execPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].workflow, { codexOptions: { executable: realpathSync.native(process.execPath) } });
  assert.equal(result.calls[0].projectRoot, root);
  assert.equal(result.calls[0].allowWrite, true);
  assert.equal(result.calls[0].signal, result.signal);
  assert.equal(JSON.parse(result.stdout).codexPath, realpathSync.native(process.execPath));
});

test('editor without codex-path preserves adapter defaults and read-only launch', async (t) => {
  const root = await fixture(t);
  const result = await invoke(root, []);
  assert.equal(result.code, 0);
  assert.equal(result.calls[0].allowWrite, false);
  assert.equal(Object.hasOwn(result.calls[0], 'workflow'), false);
  assert.equal(Object.hasOwn(JSON.parse(result.stdout), 'codexPath'), false);
});

test('editor rejects relative, wrapper, absent and directory executables before starting', async (t) => {
  const root = await fixture(t);
  const folder = path.join(root, 'directory.exe'); await mkdir(folder);
  const wrapper = path.join(root, 'codex.cmd'); await writeFile(wrapper, '@echo off\n');
  for (const value of ['codex.exe', wrapper, path.join(root, 'codex.bat'), path.join(root, 'absent.exe'), folder,
    ...(process.platform === 'win32' ? ['\\root-relative.exe'] : [])]) {
    const result = await invoke(root, ['--codex-path', value]);
    assert.notEqual(result.code, 0, value);
    assert.equal(result.calls.length, 0, value);
    const report = JSON.parse(result.stderr || result.stdout);
    assert.equal(report.error.code, 'invalid-codex-path');
  }
});

test('editor rejects executable paths reached through directory links', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'native'); await mkdir(target);
  await writeFile(path.join(target, 'codex.exe'), 'fixture-not-executed');
  const linked = path.join(root, 'linked');
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await invoke(root, ['--codex-path', path.join(linked, 'codex.exe')]);
  assert.notEqual(result.code, 0);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr || result.stdout, /symbolic links or junctions/);
});
