import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the FWA core has no sibling-framework or adapter dependency', async () => {
  const coreDirectory = path.join(repositoryRoot, 'src', 'core');
  const files = (await readdir(coreDirectory)).filter((file) => file.endsWith('.js'));

  for (const file of files) {
    const source = await readFile(path.join(coreDirectory, file), 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((match) => match[1])
      .filter((specifier) => /^(?:node:|\.{1,2}\/|@|[A-Za-z0-9])/.test(specifier));
    assert.deepEqual(
      imports.filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('./')),
      [],
      `${file} imports an external or upper-layer module`
    );
    assert.doesNotMatch(source, /(?:^|[/'"])(?:fw|fwe)(?:[/'"]|$)/i);
  }

  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
  );
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(packageJson.devDependencies ?? {}, {});
});

test('package exports keep application, core, and storage entry points explicit', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
  );
  assert.deepEqual(packageJson.exports, {
    '.': './src/index.js',
    './core': './src/core/index.js',
    './application/integration-regression-gate': './src/application/integration-regression-gate.js',
    './adapters/command-evaluator': './src/adapters/command-evaluator.js',
    './adapters/codex-executor': './src/adapters/codex-executor.js',
    './adapters/file-operations-executor': './src/adapters/file-operations-executor.js',
    './adapters/git-integration': './src/adapters/git-integration.js',
    './adapters/git-integration-workspace': './src/adapters/git-integration-workspace.js',
    './adapters/git-worktree': './src/adapters/git-worktree.js',
    './adapters/unity-evaluator-profile': './src/adapters/unity-evaluator-profile.js',
    './storage/artifact-store': './src/storage/artifact-store.js',
    './storage/file-event-store': './src/storage/file-event-store.js',
    './storage/workspace-lease': './src/storage/workspace-lease.js',
    './storage/workspace-archive': './src/storage/workspace-archive.js'
  });

  const applicationApi = await import('fwa');
  const coreApi = await import('fwa/core');
  const codexApi = await import('fwa/adapters/codex-executor');
  const unityApi = await import('fwa/adapters/unity-evaluator-profile');
  const integrationWorkspaceApi = await import('fwa/adapters/git-integration-workspace');
  const regressionGateApi = await import('fwa/application/integration-regression-gate');
  const storageApi = await import('fwa/storage/file-event-store');
  const archiveApi = await import('fwa/storage/workspace-archive');
  assert.equal(typeof applicationApi.FwaApplication, 'function');
  assert.equal(typeof applicationApi.EvaluationOrchestrator, 'function');
  assert.equal(typeof applicationApi.IntegrationOrchestrator, 'function');
  assert.equal(typeof applicationApi.GitIntegrationAdapter, 'function');
  assert.equal(typeof applicationApi.GitIntegrationWorkspaceAdapter, 'function');
  assert.equal(typeof applicationApi.CommandEvaluator, 'function');
  assert.equal(typeof applicationApi.CodexExecutor, 'function');
  assert.equal(typeof applicationApi.createUnityEvaluatorProfile, 'function');
  assert.equal(typeof applicationApi.runIntegrationRegressionGate, 'function');
  assert.equal(typeof archiveApi.WorkspaceArchiveStore, 'function');
  assert.equal(applicationApi.CodexExecutor, codexApi.CodexExecutor);
  assert.equal(
    applicationApi.createUnityEvaluatorProfile,
    unityApi.createUnityEvaluatorProfile
  );
  assert.equal(
    applicationApi.GitIntegrationWorkspaceAdapter,
    integrationWorkspaceApi.GitIntegrationWorkspaceAdapter
  );
  assert.equal(
    applicationApi.runIntegrationRegressionGate,
    regressionGateApi.runIntegrationRegressionGate
  );
  assert.equal(typeof coreApi.validatePlan, 'function');
  assert.equal(typeof coreApi.createEvent, 'function');
  assert.equal(typeof coreApi.validateActualWrites, 'function');
  assert.equal(typeof coreApi.selectExecutor, 'function');
  assert.equal(typeof coreApi.validateEvaluator, 'function');
  assert.equal(typeof coreApi.validateEvidenceAgainstProfile, 'function');
  assert.equal(typeof storageApi.FileEventStore, 'function');
});
