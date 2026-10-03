import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createEditorModel } from '../src/editor/editor-model.js';

const appFile = name => new URL(`../src/editor/app/${name}`, import.meta.url);
const configs = Object.fromEntries(await Promise.all(['console', 'content', 'workflow'].map(async name =>
  [name, JSON.parse(await readFile(appFile(`${name}.ui.json`), 'utf8'))])));

test('ordinary surfaces are JSON configurations with authoritative schema references, not embedded HTML/CSS', () => {
  const model = createEditorModel(); let fields = 0;
  const constraints = ['options', 'min', 'max', 'step', 'minLength', 'maxLength', 'required', 'pattern'];
  for (const [name, config] of Object.entries(configs)) {
    assert.ok(Object.keys(config.templates).length > 5, name);
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      for (const key of Object.keys(node.attrs || {})) assert.ok(!/^on|^(style|class|className|innerHTML|outerHTML|srcdoc)$/.test(key), `${name}.${key}`);
      if (node.type === 'field') {
        const field = typeof node.field === 'string' ? config.fields[node.field] : node.field;
        if (field.schemaPath) {
          fields++;
          assert.ok(model.fields[field.schemaPath], field.schemaPath);
          for (const key of constraints) assert.equal(field[key], undefined, `${name}.${field.schemaPath} duplicates ${key}`);
        }
      }
      for (const value of Object.values(node)) if (value && typeof value === 'object') {
        if (Array.isArray(value)) value.forEach(visit); else visit(value);
      }
    }
    visit(config);
  }
  assert.ok(fields >= 4, 'Requirement, feedback, permission and reversion fields retain authoritative schemas.');
  assert.equal(configs.console.templates.shell.type, 'fieldset', 'Native navigation lock must also disable descendant form controls.');
});

test('the adapter binds the actual model, native links and current FWE theme without a fallback control system', async () => {
  const calls = [];
  const context = { window: { fwe: { ui: { createSurface: (config, bindings) => { calls.push({ config, bindings }); return bindings; } } },
    FwaNavigation: { link: (type, id, options) => ({ type, id, options, addEventListener() {} }) } } };
  vm.runInNewContext(await readFile(appFile('surface-adapter.js'), 'utf8'), context);
  const adapter = context.window.FwaSurface, model = createEditorModel();
  adapter.configure({ domain: { model }, app: { labels: { fwaConsole: { uiConfigs: configs, importLimits: { maxFiles: 12 } } } } });
  const binding = adapter.create('console');
  assert.equal(calls[0].config, configs.console);
  assert.equal(binding.resolveField('commands.goalRequest'), model.fields['commands.goalRequest']);
  assert.throws(() => binding.resolveField('missing'), /Unknown FWA contract/);
  assert.equal(adapter.importLimits().maxFiles, 12);
  const link = adapter.resourceLink('groups', 'same', 'Group', { goalId: 'goal-a' });
  assert.equal(link.options.goalId, 'goal-a'); assert.equal(link.options.target, '_blank');
  const shell = await readFile(appFile('console.js'), 'utf8');
  assert.doesNotMatch(shell, /document\.createElement|\.innerHTML|\.style\.|\bel\(/);
  assert.match(shell, /navigation\.navigate/);
  const css = await readFile(appFile('console-style.js'), 'utf8');
  assert.ok(css.length < 2000);
  assert.doesNotMatch(css, /#[a-f\d]{3,8}\b|font-family|--fwa-/i);
  assert.match(css, /var\(--accent\)/);
});


test('the single workbench keeps requirements, DAG and inspector mounted without section navigation or polling graph recreation', async () => {
  assert.equal(configs.console.sections, undefined);
  const shell = JSON.stringify(configs.console.templates.shell);
  for (const ref of ['request', 'graphHost', 'detail']) assert.ok(shell.includes('"ref":"' + ref + '"'));
  assert.doesNotMatch(shell, /data-section|高级|FWA 工作台分区/);
  const source = await readFile(appFile('console.js'), 'utf8');
  assert.doesNotMatch(source, /showSection|state\.section/);
  assert.equal((source.match(/graph\?\.destroy\(/g) || []).length, 1, 'Graph is destroyed only on workbench disposal.');
  assert.match(source, /revision !== graphRevision.*graph\.update/);
});
