#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FwaApplication } from '../src/application/fwa-application.js';
import { loadProject } from '../src/application/project.js';
import { loadReviewConfig } from '../src/application/review-config.js';

const defaultPackageRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: start.bat [--project <initialized project>] [--fwe-path <FWE checkout>] [--port 0..65535] [--no-open] [--check] [--allow-write] [--review-config <trusted JSON>]';

async function statOrNull(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 20000
  });
  if (result.error || result.status !== 0) throw new Error(`Git failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function selectLaunch(args, { packageRoot = defaultPackageRoot, cwd = process.cwd() } = {}) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (values.has(option)) throw new Error(`Repeated option: ${option}. ${usage}`);
    if (['--project', '--fwe-path', '--port', '--review-config'].includes(option)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}. ${usage}`);
      values.set(option, value);
    } else if (['--no-open', '--check', '--allow-write'].includes(option)) values.set(option, true);
    else throw new Error(`Unknown option: ${option}. ${usage}`);
  }
  const rawPort = values.get('--port') ?? '0';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  const demo = !values.has('--project');
  return {
    packageRoot: path.resolve(packageRoot),
    projectRoot: demo ? path.resolve(packageRoot, '.local', 'demo') : path.resolve(cwd, values.get('--project')),
    fwePath: values.has('--fwe-path') ? path.resolve(cwd, values.get('--fwe-path')) : path.resolve(packageRoot, '..', 'fwe'),
    ...(values.has('--review-config') ? { reviewConfig: path.resolve(cwd, values.get('--review-config')) } : {}),
    demo, port: Number(rawPort), open: !values.has('--no-open'), check: values.has('--check'),
    allowWrite: demo || values.has('--allow-write')
  };
}

async function checkDemoLocation(selection) {
  const root = await realpath(selection.packageRoot);
  const local = path.join(root, '.local');
  if (path.resolve(selection.projectRoot) !== path.join(root, '.local', 'demo')) {
    throw new Error('Demo initialization is restricted to this FWA checkout\'s .local/demo directory.');
  }
  for (const directory of [local, selection.projectRoot]) {
    const info = await statOrNull(directory);
    if (info && (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory)) {
      throw new Error(`Demo path must be a real directory without redirection: ${directory}`);
    }
  }
  return local;
}

export async function checkLaunch(selection) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 10)) throw new Error('Node.js 20.10 or newer is required.');
  git(selection.packageRoot, ['--version']);
  const metadata = JSON.parse(await readFile(path.join(selection.fwePath, 'package.json'), 'utf8'));
  if (metadata.name !== 'fwe' || metadata.version !== '0.2.0') throw new Error('Select a compatible FWE 0.2.0 checkout with --fwe-path.');
  await access(path.join(selection.fwePath, 'src', 'server.js'));
  if (selection.demo) await checkDemoLocation(selection);
  const existing = Boolean(await statOrNull(selection.projectRoot));
  if (!selection.demo || existing) loadProject(selection.projectRoot);
  const review = selection.reviewConfig ? await loadReviewConfig(selection.reviewConfig) : null;
  return { ...selection, createDemo: selection.demo && !existing,
    review: review ? { configured: true, targetRef: review.targetRef, validationProfiles: review.validationProfiles.map(profile => ({ id: profile.id, criteria: profile.checks.map(check => check.id) })) }
      : { configured: false, setup: 'Add --review-config <trusted JSON> to validate, accept, adopt and revert candidates. See docs/change-review.md.' } };
}

export async function prepareDemo(selection) {
  if (!selection.demo) throw new Error('Only the bundled demo can be initialized by this launcher.');
  const local = await checkDemoLocation(selection);
  if (await statOrNull(selection.projectRoot)) {
    loadProject(selection.projectRoot);
    return false;
  }
  await mkdir(local, { recursive: true });
  await checkDemoLocation(selection);
  // Exclusive directory creation prevents a second launcher from overwriting a demo.
  await mkdir(selection.projectRoot);
  try {
    await writeFile(path.join(selection.projectRoot, '.gitignore'), '/.fwa/\n', { flag: 'wx' });
    await writeFile(path.join(selection.projectRoot, 'README.md'), [
      '# FWA demo', '',
      'This isolated workspace is created by the FWA launcher. Your goals, imported references and work history are retained between launches.',
      'Plan and Work require an installed, configured Codex CLI. Opening this page does not start either action.', ''
    ].join('\n'), { flag: 'wx' });
    git(selection.projectRoot, ['init', '-b', 'main']);
    git(selection.projectRoot, ['config', 'user.name', 'FWA Local Demo']);
    git(selection.projectRoot, ['config', 'user.email', 'fwa-demo@example.invalid']);
    git(selection.projectRoot, ['config', 'core.fsmonitor', 'false']);
    git(selection.projectRoot, ['add', '.gitignore', 'README.md']);
    git(selection.projectRoot, ['-c', 'core.hooksPath=', 'commit', '--no-gpg-sign', '-m', 'Initialize FWA local demo']);
    await new FwaApplication(selection.projectRoot).init();
    return true;
  } catch (error) {
    throw new Error(`Demo creation stopped; existing files were retained at ${selection.projectRoot}. Inspect that directory before retrying. ${error.message}`, { cause: error });
  }
}

export async function launchEditor(args, options = {}) {
  const selection = await checkLaunch(selectLaunch(args, options));
  if (selection.check) return selection;
  if (selection.createDemo) await prepareDemo(selection);
  const { startEditor } = await import('../src/editor/server.js');
  return startEditor({ projectRoot: selection.projectRoot, fwePath: selection.fwePath,
    port: selection.port, open: selection.open, allowWrite: selection.allowWrite, signal: options.signal,
    ...(selection.reviewConfig ? { reviewConfig: selection.reviewConfig } : {}) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    if (process.argv.slice(2).some(value => ['--help', '-h'].includes(value))) {
      process.stdout.write(`${usage}\nNo arguments: open the persistent local demo at .local/demo.\n`);
    } else {
      const result = await launchEditor(process.argv.slice(2), { signal: controller.signal });
      process.stdout.write(`${JSON.stringify(result.check ? result : {
        url: result.url, projectRoot: result.projectRoot, allowWrite: result.allowWrite, fwePath: result.fwePath
      }, null, 2)}\n`);
      if (result.closed) await result.closed;
    }
  } catch (error) {
    process.stderr.write(`FWA launcher: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
