import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { FileOperationsExecutor } from '../src/adapters/file-operations-executor.js';
import { GitWorktreeAdapter } from '../src/adapters/git-worktree.js';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { startEditor } from '../src/editor/server.js';

// Explicit isolated media fixture: these inputs record the FWA workbench, not
// a game, live model output, or gameplay acceptance. Never touches user hosts.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(process.argv[i + 1], `Missing value for ${process.argv[i]}`);
  args.set(process.argv[i], path.resolve(process.argv[i + 1]));
}
for (const key of ['--fwe', '--browser', '--playwright', '--output', '--png', '--webm']) assert.ok(args.has(key), `Missing ${key}`);
const output = args.get('--output');
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(args.get('--playwright')).href);
const { expect } = await import(pathToFileURL(path.join(path.dirname(args.get('--playwright')), 'test.mjs')).href);
const temporaryParent = realpathSync.native(tmpdir()), prefix = 'fwa-artifact-media-';
const root = realpathSync.native(await mkdtemp(path.join(temporaryParent, prefix)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { ok: false, fixtureRoot: root, scope: 'FWA workbench screenshot and recording, NOT game media or gameplay acceptance',
  isolatedBrowser: true, uiWritesAllowed: false, checks: [], screenshots: [], errors: [] };
const pass = text => { report.checks.push(text); console.log(`PASS ${text}`); };
const git = command => {
  const result = spawnSync('git', command, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
async function stateSnapshot() {
  const files = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), stats = await lstat(file);
      assert.equal(stats.isSymbolicLink(), false, 'Fixture snapshot must not follow links');
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(root, file)] = { hash: digest(await readFile(file)), size: stats.size, mtimeMs: stats.mtimeMs };
    }
  }
  await visit(path.join(root, '.fwa')); return files;
}
let browser, context, editor, page;
try {
  const pngBytes = await readFile(args.get('--png')), webmBytes = await readFile(args.get('--webm'));
  assert.equal(pngBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(webmBytes.subarray(0, 4).toString('hex'), '1a45dfa3');
  report.sources = { png: { path: args.get('--png'), bytes: pngBytes.length, sha256: digest(pngBytes) },
    webm: { path: args.get('--webm'), bytes: webmBytes.length, sha256: digest(webmBytes) } };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'FWA Media Fixture']); git(['config', 'user.email', 'media@example.invalid']);
  const note = 'Synthetic artifact-browser fixture. Attached images and video capture the FWA workbench, not a game.\n';
  await writeFile(path.join(root, '.gitignore'), '.fwa/\n'); await writeFile(path.join(root, 'fixture-note.txt'), note);
  git(['add', '.']); git(['commit', '-m', 'test: isolated media fixture']); const baseline = git(['rev-parse', 'HEAD']);
  const application = new FwaApplication(root); await application.init(); const artifacts = new ArtifactStore(root);
  const png = await artifacts.put(pngBytes), webm = await artifacts.put(webmBytes);
  const mediaMetadata = { provenance: 'Actual FWA workbench UI capture from browser-final; not game media',
    workbenchScreenshotPng: png, workbenchRecordingWebm: webm };
  const ref = { id: 'ref://asset/workbench-media-fixture', kind: 'asset', uri: 'fixture-note.txt', version: 'fixture:v1',
    hash: `sha256:${digest(note)}`, metadata: mediaMetadata };
  await application.registerRef({ ref, commandId: 'register-media-fixture' });
  const { goal } = await application.createGoal({ title: '工作台媒体预览测试 · 非游戏验收', commandId: 'goal' });
  await application.loadPlan({ goalId: goal.id, commandId: 'plan', plan: { schemaVersion: 1, nodes: [{
    id: 'media-fixture', title: '工作台截图与录屏 · 非游戏产物', dependsOn: [], reads: [ref.id], writes: ['fixture-result.txt'],
    capabilities: ['file_operations'], acceptance: { checks: ['media browser only; not game acceptance'] },
    budget: { maxRetries: 0, maxFiles: 1, maxDiffLines: 10 }
  }] } });
  const fileExecutor = new FileOperationsExecutor();
  const executor = { schemaVersion: 1, id: 'deterministic-artifact-media-fixture', version: '1', capabilities: ['file_operations'],
    async execute(input) { return { ...(await fileExecutor.execute(input)), fixtureMedia: mediaMetadata }; } };
  const produced = await application.runNext({ nodeId: 'media-fixture', commandId: 'run', executor, workspace: new GitWorktreeAdapter(root),
    input: { schemaVersion: 1, operations: [{ type: 'write', path: 'fixture-result.txt', content: note }] } });
  assert.equal(produced.ok, true);
  const status = await application.getStatus(); assert.equal(status.runs.length, 1); assert.equal(status.integrations.length, 0);
  assert.equal(git(['rev-parse', 'HEAD']), baseline); assert.equal(git(['status', '--porcelain']), '');
  report.artifacts = { png, webm, execution: status.changeSets[0].executionArtifact };
  const before = await stateSnapshot();
  pass('real media bytes stored as immutable artifacts, explicitly authorized by fixture Ref metadata and reachable from a real execution record');
  editor = await startEditor({ projectRoot: root, fwePath: args.get('--fwe'), port: 0 });
  report.editor = { url: editor.url, readonly: true };
  browser = await chromium.launch({ executablePath: args.get('--browser'), headless: true });
  context = await browser.newContext({ viewport: { width: 1512, height: 1080 }, deviceScaleFactor: 1 });
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(editor.url); await expect(page.getByTestId('fwa-refresh')).toBeEnabled();
  await expect(page.getByText('只读预览', { exact: true })).toBeVisible();
  await writeFile(path.join(output, '01-navigation-dom.txt'), await page.getByTestId('fwa-console').ariaSnapshot());
  await page.getByTestId('fwa-dag').locator('[data-node-id="media-fixture"]').click();
  const technical = page.getByTestId('fwa-node-detail').locator('[data-fwa-node-technical]');
  await technical.locator(':scope > summary').click();
  const runPath = encodeURIComponent(`objects/runs/${encodeURIComponent(status.runs[0].id)}.json`);
  const runLink = technical.locator(`a.fwe-resource-link[href*=${JSON.stringify(runPath)}]`);
  await expect(runLink).toHaveCount(1); await runLink.click();
  const inspector = page.getByTestId('fwa-inspector');
  await writeFile(path.join(output, '02-run-dom.txt'), await inspector.ariaSnapshot());
  const executionLabel = `executionArtifact · ${status.changeSets[0].executionArtifact.size.toLocaleString()} B`;
  const executionLink = inspector.getByRole('button', { name: executionLabel, exact: true });
  assert.equal(await executionLink.count(), 1); await executionLink.click();
  await expect(inspector.getByTestId('fwa-artifact-text')).toBeVisible();
  await writeFile(path.join(output, '03-artifact-links-dom.txt'), await inspector.ariaSnapshot());
  const pngLink = inspector.getByRole('button', { name: `result.fixtureMedia.workbenchScreenshotPng · ${png.size.toLocaleString()} B`, exact: true });
  assert.equal(await pngLink.count(), 1); await pngLink.click();
  const image = inspector.getByTestId('fwa-artifact-media');
  await expect(image).toHaveCount(1);
  await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth > 0), { timeout: 15000 }).toBe(true);
  report.png = await image.evaluate(node => ({ tag: node.tagName, complete: node.complete, naturalWidth: node.naturalWidth,
    naturalHeight: node.naturalHeight, src: node.currentSrc }));
  assert.equal(report.png.tag, 'IMG'); assert.match(report.png.src, new RegExp(png.digest));
  await image.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, '01-png-artifact-preview.png'), fullPage: true });
  report.screenshots.push('01-png-artifact-preview.png'); pass('actual PNG artifact decoded through the existing execution-record UI');
  const videoLink = inspector.getByRole('button', { name: `result.fixtureMedia.workbenchRecordingWebm · ${webm.size.toLocaleString()} B`, exact: true });
  assert.equal(await videoLink.count(), 1); await videoLink.click();
  const video = inspector.getByTestId('fwa-artifact-media'); await expect(video).toHaveCount(1);
  const videoState = () => video.evaluate(node => ({ tag: node.tagName, videoWidth: node.videoWidth, videoHeight: node.videoHeight,
    readyState: node.readyState, duration: node.duration, currentTime: node.currentTime, paused: node.paused,
    error: node.error ? { code: node.error.code, message: node.error.message } : null, src: node.currentSrc,
    decodedFrames: node.getVideoPlaybackQuality?.().totalVideoFrames ?? null }));
  await expect.poll(async () => { const value = await videoState(); return value.videoWidth > 0 && value.readyState >= 1 && value.error === null; }, { timeout: 15000 }).toBe(true);
  report.webmMetadata = await videoState(); assert.equal(report.webmMetadata.tag, 'VIDEO'); assert.match(report.webmMetadata.src, new RegExp(webm.digest));
  await video.scrollIntoViewIfNeeded();
  await video.screenshot({ path: path.join(output, '02-webm-loaded.png') }); report.screenshots.push('02-webm-loaded.png');
  // Native controls are clicked, never JS play(), currentTime writes or synthetic events.
  const bounds = await video.boundingBox(); assert.ok(bounds && bounds.width > 60 && bounds.height > 50);
  // Chrome's observed native play triangle is above the bottom seek bar.
  await video.click({ position: { x: 24, y: bounds.height - 48 } });
  await expect.poll(async () => { const value = await videoState(); return value.currentTime > 0.2 && value.readyState >= 2 && value.error === null; }, { timeout: 10000 }).toBe(true);
  report.webmPlaying = await videoState(); assert.ok(report.webmPlaying.decodedFrames > 0);
  await page.screenshot({ path: path.join(output, '03-webm-playing.png'), fullPage: true }); report.screenshots.push('03-webm-playing.png');
  pass('actual WebM metadata loaded and native-control click advanced playback with decoded frames and no media error');
  assert.deepEqual(report.errors, []); assert.deepEqual(await stateSnapshot(), before);
  assert.equal(git(['rev-parse', 'HEAD']), baseline); assert.equal(git(['status', '--porcelain']), '');
  assert.equal(digest(await readFile(args.get('--png'))), report.sources.png.sha256);
  assert.equal(digest(await readFile(args.get('--webm'))), report.sources.webm.sha256);
  pass('browser inspection left all fixture state, host HEAD and original recording files unchanged'); report.ok = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack }; console.error(error); process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(path.join(output, 'failure-dom.txt'), await page.getByTestId('fwa-console').ariaSnapshot()).catch(() => {});
  }
} finally {
  await context?.close(); await browser?.close(); await editor?.close(); report.ownedServicesClosed = true;
  const actual = realpathSync.native(root), relative = path.relative(temporaryParent, actual);
  assert.ok(actual === root && relative.startsWith(prefix) && !relative.includes(path.sep) && !(await lstat(root)).isSymbolicLink(), 'Refuse cleanup outside owned temporary fixture');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.fixtureRemoved = true;
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(report, null, 2));
}
