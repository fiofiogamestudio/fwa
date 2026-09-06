import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EvidenceProfileMismatchError,
  assertEvidenceMatchesProfile,
  validateEvidenceAgainstProfile
} from '../src/core/evaluator.js';

const EXPECTED_DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

function artifactRef(digest = EXPECTED_DIGEST, size = 5) {
  return { schemaVersion: 1, algorithm: 'sha256', digest, size };
}

function normalizedProfile() {
  return {
    schemaVersion: 1,
    id: 'profile-1',
    checks: [
      {
        id: 'compile',
        kind: 'build',
        command: 'node',
        args: ['compile.js', '--strict'],
        timeoutMs: 5_000,
        expectedExitCodes: [0],
        cwd: 'client',
        expectedArtifacts: [{
          path: 'reports/build.json',
          size: 5,
          sha256: EXPECTED_DIGEST
        }]
      },
      {
        id: 'test',
        kind: 'test',
        command: 'node',
        args: ['--test'],
        timeoutMs: 10_000,
        expectedExitCodes: [0, 2],
        cwd: null,
        expectedArtifacts: []
      }
    ]
  };
}

function passingCriterion({
  id = 'compile',
  kind = 'build',
  command = 'node',
  args = ['compile.js', '--strict'],
  cwd = 'client',
  expectedArtifacts = [{
    path: 'reports/build.json',
    size: 5,
    digest: EXPECTED_DIGEST,
    artifact: artifactRef(),
    failure: null
  }]
} = {}) {
  return {
    id,
    kind,
    result: 'pass',
    command: { command, args, cwd },
    exitCode: 0,
    signal: null,
    timedOut: false,
    terminationConfirmed: true,
    durationMs: 10,
    stdoutArtifact: artifactRef('c'.repeat(64), 0),
    stderrArtifact: artifactRef('d'.repeat(64), 0),
    expectedArtifacts,
    failure: null
  };
}

function projectedEvidence() {
  return {
    id: 'evidence-1',
    result: 'pass',
    criteria: [
      passingCriterion(),
      passingCriterion({
        id: 'test',
        kind: 'test',
        args: ['--test'],
        cwd: '.',
        expectedArtifacts: []
      })
    ]
  };
}

function failedFirstCriterionEvidence() {
  const evidence = projectedEvidence();
  evidence.result = 'fail';
  evidence.criteria[0] = {
    ...evidence.criteria[0],
    result: 'fail',
    exitCode: 7,
    expectedArtifacts: [{
      path: 'reports/build.json',
      size: null,
      digest: null,
      artifact: null,
      failure: {
        code: 'EXPECTED_ARTIFACT_MISSING',
        message: 'Expected artifact was not produced.',
        details: null
      }
    }],
    failure: {
      code: 'UNEXPECTED_EXIT_CODE',
      message: 'Command exited with code 7.',
      details: { expected: [0], actual: 7 }
    }
  };
  return evidence;
}

function errorCodes(result) {
  return result.errors.map((error) => error.code);
}

test('pure comparator accepts a complete profile/Evidence binding', () => {
  const profile = normalizedProfile();
  const evidence = projectedEvidence();
  const result = validateEvidenceAgainstProfile(profile, evidence);

  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.errors), true);
  assert.equal(assertEvidenceMatchesProfile(profile, evidence), evidence);
});

test('static profile fields are bound by index and exact value', async (t) => {
  const cases = [
    {
      name: 'criterion count',
      code: 'CRITERIA_COUNT_MISMATCH',
      mutate: (evidence) => evidence.criteria.pop()
    },
    {
      name: 'criterion order',
      code: 'CRITERION_ID_MISMATCH',
      mutate: (evidence) => evidence.criteria.reverse()
    },
    {
      name: 'criterion id',
      code: 'CRITERION_ID_MISMATCH',
      mutate: (evidence) => { evidence.criteria[0].id = 'another-check'; }
    },
    {
      name: 'criterion kind',
      code: 'CRITERION_KIND_MISMATCH',
      mutate: (evidence) => { evidence.criteria[0].kind = 'lint'; }
    },
    {
      name: 'command',
      code: 'CRITERION_COMMAND_MISMATCH',
      mutate: (evidence) => { evidence.criteria[0].command.command = 'npm'; }
    },
    {
      name: 'argument order',
      code: 'CRITERION_ARGUMENTS_MISMATCH',
      mutate: (evidence) => { evidence.criteria[0].command.args.reverse(); }
    },
    {
      name: 'working directory',
      code: 'CRITERION_CWD_MISMATCH',
      mutate: (evidence) => { evidence.criteria[0].command.cwd = '.'; }
    },
    {
      name: 'expected artifact count',
      code: 'EXPECTED_ARTIFACT_COUNT_MISMATCH',
      mutate: (evidence) => evidence.criteria[0].expectedArtifacts.pop()
    },
    {
      name: 'expected artifact path',
      code: 'EXPECTED_ARTIFACT_PATH_MISMATCH',
      mutate: (evidence) => {
        evidence.criteria[0].expectedArtifacts[0].path = 'reports/other.json';
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const evidence = projectedEvidence();
      scenario.mutate(evidence);
      const result = validateEvidenceAgainstProfile(normalizedProfile(), evidence);
      assert.equal(result.ok, false);
      assert.equal(errorCodes(result).includes(scenario.code), true, JSON.stringify(result));
    });
  }
});

test('failed criteria retain static bindings without being judged as passes', () => {
  const profile = normalizedProfile();
  const failed = failedFirstCriterionEvidence();
  assert.deepEqual(validateEvidenceAgainstProfile(profile, failed), {
    ok: true,
    errors: []
  });

  failed.criteria[0].command.args = ['different.js'];
  failed.criteria[0].expectedArtifacts[0].path = 'reports/different.json';
  const result = validateEvidenceAgainstProfile(profile, failed);
  assert.equal(result.ok, false);
  assert.deepEqual(errorCodes(result), [
    'CRITERION_ARGUMENTS_MISMATCH',
    'EXPECTED_ARTIFACT_PATH_MISMATCH'
  ]);
});

test('passing criteria must satisfy process and expected-artifact policy', async (t) => {
  const cases = [
    {
      name: 'allowed exit code',
      code: 'PASS_EXIT_CODE_NOT_ALLOWED',
      mutate: (criterion) => { criterion.exitCode = 9; }
    },
    {
      name: 'no signal',
      code: 'PASS_SIGNAL_PRESENT',
      mutate: (criterion) => { criterion.signal = 'SIGTERM'; }
    },
    {
      name: 'no timeout',
      code: 'PASS_TIMED_OUT',
      mutate: (criterion) => { criterion.timedOut = true; }
    },
    {
      name: 'confirmed termination',
      code: 'PASS_TERMINATION_UNCONFIRMED',
      mutate: (criterion) => { criterion.terminationConfirmed = false; }
    },
    {
      name: 'no criterion failure',
      code: 'PASS_FAILURE_PRESENT',
      mutate: (criterion) => {
        criterion.failure = { code: 'FAILED', message: 'failed', details: null };
      }
    },
    {
      name: 'artifact exists',
      code: 'PASS_EXPECTED_ARTIFACT_MISSING',
      mutate: (criterion) => { criterion.expectedArtifacts[0].artifact = null; }
    },
    {
      name: 'artifact has no failure',
      code: 'PASS_EXPECTED_ARTIFACT_FAILURE',
      mutate: (criterion) => {
        criterion.expectedArtifacts[0].failure = {
          code: 'ARTIFACT_FAILED', message: 'failed', details: null
        };
      }
    },
    {
      name: 'artifact size constraint',
      code: 'PASS_EXPECTED_ARTIFACT_SIZE_MISMATCH',
      mutate: (criterion) => {
        criterion.expectedArtifacts[0].size = 6;
        criterion.expectedArtifacts[0].artifact.size = 6;
      }
    },
    {
      name: 'artifact digest constraint',
      code: 'PASS_EXPECTED_ARTIFACT_DIGEST_MISMATCH',
      mutate: (criterion) => {
        criterion.expectedArtifacts[0].digest = OTHER_DIGEST;
        criterion.expectedArtifacts[0].artifact.digest = OTHER_DIGEST;
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const evidence = projectedEvidence();
      scenario.mutate(evidence.criteria[0]);
      const result = validateEvidenceAgainstProfile(normalizedProfile(), evidence);
      assert.equal(result.ok, false);
      assert.equal(errorCodes(result).includes(scenario.code), true, JSON.stringify(result));
    });
  }
});

test('assertion API throws a dedicated structured mismatch error', () => {
  const evidence = projectedEvidence();
  evidence.criteria[0].command.cwd = 'server';

  assert.throws(
    () => assertEvidenceMatchesProfile(normalizedProfile(), evidence),
    (error) => error instanceof EvidenceProfileMismatchError
      && error.code === 'FWA_EVIDENCE_PROFILE_MISMATCH'
      && Object.isFrozen(error.errors)
      && error.errors[0].code === 'CRITERION_CWD_MISMATCH'
  );
  assert.deepEqual(validateEvidenceAgainstProfile(null, evidence).errors, [{
    code: 'INVALID_NORMALIZED_PROFILE',
    path: 'profile',
    message: 'Expected a normalized profile object.'
  }]);
});
