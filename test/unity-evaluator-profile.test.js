import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_COMMAND_TIMEOUT_MS,
  CommandEvaluator
} from '../src/adapters/command-evaluator.js';
import {
  DEFAULT_UNITY_COMPILE_LOG_PATH,
  DEFAULT_UNITY_COMPILE_TIMEOUT_MS,
  DEFAULT_UNITY_EDITMODE_LOG_PATH,
  DEFAULT_UNITY_EDITMODE_TIMEOUT_MS,
  DEFAULT_UNITY_PROFILE_ID,
  DEFAULT_UNITY_TEST_RESULTS_PATH,
  UNITY_EVALUATION_MODE,
  UnityEvaluatorProfileError,
  createUnityEvaluatorProfile,
  inspectUnityProject
} from '../src/adapters/unity-evaluator-profile.js';
import { validateEvidenceAgainstProfile } from '../src/core/evaluator.js';

const sourcePath = fileURLToPath(new URL(
  '../src/adapters/unity-evaluator-profile.js',
  import.meta.url
));

async function fixture(t, {
  versionContents = 'm_EditorVersion: 6000.0.62f1\n'
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-unity-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'Unity Project');
  const editorPath = path.join(root, process.platform === 'win32' ? 'Unity.exe' : 'Unity');
  await mkdir(path.join(projectRoot, 'ProjectSettings'), { recursive: true });
  await writeFile(
    path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'),
    versionContents,
    'utf8'
  );
  await writeFile(editorPath, '', 'utf8');
  return { root, projectRoot, editorPath };
}

function unityOptions(item, overrides = {}) {
  return {
    projectRoot: item.projectRoot,
    editorPath: item.editorPath,
    ...overrides
  };
}

function artifactRef(digest, size) {
  return { schemaVersion: 1, algorithm: 'sha256', digest, size };
}

function passingEvidence(profile) {
  const outputDigest = 'a'.repeat(64);
  const artifactDigest = 'b'.repeat(64);
  return {
    id: 'evidence-unity',
    result: 'pass',
    criteria: profile.checks.map((check) => ({
      id: check.id,
      kind: check.kind,
      result: 'pass',
      command: {
        command: check.command,
        args: [...check.args],
        cwd: check.cwd ?? '.'
      },
      exitCode: 0,
      signal: null,
      timedOut: false,
      terminationConfirmed: true,
      durationMs: 1,
      stdoutArtifact: artifactRef(outputDigest, 0),
      stderrArtifact: artifactRef(outputDigest, 0),
      expectedArtifacts: check.expectedArtifacts.map((expected) => ({
        path: expected.path,
        size: 5,
        digest: artifactDigest,
        artifact: artifactRef(artifactDigest, 5),
        failure: null
      })),
      failure: null
    }))
  };
}

test('recognizes a Unity project only through its bounded ProjectVersion file', async (t) => {
  const item = await fixture(t, {
    versionContents: '\uFEFFm_EditorVersion: 2022.3.62f1\n'
      + 'm_EditorVersionWithRevision: 2022.3.62f1 (example)\n'
  });
  const inspected = await inspectUnityProject(item.projectRoot);

  assert.equal(inspected.projectRoot, await realpath(item.projectRoot));
  assert.equal(
    inspected.projectVersionPath,
    path.join(await realpath(item.projectRoot), 'ProjectSettings', 'ProjectVersion.txt')
  );
  assert.equal(inspected.editorVersion, '2022.3.62f1');
  assert.equal(Object.isFrozen(inspected), true);
});

test('creates one deterministic compile and EditMode CommandEvaluator profile', async (t) => {
  const item = await fixture(t);
  const options = unityOptions(item, { mode: 'EditMode' });
  const first = await createUnityEvaluatorProfile(options);
  const second = await createUnityEvaluatorProfile(options);
  const canonicalEditor = await realpath(item.editorPath);

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.checks), true);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.id, DEFAULT_UNITY_PROFILE_ID);
  assert.equal(first.checks.length, 3);

  const [compile, editMode, nunit] = first.checks;
  assert.deepEqual(compile, {
    id: 'unity-compile',
    kind: 'compile',
    command: canonicalEditor,
    args: [
      '-batchmode',
      '-nographics',
      '-projectPath',
      '.',
      '-forgetProjectPath',
      '-logFile',
      DEFAULT_UNITY_COMPILE_LOG_PATH,
      '-quit'
    ],
    timeoutMs: DEFAULT_UNITY_COMPILE_TIMEOUT_MS,
    expectedExitCodes: [0],
    cwd: null,
    captureOutput: false,
    expectedArtifacts: [{
      path: DEFAULT_UNITY_COMPILE_LOG_PATH,
      size: null,
      sha256: null
    }]
  });
  assert.deepEqual(editMode, {
    id: 'unity-editmode-tests',
    kind: 'test',
    command: canonicalEditor,
    args: [
      '-batchmode',
      '-projectPath',
      '.',
      '-forgetProjectPath',
      '-runTests',
      '-testPlatform',
      'EditMode',
      '-testResults',
      DEFAULT_UNITY_TEST_RESULTS_PATH,
      '-logFile',
      DEFAULT_UNITY_EDITMODE_LOG_PATH
    ],
    timeoutMs: DEFAULT_UNITY_EDITMODE_TIMEOUT_MS,
    expectedExitCodes: [0],
    cwd: null,
    captureOutput: false,
    expectedArtifacts: [{
      path: DEFAULT_UNITY_TEST_RESULTS_PATH,
      size: null,
      sha256: null
    }, {
      path: DEFAULT_UNITY_EDITMODE_LOG_PATH,
      size: null,
      sha256: null
    }]
  });
  assert.equal(nunit.id, 'unity-editmode-results');
  assert.equal(nunit.kind, 'test-report');
  assert.equal(nunit.command, process.execPath);
  assert.equal(Object.hasOwn(nunit, 'captureOutput'), false);
  assert.deepEqual(nunit.args.slice(-2), ['--', DEFAULT_UNITY_TEST_RESULTS_PATH]);
  assert.deepEqual(nunit.expectedArtifacts, []);

  assert.deepEqual(new CommandEvaluator({ env: {} }).normalizeProfile(first), first);
  const evidence = passingEvidence(first);
  assert.deepEqual(evidence.criteria.map((criterion) => (
    criterion.expectedArtifacts.map((artifact) => artifact.path)
  )), [
    [DEFAULT_UNITY_COMPILE_LOG_PATH],
    [DEFAULT_UNITY_TEST_RESULTS_PATH, DEFAULT_UNITY_EDITMODE_LOG_PATH],
    []
  ]);
  assert.deepEqual(validateEvidenceAgainstProfile(first, evidence), { ok: true, errors: [] });

  const evidenceWithoutCompileLog = structuredClone(evidence);
  evidenceWithoutCompileLog.criteria[0].expectedArtifacts = [];
  const missingLogBinding = validateEvidenceAgainstProfile(first, evidenceWithoutCompileLog);
  assert.equal(missingLogBinding.ok, false);
  assert.equal(
    missingLogBinding.errors.some((error) => error.code === 'EXPECTED_ARTIFACT_COUNT_MISMATCH'),
    true
  );
  assert.doesNotMatch(JSON.stringify(first), /PlayMode|screenshot|telemetry|recordVideo/u);
});

test('adds EditMode -nographics only when explicitly requested', async (t) => {
  const item = await fixture(t);
  const defaultProfile = await createUnityEvaluatorProfile(unityOptions(item));
  const noGraphicsProfile = await createUnityEvaluatorProfile(unityOptions(item, {
    editModeNoGraphics: true
  }));
  const defaultEditMode = defaultProfile.checks.find((check) => (
    check.id === 'unity-editmode-tests'
  ));
  const noGraphicsEditMode = noGraphicsProfile.checks.find((check) => (
    check.id === 'unity-editmode-tests'
  ));

  assert.equal(defaultEditMode.args.includes('-nographics'), false);
  assert.deepEqual(noGraphicsEditMode.args, [
    '-batchmode',
    '-nographics',
    '-projectPath',
    '.',
    '-forgetProjectPath',
    '-runTests',
    '-testPlatform',
    'EditMode',
    '-testResults',
    DEFAULT_UNITY_TEST_RESULTS_PATH,
    '-logFile',
    DEFAULT_UNITY_EDITMODE_LOG_PATH
  ]);
  assert.notDeepEqual(noGraphicsProfile, defaultProfile);
});

test('can explicitly omit EditMode -batchmode without changing compile isolation', async (t) => {
  const item = await fixture(t);
  const first = await createUnityEvaluatorProfile(unityOptions(item, {
    editModeBatchMode: false
  }));
  const second = await createUnityEvaluatorProfile(unityOptions(item, {
    editModeBatchMode: false
  }));
  const [compile, editMode] = first.checks;

  assert.deepEqual(first, second);
  assert.equal(compile.args.includes('-batchmode'), true);
  assert.equal(compile.args.includes('-nographics'), true);
  assert.equal(editMode.args.includes('-batchmode'), false);
  assert.equal(editMode.args.includes('-nographics'), false);
  assert.deepEqual(editMode.args.slice(0, 4), [
    '-projectPath',
    '.',
    '-forgetProjectPath',
    '-runTests'
  ]);
});

test('the generated result check rejects malformed or failing NUnit XML', async (t) => {
  const item = await fixture(t);
  const testResultsPath = 'results/editmode.xml';
  const profile = await createUnityEvaluatorProfile(unityOptions(item, { testResultsPath }));
  const validator = profile.checks[2];
  const absoluteResults = path.join(item.projectRoot, 'results', 'editmode.xml');
  await mkdir(path.dirname(absoluteResults), { recursive: true });

  const runValidator = () => spawnSync(validator.command, validator.args, {
    cwd: item.projectRoot,
    encoding: 'utf8',
    windowsHide: true
  });

  await writeFile(
    absoluteResults,
    '<?xml version="1.0" encoding="utf-8"?>\n'
      + '<test-run result="Passed" total="1" passed="1" failed="0">'
      + '<test-suite result="Passed" />'
      + '</test-run>\n',
    'utf8'
  );
  assert.equal(runValidator().status, 0);

  await writeFile(
    absoluteResults,
    '<test-run result="Passed" failed="0"><test-suite></test-run>',
    'utf8'
  );
  const malformed = runValidator();
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Invalid NUnit XML/u);

  await writeFile(
    absoluteResults,
    '<test-run result="Failed" total="1" passed="0" failed="1"></test-run>',
    'utf8'
  );
  const failed = runValidator();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /result is not Passed/u);

  for (const emptyReport of [
    '<test-run result="Passed" total="0" passed="0" failed="0"></test-run>',
    '<test-run result="Passed" total="1" passed="0" failed="0" skipped="1"></test-run>',
    '<test-results total="0" errors="0" failures="0" not-run="0"></test-results>',
    '<test-results total="1" errors="0" failures="0" not-run="1"></test-results>'
  ]) {
    await writeFile(absoluteResults, emptyReport, 'utf8');
    const empty = runValidator();
    assert.equal(empty.status, 1, emptyReport);
    assert.match(empty.stderr, /Invalid NUnit XML/u);
  }
});

test('rejects non-Unity projects and malformed project versions', async (t) => {
  const item = await fixture(t);
  const missingRoot = path.join(item.root, 'Not Unity');
  await mkdir(missingRoot);

  await assert.rejects(
    inspectUnityProject(missingRoot),
    (error) => error instanceof UnityEvaluatorProfileError
      && error.code === 'FWA_NOT_UNITY_PROJECT'
  );
  await assert.rejects(
    inspectUnityProject('relative/project'),
    (error) => error instanceof UnityEvaluatorProfileError
      && error.code === 'FWA_INVALID_UNITY_PATH'
  );

  const malformed = await fixture(t, { versionContents: 'not a Unity version file\n' });
  await assert.rejects(
    inspectUnityProject(malformed.projectRoot),
    (error) => error instanceof UnityEvaluatorProfileError
      && error.code === 'FWA_INVALID_UNITY_PROJECT_VERSION'
  );
});

test('validates editor, mode, timeout, result path, and option boundaries', async (t) => {
  const item = await fixture(t);
  const missingEditor = path.join(item.root, 'missing-editor');
  const editorDirectory = path.join(item.root, 'editor-directory');
  await mkdir(editorDirectory);

  const cases = [
    {
      name: 'non-object options',
      options: null,
      code: 'FWA_INVALID_UNITY_PROFILE_OPTIONS'
    },
    {
      name: 'unknown option',
      options: unityOptions(item, { runtimeScenario: true }),
      code: 'FWA_INVALID_UNITY_PROFILE_OPTIONS'
    },
    {
      name: 'relative project path',
      options: unityOptions(item, { projectRoot: 'relative/project' }),
      code: 'FWA_INVALID_UNITY_PATH'
    },
    {
      name: 'relative editor path',
      options: unityOptions(item, { editorPath: 'Unity.exe' }),
      code: 'FWA_INVALID_UNITY_PATH'
    },
    {
      name: 'missing editor',
      options: unityOptions(item, { editorPath: missingEditor }),
      code: 'FWA_INVALID_UNITY_EDITOR'
    },
    {
      name: 'editor directory',
      options: unityOptions(item, { editorPath: editorDirectory }),
      code: 'FWA_INVALID_UNITY_EDITOR'
    },
    {
      name: 'PlayMode',
      options: unityOptions(item, { mode: 'PlayMode' }),
      code: 'FWA_UNSUPPORTED_UNITY_MODE'
    },
    {
      name: 'zero compile timeout',
      options: unityOptions(item, { compileTimeoutMs: 0 }),
      code: 'FWA_INVALID_UNITY_TIMEOUT'
    },
    {
      name: 'oversized EditMode timeout',
      options: unityOptions(item, { editModeTimeoutMs: MAX_COMMAND_TIMEOUT_MS + 1 }),
      code: 'FWA_INVALID_UNITY_TIMEOUT'
    },
    {
      name: 'non-boolean EditMode no-graphics option',
      options: unityOptions(item, { editModeNoGraphics: 'true' }),
      code: 'FWA_INVALID_UNITY_PROFILE_OPTIONS'
    },
    {
      name: 'non-boolean EditMode batch-mode option',
      options: unityOptions(item, { editModeBatchMode: 'false' }),
      code: 'FWA_INVALID_UNITY_PROFILE_OPTIONS'
    },
    {
      name: 'non-batch EditMode cannot request no-graphics',
      options: unityOptions(item, {
        editModeBatchMode: false,
        editModeNoGraphics: true
      }),
      code: 'FWA_INVALID_UNITY_PROFILE_OPTIONS'
    },
    {
      name: 'unsafe profile id',
      options: unityOptions(item, { profileId: 'unity profile' }),
      code: 'FWA_INVALID_UNITY_PROFILE_ID'
    },
    ...[
      '../results.xml',
      '/tmp/results.xml',
      'C:/temp/results.xml',
      'results\\editmode.xml',
      '.fwa/results.xml',
      'results//editmode.xml',
      'results./editmode.xml',
      'CON/editmode.xml',
      'results/editmode.txt'
    ].map((testResultsPath) => ({
      name: `unsafe results path ${testResultsPath}`,
      options: unityOptions(item, { testResultsPath }),
      code: 'FWA_INVALID_UNITY_RESULTS_PATH'
    }))
  ];

  for (const example of cases) {
    await t.test(example.name, async () => {
      await assert.rejects(
        createUnityEvaluatorProfile(example.options),
        (error) => error instanceof UnityEvaluatorProfileError
          && error.code === example.code
      );
    });
  }
});

test('the Unity profile adapter has no direct core, runtime, or UI dependency', async () => {
  const source = await readFile(sourcePath, 'utf8');
  assert.doesNotMatch(source, /from\s+['"]\.\.\/core\//u);
  assert.doesNotMatch(source, /(?:fwe|UnityEngine|CaptureScreenshot|RecordVideo|PlayMode)/u);
  assert.equal(UNITY_EVALUATION_MODE, 'editmode');
});
