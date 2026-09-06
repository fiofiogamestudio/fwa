import { constants as fsConstants } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  open,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';

import {
  assertActualWrites,
  normalizeWorkspacePath
} from '../core/effects.js';
import {
  EXECUTOR_SCHEMA_VERSION,
  assertExecutor,
  executorProvidesCapabilities
} from '../core/executor.js';

export const FILE_OPERATIONS_SCHEMA_VERSION = 1;
export const FILE_OPERATIONS_CAPABILITY = 'file_operations';

const OPERATION_TYPES = new Set(['write', 'append', 'delete']);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function errorDetails(code, pathValue, message, details = undefined) {
  const issue = { code, path: pathValue, message };
  if (details !== undefined) {
    issue.details = details;
  }
  return issue;
}

export class FileOperationsExecutorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'FileOperationsExecutorError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

function validateJsonValue(value, valuePath, errors, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      errors.push(errorDetails(
        'NON_JSON_NUMBER',
        valuePath,
        'JSON numbers must be finite.'
      ));
    }
    return;
  }
  if (typeof value !== 'object') {
    errors.push(errorDetails(
      'NON_JSON_VALUE',
      valuePath,
      `Values of type ${typeof value} are not JSON compatible.`
    ));
    return;
  }
  if (ancestors.has(value)) {
    errors.push(errorDetails('CYCLIC_VALUE', valuePath, 'Cyclic values are not JSON compatible.'));
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    errors.push(errorDetails(
      'NON_PLAIN_OBJECT',
      valuePath,
      'Only arrays and plain objects are JSON compatible executor inputs.'
    ));
    return;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateJsonValue(value[index], `${valuePath}[${index}]`, errors, ancestors);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      validateJsonValue(child, `${valuePath}.${key}`, errors, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertJsonFriendly(value, valuePath) {
  const errors = [];
  validateJsonValue(value, valuePath, errors, new Set());
  if (errors.length > 0) {
    throw new FileOperationsExecutorError(
      'FWA_NON_JSON_EXECUTOR_VALUE',
      `Executor value at ${valuePath} is not JSON compatible.`,
      { errors }
    );
  }
}

function assertKnownFields(value, allowed, valuePath, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(errorDetails(
        'UNKNOWN_FIELD',
        `${valuePath}.${key}`,
        `Unknown field "${key}".`
      ));
    }
  }
}

function validateInput(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    throw new FileOperationsExecutorError(
      'FWA_INVALID_FILE_OPERATIONS',
      'File operations input must be a plain object.',
      { errors: [errorDetails('INVALID_INPUT', 'input', 'Expected a plain object.')] }
    );
  }
  assertKnownFields(input, ['schemaVersion', 'operations'], 'input', errors);
  if (input.schemaVersion !== FILE_OPERATIONS_SCHEMA_VERSION) {
    errors.push(errorDetails(
      'UNSUPPORTED_SCHEMA',
      'input.schemaVersion',
      `Expected file operations schema version ${FILE_OPERATIONS_SCHEMA_VERSION}.`
    ));
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    errors.push(errorDetails(
      'INVALID_OPERATIONS',
      'input.operations',
      'Expected a non-empty operations array.'
    ));
  }

  const normalized = [];
  if (Array.isArray(input.operations)) {
    for (let index = 0; index < input.operations.length; index += 1) {
      const operation = input.operations[index];
      const operationPath = `input.operations[${index}]`;
      if (!isPlainObject(operation)) {
        errors.push(errorDetails('INVALID_OPERATION', operationPath, 'Expected a plain object.'));
        continue;
      }
      assertKnownFields(operation, ['type', 'path', 'content'], operationPath, errors);
      if (!OPERATION_TYPES.has(operation.type)) {
        errors.push(errorDetails(
          'INVALID_OPERATION_TYPE',
          `${operationPath}.type`,
          'Operation type must be write, append, or delete.'
        ));
      }

      let normalizedPath;
      try {
        normalizedPath = normalizeWorkspacePath(operation.path, {
          path: `${operationPath}.path`
        });
      } catch (error) {
        if (Array.isArray(error.errors)) {
          errors.push(...error.errors);
        } else {
          throw error;
        }
      }

      if (operation.type === 'write' || operation.type === 'append') {
        if (typeof operation.content !== 'string') {
          errors.push(errorDetails(
            'INVALID_CONTENT',
            `${operationPath}.content`,
            `${operation.type} operations require string content.`
          ));
        }
      } else if (operation.type === 'delete' && Object.hasOwn(operation, 'content')) {
        errors.push(errorDetails(
          'UNEXPECTED_CONTENT',
          `${operationPath}.content`,
          'delete operations do not accept content.'
        ));
      }

      if (OPERATION_TYPES.has(operation.type)
        && normalizedPath !== undefined
        && ((operation.type === 'delete') || typeof operation.content === 'string')) {
        const item = { type: operation.type, path: normalizedPath };
        if (operation.type !== 'delete') {
          item.content = operation.content;
        }
        normalized.push(Object.freeze(item));
      }
    }
  }

  if (errors.length > 0) {
    throw new FileOperationsExecutorError(
      'FWA_INVALID_FILE_OPERATIONS',
      `File operations validation failed with ${errors.length} error(s).`,
      { errors }
    );
  }
  return Object.freeze(normalized);
}

function assertWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string'
    || workspaceRoot.length === 0
    || workspaceRoot !== workspaceRoot.trim()) {
    throw new FileOperationsExecutorError(
      'FWA_INVALID_WORKSPACE',
      'workspaceRoot must be a non-empty, trimmed path.'
    );
  }
  return path.resolve(workspaceRoot);
}

function isLexicallyContained(workspaceRoot, targetPath, ignoreCase) {
  const relative = path.relative(workspaceRoot, targetPath);
  if (relative.length === 0 || path.isAbsolute(relative)) {
    return false;
  }
  const comparison = ignoreCase ? relative.toLocaleLowerCase('en-US') : relative;
  return comparison !== '..' && !comparison.startsWith(`..${path.sep}`);
}

async function lstatIfPresent(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function assertSafeExistingChain(workspaceRoot, targetPath, operationPath) {
  const rootStats = await lstatIfPresent(workspaceRoot);
  if (!rootStats || !rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new FileOperationsExecutorError(
      'FWA_UNSAFE_WORKSPACE',
      'workspaceRoot must be an existing, non-symlink directory.',
      { workspaceRoot }
    );
  }

  const relative = path.relative(workspaceRoot, targetPath);
  const segments = relative.split(path.sep);
  let current = workspaceRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stats = await lstatIfPresent(current);
    if (!stats) {
      break;
    }
    if (stats.isSymbolicLink()) {
      throw new FileOperationsExecutorError(
        'FWA_SYMLINK_PATH',
        `Existing path component "${current}" is a symbolic link.`,
        { path: operationPath, component: current }
      );
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new FileOperationsExecutorError(
        'FWA_NON_DIRECTORY_ANCESTOR',
        `Existing path ancestor "${current}" is not a directory.`,
        { path: operationPath, component: current }
      );
    }
    if (index === segments.length - 1 && stats.isDirectory()) {
      throw new FileOperationsExecutorError(
        'FWA_DIRECTORY_TARGET',
        `File operation target "${operationPath}" is an existing directory.`,
        { path: operationPath }
      );
    }
  }
}

function assertNoAncestorTargetCollisions(operations) {
  const targets = [...new Set(operations.map((operation) => operation.path))];
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      const a = targets[left];
      const b = targets[right];
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        throw new FileOperationsExecutorError(
          'FWA_OVERLAPPING_OPERATION_TARGETS',
          `Operation targets "${a}" and "${b}" have an ancestor relationship.`,
          { paths: [a, b] }
        );
      }
    }
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new FileOperationsExecutorError(
      'FWA_EXECUTION_ABORTED',
      'File operations execution was aborted.',
      { reason: signal.reason === undefined ? null : String(signal.reason) }
    );
  }
}

export class FileOperationsExecutor {
  constructor(options = {}) {
    this.schemaVersion = EXECUTOR_SCHEMA_VERSION;
    this.id = options.id ?? 'file-operations';
    this.version = options.version ?? '1';
    this.capabilities = Object.freeze([FILE_OPERATIONS_CAPABILITY]);
    this.ignoreCase = options.ignoreCase ?? (process.platform === 'win32');
    assertExecutor(this);
  }

  async execute({ workspaceRoot, node, input, signal } = {}) {
    assertJsonFriendly(node, 'node');
    assertJsonFriendly(input, 'input');
    const root = assertWorkspaceRoot(workspaceRoot);
    const operations = validateInput(input);

    if (!isPlainObject(node)) {
      throw new FileOperationsExecutorError(
        'FWA_INVALID_EXECUTOR_NODE',
        'node must be a plain JSON object.'
      );
    }
    if (!executorProvidesCapabilities(this, node.capabilities)) {
      throw new FileOperationsExecutorError(
        'FWA_CAPABILITY_MISMATCH',
        'The file operations executor does not provide every capability required by the node.',
        {
          requiredCapabilities: node.capabilities,
          executorCapabilities: this.capabilities
        }
      );
    }
    if (!Array.isArray(node.writes)) {
      throw new FileOperationsExecutorError(
        'FWA_INVALID_EXECUTOR_NODE',
        'node.writes must be an array of declared write patterns.'
      );
    }

    assertNoAncestorTargetCollisions(operations);
    assertActualWrites(
      node.writes,
      operations.map((operation) => operation.path),
      { ignoreCase: this.ignoreCase }
    );

    const prepared = [];
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const targetPath = path.resolve(root, ...operation.path.split('/'));
      if (!isLexicallyContained(root, targetPath, this.ignoreCase)) {
        throw new FileOperationsExecutorError(
          'FWA_PATH_ESCAPE',
          `Operation target "${operation.path}" escapes the workspace.`,
          { index, path: operation.path }
        );
      }
      await assertSafeExistingChain(root, targetPath, operation.path);
      prepared.push(Object.freeze({ operation, targetPath }));
    }

    // No filesystem mutation occurs before every operation, capability, effect,
    // containment, and existing-path check above has passed.
    throwIfAborted(signal);
    const log = [];
    for (let index = 0; index < prepared.length; index += 1) {
      const { operation, targetPath } = prepared[index];
      throwIfAborted(signal);
      await assertSafeExistingChain(root, targetPath, operation.path);
      try {
        if (operation.type === 'write' || operation.type === 'append') {
          await mkdir(path.dirname(targetPath), { recursive: true });
          // Opening with O_NOFOLLOW protects the final component on platforms
          // that implement it. Existing-chain checks cover portable behavior.
          const noFollow = fsConstants.O_NOFOLLOW ?? 0;
          const flags = operation.type === 'write'
            ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow
            : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | noFollow;
          let fileHandle;
          try {
            fileHandle = await open(targetPath, flags, 0o666);
            if (operation.type === 'write') {
              await writeFile(fileHandle, operation.content, 'utf8');
            } else {
              await appendFile(fileHandle, operation.content, 'utf8');
            }
          } finally {
            await fileHandle?.close();
          }
          log.push(Object.freeze({
            index,
            type: operation.type,
            path: operation.path,
            status: operation.type === 'write' ? 'written' : 'appended',
            bytes: Buffer.byteLength(operation.content, 'utf8')
          }));
        } else {
          const stats = await lstatIfPresent(targetPath);
          if (stats) {
            await unlink(targetPath);
          }
          log.push(Object.freeze({
            index,
            type: operation.type,
            path: operation.path,
            status: stats ? 'deleted' : 'missing',
            bytes: 0
          }));
        }
      } catch (error) {
        if (error instanceof FileOperationsExecutorError) {
          throw error;
        }
        throw new FileOperationsExecutorError(
          'FWA_FILE_OPERATION_FAILED',
          `File operation ${index} (${operation.type} ${operation.path}) failed.`,
          {
            index,
            operation: { type: operation.type, path: operation.path },
            completed: log,
            cause: {
              code: typeof error?.code === 'string' ? error.code : null,
              message: error instanceof Error ? error.message : String(error)
            }
          }
        );
      }
    }

    const summary = {
      total: log.length,
      written: log.filter((entry) => entry.status === 'written').length,
      appended: log.filter((entry) => entry.status === 'appended').length,
      deleted: log.filter((entry) => entry.status === 'deleted').length,
      missing: log.filter((entry) => entry.status === 'missing').length,
      bytes: log.reduce((total, entry) => total + entry.bytes, 0)
    };
    const result = {
      ok: true,
      summary,
      operations: operations.map((operation, index) => ({
        index,
        type: operation.type,
        path: operation.path
      })),
      log
    };
    assertJsonFriendly(result, 'result');
    return result;
  }
}
