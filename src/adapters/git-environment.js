import process from 'node:process';

const GIT_ENVIRONMENT_VARIABLE = /^GIT_/iu;
const ALLOWED_OVERRIDES = new Set([
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE'
]);

/**
 * Build the environment for every Git subprocess owned by FWA.
 *
 * Git exposes repository, index, object database, namespace, replacement,
 * configuration, tracing, and transport routing through GIT_* variables. An
 * adapter must not accidentally operate on a different repository view simply
 * because its parent process was launched by another Git command. Preserve the
 * ordinary operating-system environment, remove every inherited Git variable
 * case-insensitively, and then add only FWA's fixed controls plus the explicit
 * commit identity used by commit-tree. Disable Git's built-in filesystem
 * monitor so FWA-owned temporary worktrees never inherit a long-lived daemon
 * from machine-level configuration.
 */
export function createGitEnvironment(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Git environment overrides must be an object.');
  }

  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!GIT_ENVIRONMENT_VARIABLE.test(key)) environment[key] = value;
  }
  Object.assign(environment, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false'
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (!ALLOWED_OVERRIDES.has(key) || typeof value !== 'string') {
      throw new TypeError(`Unsupported Git environment override: ${key}`);
    }
    environment[key] = value;
  }
  return environment;
}
