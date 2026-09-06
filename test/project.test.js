import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  initializeProject,
  loadProject,
  ProjectConfigurationError
} from '../src/application/project.js';

function withTemporaryProject(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'fwa-project-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('initializeProject creates one stable project identity', () => {
  withTemporaryProject((root) => {
    const first = initializeProject(root, new Date('2026-09-05T00:00:00.000Z'));
    const second = initializeProject(root, new Date('2026-09-06T00:00:00.000Z'));

    assert.equal(first.initialized, true);
    assert.equal(second.initialized, false);
    assert.deepEqual(second.config, first.config);
    assert.deepEqual(loadProject(root), first.config);
  });
});

test('loadProject rejects an unsupported schema instead of guessing', () => {
  withTemporaryProject((root) => {
    initializeProject(root);
    const configPath = path.join(root, '.fwa', 'project.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.schemaVersion = 999;
    writeFileSync(configPath, `${JSON.stringify(config)}\n`, 'utf8');

    assert.throws(
      () => loadProject(root),
      (error) => error instanceof ProjectConfigurationError
        && error.code === 'project-schema-unsupported'
    );
  });
});
