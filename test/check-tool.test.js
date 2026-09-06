import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectJavaScriptFiles } from '../tools/check.js';

test('syntax discovery includes module variants and nested executable examples', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-check-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of ['bin', 'src', 'test', 'tools', 'examples/nested']) {
    await mkdir(path.join(root, relative), { recursive: true });
  }
  const included = ['src/main.js', 'tools/live.mjs', 'examples/nested/run.cjs'];
  for (const relative of [...included, 'tools/notes.md', 'examples/input.json']) {
    await writeFile(path.join(root, relative), '', 'utf8');
  }
  assert.deepEqual(
    await collectJavaScriptFiles(root),
    included.map((relative) => path.normalize(relative)).sort()
  );
});

test('the real live validator and executable onboarding examples are syntax-check targets', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = await collectJavaScriptFiles(root);
  for (const relative of [
    'tools/validate-v01-live.mjs',
    'examples/basic/run.mjs',
    'examples/unity/generate-profile.mjs'
  ]) assert.ok(files.includes(path.normalize(relative)), `${relative} is missing`);
});
