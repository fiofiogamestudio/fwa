import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import '../tools/test-environment.js';

test('test environment disables inherited Git filesystem monitoring', () => {
  assert.equal(process.env.GIT_CONFIG_COUNT, '1');
  assert.equal(process.env.GIT_CONFIG_KEY_0, 'core.fsmonitor');
  assert.equal(process.env.GIT_CONFIG_VALUE_0, 'false');

  const result = spawnSync('git', ['config', '--get', 'core.fsmonitor'], {
    encoding: 'utf8',
    env: { ...process.env },
    shell: false,
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'false');
});
