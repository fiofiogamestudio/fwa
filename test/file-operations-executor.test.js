import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FILE_OPERATIONS_CAPABILITY,
  FileOperationsExecutor,
  FileOperationsExecutorError
} from '../src/adapters/file-operations-executor.js';
import { WriteSetViolationError } from '../src/core/effects.js';

const temporaryRoots = new Set();

async function temporaryWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fwa-file-executor-'));
  temporaryRoots.add(root);
  return root;
}

test.afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => {
    await rm(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }));
});

function node(overrides = {}) {
  return {
    id: 'N-files',
    writes: ['src/**', 'obsolete.txt', 'missing.txt'],
    capabilities: [FILE_OPERATIONS_CAPABILITY],
    ...overrides
  };
}

function input(operations) {
  return { schemaVersion: 1, operations };
}

test('writes, appends, and deletes files with a JSON-friendly structured log', async () => {
  const workspaceRoot = await temporaryWorkspace();
  await writeFile(path.join(workspaceRoot, 'obsolete.txt'), 'old', 'utf8');
  const executor = new FileOperationsExecutor({ ignoreCase: false });

  const result = await executor.execute({
    workspaceRoot,
    node: node(),
    input: input([
      { type: 'write', path: './src//hello.txt', content: 'hello' },
      { type: 'append', path: 'src/hello.txt', content: ' world' },
      { type: 'delete', path: 'obsolete.txt' },
      { type: 'delete', path: 'missing.txt' }
    ])
  });

  assert.equal(await readFile(path.join(workspaceRoot, 'src', 'hello.txt'), 'utf8'), 'hello world');
  await assert.rejects(readFile(path.join(workspaceRoot, 'obsolete.txt')), { code: 'ENOENT' });
  assert.deepEqual(result.summary, {
    total: 4,
    written: 1,
    appended: 1,
    deleted: 1,
    missing: 1,
    bytes: 11
  });
  assert.deepEqual(result.log.map((entry) => entry.status), [
    'written', 'appended', 'deleted', 'missing'
  ]);
  assert.equal(result.ok, true);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('preflights the entire batch against declared writes before mutating files', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const executor = new FileOperationsExecutor();

  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: node({ writes: ['src/**'] }),
      input: input([
        { type: 'write', path: 'src/would-have-been-written.txt', content: 'x' },
        { type: 'write', path: 'outside.txt', content: 'escape' }
      ])
    }),
    (error) => error instanceof WriteSetViolationError
      && error.evidence.violations[0].details.actualWrite === 'outside.txt'
  );
  await assert.rejects(
    readFile(path.join(workspaceRoot, 'src', 'would-have-been-written.txt')),
    { code: 'ENOENT' }
  );
});

test('rejects absolute, traversal, backslash, glob, ref, and malformed operation schemas', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const executor = new FileOperationsExecutor();
  const unsafePaths = [
    path.resolve(workspaceRoot, '..', 'absolute.txt').replaceAll('\\', '/'),
    '../escape.txt',
    'src\\windows.txt',
    'src/*.txt',
    'ref://code/file'
  ];

  for (const unsafePath of unsafePaths) {
    await assert.rejects(
      executor.execute({
        workspaceRoot,
        node: node(),
        input: input([{ type: 'write', path: unsafePath, content: 'x' }])
      }),
      (error) => error instanceof FileOperationsExecutorError
        && error.code === 'FWA_INVALID_FILE_OPERATIONS'
    );
  }

  const malformed = [
    { schemaVersion: 2, operations: [] },
    input([{ type: 'shell', path: 'src/a.txt', content: 'echo unsafe' }]),
    input([{ type: 'write', path: 'src/a.txt' }]),
    input([{ type: 'delete', path: 'obsolete.txt', content: 'unexpected' }]),
    { schemaVersion: 1, operations: [{ type: 'delete', path: 'missing.txt' }], extra: true }
  ];
  for (const badInput of malformed) {
    await assert.rejects(
      executor.execute({ workspaceRoot, node: node(), input: badInput }),
      (error) => error instanceof FileOperationsExecutorError
        && error.code === 'FWA_INVALID_FILE_OPERATIONS'
        && Array.isArray(error.details.errors)
    );
  }
});

test('rejects capability mismatches and non-JSON inputs', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const executor = new FileOperationsExecutor();
  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: node({ capabilities: ['network'] }),
      input: input([{ type: 'write', path: 'src/a.txt', content: 'x' }])
    }),
    (error) => error.code === 'FWA_CAPABILITY_MISMATCH'
  );
  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: node(),
      input: input([{ type: 'write', path: 'src/a.txt', content: 1n }])
    }),
    (error) => error.code === 'FWA_NON_JSON_EXECUTOR_VALUE'
  );
});

test('rejects an existing symlink ancestor before any operation executes', async (t) => {
  const workspaceRoot = await temporaryWorkspace();
  const outsideRoot = await temporaryWorkspace();
  const linkPath = path.join(workspaceRoot, 'linked');
  try {
    await symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`symbolic links are unavailable in this environment: ${error.code}`);
      return;
    }
    throw error;
  }

  const executor = new FileOperationsExecutor();
  await assert.rejects(
    executor.execute({
      workspaceRoot,
      node: node({ writes: ['safe.txt', 'linked/**'] }),
      input: input([
        { type: 'write', path: 'safe.txt', content: 'must not exist' },
        { type: 'write', path: 'linked/escape.txt', content: 'escape' }
      ])
    }),
    (error) => error.code === 'FWA_SYMLINK_PATH'
      && error.details.path === 'linked/escape.txt'
  );
  await assert.rejects(readFile(path.join(workspaceRoot, 'safe.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(outsideRoot, 'escape.txt')), { code: 'ENOENT' });
});

test('rejects file ancestors, directory targets, and overlapping operation paths in preflight', async () => {
  const workspaceRoot = await temporaryWorkspace();
  const executor = new FileOperationsExecutor();
  await writeFile(path.join(workspaceRoot, 'parent-file'), 'x', 'utf8');
  await mkdir(path.join(workspaceRoot, 'directory'));

  const cases = [
    {
      operations: [{ type: 'write', path: 'parent-file/child.txt', content: 'x' }],
      writes: ['parent-file/**'],
      code: 'FWA_NON_DIRECTORY_ANCESTOR'
    },
    {
      operations: [{ type: 'delete', path: 'directory' }],
      writes: ['directory'],
      code: 'FWA_DIRECTORY_TARGET'
    },
    {
      operations: [
        { type: 'write', path: 'tree', content: 'x' },
        { type: 'write', path: 'tree/child.txt', content: 'y' }
      ],
      writes: ['tree', 'tree/**'],
      code: 'FWA_OVERLAPPING_OPERATION_TARGETS'
    }
  ];

  for (const example of cases) {
    await assert.rejects(
      executor.execute({
        workspaceRoot,
        node: node({ writes: example.writes }),
        input: input(example.operations)
      }),
      (error) => error.code === example.code
    );
  }
});
