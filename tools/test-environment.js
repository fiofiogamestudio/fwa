// Keep every Git subprocess spawned by the test runner and its fixtures
// independent from machine-level filesystem-monitor configuration. Git's
// process-scoped configuration environment is inherited by every test worker.
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor';
process.env.GIT_CONFIG_VALUE_0 = 'false';
