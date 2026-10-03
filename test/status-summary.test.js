import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { FwaApplication } from '../src/application/fwa-application.js';
import { handleConsoleApi } from '../src/editor/console-api.js';
import { objectResourceName, readObjectResource } from '../src/editor/object-resources.js';
import { summarizeStatus, STATUS_PREVIEW_MAX_BYTES } from '../src/editor/status-summary.js';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const long = '🐈界'.repeat(4000);
  const plan = { nodes: [{ id: 'work', instruction: long, acceptance: { commands: [long] } }] };
  return { projectId: 'summary-test', projectRoot: tmpdir(), lastSequence: 40, eventCount: 40,
    nodes: [{ id: 'work', goalId: 'goal', status: 'failed', validity: 'valid', dependsOn: [], runIds: ['run-1'],
      instruction: long, acceptance: { checks: [long] }, failure: { code: 'TEST_ERROR', message: long } }],
    runs: [{ id: 'run-1', nodeId: 'work', status: 'failed', inputHash: `sha256:${'a'.repeat(64)}`,
      failure: { code: 'TEST_ERROR', message: 'Failed', details: { process: { stdout: long, stderr: long, exitCode: 1 },
        invocation: { command: long, args: [long] } } } }],
    goals: [{ id: 'goal', title: 'Goal', status: 'active', nodeIds: ['work'], planId: 'plan', planHistory: [{ plan }] }],
    changeSets: [], evidence: [], evaluations: [], integrations: [], reversions: [], refs: [],
    workflow: { goals: [], feedback: [], revisions: [{ goalId: 'goal', plan }] } };
}

test('summary previews diagnostic text with UTF-8 bounds and provenance while preserving all records and contracts', () => {
  const original = fixture();
  const before = JSON.stringify(original);
  const summary = summarizeStatus(original);
  assert.equal(summary._fwaSummary.displayOnly, true);
  assert.equal(summary._fwaSummary.truncatedFieldCount, 3);
  assert.equal(summary._fwaSummary.fullStatusUrl, '/api/fwa/status');
  assert.equal(summary.eventCount, original.eventCount);
  assert.equal(summary.nodes.length, original.nodes.length);
  assert.equal(summary.runs[0].id, original.runs[0].id);
  assert.equal(summary.runs[0].inputHash, original.runs[0].inputHash);
  assert.equal(summary.runs[0].failure.details.process.exitCode, 1);
  assert.equal(summary.nodes[0].instruction, original.nodes[0].instruction);
  assert.equal(summary.nodes[0].acceptance, original.nodes[0].acceptance);
  assert.equal(summary.workflow, original.workflow);
  assert.equal(summary.goals, original.goals);
  assert.deepEqual(summary.runs[0].failure.details.invocation, original.runs[0].failure.details.invocation);
  const raw = original.runs[0].failure.details.process.stdout;
  const preview = summary.runs[0].failure.details.process.stdout;
  assert.ok(Buffer.byteLength(preview) <= STATUS_PREVIEW_MAX_BYTES);
  assert.equal(raw.startsWith(preview), true);
  assert.equal(preview.includes('\ufffd'), false);
  const field = summary._fwaSummary.fields.find(item => item.pointer === '/runs/0/failure/details/process/stdout');
  assert.equal(field.originalBytes, Buffer.byteLength(raw));
  assert.equal(field.previewBytes, Buffer.byteLength(preview));
  assert.equal(field.sha256, hash(raw));
  assert.equal(JSON.stringify(original), before);
  assert.equal(summarizeStatus(summary), summary);
});

test('small resources preserve identity; large selected resources explicitly carry a summary and canonical selection', () => {
  const small = { projectId: 'p', nodes: [{ id: 'node', goalId: 'goal' }], runs: [] };
  assert.equal(summarizeStatus(small), small);
  assert.equal(readObjectResource(small, 'projection.json').data, small);
  assert.equal(readObjectResource(small, objectResourceName('nodes', 'node')).data.nodes, small.nodes);
  const original = fixture();
  const result = readObjectResource(original, objectResourceName('runs', 'run-1'));
  assert.equal(result.data._fwaSummary.displayOnly, true);
  assert.deepEqual(result.data._fwaSelection, { type: 'runs', id: 'run-1' });
  assert.equal(result.data.nodes.length, original.nodes.length);
  assert.equal(original.runs[0].failure.details.process.stdout.length, 12000);
});

test('truncation metadata stays bounded without dropping collection elements or hiding omitted field counts', () => {
  const original = { runs: Array.from({ length: 80 }, (_, index) => ({ id: `run-${index}`,
    failure: { message: 'x'.repeat(9000) } })) };
  const summary = summarizeStatus(original);
  assert.equal(summary.runs.length, 80);
  assert.equal(summary._fwaSummary.truncatedFieldCount, 80);
  assert.equal(summary._fwaSummary.fields.length, 64);
  assert.equal(summary._fwaSummary.omittedFieldCount, 16);
  assert.equal(summary._fwaSummary.removedTextBytes, 80 * (9000 - STATUS_PREVIEW_MAX_BYTES));
  assert.deepEqual(summary.runs.map(run => run.id), original.runs.map(run => run.id));
});

test('HTTP status requires explicit summary view and preserves the default full API', async () => {
  const original = fixture();
  const app = { fwaConsole: { projectId: original.projectId, projectRoot: original.projectRoot,
    application: { getStatus: async () => original, lease: { inspect: async () => ({ held: false }) } } } };
  async function get(query) {
    let response;
    const handled = await handleConsoleApi({ app, req: { method: 'GET' }, res: { setHeader() {} },
      url: new URL(`http://localhost/api/fwa/status${query}`), sendJson: (status, data) => { response = { status, data }; } });
    assert.equal(handled, true);
    return response;
  }
  const full = await get('');
  assert.equal(full.status, 200);
  assert.equal(full.data.runs[0].failure.details.process.stdout, original.runs[0].failure.details.process.stdout);
  assert.equal(full.data._fwaSummary, undefined);
  const summary = await get('?view=summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.data._fwaSummary.displayOnly, true);
  assert.equal(summary.data.runs.length, full.data.runs.length);
  assert.equal(summary.data.workflow.goals[0].summary.attempts, full.data.workflow.goals[0].summary.attempts);
  assert.equal((await get('?view=full')).data._fwaSummary, undefined);
  assert.equal((await get('?view=unknown')).status, 400);
});

test('retained real project produces a smaller display view without changing authoritative status',
  { skip: !process.env.FWA_SUMMARY_PROJECT }, async t => {
    const app = new FwaApplication(process.env.FWA_SUMMARY_PROJECT);
    const status = await app.getStatus();
    const before = JSON.stringify(status);
    const summary = summarizeStatus(status);
    const serialized = JSON.stringify(summary);
    assert.equal(JSON.stringify(status), before);
    assert.equal(summary.lastSequence, status.lastSequence);
    for (const [key, value] of Object.entries(status)) if (Array.isArray(value)) {
      assert.equal(summary[key].length, value.length, key);
      assert.deepEqual(summary[key].map(item => item?.id), value.map(item => item?.id), key);
    }
    assert.deepEqual(summary.workflow.revisions, status.workflow.revisions);
    assert.ok(Buffer.byteLength(serialized) < Buffer.byteLength(before));
    assert.equal((await app.getStatus()).lastSequence, status.lastSequence);
    t.diagnostic(JSON.stringify({ fullBytes: Buffer.byteLength(before), summaryBytes: Buffer.byteLength(serialized),
      truncatedFieldCount: summary._fwaSummary.truncatedFieldCount, removedTextBytes: summary._fwaSummary.removedTextBytes }));
  });
