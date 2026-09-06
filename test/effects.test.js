import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EffectPatternError,
  WriteSetViolationError,
  assertActualWrites,
  matchesEffectPattern,
  normalizeEffectPattern,
  normalizeWorkspacePath,
  validateActualWrites
} from '../src/core/effects.js';
import {
  ExecutorContractError,
  ExecutorSelectionError,
  executorProvidesCapabilities,
  selectExecutor,
  validateExecutor
} from '../src/core/executor.js';

test('normalizes portable relative patterns and concrete paths', () => {
  assert.equal(normalizeEffectPattern('./src//features/**/test-?.js'), 'src/features/**/test-?.js');
  assert.equal(normalizeWorkspacePath('./src//features/a.js'), 'src/features/a.js');
});

test('rejects unsafe and adapter-dependent patterns with structured evidence', () => {
  const cases = [
    ['/root/file', 'ABSOLUTE_PATH'],
    ['C:/root/file', 'ABSOLUTE_PATH'],
    ['src/../secret', 'PARENT_TRAVERSAL'],
    ['src\\file', 'BACKSLASH_IN_PATH'],
    ['src/\0file', 'NUL_IN_PATH'],
    ['ref://code/player', 'UNSUPPORTED_REF_PATH']
  ];

  for (const [value, code] of cases) {
    assert.throws(
      () => normalizeEffectPattern(value),
      (error) => error instanceof EffectPatternError
        && error.code === 'FWA_INVALID_EFFECT_PATTERN'
        && error.errors.some((entry) => entry.code === code)
    );
  }
  assert.throws(
    () => normalizeWorkspacePath('src/*.js'),
    (error) => error.errors.some((entry) => entry.code === 'GLOB_IN_ACTUAL_PATH')
  );
});

test('rejects Windows aliases that can bypass file and Git effect tracking', () => {
  for (const unsafe of [
    'out.txt:stream',
    'NUL',
    'con.txt',
    'dir/COM1.log',
    '.git/config',
    'nested/.Git/index',
    '.fwa/events/0001.json',
    'trailing.',
    'trailing ',
    'line\nbreak.txt'
  ]) {
    assert.throws(
      () => normalizeWorkspacePath(unsafe),
      (error) => error instanceof EffectPatternError
        && error.errors.length > 0
    );
  }
});

test('matches *, **, and ? with workspace path semantics', () => {
  assert.equal(matchesEffectPattern('src/*.js', 'src/a.js'), true);
  assert.equal(matchesEffectPattern('src/*.js', 'src/nested/a.js'), false);
  assert.equal(matchesEffectPattern('src/**/*.js', 'src/a.js'), true);
  assert.equal(matchesEffectPattern('src/**/*.js', 'src/deep/a.js'), true);
  assert.equal(matchesEffectPattern('assets/icon-?.png', 'assets/icon-a.png'), true);
  assert.equal(matchesEffectPattern('assets/icon-?.png', 'assets/icon-aa.png'), false);
});

test('returns and optionally throws structured out-of-scope write evidence', () => {
  const result = validateActualWrites(
    ['src/**', 'README.?d'],
    ['src/a.js', 'README.md', 'secrets.txt']
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.actualWrites, ['src/a.js', 'README.md', 'secrets.txt']);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].code, 'WRITE_OUT_OF_SCOPE');
  assert.equal(result.violations[0].details.actualWrite, 'secrets.txt');
  assert.throws(
    () => assertActualWrites(['src/**'], ['outside.txt']),
    (error) => error instanceof WriteSetViolationError
      && error.code === 'FWA_WRITE_SET_VIOLATION'
      && error.evidence.violations[0].details.actualWrite === 'outside.txt'
  );
});

test('supports explicit case-insensitive write-set comparison', () => {
  assert.equal(validateActualWrites(['SRC/**'], ['src/File.js']).ok, false);
  assert.equal(validateActualWrites(
    ['SRC/**'],
    ['src/File.js'],
    { ignoreCase: true }
  ).ok, true);
});

test('executor port validates stable identity, version, shape, and capability matching', () => {
  const fileExecutor = {
    schemaVersion: 1,
    id: 'files',
    version: '1',
    capabilities: ['file_operations'],
    async execute() {}
  };
  const networkExecutor = {
    schemaVersion: 1,
    id: 'network',
    version: '1',
    capabilities: ['network'],
    async execute() {}
  };

  assert.deepEqual(validateExecutor(fileExecutor), { ok: true, errors: [] });
  assert.equal(executorProvidesCapabilities(fileExecutor, ['file_operations']), true);
  assert.equal(executorProvidesCapabilities(fileExecutor, ['network']), false);
  assert.equal(selectExecutor([networkExecutor, fileExecutor], ['file_operations']), fileExecutor);
  assert.throws(
    () => selectExecutor([fileExecutor], ['network']),
    (error) => error instanceof ExecutorSelectionError
      && error.requiredCapabilities[0] === 'network'
  );

  const invalid = { ...fileExecutor, version: '', execute: null };
  assert.throws(() => selectExecutor([invalid], ['file_operations']), ExecutorContractError);
  assert.deepEqual(
    validateExecutor(invalid).errors.map((error) => error.code),
    ['INVALID_EXECUTOR_VERSION', 'MISSING_EXECUTE']
  );
});
