import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { buildWorkbenchRepairContext, loadWorkbenchRepairDiagnostics,
  MAX_REPAIR_DIAGNOSTICS_BYTES } from '../src/application/workbench-repair-context.js';

const ref = (digit = 'a', size = 12) => ({ schemaVersion: 1, algorithm: 'sha256', digest: digit.repeat(64), size });
const node = { id: 'leaf', goalId: 'goal', logicalId: 'feature' };
function fixture(count = 1) {
  const projection = { nodes: [node], runs: [], changeSets: [], evaluations: [], evidence: [], integrations: [] };
  for (let index = 1; index <= count; index++) {
    const runId = `run_${index}`, changeSetId = `change_${index}`, evaluationId = `evaluation_${index}`, evidenceId = `evidence_${index}`;
    const binding = { runId, nodeId: node.id, goalId: node.goalId, changeSetId };
    projection.runs.push({ id: runId, ...binding, createdSequence: index, status: 'produced', baseRevision: `base-${index}` });
    projection.changeSets.push({ id: changeSetId, ...binding, valid: true, changedFiles: ['src/a.js'],
      headRevision: `head-${index}`, baseRevision: `base-${index}`, patchArtifact: ref(), executionArtifact: ref('b') });
    projection.evaluations.push({ id: evaluationId, ...binding, status: 'rejected', evidenceId });
    projection.evidence.push({ id: evidenceId, ...binding, result: 'fail', resultArtifact: ref('c'), profileArtifact: ref('d'),
      criteria: [{ id: 'behavior', kind: 'test', result: 'fail', exitCode: 1, terminationConfirmed: true,
        failure: { code: 'CHECK_FAILED', message: 'Expected output is missing' },
        stdoutArtifact: ref('e'), stderrArtifact: ref('f'), expectedArtifacts: [] }] });
  }
  return projection;
}

test('repair context retains exact candidate and log references without copying log bodies or mutating projection', () => {
  const projection = fixture();
  projection.evidence[0].criteria[0].failure.details = { stdout: 'huge raw output'.repeat(10_000) };
  const before = JSON.stringify(projection);
  const result = buildWorkbenchRepairContext(projection, node);
  assert.equal(result.summary.phase, 'validation');
  assert.equal(result.summary.retryDisposition, 'retry');
  assert.equal(result.summary.failedChecks[0].failure.code, 'CHECK_FAILED');
  assert.equal(result.references.candidateRevision, 'head-1');
  assert.equal(result.references.candidateValid, true);
  assert.deepEqual(result.references.changedFiles, ['src/a.js']);
  assert.deepEqual(result.references.patchArtifact, ref());
  assert.deepEqual(result.references.failedCheckLogs[0].stderrArtifact, ref('f'));
  assert.deepEqual(result.references.resultArtifact, ref('c'));
  assert.ok(!JSON.stringify(result).includes('huge raw output'));
  assert.equal(JSON.stringify(projection), before);
});

test('new run, revision, timestamp and log artifacts do not manufacture repair progress', () => {
  const projection = fixture(2);
  for (const [index, record] of projection.evidence.entries()) {
    record.criteria[0].failure.message = `Failure for run_${index + 1} at 2026-09-2${index + 1}T12:30:40Z`;
    record.criteria[0].stdoutArtifact = ref(index ? '1' : '2');
    record.criteria[0].durationMs = index + 100;
  }
  const single = structuredClone(projection); single.runs.pop();
  const first = buildWorkbenchRepairContext(single, node), second = buildWorkbenchRepairContext(projection, node);
  assert.equal(first.signature, second.signature);
  assert.deepEqual(first.summary, second.summary);
  assert.notDeepEqual(first.references, second.references);
  assert.equal(second.repeatedFailureCount, 2);
});

test('changed code, failure content or failing criterion each break consecutive no progress', () => {
  for (const change of [
    projection => { projection.changeSets[1].patchArtifact = ref('1'); },
    projection => { projection.evidence[1].criteria[0].failure.message = 'Expected output has the wrong value'; },
    projection => { projection.evidence[1].criteria[0].id = 'different-behavior'; }
  ]) {
    const projection = fixture(2); change(projection);
    assert.equal(buildWorkbenchRepairContext(projection, node).repeatedFailureCount, 1);
  }
});

test('execution failure without captured output remains bounded and retains full failure artifact', () => {
  const projection = fixture(2); projection.changeSets = []; projection.evaluations = []; projection.evidence = [];
  for (const run of projection.runs) run.failure = { code: 'EXECUTION_FAILED', message: 'Failed to execute',
    details: { artifactRef: ref('1'), stdout: 'x'.repeat(50_000), failure: { code: 'FWA_CODEX_SPAWN_FAILED', message: 'Missing tool' } } };
  const result = buildWorkbenchRepairContext(projection, node);
  assert.equal(result.summary.phase, 'execution');
  assert.equal(result.summary.failures.execution.retryDisposition, 'repair-environment');
  assert.deepEqual(result.references.executionFailureArtifact, ref('1'));
  assert.equal(result.references.candidateRevision, null);
  assert.equal(result.repeatedFailureCount, 2);
  assert.ok(JSON.stringify(result).length < 3_000);
});

test('logical history crosses plan revisions and excludes other goals; integration resets consecutive history', () => {
  const projection = fixture(2), current = { ...node, id: 'leaf@revision-2' };
  projection.nodes.push(current, { ...node, id: 'other', goalId: 'other' });
  for (const records of [projection.runs, projection.changeSets, projection.evaluations, projection.evidence]) records[1].nodeId = current.id;
  projection.runs.push({ ...projection.runs[1], id: 'unrelated', nodeId: 'other', goalId: 'other', createdSequence: 100 });
  assert.equal(buildWorkbenchRepairContext(projection, current).repeatedFailureCount, 2);
  projection.integrations.push({ nodeId: node.id, changeSetId: 'change_1', status: 'integrated' });
  assert.equal(buildWorkbenchRepairContext(projection, current).repeatedFailureCount, 1);
  projection.integrations.push({ nodeId: current.id, changeSetId: 'change_2', status: 'integrated' });
  assert.equal(buildWorkbenchRepairContext(projection, current), null);
});

test('context is bounded with many criteria; complete evidence remains reachable', () => {
  const projection = fixture(), criterion = projection.evidence[0].criteria[0];
  projection.evidence[0].criteria = Array.from({ length: 100 }, (_, index) => ({ ...criterion, id: `check-${index}`,
    failure: { code: 'FAILURE', message: '测'.repeat(10_000) } }));
  const result = buildWorkbenchRepairContext(projection, node);
  assert.equal(result.summary.failedChecks.length, 16);
  assert.equal(result.summary.omittedCheckCount, 84);
  assert.equal(result.references.failedCheckLogs.length, 16);
  assert.equal(result.references.omittedCheckLogCount, 84);
  assert.deepEqual(result.references.resultArtifact, ref('c'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 30_000);
});

test('passing latest attempt and never-run nodes produce no repair context', () => {
  assert.equal(buildWorkbenchRepairContext({ nodes: [node] }, node), null);
  const projection = fixture(); projection.evaluations[0].status = 'passed'; projection.evidence[0].result = 'pass';
  assert.equal(buildWorkbenchRepairContext(projection, node), null);
});

test('Map projections and malformed artifact references are handled without trusting arbitrary fields', () => {
  const projection = fixture();
  projection.changeSets[0].executionArtifact = { ...ref(), digest: '../external', raw: 'secret' };
  for (const key of Object.keys(projection)) projection[key] = new Map(projection[key].map((item, index) => [item.id ?? index, item]));
  assert.equal(buildWorkbenchRepairContext(projection, node).references.executionArtifact, null);
});

test('validation timeouts, aborts, unconfirmed termination and tracked-file mutations demand inspection', () => {
  for (const change of [
    projection => { projection.evidence[0].criteria[0].timedOut = true; },
    projection => { projection.evidence[0].criteria[0].failure.code = 'COMMAND_ABORTED'; },
    projection => { projection.evidence[0].criteria[0].terminationConfirmed = false; },
    projection => { projection.evidence[0].policyViolations = [{ code: 'EVALUATION_MUTATED_TRACKED_FILE', message: 'Changed src/a.js' }]; },
    projection => { projection.evaluations[0].failure = { code: 'EVALUATION_SETUP_FAILED', message: 'Could not create workspace' }; }
  ]) {
    const projection = fixture(); change(projection);
    assert.equal(buildWorkbenchRepairContext(projection, node).summary.retryDisposition, 'inspect');
  }
});

test('FAIL_FAST skipped checks do not imply an unconfirmed running process', () => {
  const projection = fixture();
  projection.evidence[0].criteria.push({ id: 'later', kind: 'test', result: 'fail', terminationConfirmed: false,
    failure: { code: 'FAIL_FAST', message: 'Skipped after behavior failed', details: { failedCheckId: 'behavior' } } });
  const result = buildWorkbenchRepairContext(projection, node);
  assert.equal(result.summary.retryDisposition, 'retry');
  assert.equal(result.summary.failedChecks[1].failure.details.failedCheckId, 'behavior');
});

test('invalid candidates retain explicit validity and bounded violation details', () => {
  const projection = fixture();
  projection.changeSets[0].valid = false;
  projection.changeSets[0].violations = [{ code: 'MAX_FILES_EXCEEDED', message: 'Too many changes',
    details: { actual: 5, limit: 3, recursiveOutput: 'x'.repeat(50_000) } }];
  const result = buildWorkbenchRepairContext(projection, node);
  assert.equal(result.references.candidateValid, false);
  assert.deepEqual(result.summary.violations[0].details, { actual: 5, limit: 3 });
  assert.equal(result.summary.category, 'execution-policy');
  assert.equal(result.summary.retryDisposition, 'inspect');
});

function failedExecution() {
  const projection = fixture();
  projection.evaluations = []; projection.evidence = [];
  Object.assign(projection.runs[0], { status: 'failed', workspaceStatus: 'preserved',
    failure: { code: 'EXECUTOR_FAILED', message: 'Implementation attempt failed', phase: 'verification' } });
  projection.changeSets[0].valid = false;
  projection.changeSets[0].violations = [{ code: 'EXECUTION_FAILED', message: 'Executor returned failure' }];
  return projection;
}

test('captured ordinary executor failures remain repairable without bypassing effects or budget failures', () => {
  const projection = failedExecution();
  const repair = buildWorkbenchRepairContext(projection, node);
  assert.equal(repair.summary.retryDisposition, 'retry');
  assert.equal(repair.summary.failures.execution.phase, 'verification');
  assert.deepEqual(repair.references.patchArtifact, projection.changeSets[0].patchArtifact);
  for (const code of ['MAX_FILES_EXCEEDED', 'MAX_DIFF_LINES_EXCEEDED', 'WRITE_OUTSIDE_DECLARED_EFFECTS']) {
    const limited = structuredClone(projection);
    limited.changeSets[0].violations.push({ code, message: 'The capture violated its contract' });
    const stopped = buildWorkbenchRepairContext(limited, node);
    assert.equal(stopped.summary.category, 'execution-policy');
    assert.equal(stopped.summary.retryDisposition, 'inspect');
  }
});

test('durable infrastructure failures require inspection even if an older capture is present', () => {
  for (const phase of ['setup', 'capture', 'artifact', 'reconciliation', 'execution', 'lease', 'heartbeat', 'future-phase']) {
    const projection = failedExecution(); projection.runs[0].failure.phase = phase;
    const repair = buildWorkbenchRepairContext(projection, node);
    assert.equal(repair.summary.category, 'execution-infrastructure', phase);
    assert.equal(repair.summary.retryDisposition, 'inspect', phase);
  }
});

test('lease or transport failure during executor verification never authorizes code repair', () => {
  for (const code of ['LEASE_HEARTBEAT_FAILED', 'workspace-lease-busy', 'workspace-lease-owner-mismatch',
    'event-store-locked', 'FWA_CODEX_INPUT_STREAM_FAILED', 'FWA_CODEX_OUTPUT_STREAM_FAILED']) {
    for (const wrapped of [false, true]) {
      const projection = failedExecution(), failure = { code, message: 'An infrastructure operation failed' };
      projection.runs[0].failure = { ...(wrapped ? { code: 'EXECUTION_FAILED', message: 'Executor failed',
        details: { failure } } : failure), phase: 'verification' };
      const repair = buildWorkbenchRepairContext(projection, node);
      assert.equal(repair.summary.category, 'execution-infrastructure', code);
      assert.equal(repair.summary.retryDisposition, 'inspect', code);
    }
  }
});

test('uncaptured preserved work and incomplete captures require recovery before another executor attempt', () => {
  for (const change of [
    projection => { projection.changeSets = []; },
    projection => { projection.changeSets[0].executionArtifact = null; },
    projection => { projection.changeSets[0].patchArtifact = null; },
    projection => { projection.changeSets[0].headRevision = null; },
    projection => { delete projection.runs[0].failure.phase; projection.changeSets = []; }
  ]) {
    const projection = failedExecution(); change(projection);
    const repair = buildWorkbenchRepairContext(projection, node);
    assert.equal(repair.summary.category, 'candidate-recovery');
    assert.equal(repair.summary.retryDisposition, 'inspect');
  }
  const compatible = failedExecution(); delete compatible.runs[0].failure.phase;
  delete compatible.runs[0].workspaceStatus; compatible.changeSets = [];
  assert.equal(buildWorkbenchRepairContext(compatible, node).summary.retryDisposition, 'retry',
    'Simplified adapters without durable phase/workspace fields retain their previous contract.');
});

test('explicit independent review signals never authorize an implementation repair', () => {
  for (const change of [
    projection => { projection.runs[0].failure = { code: 'REVIEW_REQUIRED', message: 'Wait for a reviewer' }; },
    projection => { projection.runs[0].failure = { code: 'FAILED', message: 'review-required for candidate' }; },
    projection => { projection.evaluations[0].failure = { code: 'REVIEW_REQUIRED' }; },
    projection => { projection.evaluations[0].failure = { message: 'review-required' }; },
    projection => { projection.evaluations[0].reason = 'REVIEW_REQUIRED'; },
    projection => { projection.evidence[0].criteria[0].code = 'REVIEW_REQUIRED'; },
    projection => { projection.evidence[0].criteria[0].message = 'review-required'; },
    projection => { projection.evidence[0].criteria[0].summary = 'REVIEW_REQUIRED'; },
    projection => { projection.evidence[0].criteria[0].failure.code = 'REVIEW_REQUIRED'; },
    projection => { projection.evidence[0].criteria[0].failure.message = 'review-required'; }
  ]) {
    const projection = fixture(); change(projection);
    const repair = buildWorkbenchRepairContext(projection, node);
    assert.equal(repair.summary.category, 'independent-review');
    assert.equal(repair.summary.retryDisposition, 'inspect');
  }
});

async function logStore(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-repair-logs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  await store.init();
  return { root, store };
}

test('repair log tails include real compiler errors within a total serialized 8 KiB budget', async t => {
  const { store } = await logStore(t);
  const stderr = await store.put('UNRELATED_LOG_START\n' + '\u0000\n"测\\'.repeat(200_000)
    + '\nCompiler.cs(42,9): error CS0103: The name missingValue does not exist.\n');
  const stdout = await store.put('BUILD_LOG_START\n' + 'compiling\n'.repeat(100_000) + 'Build FAILED.\n');
  const projection = fixture(), criterion = projection.evidence[0].criteria[0];
  projection.evidence[0].criteria = [{ ...criterion, id: 'skipped', failure: { code: 'FAIL_FAST' },
    stderrArtifact: ref('9'), stdoutArtifact: ref('9') },
  ...Array.from({ length: 5 }, (_, index) => ({ ...criterion, id: `compile-${index}`,
    stderrArtifact: stderr, stdoutArtifact: stdout }))];
  const repair = buildWorkbenchRepairContext(projection, node), before = JSON.stringify(repair);
  const diagnostics = await loadWorkbenchRepairDiagnostics(store, repair);
  assert.equal(diagnostics.length, 6);
  assert.deepEqual([...new Set(diagnostics.map(item => item.checkId))], ['compile-0', 'compile-1', 'compile-2']);
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) <= MAX_REPAIR_DIAGNOSTICS_BYTES);
  for (const item of diagnostics) {
    assert.equal(item.truncated, true);
    assert.ok(!item.text.includes('LOG_START'));
    assert.ok(!item.text.includes('\ufffd'), 'UTF-8 boundaries retain complete codepoints.');
    assert.deepEqual(item.artifact, item.stream === 'stderr' ? stderr : stdout);
    assert.match(item.text, item.stream === 'stderr' ? /CS0103: The name missingValue/ : /Build FAILED/);
  }
  assert.equal(JSON.stringify(repair), before, 'Loading logs does not change repair signatures or references.');
});

test('missing log bindings or an unavailable artifact reader yield empty diagnostics', async () => {
  const repair = buildWorkbenchRepairContext(fixture(), node);
  assert.deepEqual(await loadWorkbenchRepairDiagnostics(null, repair), []);
  assert.deepEqual(await loadWorkbenchRepairDiagnostics({}, repair), []);
  const unread = { get() { assert.fail('No artifact should be read without a log binding.'); } };
  assert.deepEqual(await loadWorkbenchRepairDiagnostics(unread, null), []);
  assert.deepEqual(await loadWorkbenchRepairDiagnostics(unread, { references: { failedCheckLogs: [] } }), []);
});

test('small and JSON-looking log output stays verbatim text without loading nested references', async t => {
  const { store } = await logStore(t);
  const source = JSON.stringify({ message: 'compile failed', artifact: ref('9') });
  const log = await store.put(source), empty = await store.put('');
  const calls = [];
  const reader = { async get(reference) { calls.push(reference); return store.get(reference); } };
  const diagnostics = await loadWorkbenchRepairDiagnostics(reader,
    { references: { failedCheckLogs: [{ id: 'compile', stdoutArtifact: log, stderrArtifact: empty }] } });
  assert.deepEqual(calls, [empty, log]);
  assert.deepEqual(diagnostics, [{ checkId: 'compile', stream: 'stdout', text: source, truncated: false, artifact: log }]);
});

test('corrupt diagnostic artifacts fail explicitly instead of hiding broken evidence', async t => {
  const { root, store } = await logStore(t);
  const log = await store.put('real compiler failure');
  await writeFile(path.join(root, '.fwa', 'artifacts', 'sha256', log.digest.slice(0, 2), log.digest), 'tampered log');
  await assert.rejects(loadWorkbenchRepairDiagnostics(store,
    { references: { failedCheckLogs: [{ id: 'compile', stderrArtifact: log }] } }),
  error => error.code === 'artifact-corruption');
});
