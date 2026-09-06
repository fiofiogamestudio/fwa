#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODEX_CODE_EDIT_CAPABILITY,
  FILE_OPERATIONS_CAPABILITY,
  CodexExecutor,
  CommandEvaluator,
  FileOperationsExecutor,
  FwaApplication,
  GitIntegrationAdapter,
  GitIntegrationWorkspaceAdapter,
  GitWorktreeAdapter,
  createUnityEvaluatorProfile
} from '../src/index.js';
import { LiveUnityRetryEvaluator } from './live-unity-retry.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FWA_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const ZERO_HASH = `sha256:${'0'.repeat(64)}`;
const SOURCE_REF_ID = 'ref://code/live-counter';
const FEATURE_FILES = Object.freeze([
  'Assets/Scripts/FwaLiveCounter.cs',
  'Assets/Tests/EditMode/FwaLiveCounterTests.cs'
]);
const PRE_INTEGRATION_CONSUMER_FILE = 'Documentation/fwa-live-old-ref-consumer.txt';
const CONSUMER_FILE = 'Documentation/fwa-live-consumer.txt';
const DEFAULT_CODEX_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_COMPILE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_EDITMODE_TIMEOUT_MS = 20 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const PROCESS_EXIT_CODES = Object.freeze(Array.from({ length: 256 }, (_, index) => index));
const UNITY_VERSION_PATTERN = /^\d+\.\d+\.\d+[a-z]\d+(?:[a-z]\d+)*$/iu;
let commandSequence = 0;

const HELP = `FWA V0.1 live composition validation

Usage:
  node tools/validate-v01-live.mjs --unity <absolute-editor-path> [options]

Required:
  --unity <path>                 Unity editor executable. Env: FWA_UNITY_PATH

Options:
  --unity-version <version>      Project version; otherwise inferred from the editor path
                                 Env: FWA_UNITY_VERSION
  --codex <path-or-name>         Codex executable override. Env: FWA_CODEX_PATH
  --model <model>                Codex model override. Env: FWA_CODEX_MODEL
  --ignore-user-config           Pass ignoreUserConfig=true to CodexExecutor
                                 Env: FWA_CODEX_IGNORE_USER_CONFIG=1
  --windows-elevated             Explicitly request the Windows elevated sandbox override
                                 Env: FWA_CODEX_WINDOWS_ELEVATED=1
  --output-dir <directory>       Parent for a unique retained run directory
                                 Env: FWA_LIVE_OUTPUT_DIR; default: OS temp directory
  --test-framework-version <v>   Unity Test Framework package version; default: 1.1.33
  --codex-timeout-ms <ms>        Default: ${DEFAULT_CODEX_TIMEOUT_MS}
  --compile-timeout-ms <ms>      Default: ${DEFAULT_COMPILE_TIMEOUT_MS}
  --editmode-timeout-ms <ms>     Default: ${DEFAULT_EDITMODE_TIMEOUT_MS}
  --editmode-no-batch            Omit -batchmode for EditMode tests on affected Unity hosts
                                 Env: FWA_UNITY_EDITMODE_NO_BATCH=1
  --help                         Show this help

The run directory is deliberately retained. It contains the temporary Git/Unity
project, FWA's append-only store and artifacts, plus evidence/summary.json.
These files can contain local paths, model output, command output, and Unity logs;
treat the retained directory as sensitive local engineering evidence.
The script refuses an output directory inside the FWA source tree.
`;

function fail(message, code = 'FWA_LIVE_VALIDATION_FAILED', details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function invariant(condition, message, details = undefined) {
  if (!condition) fail(message, 'FWA_LIVE_ASSERTION_FAILED', details);
}

function sameJson(actual, expected, message) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  invariant(left === right, message, { actual, expected });
}

function errorJson(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' ? error.code : null,
    message: typeof error?.message === 'string' ? error.message : String(error),
    details: error?.details ?? null,
    stack: typeof error?.stack === 'string' ? error.stack : null
  };
}

function commandCheckDiagnostics(result) {
  return result.checks.map((check) => ({
    id: check.id,
    args: [...check.args],
    passed: check.passed,
    exitCode: check.exitCode,
    signal: check.signal,
    timedOut: check.timedOut,
    terminationConfirmed: check.terminationConfirmed,
    failure: check.failure,
    stdoutTail: check.stdout.slice(-4_096),
    stderrTail: check.stderr.slice(-4_096)
  }));
}

function envFlag(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return false;
  if (['1', 'true', 'yes'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(value.toLowerCase())) return false;
  fail(`${name} must be one of 1, 0, true, false, yes, or no.`, 'FWA_LIVE_INVALID_OPTION');
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${name} must be a positive safe integer.`, 'FWA_LIVE_INVALID_OPTION');
  }
  return parsed;
}

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set();
  const valueOptions = new Set([
    '--unity',
    '--unity-version',
    '--codex',
    '--model',
    '--output-dir',
    '--test-framework-version',
    '--codex-timeout-ms',
    '--compile-timeout-ms',
    '--editmode-timeout-ms'
  ]);
  const flagOptions = new Set([
    '--ignore-user-config',
    '--windows-elevated',
    '--editmode-no-batch',
    '--help'
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (flagOptions.has(option)) {
      if (flags.has(option)) fail(`Duplicate option ${option}.`, 'FWA_LIVE_INVALID_OPTION');
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) {
      fail(`Unknown option ${option}.`, 'FWA_LIVE_INVALID_OPTION');
    }
    if (values.has(option)) fail(`Duplicate option ${option}.`, 'FWA_LIVE_INVALID_OPTION');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`Option ${option} requires a value.`, 'FWA_LIVE_INVALID_OPTION');
    }
    values.set(option, value);
    index += 1;
  }

  if (flags.has('--help')) return { help: true };
  const editorPath = values.get('--unity') ?? process.env.FWA_UNITY_PATH;
  if (typeof editorPath !== 'string' || editorPath.trim() === '') {
    fail('Unity editor path is required via --unity or FWA_UNITY_PATH.', 'FWA_LIVE_INVALID_OPTION');
  }

  return {
    help: false,
    editorPath: path.resolve(editorPath),
    unityVersion: values.get('--unity-version') ?? process.env.FWA_UNITY_VERSION ?? null,
    codexPath: values.get('--codex') ?? process.env.FWA_CODEX_PATH ?? null,
    model: values.get('--model') ?? process.env.FWA_CODEX_MODEL ?? null,
    ignoreUserConfig: flags.has('--ignore-user-config')
      || envFlag('FWA_CODEX_IGNORE_USER_CONFIG'),
    windowsElevated: flags.has('--windows-elevated')
      || envFlag('FWA_CODEX_WINDOWS_ELEVATED'),
    editModeBatchMode: !(flags.has('--editmode-no-batch')
      || envFlag('FWA_UNITY_EDITMODE_NO_BATCH')),
    outputDirectory: path.resolve(
      values.get('--output-dir') ?? process.env.FWA_LIVE_OUTPUT_DIR ?? os.tmpdir()
    ),
    testFrameworkVersion: values.get('--test-framework-version')
      ?? process.env.FWA_UNITY_TEST_FRAMEWORK_VERSION
      ?? '1.1.33',
    codexTimeoutMs: positiveInteger(
      values.get('--codex-timeout-ms'),
      '--codex-timeout-ms',
      DEFAULT_CODEX_TIMEOUT_MS
    ),
    compileTimeoutMs: positiveInteger(
      values.get('--compile-timeout-ms'),
      '--compile-timeout-ms',
      DEFAULT_COMPILE_TIMEOUT_MS
    ),
    editModeTimeoutMs: positiveInteger(
      values.get('--editmode-timeout-ms'),
      '--editmode-timeout-ms',
      DEFAULT_EDITMODE_TIMEOUT_MS
    )
  };
}

function portableRelative(parent, child) {
  return path.relative(parent, child).split(path.sep).join('/');
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function canonicalProspectivePath(targetPath) {
  let cursor = path.resolve(targetPath);
  const missingSegments = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(cursor);
      return path.resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function requireFile(targetPath, label) {
  let information;
  try {
    information = await stat(targetPath);
  } catch (error) {
    fail(`${label} does not exist: ${targetPath}`, 'FWA_LIVE_INVALID_OPTION', {
      cause: errorJson(error)
    });
  }
  invariant(information.isFile(), `${label} must be a file: ${targetPath}`);
  return realpath(targetPath);
}

function inferUnityVersion(editorPath) {
  const segments = path.resolve(editorPath).split(path.sep).reverse();
  const match = segments.find((segment) => UNITY_VERSION_PATTERN.test(segment));
  return match ?? null;
}

async function readUnityProjectVersion(projectRoot) {
  const versionPath = path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt');
  const source = await readFile(versionPath, 'utf8');
  const version = /^m_EditorVersion:\s*(\S+)\s*$/mu.exec(source)?.[1] ?? null;
  const versionWithRevision = /^m_EditorVersionWithRevision:\s*(.+?)\s*$/mu
    .exec(source)?.[1] ?? null;
  invariant(
    typeof version === 'string' && UNITY_VERSION_PATTERN.test(version),
    'Unity created an invalid ProjectVersion.txt.',
    { versionPath, version }
  );
  invariant(
    typeof versionWithRevision === 'string'
      && versionWithRevision.startsWith(`${version} (`)
      && versionWithRevision.endsWith(')'),
    'Unity ProjectVersion.txt does not bind the editor revision.',
    { versionPath, version, versionWithRevision }
  );
  return { version, versionWithRevision };
}

async function runCommand(command, args, {
  cwd,
  allowedExitCodes = [0],
  timeoutMs = COMMAND_TIMEOUT_MS
} = {}) {
  const workspaceRoot = path.resolve(cwd ?? process.cwd());
  commandSequence += 1;
  const evaluation = await new CommandEvaluator({
    outputLimitBytes: COMMAND_OUTPUT_LIMIT_BYTES
  }).evaluate({
    workspaceRoot,
    manifest: {
      schemaVersion: 1,
      id: `fwa-v01-live-command-${commandSequence}`,
      checks: [{
        id: 'command',
        kind: 'command',
        command,
        args: [...args],
        cwd: '.',
        timeoutMs,
        expectedExitCodes: [...allowedExitCodes],
        expectedArtifacts: []
      }]
    }
  });
  const check = evaluation.checks[0];
  const result = {
    command,
    args: [...args],
    cwd: workspaceRoot,
    exitCode: check.exitCode,
    signal: check.signal,
    timedOut: check.timedOut,
    terminationConfirmed: check.terminationConfirmed,
    stdout: check.stdout,
    stderr: check.stderr
  };
  if (!check.passed) {
    const error = new Error(
      `${command} ${args.join(' ')} failed: ${check.failure?.message ?? 'unknown failure'}`
    );
    error.code = check.failure?.code === 'PROCESS_TERMINATION_UNCONFIRMED'
      ? 'FWA_LIVE_COMMAND_TERMINATION_UNCONFIRMED'
      : 'FWA_LIVE_COMMAND_FAILED';
    error.details = { ...result, failure: check.failure };
    throw error;
  }
  return result;
}

async function git(cwd, args, options = {}) {
  return runCommand('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, ...options });
}

async function gitLine(cwd, args) {
  return (await git(cwd, args)).stdout.trim();
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) files.push(portableRelative(root, absolute));
  }
  return files;
}

async function sourceSnapshot() {
  const sourceRoot = path.join(FWA_ROOT, 'src');
  const sourceFiles = (await walkFiles(sourceRoot))
    .filter((file) => file.endsWith('.js'))
    .map((file) => `src/${file}`);
  const files = [
    ...sourceFiles,
    'package.json',
    'tools/live-unity-retry.js',
    'tools/validate-v01-live.mjs'
  ].sort();
  const entries = [];
  for (const file of files) {
    const bytes = await readFile(path.join(FWA_ROOT, file));
    entries.push({
      path: file,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(entries))
    .digest('hex');
  return { algorithm: 'sha256', digest, files: entries };
}

async function hostGitSnapshot() {
  const topLevel = await runCommand(
    'git',
    ['-c', 'core.fsmonitor=false', '-C', FWA_ROOT, 'rev-parse', '--show-toplevel'],
    { allowedExitCodes: [0, 128] }
  );
  if (topLevel.exitCode !== 0) return { available: false };
  const root = topLevel.stdout.trim();
  const [revision, statusResult] = await Promise.all([
    runCommand('git', [
      '-c', 'core.fsmonitor=false', '-C', root, 'rev-parse', 'HEAD'
    ], { allowedExitCodes: [0, 128] }),
    runCommand('git', [
      '-c', 'core.fsmonitor=false', '-C', root,
      'status', '--porcelain=v1', '--untracked-files=all'
    ])
  ]);
  return {
    available: true,
    root,
    revision: revision.exitCode === 0 ? revision.stdout.trim() : null,
    status: statusResult.stdout
  };
}

async function fileFingerprint(targetPath) {
  try {
    const bytes = await readFile(targetPath);
    return {
      exists: true,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, size: null, sha256: null };
    throw error;
  }
}

function codexConfigPath() {
  const home = process.env.CODEX_HOME;
  return path.join(home ? path.resolve(home) : path.join(os.homedir(), '.codex'), 'config.toml');
}

function packageManifest(testFrameworkVersion) {
  return `${JSON.stringify({
    dependencies: {
      'com.unity.test-framework': testFrameworkVersion,
      'com.unity.modules.ai': '1.0.0',
      'com.unity.modules.androidjni': '1.0.0',
      'com.unity.modules.animation': '1.0.0',
      'com.unity.modules.assetbundle': '1.0.0',
      'com.unity.modules.audio': '1.0.0',
      'com.unity.modules.cloth': '1.0.0',
      'com.unity.modules.director': '1.0.0',
      'com.unity.modules.imageconversion': '1.0.0',
      'com.unity.modules.imgui': '1.0.0',
      'com.unity.modules.jsonserialize': '1.0.0',
      'com.unity.modules.particlesystem': '1.0.0',
      'com.unity.modules.physics': '1.0.0',
      'com.unity.modules.physics2d': '1.0.0',
      'com.unity.modules.screencapture': '1.0.0',
      'com.unity.modules.terrain': '1.0.0',
      'com.unity.modules.terrainphysics': '1.0.0',
      'com.unity.modules.tilemap': '1.0.0',
      'com.unity.modules.ui': '1.0.0',
      'com.unity.modules.uielements': '1.0.0',
      'com.unity.modules.umbra': '1.0.0',
      'com.unity.modules.unityanalytics': '1.0.0',
      'com.unity.modules.unitywebrequest': '1.0.0',
      'com.unity.modules.unitywebrequestassetbundle': '1.0.0',
      'com.unity.modules.unitywebrequestaudio': '1.0.0',
      'com.unity.modules.unitywebrequesttexture': '1.0.0',
      'com.unity.modules.unitywebrequestwww': '1.0.0',
      'com.unity.modules.vehicles': '1.0.0',
      'com.unity.modules.video': '1.0.0',
      'com.unity.modules.vr': '1.0.0',
      'com.unity.modules.wind': '1.0.0',
      'com.unity.modules.xr': '1.0.0'
    }
  }, null, 2)}\n`;
}

async function scaffoldUnityProject(projectRoot, testFrameworkVersion) {
  const testsRoot = path.join(projectRoot, 'Assets', 'Tests', 'EditMode');
  const scriptsRoot = path.join(projectRoot, 'Assets', 'Scripts');
  const editorRoot = path.join(projectRoot, 'Assets', 'Editor');
  await mkdir(scriptsRoot, { recursive: true });
  await mkdir(testsRoot, { recursive: true });
  await mkdir(editorRoot, { recursive: true });
  await mkdir(path.join(projectRoot, 'Packages'), { recursive: true });
  await mkdir(path.join(projectRoot, 'ProjectSettings'), { recursive: true });

  await Promise.all([
    writeFile(path.join(projectRoot, '.gitignore'), [
      '/.fwa/',
      '/[Ll]ibrary/',
      '/[Tt]emp/',
      '/[Oo]bj/',
      '/[Ll]ogs/',
      '/[Uu]ser[Ss]ettings/',
      '*.csproj',
      '*.sln',
      '*.userprefs',
      ''
    ].join('\n'), 'utf8'),
    writeFile(
      path.join(projectRoot, 'Packages', 'manifest.json'),
      packageManifest(testFrameworkVersion),
      'utf8'
    ),
    writeFile(
      path.join(editorRoot, 'FwaLiveProjectNormalizer.cs'),
      [
        'using UnityEditor;',
        '',
        'namespace Fwa.LiveValidation',
        '{',
        '    public static class FwaLiveProjectNormalizer',
        '    {',
        '        public static void Normalize()',
        '        {',
        '            var runInBackground = PlayerSettings.runInBackground;',
        '            PlayerSettings.runInBackground = runInBackground;',
        '            AssetDatabase.SaveAssets();',
        '        }',
        '    }',
        '}',
        ''
      ].join('\n'),
      'utf8'
    ),
    writeFile(
      path.join(scriptsRoot, 'Fwa.Live.asmdef'),
      `${JSON.stringify({
        name: 'Fwa.Live',
        rootNamespace: 'Fwa.Live',
        references: [],
        includePlatforms: [],
        excludePlatforms: [],
        allowUnsafeCode: false,
        overrideReferences: false,
        precompiledReferences: [],
        autoReferenced: true,
        defineConstraints: [],
        versionDefines: [],
        noEngineReferences: false
      }, null, 2)}\n`,
      'utf8'
    ),
    writeFile(
      path.join(scriptsRoot, 'FwaLiveBaseline.cs'),
      [
        'namespace Fwa.Live',
        '{',
        '    public static class FwaLiveBaseline',
        '    {',
        '        public static bool IsReady => true;',
        '    }',
        '}',
        ''
      ].join('\n'),
      'utf8'
    ),
    writeFile(
      path.join(testsRoot, 'Fwa.LiveValidation.EditMode.Tests.asmdef'),
      `${JSON.stringify({
        name: 'Fwa.LiveValidation.EditMode.Tests',
        rootNamespace: 'Fwa.Live.Tests',
        references: ['Fwa.Live'],
        includePlatforms: ['Editor'],
        excludePlatforms: [],
        allowUnsafeCode: false,
        overrideReferences: false,
        precompiledReferences: [],
        autoReferenced: true,
        defineConstraints: [],
        versionDefines: [],
        noEngineReferences: false,
        optionalUnityReferences: ['TestAssemblies']
      }, null, 2)}\n`,
      'utf8'
    ),
    writeFile(
      path.join(testsRoot, 'FwaLiveBaselineTests.cs'),
      [
        'using NUnit.Framework;',
        'using Fwa.Live;',
        '',
        'namespace Fwa.Live.Tests',
        '{',
        '    public sealed class FwaLiveBaselineTests',
        '    {',
        '        [Test]',
        '        public void BaselineRemainsRunnableAfterRevert()',
        '        {',
        '            Assert.That(FwaLiveBaseline.IsReady, Is.True);',
        '        }',
        '    }',
        '}',
        ''
      ].join('\n'),
      'utf8'
    ),
    writeFile(
      path.join(projectRoot, 'fwa-live-seed.txt'),
      'FWA V0.1 live validation seed\n',
      'utf8'
    )
  ]);
}

function codexPrompt() {
  return `Implement exactly the following bounded Unity EditMode test change.

Create only these two files and do not modify or create any other file:

1. Assets/Scripts/FwaLiveCounter.cs

namespace Fwa.Live
{
    public static class FwaLiveCounter
    {
        public static int Next(int value)
        {
            return checked(value + 1);
        }
    }
}

2. Assets/Tests/EditMode/FwaLiveCounterTests.cs

using NUnit.Framework;
using Fwa.Live;

namespace Fwa.Live.Tests
{
    public sealed class FwaLiveCounterTests
    {
        [Test]
        public void NextIncrementsOneStep()
        {
            Assert.That(FwaLiveCounter.Next(41), Is.EqualTo(42));
        }
    }
}

Use UTF-8 text and LF line endings. Do not run Unity. Do not edit metadata,
project settings, package files, ignore files, or documentation. Finish with a
concise summary after creating the two files.`;
}

function summarizeCriterion(criterion) {
  return {
    id: criterion.id,
    kind: criterion.kind,
    result: criterion.result,
    exitCode: criterion.exitCode,
    durationMs: criterion.durationMs,
    timedOut: criterion.timedOut,
    terminationConfirmed: criterion.terminationConfirmed,
    expectedArtifacts: criterion.expectedArtifacts.map((artifact) => ({
      path: artifact.path,
      size: artifact.size,
      digest: artifact.digest,
      passed: artifact.failure === null,
      artifact: artifact.artifact ?? null
    }))
  };
}

function summarizeEvidence(evidence) {
  return {
    id: evidence.id,
    evaluationId: evidence.evaluationId,
    changeSetId: evidence.changeSetId,
    result: evidence.result,
    evaluator: evidence.evaluator,
    profile: evidence.profile,
    environmentFingerprint: evidence.environmentFingerprint,
    criteria: evidence.criteria.map(summarizeCriterion),
    policyViolations: evidence.policyViolations
  };
}

function summarizeRegression(evidence) {
  return {
    integrationId: evidence.integrationId,
    result: evidence.result,
    regressionResult: evidence.regressionResult,
    evaluator: evidence.evaluator,
    profile: evidence.profile,
    environmentFingerprint: evidence.environmentFingerprint,
    criteria: evidence.criteria.map(summarizeCriterion),
    policyViolations: evidence.policyViolations,
    cleanup: evidence.cleanup
  };
}

function nunitCounts(xml) {
  const root = /<(test-run|test-results)\b([^>]*)>/iu.exec(xml);
  if (!root) return null;
  const attributes = Object.create(null);
  for (const match of root[2].matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*["']([^"']*)["']/gu)) {
    attributes[match[1].toLowerCase()] = match[2];
  }
  return {
    root: root[1].toLowerCase(),
    total: Number(attributes.total),
    passed: attributes.passed === undefined ? null : Number(attributes.passed),
    failed: attributes.failed === undefined ? null : Number(attributes.failed),
    errors: attributes.errors === undefined ? null : Number(attributes.errors),
    failures: attributes.failures === undefined ? null : Number(attributes.failures),
    skipped: attributes.skipped === undefined ? null : Number(attributes.skipped),
    inconclusive: attributes.inconclusive === undefined
      ? null
      : Number(attributes.inconclusive),
    notRun: attributes['not-run'] === undefined ? null : Number(attributes['not-run'])
  };
}

async function nunitSummary(app, evidence) {
  const criterion = evidence.criteria.find((candidate) => candidate.id === 'unity-editmode-tests');
  const artifact = criterion?.expectedArtifacts?.[0]?.artifact;
  invariant(artifact !== undefined && artifact !== null, 'Unity Evidence has no NUnit artifact.');
  const xml = (await app.artifacts.get(artifact)).toString('utf8');
  const counts = nunitCounts(xml);
  invariant(counts !== null && counts.total > 0, 'Unity NUnit report has no positive test count.', {
    counts
  });
  return { ...counts, artifact };
}

function assertExactPassingNunit(counts, expectedTotal, label) {
  invariant(counts.total === expectedTotal, `${label} ran an unexpected number of tests.`, {
    expectedTotal,
    counts
  });
  if (counts.root === 'test-run') {
    invariant(
      counts.passed === expectedTotal
        && counts.failed === 0
        && (counts.skipped === null || counts.skipped === 0)
        && (counts.inconclusive === null || counts.inconclusive === 0),
      `${label} did not execute and pass every expected test.`,
      { expectedTotal, counts }
    );
    return;
  }
  invariant(
    counts.errors === 0
      && counts.failures === 0
      && counts.notRun === 0,
    `${label} did not execute and pass every expected test.`,
    { expectedTotal, counts }
  );
}

async function executionSummary(app, changeSet) {
  const bytes = await app.artifacts.get(changeSet.executionArtifact);
  const envelope = JSON.parse(bytes.toString('utf8'));
  const result = envelope.result;
  invariant(result?.ok === true, 'Codex execution artifact does not contain a successful result.');
  return {
    artifact: changeSet.executionArtifact,
    executor: result.executor,
    codex: result.codex,
    process: result.process,
    usage: result.usage,
    jsonlEventCount: result.jsonl?.eventCount ?? null
  };
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function successMarkdown(summary) {
  const sourceTests = summary.sourceEvaluation.nunit;
  const consumerTests = summary.consumer.nunit;
  const staleIds = [summary.final.oldRefConsumerNode, summary.final.consumerNode]
    .filter((node) => node.validity === 'stale')
    .map((node) => node.id);
  const timeline = summary.timeline.map((entry) => (
    `| ${markdownCell(entry.name)} | ${entry.result} | ${entry.durationMs} |`
  )).join('\n');
  return `# FWA V0.1 live composition validation

- Result: **PASS**
- Run root: \`${summary.runRoot}\`
- Temporary project: \`${summary.projectRoot}\`
- FWA source SHA-256: \`${summary.source.snapshot.digest}\`
- Unity: \`${summary.environment.unityProjectVersion.versionWithRevision}\`
- Codex executor: \`${summary.codex.executor.id}@${summary.codex.executor.version}\`
- Final Git revision: \`${summary.final.targetRevision}\`
- Unity command attempts retained: ${summary.unityAttempts.length}
- Shared Codex config changed during run: ${summary.source.codexConfig.changedDuringRun} (observation only; not attributed to FWA)

## Proven outcomes

- Real Codex produced exactly: ${summary.sourceRun.changedFiles.map((file) => `\`${file}\``).join(', ')}.
- Source Unity evaluation passed ${sourceTests.passed ?? sourceTests.total}/${sourceTests.total} NUnit tests.
- Gated source integration reran ${summary.sourceIntegration.nunit.passed ?? summary.sourceIntegration.nunit.total}/${summary.sourceIntegration.nunit.total} tests, produced \`${summary.sourceIntegration.integratedRevision}\`, and advanced ${summary.sourceIntegration.changedRefIds.map((id) => `\`${id}\``).join(', ')}.
- Source integration made the materialized old-version Ref consumer \`${summary.oldRefConsumer.nodeId}\` stale.
- Materialized consumer Unity evaluation passed ${consumerTests.passed ?? consumerTests.total}/${consumerTests.total} NUnit tests.
- Gated revert kept ${summary.reversion.nunit.passed ?? summary.reversion.nunit.total}/${summary.reversion.nunit.total} baseline tests passing and produced \`${summary.reversion.candidateRevision}\` without erasing the source commit.
- Stale Nodes: ${staleIds.map((id) => `\`${id}\``).join(', ')}.
- Final FWA verification: operationally clean, ${summary.final.verification.artifactCount} artifacts checked.

## Phase timings

| Phase | Result | Duration (ms) |
| --- | --- | ---: |
${timeline}

The complete machine-readable result is in \`summary.json\`; the append-only
history and final projection are in \`events.json\` and \`final-status.json\`.
The retained run is sensitive local engineering evidence and should not be
published without review and redaction.
`;
}

function failureMarkdown(failure) {
  const timeline = failure.timeline.map((entry) => (
    `| ${markdownCell(entry.name)} | ${entry.result} | ${entry.durationMs} |`
  )).join('\n');
  return `# FWA V0.1 live composition validation

- Result: **FAIL**
- Failed phase: \`${failure.activePhase}\`
- Run root: \`${failure.runRoot}\`
- Error code: \`${failure.error.code ?? 'none'}\`
- Error: ${failure.error.message}

## Phase timings

| Phase | Result | Duration (ms) |
| --- | --- | ---: |
${timeline}

See \`failure.json\` for the structured error, assertion details, source
snapshot and host-state snapshot. The temporary project is retained for
inspection. The retained run is sensitive local engineering evidence and
should not be published without review and redaction.
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  options.editorPath = await requireFile(options.editorPath, 'Unity editor');
  const unityVersion = options.unityVersion ?? inferUnityVersion(options.editorPath);
  invariant(
    typeof unityVersion === 'string' && UNITY_VERSION_PATTERN.test(unityVersion),
    'Unity version could not be inferred; pass --unity-version.',
    { editorPath: options.editorPath }
  );
  invariant(
    typeof options.testFrameworkVersion === 'string'
      && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(options.testFrameworkVersion),
    'Unity Test Framework version is invalid.'
  );
  if (options.windowsElevated) {
    invariant(
      process.platform === 'win32',
      '--windows-elevated is only valid on Windows.'
    );
  }

  const canonicalFwaRoot = await realpath(FWA_ROOT);
  const prospectiveOutput = await canonicalProspectivePath(options.outputDirectory);
  invariant(
    !isWithin(canonicalFwaRoot, prospectiveOutput),
    'The live-validation output directory must be outside the FWA source tree.',
    { fwaRoot: canonicalFwaRoot, outputDirectory: prospectiveOutput }
  );
  await mkdir(options.outputDirectory, { recursive: true });
  const canonicalOutput = await realpath(options.outputDirectory);
  invariant(
    !isWithin(canonicalFwaRoot, canonicalOutput),
    'The live-validation output directory must be outside the FWA source tree.',
    { fwaRoot: canonicalFwaRoot, outputDirectory: canonicalOutput }
  );
  const runRoot = await mkdtemp(path.join(canonicalOutput, 'fwa-v01-live-'));
  const projectRoot = path.join(runRoot, 'project');
  const evidenceRoot = path.join(runRoot, 'evidence');
  const unityAttemptRoot = path.join(evidenceRoot, 'unity-attempts');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(unityAttemptRoot, { recursive: true });

  const timeline = [];
  let activePhase = 'initialization';
  const unityAttempts = [];
  let unityAttemptSequence = 0;
  const writeUnityAttempt = async (record) => {
    unityAttemptSequence += 1;
    const sequence = unityAttemptSequence;
    const profileId = typeof record?.result?.manifest?.id === 'string'
      ? record.result.manifest.id
      : null;
    const safeLabel = (profileId ?? activePhase)
      .replaceAll(/[^A-Za-z0-9._-]/gu, '-')
      .slice(0, 80) || 'unknown';
    const filename = `${String(sequence).padStart(3, '0')}-${safeLabel}-attempt-${record.attempt}.json`;
    const targetPath = path.join(unityAttemptRoot, filename);
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(targetPath, serialized, { encoding: 'utf8', flag: 'wx' });
    unityAttempts.push({
      sequence,
      phase: activePhase,
      profileId,
      attempt: record.attempt,
      maxAttempts: record.maxAttempts,
      outcome: record.outcome,
      retryEligible: record.retryEligible,
      retryPermitted: record.retryPermitted,
      nextBackoffMs: record.nextBackoffMs,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      path: portableRelative(runRoot, targetPath),
      size: Buffer.byteLength(serialized),
      sha256: createHash('sha256').update(serialized).digest('hex'),
      checks: Array.isArray(record?.result?.checks)
        ? record.result.checks.map((check) => ({
          id: check.id,
          status: check.status,
          passed: check.passed,
          exitCode: check.exitCode,
          signal: check.signal,
          timedOut: check.timedOut,
          terminationConfirmed: check.terminationConfirmed,
          failureCode: check.failure?.code ?? null
        }))
        : null,
      error: record.error
    });
  };
  const evaluator = new LiveUnityRetryEvaluator(
    new CommandEvaluator({ id: 'fwa-v01-live-unity-evaluator', version: '1' }),
    { writeAttempt: writeUnityAttempt }
  );
  const executePhase = async (name, operation) => {
    activePhase = name;
    const startedAt = new Date();
    process.stderr.write(`[fwa-v01-live] ${name}\n`);
    try {
      const value = await operation();
      timeline.push({
        name,
        result: 'pass',
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime()
      });
      return value;
    } catch (error) {
      timeline.push({
        name,
        result: 'fail',
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        error: errorJson(error)
      });
      throw error;
    }
  };

  const startedAt = new Date();
  let sourceBefore = null;
  let hostGitBefore = null;
  let codexConfigBefore = null;
  let codexConfigAfter = null;
  let unityProjectVersion = null;
  let baselinePurityCleanup = null;
  try {
    [sourceBefore, hostGitBefore, codexConfigBefore] = await executePhase(
      'snapshot-fwa-and-host-state',
      () => Promise.all([
        sourceSnapshot(),
        hostGitSnapshot(),
        fileFingerprint(codexConfigPath())
      ])
    );

    await executePhase('create-temporary-unity-project', async () => {
      await runCommand(options.editorPath, [
        '-batchmode',
        '-nographics',
        '-forgetProjectPath',
        '-quit',
        '-createProject',
        projectRoot,
        '-logFile',
        '-'
      ], {
        cwd: projectRoot,
        timeoutMs: options.compileTimeoutMs
      });
    });
    unityProjectVersion = await executePhase('verify-created-unity-version', async () => {
      const observed = await readUnityProjectVersion(projectRoot);
      invariant(
        observed.version === unityVersion,
        'Created Unity project version differs from the requested editor version.',
        { requested: unityVersion, observed }
      );
      return observed;
    });
    await executePhase('scaffold-temporary-unity-project', async () => {
      await scaffoldUnityProject(projectRoot, options.testFrameworkVersion);
    });
    await executePhase('serialize-temporary-unity-settings', async () => {
      await runCommand(options.editorPath, [
        '-batchmode',
        '-nographics',
        '-forgetProjectPath',
        '-projectPath',
        projectRoot,
        '-executeMethod',
        'Fwa.LiveValidation.FwaLiveProjectNormalizer.Normalize',
        '-logFile',
        '-',
        '-quit'
      ], {
        cwd: projectRoot,
        timeoutMs: options.compileTimeoutMs
      });
      await Promise.all([
        rm(path.join(projectRoot, 'Assets', 'Editor'), {
          recursive: true,
          force: true
        }),
        rm(path.join(projectRoot, 'Assets', 'Editor.meta'), { force: true })
      ]);
    });
    const baselineProfile = await executePhase(
      'normalize-temporary-unity-project',
      async () => {
        const createdProfile = await createUnityEvaluatorProfile({
          projectRoot,
          editorPath: options.editorPath,
          profileId: 'fwa-v01-live-unity-baseline',
          compileTimeoutMs: options.compileTimeoutMs,
          editModeTimeoutMs: options.editModeTimeoutMs,
          editModeBatchMode: options.editModeBatchMode,
          editModeNoGraphics: false,
          testResultsPath: 'Library/fwa-v01-live-baseline-results.xml'
        });
        const result = await evaluator.evaluate({
          workspaceRoot: projectRoot,
          manifest: createdProfile
        });
        invariant(result.passed, 'Unity could not normalize the temporary baseline.', {
          checks: commandCheckDiagnostics(result)
        });
        return createdProfile;
      }
    );
    await executePhase('initialize-temporary-git-baseline', async () => {
      await git(projectRoot, ['init', '-b', 'main']);
      await git(projectRoot, ['config', 'user.name', 'FWA V0.1 Live Validation']);
      await git(projectRoot, ['config', 'user.email', 'fwa-v01-live@example.invalid']);
      await git(projectRoot, ['config', 'core.ignorecase', 'false']);
      await git(projectRoot, ['config', 'core.autocrlf', 'false']);
      await git(projectRoot, ['config', 'core.fsmonitor', 'false']);
      await git(projectRoot, ['add', '-A', '--', '.']);
      await git(projectRoot, [
        'commit', '--no-gpg-sign', '-m', 'test: establish FWA V0.1 Unity baseline'
      ]);
    });
    await executePhase('verify-temporary-unity-baseline-purity', async () => {
      const purityWorkspace = path.join(runRoot, 'baseline-purity-worktree');
      await git(projectRoot, ['worktree', 'add', '--detach', purityWorkspace, 'HEAD']);
      const canonicalRunRoot = path.resolve(await realpath(runRoot));
      const canonicalPurityWorkspace = path.resolve(await realpath(purityWorkspace));
      const [runRootIdentity, purityWorkspaceIdentity] = await Promise.all([
        lstat(canonicalRunRoot),
        lstat(canonicalPurityWorkspace)
      ]);
      invariant(
        runRootIdentity.isDirectory()
          && !runRootIdentity.isSymbolicLink()
          && purityWorkspaceIdentity.isDirectory()
          && !purityWorkspaceIdentity.isSymbolicLink()
          && !samePath(canonicalRunRoot, canonicalPurityWorkspace)
          && samePath(path.dirname(canonicalPurityWorkspace), canonicalRunRoot)
          && samePath(canonicalPurityWorkspace, purityWorkspace),
        'Baseline-purity worktree is not the exact real directory owned by this run.',
        { runRoot: canonicalRunRoot, purityWorkspace, canonicalPurityWorkspace }
      );
      const cleanupIdentity = {
        parentDevice: runRootIdentity.dev,
        parentInode: runRootIdentity.ino,
        workspaceDevice: purityWorkspaceIdentity.dev,
        workspaceInode: purityWorkspaceIdentity.ino
      };
      try {
        const result = await evaluator.evaluate({
          workspaceRoot: purityWorkspace,
          manifest: baselineProfile
        });
        invariant(result.passed, 'Normalized Unity baseline failed in a fresh worktree.', {
          checks: commandCheckDiagnostics(result)
        });
        const status = await git(
          purityWorkspace,
          ['status', '--porcelain=v1', '--untracked-files=all']
        );
        invariant(
          status.stdout.trim().length === 0,
          'Normalized Unity baseline is not clean after fresh-worktree evaluation.',
          { status: status.stdout }
        );
      } finally {
        const removal = await git(
          projectRoot,
          ['worktree', 'remove', '--force', purityWorkspace],
          { allowedExitCodes: PROCESS_EXIT_CODES }
        );
        const registrationAfterGitRemoval = await git(
          projectRoot,
          ['worktree', 'list', '--porcelain']
        );
        const normalizedPurityWorkspace = path.resolve(purityWorkspace)
          .replaceAll('\\', '/')
          .toLowerCase();
        const registeredAfterGitRemoval = registrationAfterGitRemoval.stdout
          .split(/\r?\n/u)
          .filter((line) => line.startsWith('worktree '))
          .map((line) => line.slice('worktree '.length).replaceAll('\\', '/').toLowerCase())
          .includes(normalizedPurityWorkspace);
        baselinePurityCleanup = {
          workspacePath: purityWorkspace,
          gitRemovalExitCode: removal.exitCode,
          filesystemFallbackUsed: false,
          physicalPathRemoved: !await pathExists(purityWorkspace),
          registrationRemoved: !registeredAfterGitRemoval,
          cleanupIdentity
        };
        invariant(
          !registeredAfterGitRemoval,
          'Git retained the baseline-purity worktree registration after removal.',
          { purityWorkspace, removal, worktreeList: registrationAfterGitRemoval.stdout }
        );
        if (await pathExists(purityWorkspace)) {
          const resolvedRunRoot = path.resolve(await realpath(runRoot));
          const resolvedPurityWorkspace = path.resolve(purityWorkspace);
          const [parentMetadata, metadata] = await Promise.all([
            lstat(resolvedRunRoot),
            lstat(resolvedPurityWorkspace)
          ]);
          invariant(
            parentMetadata.isDirectory()
              && !parentMetadata.isSymbolicLink()
              && metadata.isDirectory()
              && !metadata.isSymbolicLink()
              && parentMetadata.dev === cleanupIdentity.parentDevice
              && parentMetadata.ino === cleanupIdentity.parentInode
              && metadata.dev === cleanupIdentity.workspaceDevice
              && metadata.ino === cleanupIdentity.workspaceInode,
            'Baseline-purity cleanup fallback refuses a replaced directory.',
            { purityWorkspace, cleanupIdentity }
          );
          const currentCanonicalPurityWorkspace = path.resolve(
            await realpath(resolvedPurityWorkspace)
          );
          invariant(
            !samePath(resolvedRunRoot, currentCanonicalPurityWorkspace)
              && isWithin(resolvedRunRoot, currentCanonicalPurityWorkspace)
              && samePath(path.dirname(currentCanonicalPurityWorkspace), resolvedRunRoot)
              && samePath(currentCanonicalPurityWorkspace, resolvedPurityWorkspace)
              && samePath(currentCanonicalPurityWorkspace, canonicalPurityWorkspace),
            'Baseline-purity cleanup fallback target is outside its exact owned directory.',
            {
              runRoot: resolvedRunRoot,
              purityWorkspace,
              canonicalPurityWorkspace: currentCanonicalPurityWorkspace
            }
          );
          await rm(currentCanonicalPurityWorkspace, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100
          });
          baselinePurityCleanup.filesystemFallbackUsed = true;
        }
        await git(projectRoot, ['worktree', 'prune']);
        const worktreeList = await git(projectRoot, ['worktree', 'list', '--porcelain']);
        const registeredWorktrees = worktreeList.stdout
          .split(/\r?\n/u)
          .filter((line) => line.startsWith('worktree '))
          .map((line) => line.slice('worktree '.length).replaceAll('\\', '/').toLowerCase());
        baselinePurityCleanup.physicalPathRemoved = !await pathExists(purityWorkspace);
        baselinePurityCleanup.registrationRemoved = !registeredWorktrees.includes(
          normalizedPurityWorkspace
        );
        invariant(
          baselinePurityCleanup.physicalPathRemoved,
          'Baseline-purity worktree still exists after removal.',
          { purityWorkspace, baselinePurityCleanup }
        );
        invariant(
          baselinePurityCleanup.registrationRemoved,
          'Baseline-purity Git worktree registration remains after removal.',
          { purityWorkspace, worktreeList: worktreeList.stdout, baselinePurityCleanup }
        );
      }
    });
    const baseRevision = await gitLine(projectRoot, ['rev-parse', 'HEAD']);

    const app = new FwaApplication(projectRoot, { actor: 'v01-live-validator' });
    const evaluationWorkspace = new GitWorktreeAdapter(projectRoot);
    const candidateWorkspace = new GitIntegrationWorkspaceAdapter(projectRoot);
    const promotion = new GitIntegrationAdapter(projectRoot);
    const codex = new CodexExecutor({
      ...(options.codexPath === null ? {} : { executable: options.codexPath }),
      timeoutMs: options.codexTimeoutMs
    });
    const fileOperations = new FileOperationsExecutor();

    await executePhase('initialize-fwa-and-register-ref', async () => {
      await app.init();
      await app.registerRef({
        commandId: 'live-register-source-ref',
        ref: {
          id: SOURCE_REF_ID,
          kind: 'code',
          uri: FEATURE_FILES[0],
          version: 'absent-at-baseline',
          hash: ZERO_HASH,
          metadata: { purpose: 'FWA V0.1 live validation source' }
        }
      });
    });

    const profile = await executePhase('create-real-unity-profile', () => (
      createUnityEvaluatorProfile({
        projectRoot,
        editorPath: options.editorPath,
        profileId: 'fwa-v01-live-unity',
        compileTimeoutMs: options.compileTimeoutMs,
        editModeTimeoutMs: options.editModeTimeoutMs,
        editModeBatchMode: options.editModeBatchMode,
        editModeNoGraphics: false,
        testResultsPath: 'Library/fwa-v01-live-editmode-results.xml'
      })
    ));
    const acceptanceChecks = profile.checks.map((check) => check.id);

    const oldRefConsumerGoal = await executePhase(
      'create-old-ref-consumer-probe',
      async () => {
        const created = await app.createGoal({
          title: 'Materialize a consumer of the baseline Ref version',
          request: 'Record one bounded consumer before the source Ref advances.',
          commandId: 'live-create-old-ref-consumer-goal'
        });
        await app.loadPlan({
          goalId: created.goal.id,
          commandId: 'live-load-old-ref-consumer-plan',
          plan: {
            schemaVersion: 1,
            id: 'fwa-v01-live-old-ref-consumer-plan',
            nodes: [{
              id: 'old-ref-consumer',
              title: 'Materialize the baseline source Ref version',
              dependsOn: [],
              reads: [SOURCE_REF_ID],
              writes: [PRE_INTEGRATION_CONSUMER_FILE],
              capabilities: [FILE_OPERATIONS_CAPABILITY],
              acceptance: { checks: acceptanceChecks },
              budget: {
                maxRetries: 1,
                maxFiles: 1,
                maxDiffLines: 20,
                wallTimeMinutes: 20
              }
            }]
          }
        });
        return created;
      }
    );
    const refBeforeSource = (await app.getStatus()).refs.find((ref) => ref.id === SOURCE_REF_ID);
    invariant(refBeforeSource?.version === 'absent-at-baseline', 'Baseline Ref version changed early.');
    const oldRefConsumerRun = await executePhase(
      'materialize-consumer-of-old-ref-version',
      () => app.runNext({
        executor: fileOperations,
        workspace: evaluationWorkspace,
        nodeId: 'old-ref-consumer',
        baseRevision: 'main',
        input: {
          schemaVersion: 1,
          operations: [{
            type: 'write',
            path: PRE_INTEGRATION_CONSUMER_FILE,
            content: [
              'FWA V0.1 pre-integration logical Ref consumer',
              `ref=${SOURCE_REF_ID}`,
              `version=${refBeforeSource.version}`,
              `hash=${refBeforeSource.hash}`,
              ''
            ].join('\n')
          }]
        },
        commandId: 'live-run-old-ref-consumer'
      })
    );
    invariant(oldRefConsumerRun.ok === true, 'Old-Ref consumer Run did not succeed.');
    invariant(oldRefConsumerRun.run.status === 'produced', 'Old-Ref consumer is not materialized.');
    const oldRefSnapshot = oldRefConsumerRun.run.effects.consumedRefs.find(
      (ref) => ref.id === SOURCE_REF_ID
    );
    invariant(
      oldRefSnapshot?.version === refBeforeSource.version
        && oldRefSnapshot.hash === refBeforeSource.hash,
      'Old-Ref consumer did not snapshot the baseline Ref version.',
      { expected: refBeforeSource, actual: oldRefSnapshot ?? null }
    );
    sameJson(
      oldRefConsumerRun.changeSet.changedFiles,
      [PRE_INTEGRATION_CONSUMER_FILE],
      'Old-Ref consumer changed wrong files.'
    );
    invariant(oldRefConsumerRun.cleanup.worktreeRemoved, 'Old-Ref consumer worktree was not removed.');
    invariant(oldRefConsumerRun.cleanup.leaseReleased, 'Old-Ref consumer lease was not released.');

    const goal = await executePhase('create-goal-and-manual-dag', async () => {
      const created = await app.createGoal({
        title: 'Validate the complete FWA V0.1 Unity slice',
        request: 'Use real Codex and Unity, integrate, materialize a Ref consumer, then revert.',
        commandId: 'live-create-goal'
      });
      await app.loadPlan({
        goalId: created.goal.id,
        commandId: 'live-load-plan',
        plan: {
          schemaVersion: 1,
          id: 'fwa-v01-live-manual-plan',
          nodes: [{
            id: 'codex-source',
            title: 'Create a tested counter through Codex',
            dependsOn: [],
            reads: ['fwa-live-seed.txt'],
            writes: [SOURCE_REF_ID, FEATURE_FILES[1]],
            capabilities: [CODEX_CODE_EDIT_CAPABILITY],
            acceptance: { checks: acceptanceChecks },
            budget: {
              maxRetries: 1,
              maxFiles: 2,
              maxDiffLines: 120,
              wallTimeMinutes: 20
            }
          }, {
            id: 'materialized-consumer',
            title: 'Materialize one consumer of the source Ref',
            dependsOn: ['codex-source'],
            reads: [SOURCE_REF_ID],
            writes: [CONSUMER_FILE],
            capabilities: [FILE_OPERATIONS_CAPABILITY],
            acceptance: { checks: acceptanceChecks },
            budget: {
              maxRetries: 1,
              maxFiles: 1,
              maxDiffLines: 20,
              wallTimeMinutes: 20
            }
          }]
        }
      });
      return created;
    });

    const sourceRun = await executePhase('run-real-codex-in-isolated-worktree', () => (
      app.runNext({
        executor: codex,
        workspace: evaluationWorkspace,
        nodeId: 'codex-source',
        baseRevision: 'main',
        input: {
          schemaVersion: 1,
          prompt: codexPrompt(),
          ...(options.model === null ? {} : { model: options.model }),
          ignoreUserConfig: options.ignoreUserConfig,
          ...(options.windowsElevated
            ? { windowsSandboxOverride: 'elevated' }
            : {})
        },
        commandId: 'live-run-codex-source'
      })
    ));
    invariant(sourceRun.ok === true, 'Codex Run did not succeed.', sourceRun);
    invariant(sourceRun.node.id === 'codex-source', 'Codex Run selected the wrong Node.');
    invariant(sourceRun.run.status === 'produced', 'Codex Run was not recorded as produced.');
    invariant(sourceRun.changeSet.valid === true, 'Codex ChangeSet is invalid.', {
      violations: sourceRun.changeSet.violations
    });
    sameJson(
      sourceRun.changeSet.changedFiles,
      [...FEATURE_FILES],
      'Codex changed files outside the declared two-file boundary.'
    );
    invariant(sourceRun.cleanup.worktreeRemoved, 'Codex Run worktree was not removed.');
    invariant(sourceRun.cleanup.leaseReleased, 'Codex Run lease was not released.');
    invariant(
      await gitLine(projectRoot, ['rev-parse', 'HEAD']) === baseRevision,
      'The isolated Codex Run moved the target branch.'
    );
    const codexExecution = await executionSummary(app, sourceRun.changeSet);
    invariant(
      codexExecution.executor?.id === 'codex'
        && codexExecution.process?.exitCode === 0
        && codexExecution.process.signal === null
        && codexExecution.process.terminationConfirmed === true
        && codexExecution.process.timedOut === false
        && codexExecution.jsonlEventCount > 0,
      'Codex execution metadata does not prove a clean real process completion.',
      { codexExecution }
    );
    invariant(
      codexExecution.codex?.shell === false
        && typeof codexExecution.codex.cwd === 'string'
        && codexExecution.codex.cwd !== projectRoot
        && isWithin(projectRoot, codexExecution.codex.cwd)
        && await pathExists(codexExecution.codex.cwd) === false,
      'Codex execution metadata does not prove an isolated removed worktree.',
      { invocation: codexExecution.codex }
    );
    invariant(
      codexExecution.codex.ignoreUserConfig === options.ignoreUserConfig
        && codexExecution.codex.windowsSandboxOverride === (
          options.windowsElevated ? 'elevated' : null
        ),
      'Codex invocation did not preserve the explicit configuration and sandbox choices.',
      { invocation: codexExecution.codex, options }
    );

    const sourceEvaluationPhase = await executePhase(
      'evaluate-source-with-real-unity',
      async () => {
        const evaluation = await app.evaluateChangeSet({
        changeSetId: sourceRun.changeSet.id,
        profile,
        evaluator,
        workspace: evaluationWorkspace,
        commandId: 'live-evaluate-codex-source'
        });
        invariant(evaluation.ok === true, 'Source Unity evaluation did not pass.', {
          evidence: evaluation.evidence ? summarizeEvidence(evaluation.evidence) : null,
          cleanup: evaluation.cleanup ?? null
        });
        invariant(evaluation.evidence.result === 'pass', 'Source Evidence is not passing.');
        invariant(
          evaluation.evidence.criteria.every((criterion) => criterion.result === 'pass'),
          'At least one source Unity criterion failed.'
        );
        const nunit = await nunitSummary(app, evaluation.evidence);
        assertExactPassingNunit(nunit, 2, 'Source Unity evaluation');
        return { evaluation, nunit };
      }
    );
    const sourceEvaluation = sourceEvaluationPhase.evaluation;
    const sourceNunit = sourceEvaluationPhase.nunit;

    const sourceIntegration = await executePhase('gated-integrate-source', () => (
      app.integrateChangeSetGated({
        changeSetId: sourceRun.changeSet.id,
        targetRef: 'main',
        candidateWorkspace,
        promotion,
        evaluator,
        profile,
        evaluationWorkspace,
        commandId: 'live-gated-integrate-source'
      })
    ));
    invariant(sourceIntegration.ok === true, 'Gated source integration did not pass.', {
      integration: sourceIntegration.integration,
      cleanup: sourceIntegration.cleanup
    });
    invariant(sourceIntegration.integration.status === 'integrated', 'Source is not integrated.');
    invariant(
      sourceIntegration.integration.regressionEvidence?.result === 'pass',
      'Source integration has no passing regression Evidence.'
    );
    invariant(
      sourceIntegration.integration.regressionEvidence?.cleanup?.status === 'succeeded',
      'Source integration regression workspace cleanup was not proven.'
    );
    invariant(
      sourceIntegration.cleanup.candidateWorkspaceRemoved === true,
      'Source integration candidate worktree was not removed.'
    );
    const sourceIntegrationNunit = await nunitSummary(
      app,
      sourceIntegration.integration.regressionEvidence
    );
    assertExactPassingNunit(sourceIntegrationNunit, 2, 'Source integration regression gate');
    const sourceRevision = sourceIntegration.integration.integratedRevision;
    invariant(
      await gitLine(projectRoot, ['rev-parse', 'refs/heads/main']) === sourceRevision,
      'Source integration did not become the target revision.'
    );
    const afterSource = await app.getStatus();
    const sourceRefAfterIntegration = afterSource.refs.find((ref) => ref.id === SOURCE_REF_ID);
    const oldRefConsumerAfterIntegration = afterSource.nodes.find(
      (node) => node.id === 'old-ref-consumer'
    );
    const consumerReady = afterSource.nodes.find((node) => node.id === 'materialized-consumer');
    invariant(sourceRefAfterIntegration?.version === sourceRevision, 'Source Ref did not advance.');
    invariant(sourceRefAfterIntegration.hash !== ZERO_HASH, 'Source Ref hash did not advance.');
    sameJson(
      sourceIntegration.integration.changedRefIds,
      [SOURCE_REF_ID],
      'Source Integration advanced the wrong logical Refs.'
    );
    invariant(
      oldRefConsumerAfterIntegration?.validity === 'stale',
      'Materialized consumer of the old Ref version was not made stale.'
    );
    invariant(
      oldRefConsumerAfterIntegration.staleByIntegrationIds?.includes(
        sourceIntegration.integration.id
      ),
      'Old-Ref consumer does not identify the Integration that made it stale.'
    );
    sameJson(
      sourceIntegration.integration.affectedNodeIds,
      ['old-ref-consumer'],
      'Source Integration recorded the wrong affected Nodes.'
    );
    sameJson(
      sourceIntegration.integration.recomputeRootNodeIds,
      ['old-ref-consumer'],
      'Source Integration recorded the wrong minimal recomputation roots.'
    );
    invariant(consumerReady?.status === 'ready', 'Downstream consumer is not ready.');
    invariant(consumerReady?.validity === 'valid', 'Unrun downstream consumer was made stale.');

    const consumerRun = await executePhase('materialize-downstream-ref-consumer', () => (
      app.runNext({
        executor: fileOperations,
        workspace: evaluationWorkspace,
        nodeId: 'materialized-consumer',
        baseRevision: 'main',
        input: {
          schemaVersion: 1,
          operations: [{
            type: 'write',
            path: CONSUMER_FILE,
            content: [
              'FWA V0.1 materialized logical Ref consumer',
              `ref=${SOURCE_REF_ID}`,
              `version=${sourceRefAfterIntegration.version}`,
              `hash=${sourceRefAfterIntegration.hash}`,
              ''
            ].join('\n')
          }]
        },
        commandId: 'live-run-materialized-consumer'
      })
    ));
    invariant(consumerRun.ok === true, 'Downstream consumer Run did not succeed.');
    const newRefSnapshot = consumerRun.run.effects.consumedRefs.find(
      (ref) => ref.id === SOURCE_REF_ID
    );
    invariant(
      newRefSnapshot?.version === sourceRefAfterIntegration.version
        && newRefSnapshot.hash === sourceRefAfterIntegration.hash,
      'Downstream consumer did not snapshot the integrated Ref version.',
      { expected: sourceRefAfterIntegration, actual: newRefSnapshot ?? null }
    );
    sameJson(consumerRun.changeSet.changedFiles, [CONSUMER_FILE], 'Consumer changed wrong files.');

    const consumerEvaluationPhase = await executePhase(
      'evaluate-consumer-with-real-unity',
      async () => {
        const evaluation = await app.evaluateChangeSet({
        changeSetId: consumerRun.changeSet.id,
        profile,
        evaluator,
        workspace: evaluationWorkspace,
        commandId: 'live-evaluate-materialized-consumer'
        });
        invariant(evaluation.ok === true, 'Consumer Unity evaluation did not pass.', {
          evidence: evaluation.evidence ? summarizeEvidence(evaluation.evidence) : null,
          cleanup: evaluation.cleanup ?? null
        });
        invariant(evaluation.evidence.result === 'pass', 'Consumer Evidence is not passing.');
        const nunit = await nunitSummary(app, evaluation.evidence);
        assertExactPassingNunit(nunit, 2, 'Consumer Unity evaluation');
        return { evaluation, nunit };
      }
    );
    const consumerEvaluation = consumerEvaluationPhase.evaluation;
    const consumerNunit = consumerEvaluationPhase.nunit;

    const consumerIntegration = await executePhase('integrate-materialized-consumer', () => (
      app.integrateChangeSet({
        changeSetId: consumerRun.changeSet.id,
        targetRef: 'main',
        workspace: promotion,
        commandId: 'live-integrate-materialized-consumer'
      })
    ));
    invariant(consumerIntegration.ok === true, 'Consumer integration did not succeed.');
    invariant(consumerIntegration.integration.status === 'integrated', 'Consumer is not integrated.');
    const beforeRevert = await app.getStatus();
    const goalBeforeRevert = beforeRevert.goals.find((candidate) => candidate.id === goal.goal.id);
    invariant(goalBeforeRevert?.status === 'completed', 'Goal did not complete after both Nodes.');
    const consumerBeforeRevert = beforeRevert.nodes.find(
      (node) => node.id === 'materialized-consumer'
    );
    invariant(consumerBeforeRevert?.validity === 'valid', 'Consumer is stale before the revert.');

    const reversion = await executePhase('gated-revert-source-after-downstream', () => (
      app.revertChangeSet({
        changeSetId: sourceRun.changeSet.id,
        targetRef: 'main',
        candidateWorkspace,
        promotion,
        evaluator,
        profile,
        evaluationWorkspace,
        commandId: 'live-gated-revert-source'
      })
    ));
    invariant(reversion.ok === true, 'Gated source reversion did not pass.', {
      reversion: reversion.reversion,
      cleanup: reversion.cleanup
    });
    invariant(reversion.reversion.status === 'reverted', 'Source Reversion is not terminal success.');
    invariant(
      reversion.reversion.regressionEvidence?.result === 'pass',
      'Reversion has no passing regression Evidence.'
    );
    invariant(
      reversion.reversion.regressionEvidence?.cleanup?.status === 'succeeded',
      'Reversion regression workspace cleanup was not proven.'
    );
    sameJson(
      reversion.reversion.changedRefIds,
      [SOURCE_REF_ID],
      'Source Reversion advanced the wrong logical Refs.'
    );
    sameJson(
      reversion.reversion.affectedNodeIds,
      ['materialized-consumer'],
      'Source Reversion recorded the wrong affected Nodes.'
    );
    sameJson(
      reversion.reversion.recomputeRootNodeIds,
      ['materialized-consumer'],
      'Source Reversion recorded the wrong minimal recomputation roots.'
    );
    invariant(
      reversion.cleanup.candidateWorkspaceRemoved === true,
      'Reversion candidate worktree was not removed.'
    );
    const reversionNunit = await nunitSummary(app, reversion.reversion.regressionEvidence);
    assertExactPassingNunit(reversionNunit, 1, 'Source reversion regression gate');

    const finalStatus = await executePhase('inspect-final-history-and-staleness', () => app.getStatus());
    const finalSource = finalStatus.nodes.find((node) => node.id === 'codex-source');
    const finalConsumer = finalStatus.nodes.find((node) => node.id === 'materialized-consumer');
    const finalOldRefConsumer = finalStatus.nodes.find((node) => node.id === 'old-ref-consumer');
    const finalGoal = finalStatus.goals.find((candidate) => candidate.id === goal.goal.id);
    const finalRef = finalStatus.refs.find((ref) => ref.id === SOURCE_REF_ID);
    invariant(finalSource?.integrationStatus === 'reverted', 'Source integration is not reverted.');
    invariant(finalSource?.validity === 'invalid', 'Reverted source is not invalid.');
    invariant(
      finalOldRefConsumer?.validity === 'stale'
        && finalOldRefConsumer.staleByIntegrationIds?.includes(sourceIntegration.integration.id),
      'Old-Ref consumer lost its Integration-origin stale history.'
    );
    invariant(finalConsumer?.validity === 'stale', 'Materialized consumer is not stale.');
    invariant(
      finalConsumer.staleByReversionIds?.includes(reversion.reversion.id),
      'Consumer does not identify the Reversion that made it stale.'
    );
    invariant(finalGoal?.status === 'active', 'Affected completed Goal was not reopened.');
    invariant(finalRef?.version === reversion.reversion.candidateRevision, 'Ref did not advance on revert.');
    invariant(
      finalRef.hash !== sourceRefAfterIntegration.hash,
      'Ref hash did not change when the source was reverted.'
    );
    invariant(
      finalStatus.projectRevisions.at(-1)?.revision === reversion.reversion.candidateRevision,
      'Final ProjectRevision is not the reversion candidate.'
    );
    invariant(await pathExists(path.join(projectRoot, FEATURE_FILES[0])) === false,
      'Reverted source file remains in the target checkout.');
    invariant(await pathExists(path.join(projectRoot, FEATURE_FILES[1])) === false,
      'Reverted source test remains in the target checkout.');
    invariant(await pathExists(path.join(projectRoot, CONSUMER_FILE)) === true,
      'Downstream materialized file was erased by the source revert.');
    await git(projectRoot, [
      'cat-file', '-e', `${sourceRun.changeSet.headRevision}^{commit}`
    ]);
    await git(projectRoot, ['show', `${sourceRevision}:${FEATURE_FILES[0]}`]);
    const ancestry = await git(projectRoot, [
      'merge-base', '--is-ancestor', sourceRevision, reversion.reversion.candidateRevision
    ], { allowedExitCodes: [0, 1] });
    invariant(ancestry.exitCode === 0, 'Reversion erased source integration history.');

    const verification = await executePhase('verify-full-durable-and-git-state', () => (
      app.verify({
        workspace: evaluationWorkspace,
        integration: promotion,
        candidateWorkspace
      })
    ));
    invariant(verification.ok === true, 'FWA verify did not succeed.');
    invariant(verification.operationallyClean === true, 'FWA verify found operational residue.', {
      verification
    });
    invariant(
      verification.gitVerifiedChangeSetCount === 3
        && verification.gitSkippedRevertChangeSetCount === 1,
      'FWA verify did not cover every original and revert ChangeSet.',
      { verification }
    );
    invariant(
      verification.gitVerifiedIntegrationCount === 2,
      'FWA verify did not cover both historical Integrations.',
      { verification }
    );
    invariant(verification.gitVerifiedReversionCount === 1, 'Reversion was not Git-verified.');

    const events = await app.listEvents();
    const eventTypeCounts = Object.fromEntries(
      [...new Set(events.map((event) => event.type))]
        .sort()
        .map((type) => [type, events.filter((event) => event.type === type).length])
    );
    for (const requiredType of [
      'GoalCreated',
      'PlanLoaded',
      'RunCreated',
      'ChangeSetCaptured',
      'EvidenceRecorded',
      'IntegrationApplied',
      'ReversionApplied',
      'NodeMarkedStale'
    ]) {
      invariant(eventTypeCounts[requiredType] > 0, `Required event ${requiredType} is absent.`);
    }

    const [sourceAfter, hostGitAfter, observedCodexConfigAfter, targetStatus, log] = await executePhase(
      'prove-source-host-and-target-cleanliness',
      () => Promise.all([
        sourceSnapshot(),
        hostGitSnapshot(),
        fileFingerprint(codexConfigPath()),
        git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
        git(projectRoot, [
          'log', '--graph', '--decorate', '--oneline', '--all', '--max-count=30'
        ])
      ])
    );
    codexConfigAfter = observedCodexConfigAfter;
    invariant(sourceAfter.digest === sourceBefore.digest, 'FWA source changed during validation.');
    sameJson(hostGitAfter, hostGitBefore, 'The FWA host Git state changed during validation.');
    invariant(targetStatus.stdout === '', 'Temporary target checkout is dirty.', {
      status: targetStatus.stdout
    });
    const codexConfigObservation = {
      before: codexConfigBefore,
      after: codexConfigAfter,
      changedDuringRun: JSON.stringify(codexConfigAfter) !== JSON.stringify(codexConfigBefore),
      attribution: 'observational-only-shared-external-state'
    };

    const finishedAt = new Date();
    const summary = {
      schemaVersion: 1,
      kind: 'fwa-v01-live-composition-validation',
      result: 'pass',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      runRoot,
      projectRoot,
      evidenceRoot,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        unityEditor: options.editorPath,
        unityVersion,
        unityProjectVersion,
        unityEditModeBatchMode: options.editModeBatchMode,
        unityEditModeNoGraphics: false,
        unityTestFrameworkVersion: options.testFrameworkVersion,
        codexExecutableOverride: options.codexPath,
        codexModelOverride: options.model,
        ignoreUserConfig: options.ignoreUserConfig,
        windowsElevated: options.windowsElevated
      },
      source: {
        snapshot: sourceAfter,
        hostGit: hostGitAfter,
        codexConfig: codexConfigObservation
      },
      unityAttempts: unityAttempts.map((attempt) => ({ ...attempt })),
      baselinePurityCleanup,
      goal: {
        id: goal.goal.id,
        finalStatus: finalGoal.status
      },
      oldRefConsumer: {
        goalId: oldRefConsumerGoal.goal.id,
        nodeId: oldRefConsumerRun.node.id,
        runId: oldRefConsumerRun.run.id,
        changeSetId: oldRefConsumerRun.changeSet.id,
        consumedRefs: oldRefConsumerRun.run.effects.consumedRefs,
        finalValidity: finalOldRefConsumer.validity,
        staleByIntegrationIds: finalOldRefConsumer.staleByIntegrationIds
      },
      codex: codexExecution,
      sourceRun: {
        runId: sourceRun.run.id,
        changeSetId: sourceRun.changeSet.id,
        baseRevision: sourceRun.changeSet.baseRevision,
        headRevision: sourceRun.changeSet.headRevision,
        changedFiles: sourceRun.changeSet.changedFiles,
        stats: sourceRun.changeSet.stats,
        cleanup: sourceRun.cleanup
      },
      sourceEvaluation: {
        evidence: summarizeEvidence(sourceEvaluation.evidence),
        nunit: sourceNunit,
        cleanup: sourceEvaluation.cleanup
      },
      sourceIntegration: {
        id: sourceIntegration.integration.id,
        status: sourceIntegration.integration.status,
        strategy: sourceIntegration.integration.strategy,
        integratedRevision: sourceRevision,
        candidateParents: sourceIntegration.integration.candidateParents,
        changedRefIds: sourceIntegration.integration.changedRefIds,
        affectedNodeIds: sourceIntegration.integration.affectedNodeIds,
        recomputeRootNodeIds: sourceIntegration.integration.recomputeRootNodeIds,
        nunit: sourceIntegrationNunit,
        regressionEvidence: summarizeRegression(
          sourceIntegration.integration.regressionEvidence
        ),
        cleanup: sourceIntegration.cleanup
      },
      consumer: {
        runId: consumerRun.run.id,
        changeSetId: consumerRun.changeSet.id,
        integrationId: consumerIntegration.integration.id,
        integratedRevision: consumerIntegration.integration.integratedRevision,
        consumedRefs: consumerRun.run.effects.consumedRefs,
        evidence: summarizeEvidence(consumerEvaluation.evidence),
        nunit: consumerNunit,
        evaluationCleanup: consumerEvaluation.cleanup,
        integrationCleanup: consumerIntegration.cleanup ?? null
      },
      reversion: {
        id: reversion.reversion.id,
        status: reversion.reversion.status,
        revertedRevision: reversion.reversion.revertedRevision,
        candidateRevision: reversion.reversion.candidateRevision,
        changedRefIds: reversion.reversion.changedRefIds,
        affectedNodeIds: reversion.reversion.affectedNodeIds,
        recomputeRootNodeIds: reversion.reversion.recomputeRootNodeIds,
        nunit: reversionNunit,
        regressionEvidence: summarizeRegression(reversion.reversion.regressionEvidence),
        cleanup: reversion.cleanup
      },
      final: {
        targetRevision: await gitLine(projectRoot, ['rev-parse', 'refs/heads/main']),
        ref: finalRef,
        sourceNode: finalSource,
        oldRefConsumerNode: finalOldRefConsumer,
        consumerNode: finalConsumer,
        projectRevisions: finalStatus.projectRevisions,
        verification,
        eventTypeCounts,
        gitLog: log.stdout
      },
      timeline
    };
    const summaryPath = path.join(evidenceRoot, 'summary.json');
    const summaryMarkdownPath = path.join(evidenceRoot, 'summary.md');
    const eventsPath = path.join(evidenceRoot, 'events.json');
    const statusPath = path.join(evidenceRoot, 'final-status.json');
    await Promise.all([
      writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
      writeFile(summaryMarkdownPath, successMarkdown(summary), 'utf8'),
      writeFile(eventsPath, `${JSON.stringify(events, null, 2)}\n`, 'utf8'),
      writeFile(statusPath, `${JSON.stringify(finalStatus, null, 2)}\n`, 'utf8')
    ]);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      result: 'pass',
      runRoot,
      projectRoot,
      summaryPath,
      summaryMarkdownPath,
      eventCount: events.length,
      finalRevision: summary.final.targetRevision,
      staleNodeIds: finalStatus.nodes
        .filter((node) => node.validity === 'stale')
        .map((node) => node.id)
    })}\n`);
  } catch (error) {
    const failedAt = new Date();
    const lastTimelineEntry = timeline.at(-1);
    if (lastTimelineEntry?.name === activePhase && lastTimelineEntry.result === 'pass') {
      lastTimelineEntry.result = 'fail';
      lastTimelineEntry.durationMs = Math.max(
        lastTimelineEntry.durationMs,
        failedAt.getTime() - Date.parse(lastTimelineEntry.startedAt)
      );
      lastTimelineEntry.error = errorJson(error);
    } else if (lastTimelineEntry?.name !== activePhase) {
      timeline.push({
        name: activePhase,
        result: 'fail',
        startedAt: failedAt.toISOString(),
        durationMs: 0,
        error: errorJson(error)
      });
    }
    const failure = {
      schemaVersion: 1,
      kind: 'fwa-v01-live-composition-validation',
      result: 'fail',
      activePhase,
      startedAt: startedAt.toISOString(),
      failedAt: failedAt.toISOString(),
      runRoot,
      projectRoot,
      evidenceRoot,
      error: errorJson(error),
      unityProjectVersion,
      unityEditModeBatchMode: options.editModeBatchMode,
      unityAttempts: unityAttempts.map((attempt) => ({ ...attempt })),
      baselinePurityCleanup,
      sourceBefore,
      hostGitBefore,
      codexConfigBefore,
      codexConfigAfter,
      timeline
    };
    const failurePath = path.join(evidenceRoot, 'failure.json');
    const failureMarkdownPath = path.join(evidenceRoot, 'failure.md');
    await Promise.all([
      writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8'),
      writeFile(failureMarkdownPath, failureMarkdown(failure), 'utf8')
    ]);
    process.stderr.write(`${JSON.stringify({
      ok: false,
      result: 'fail',
      activePhase,
      runRoot,
      failurePath,
      failureMarkdownPath,
      error: errorJson(error)
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

await main();
