import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function factory() {
  const context = vm.createContext({ window: { fwe: { registerView() {} } } });
  vm.runInContext(await readFile(new URL('../src/editor/app/console.js', import.meta.url), 'utf8'), context);
  return context.window.FwaConsoleCommandJournal;
}
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('unconfirmed console intent survives redraw, tab switch, reload and server restart with the same project identity', async () => {
  const create = await factory();
  const session = storage();
  let counter = 0;
  const id = () => `console-${++counter}`;
  const payload = { title: 'Lost HTTP response', request: 'Record exactly once' };
  const first = create(session, 'project-1', id);
  assert.equal(first.begin('goal.create', payload), 'console-1');
  assert.equal(first.begin('goal.create', payload), 'console-1');
  assert.equal(first.begin('goal.create', { ...payload, title: 'Different intent' }), 'console-2');
  const remounted = create(session, 'project-1', id);
  assert.equal(remounted.begin('goal.create', payload), 'console-1');
  const reloadedFactory = await factory();
  const reloaded = reloadedFactory(session, 'project-1', id);
  assert.equal(reloaded.begin('goal.create', payload), 'console-1');
  reloaded.acknowledge('goal.create', payload, 'wrong-response-id');
  assert.equal(reloaded.begin('goal.create', payload), 'console-1');
  reloaded.acknowledge('goal.create', payload, 'console-1');
  assert.equal(reloaded.begin('goal.create', payload), 'console-3');
  assert.equal(create(session, 'project-2', id).begin('goal.create', payload), 'console-4');
});

test('unavailable pending-command storage fails before an id is returned for dispatch', async () => {
  const create = await factory();
  const journal = create({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, 'project', () => 'console-1');
  assert.throws(() => journal.begin('goal.create', { title: 'Not sent' }), /quota/);
  const malformed = create({ getItem: () => '{invalid' }, 'project');
  assert.throws(() => malformed.begin('goal.create', { title: 'Not sent' }));
});
