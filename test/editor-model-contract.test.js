import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { INTERACTION_FIELDS, LIBRARY_ACCESS_VALUES, validateInteractionField } from '../src/core/interaction-contract.js';
import { NodeStatus, IntegrationStatus } from '../src/core/state-machines.js';
import { applyEditorModel, createEditorModel } from '../src/editor/editor-model.js';
import { OBJECT_COLLECTIONS, objectResourceName, parseObjectResourceName, listObjectResources, readObjectResource } from '../src/editor/object-resources.js';

test('FWE command fields derive constraints from the exact transport validation contract', () => {
  const model = createEditorModel();
  for (const [name, definition] of Object.entries(INTERACTION_FIELDS)) {
    const field = model.fields[`commands.${name}`];
    assert.ok(field, name);
    for (const key of ['required', 'maxLength', 'minLength', 'pattern', 'options']) assert.deepEqual(field[key], definition[key], `${name}.${key}`);
    if (definition.options) {
      for (const option of definition.options) assert.equal(validateInteractionField(name, option), option);
      assert.throws(() => validateInteractionField(name, 'not-an-enum-value'));
      assert.equal(field.type, 'select');
    } else if (definition.valueType === 'string') {
      assert.equal(validateInteractionField(name, 'x'.repeat(definition.maxLength)).length, definition.maxLength);
      assert.throws(() => validateInteractionField(name, 'x'.repeat(definition.maxLength + 1)));
      if (definition.required) assert.throws(() => validateInteractionField(name, ''));
    }
  }
  assert.equal(model.fields['commands.request'].required, false);
  assert.equal(validateInteractionField('request', '  '), '  ');
  assert.throws(() => validateInteractionField('goalRequest', '  '));
  assert.throws(() => validateInteractionField('feedback', ' leading space'));
  assert.equal(validateInteractionField('plan', { nodes: [] }).nodes.length, 0);
  assert.throws(() => validateInteractionField('plan', []));
  assert.deepEqual(LIBRARY_ACCESS_VALUES, ['read', 'write', 'deny']);
  assert.throws(() => validateInteractionField('permission', ''));
});

test('projection status metadata derives from real state machines and cannot authorize generic editing', () => {
  const domain = { inspector: { summary: false }, actions: { save: false } };
  applyEditorModel(domain);
  assert.equal(domain.model.authority, 'fwa-interaction-contract-v1');
  assert.deepEqual(domain.model.fields['nodes[].status'].options, Object.values(NodeStatus));
  assert.deepEqual(domain.model.fields['nodes[].integrationStatus'].options, [...Object.values(IntegrationStatus), null]);
  assert.equal(domain.model.fields['nodes[].status'].disabled, true);
  assert.equal(domain.inspector.summary, false);
  assert.equal(domain.inspector.forms.commands.groups[0].fields.length, Object.keys(INTERACTION_FIELDS).length);
  assert.equal(domain.actions.save, false);
  assert.ok(Object.isFrozen(INTERACTION_FIELDS.mode.options));
});

const status = {
  projectId: 'fixture-project', lastSequence: 8,
  nodes: [{ id: 'node@revision-2', goalId: 'goal/a', title: 'Node' }],
  refs: [{ id: 'ref://document/docs/brief.md', uri: 'docs/brief.md' }],
  runs: [{ id: 'run-1', goalId: 'goal/a' }], changeSets: [], evidence: [],
  evaluations: [{ id: 'evaluation-1', goalId: 'goal/a' }], integrations: [], reversions: [],
  goals: [{ id: 'goal/a', title: 'First' }, { id: 'goal/b', title: 'Second' }],
  workflow: { goals: [
    { id: 'goal/a', children: [{ type: 'group', id: 'shared-group', children: [{ type: 'group', id: 'nested', children: [] }] }] },
    { id: 'goal/b', children: [{ type: 'group', id: 'shared-group', children: [] }] }
  ] }
};

test('native resource list resolves virtual object files to full authoritative projection and selection', () => {
  const resources = listObjectResources(status);
  assert.equal(resources[0].name, 'projection.json');
  assert.equal(new Set(resources.map(item => item.name)).size, resources.length);
  assert.equal(readObjectResource(status, 'projection.json').data, status);
  for (const resource of resources.slice(1)) {
    const selected = parseObjectResourceName(resource.name);
    const result = readObjectResource(status, resource.name);
    assert.equal(result.type, 'json');
    assert.equal(result.data.nodes, status.nodes);
    assert.equal(result.data.lastSequence, status.lastSequence);
    assert.equal(result.data._fwaSelection.type, selected.type);
    assert.equal(result.data._fwaSelection.id, selected.id);
  }
  assert.equal(readObjectResource(status, objectResourceName('nodes', 'node@revision-2')).data._fwaSelection.goalId, 'goal/a');
  assert.equal(readObjectResource(status, objectResourceName('groups', 'shared-group', { goalId: 'goal/b' })).data._fwaSelection.goalId, 'goal/b');
  assert.equal(Object.hasOwn(status, '_fwaSelection'), false);
});

test('missing, ambiguous, malformed and noncanonical resource routes fail closed', () => {
  for (const name of ['unknown.json', '../projection.json', 'objects/nodes/missing.json',
    'objects/unknown/id.json', 'objects/refs/ref://document/docs/brief.md.json',
    'objects/nodes/%ZZ.json', 'objects/nodes/%6eode%40revision-2.json',
    'objects/groups/shared-group.json', 'objects/groups/missing/shared-group.json',
    'objects/groups/goal%2Fa/missing.json', 'objects/refs/ref%253A%252F%252Fdocument%252Fdocs%252Fbrief.md.json']) {
    assert.throws(() => readObjectResource(status, name), error => error.status === 404, name);
  }
  assert.throws(() => objectResourceName('groups', 'shared-group'), error => error.status === 404);
});

test('browser mapping uses actual FWE navigation and shared resource links with identical canonical names', async () => {
  const calls = [], window = { fwe: {
    navigation: { href: target => { calls.push(['href', target]); return 'https://local.invalid/?fweFile=' + encodeURIComponent(target.fileName); } },
    ui: { createResourceLink: options => { calls.push(['link', options]); return options; } }
  } };
  vm.runInNewContext(await readFile(new URL('../src/editor/app/navigation.js', import.meta.url), 'utf8'), { window });
  for (const type of OBJECT_COLLECTIONS) {
    const id = type === 'refs' ? 'ref://document/docs/说明.md' : 'object@revision-2';
    const options = { goalId: 'goal/a', label: 'Open object', target: '_blank' };
    const target = window.FwaNavigation.target(type, id, options);
    assert.equal(target.domainId, 'fwa-projection');
    assert.equal(target.fileName, objectResourceName(type, id, options));
    assert.ok(window.FwaNavigation.href(type, id, options).includes('fweFile='));
    const link = window.FwaNavigation.link(type, id, options);
    assert.equal(link.navigation.fileName, target.fileName);
    assert.equal(link.target, '_blank');
    assert.equal(link.label, options.label);
  }
  assert.equal(calls.filter(([method]) => method === 'href').length, OBJECT_COLLECTIONS.length);
  assert.equal(calls.filter(([method]) => method === 'link').length, OBJECT_COLLECTIONS.length);
});
