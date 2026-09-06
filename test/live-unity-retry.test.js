import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LiveUnityRetryEvaluator,
  MAX_LIVE_UNITY_ATTEMPTS,
  isRetryableUnityTeardownTimeout
} from '../tools/live-unity-retry.js';

function baseCheck(id, kind, overrides = {}) {
  return {
    id,
    kind,
    status: 'passed',
    passed: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    terminationConfirmed: true,
    expectedExitCodes: [0],
    failure: null,
    ...overrides
  };
}

function passingResult() {
  return {
    schemaVersion: 1,
    evaluator: { id: 'live-unity', version: '1' },
    manifest: { id: 'unity-profile', schemaVersion: 1 },
    passed: true,
    checks: [
      baseCheck('unity-compile', 'compile'),
      baseCheck('unity-editmode-tests', 'test'),
      baseCheck('unity-editmode-results', 'test-report')
    ]
  };
}

function teardownTimeoutResult() {
  return {
    schemaVersion: 1,
    evaluator: { id: 'live-unity', version: '1' },
    manifest: { id: 'unity-profile', schemaVersion: 1 },
    passed: false,
    checks: [
      baseCheck('unity-compile', 'compile'),
      baseCheck('unity-editmode-tests', 'test', {
        status: 'failed',
        passed: false,
        exitCode: null,
        signal: 'SIGKILL',
        timedOut: true,
        terminationConfirmed: true,
        failure: {
          code: 'COMMAND_TIMEOUT',
          message: 'Unity did not exit.',
          details: { timeoutMs: 1_200_000 }
        }
      }),
      baseCheck('unity-editmode-results', 'test-report', {
        status: 'skipped',
        passed: false,
        exitCode: null,
        terminationConfirmed: null,
        failure: {
          code: 'FAIL_FAST',
          message: 'Skipped after EditMode timeout.',
          details: { failedCheckId: 'unity-editmode-tests' }
        }
      })
    ]
  };
}

function clone(value) {
  return structuredClone(value);
}

function fakeEvaluator(sequence, { normalizedProfile = null } = {}) {
  let calls = 0;
  let normalizeCalls = 0;
  const requests = [];
  return {
    schemaVersion: 1,
    id: 'live-unity',
    version: '1',
    get calls() {
      return calls;
    },
    get normalizeCalls() {
      return normalizeCalls;
    },
    requests,
    normalizeProfile(profile) {
      normalizeCalls += 1;
      return normalizedProfile ?? profile;
    },
    async evaluate(request) {
      requests.push(request);
      const selected = sequence[calls];
      calls += 1;
      if (selected instanceof Error) throw selected;
      if (typeof selected === 'function') return selected(request);
      return selected;
    }
  };
}

test('strict teardown-timeout classifier accepts only the settled V0.1 shape', () => {
  assert.equal(isRetryableUnityTeardownTimeout(teardownTimeoutResult()), true);

  const mutations = [
    (result) => { result.passed = true; },
    (result) => { result.checks.push(baseCheck('extra', 'test')); },
    (result) => { result.checks[0].exitCode = 1; },
    (result) => { result.checks[0].terminationConfirmed = false; },
    (result) => { result.checks[1].failure.code = 'UNEXPECTED_EXIT_CODE'; },
    (result) => { result.checks[1].failure.details = null; },
    (result) => { result.checks[1].aborted = true; },
    (result) => { result.checks[1].terminationConfirmed = false; },
    (result) => { result.checks[2].status = 'failed'; },
    (result) => { result.checks[2].terminationConfirmed = true; },
    (result) => { result.checks[2].failure.details.failedCheckId = 'unity-compile'; }
  ];
  for (const mutate of mutations) {
    const candidate = teardownTimeoutResult();
    mutate(candidate);
    assert.equal(isRetryableUnityTeardownTimeout(candidate), false);
  }
});

test('timeout then pass records and awaits both attempts and returns the final delegate result',
  async () => {
    const timeout = teardownTimeoutResult();
    const pass = passingResult();
    const profile = { id: 'input-profile' };
    const normalized = { id: 'normalized-profile' };
    const delegate = fakeEvaluator([timeout, pass], { normalizedProfile: normalized });
    const records = [];
    let releaseFirstRecord;
    const firstRecordGate = new Promise((resolve) => {
      releaseFirstRecord = resolve;
    });
    let firstWriterEntered;
    const firstWriterStarted = new Promise((resolve) => {
      firstWriterEntered = resolve;
    });
    const evaluator = new LiveUnityRetryEvaluator(delegate, {
      backoffMs: [0, 0],
      async writeAttempt(record) {
        records.push(record);
        if (record.attempt === 1) {
          firstWriterEntered();
          await firstRecordGate;
        }
      }
    });

    assert.equal(evaluator.schemaVersion, delegate.schemaVersion);
    assert.equal(evaluator.id, delegate.id);
    assert.equal(evaluator.version, delegate.version);
    assert.equal(evaluator.normalizeProfile(profile), normalized);
    assert.equal(delegate.normalizeCalls, 1);

    const request = { workspaceRoot: 'workspace', manifest: profile };
    const pending = evaluator.evaluate(request);
    await firstWriterStarted;
    assert.equal(delegate.calls, 1, 'the next attempt must wait for durable recording');
    releaseFirstRecord();

    assert.equal(await pending, pass);
    assert.equal(delegate.calls, 2);
    assert.deepEqual(delegate.requests, [request, request]);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => ({
      attempt: record.attempt,
      outcome: record.outcome,
      eligible: record.retryEligible,
      permitted: record.retryPermitted,
      backoff: record.nextBackoffMs,
      result: record.result
    })), [
      {
        attempt: 1,
        outcome: 'result',
        eligible: true,
        permitted: true,
        backoff: 0,
        result: timeout
      },
      {
        attempt: 2,
        outcome: 'result',
        eligible: false,
        permitted: false,
        backoff: null,
        result: pass
      }
    ]);
  });

test('three teardown timeouts exhaust the hard bound and return the third result', async () => {
  const results = [teardownTimeoutResult(), teardownTimeoutResult(), teardownTimeoutResult()];
  const delegate = fakeEvaluator(results);
  const records = [];
  const evaluator = new LiveUnityRetryEvaluator(delegate, {
    maxAttempts: MAX_LIVE_UNITY_ATTEMPTS,
    backoffMs: [0, 0],
    async writeAttempt(record) {
      records.push(record);
    }
  });

  assert.equal(await evaluator.evaluate({}), results[2]);
  assert.equal(delegate.calls, 3);
  assert.deepEqual(records.map((record) => record.retryPermitted), [true, true, false]);
  assert.deepEqual(records.map((record) => record.attempt), [1, 2, 3]);
});

test('non-retryable compile, natural nonzero, report, and abort failures run once', async (t) => {
  const cases = [
    {
      name: 'compile failure',
      change(result) {
        result.checks[0] = baseCheck('unity-compile', 'compile', {
          status: 'failed',
          passed: false,
          exitCode: 1,
          failure: { code: 'UNEXPECTED_EXIT_CODE', message: 'compile failed', details: null }
        });
      }
    },
    {
      name: 'natural EditMode nonzero',
      change(result) {
        Object.assign(result.checks[1], {
          exitCode: 1,
          signal: null,
          timedOut: false,
          failure: { code: 'UNEXPECTED_EXIT_CODE', message: 'tests failed', details: null }
        });
      }
    },
    {
      name: 'test report failure',
      change(result) {
        Object.assign(result.checks[1], baseCheck('unity-editmode-tests', 'test'));
        Object.assign(result.checks[2], {
          status: 'failed',
          passed: false,
          exitCode: 1,
          terminationConfirmed: true,
          failure: { code: 'UNEXPECTED_EXIT_CODE', message: 'bad report', details: null }
        });
      }
    },
    {
      name: 'aborted EditMode',
      change(result) {
        Object.assign(result.checks[1], {
          timedOut: false,
          aborted: true,
          failure: { code: 'COMMAND_ABORTED', message: 'aborted', details: null }
        });
      }
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const failure = teardownTimeoutResult();
      item.change(failure);
      const delegate = fakeEvaluator([failure, passingResult()]);
      const records = [];
      const evaluator = new LiveUnityRetryEvaluator(delegate, {
        backoffMs: [0, 0],
        async writeAttempt(record) {
          records.push(record);
        }
      });
      assert.equal(await evaluator.evaluate({}), failure);
      assert.equal(delegate.calls, 1);
      assert.equal(records.length, 1);
      assert.equal(records[0].retryEligible, false);
      assert.equal(records[0].retryPermitted, false);
    });
  }
});

test('an AbortSignal interrupts backoff without starting another delegate attempt', async () => {
  const timeout = teardownTimeoutResult();
  const delegate = fakeEvaluator([timeout, passingResult()]);
  const controller = new AbortController();
  let firstRecorded;
  const recordWritten = new Promise((resolve) => {
    firstRecorded = resolve;
  });
  const records = [];
  const evaluator = new LiveUnityRetryEvaluator(delegate, {
    backoffMs: [60_000, 60_000],
    async writeAttempt(record) {
      records.push(record);
      firstRecorded();
    }
  });

  const pending = evaluator.evaluate({ signal: controller.signal });
  await recordWritten;
  controller.abort(new Error('stop retrying'));

  assert.equal(await pending, timeout);
  assert.equal(delegate.calls, 1);
  assert.equal(records.length, 1);
});

test('delegate exceptions are recorded once and rethrown by identity without retry', async (t) => {
  for (const code of ['FWA_PROCESS_TERMINATION_UNCONFIRMED', 'UNEXPECTED_INFRA_FAILURE']) {
    await t.test(code, async () => {
      const failure = Object.assign(new Error(code), { code, details: { attempt: 1 } });
      const delegate = fakeEvaluator([failure, passingResult()]);
      const records = [];
      const evaluator = new LiveUnityRetryEvaluator(delegate, {
        backoffMs: [0, 0],
        async writeAttempt(record) {
          records.push(record);
        }
      });

      await assert.rejects(evaluator.evaluate({}), (error) => error === failure);
      assert.equal(delegate.calls, 1);
      assert.equal(records.length, 1);
      assert.equal(records[0].outcome, 'error');
      assert.equal(records[0].retryEligible, false);
      assert.equal(records[0].retryPermitted, false);
      assert.equal(records[0].error.code, code);
      assert.deepEqual(records[0].error.details, { attempt: 1 });
    });
  }
});

test('attempt writer failure is fail-closed and prevents retry', async () => {
  const writerFailure = new Error('evidence storage unavailable');
  const delegate = fakeEvaluator([teardownTimeoutResult(), passingResult()]);
  const evaluator = new LiveUnityRetryEvaluator(delegate, {
    backoffMs: [0, 0],
    async writeAttempt() {
      throw writerFailure;
    }
  });

  await assert.rejects(evaluator.evaluate({}), (error) => error === writerFailure);
  assert.equal(delegate.calls, 1);
});

test('constructor enforces an injected writer, bounded attempts, and bounded backoff', () => {
  const delegate = fakeEvaluator([]);
  assert.throws(
    () => new LiveUnityRetryEvaluator(delegate),
    /writeAttempt must be a function/u
  );
  assert.throws(
    () => new LiveUnityRetryEvaluator(delegate, {
      maxAttempts: MAX_LIVE_UNITY_ATTEMPTS + 1,
      writeAttempt() {}
    }),
    /maxAttempts/u
  );
  assert.throws(
    () => new LiveUnityRetryEvaluator(delegate, {
      backoffMs: [0],
      writeAttempt() {}
    }),
    /backoffMs/u
  );
  assert.throws(
    () => new LiveUnityRetryEvaluator(delegate, {
      backoffMs: [0, 60_001],
      writeAttempt() {}
    }),
    /backoffMs/u
  );
});
