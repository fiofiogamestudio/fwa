import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

export const PROJECT_SCHEMA_VERSION = 1;
export const FWA_DIRECTORY = '.fwa';

export class ProjectConfigurationError extends Error {
  constructor(message, code = 'project-configuration-error') {
    super(message);
    this.name = 'ProjectConfigurationError';
    this.code = code;
  }
}

function syncDirectoryWhenSupported(directoryPath) {
  let descriptor;
  try {
    descriptor = openSync(directoryPath, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function resolveProjectRoot(value = '.', cwd = process.cwd()) {
  const candidate = path.resolve(cwd, value);
  if (!existsSync(candidate)) {
    throw new ProjectConfigurationError(
      `Project directory does not exist: ${candidate}`,
      'project-not-found'
    );
  }
  const stat = lstatSync(candidate);
  if (!stat.isDirectory()) {
    throw new ProjectConfigurationError(
      `Project path is not a directory: ${candidate}`,
      'project-not-directory'
    );
  }
  return realpathSync(candidate);
}

export function projectStatePath(projectRoot) {
  return path.join(projectRoot, FWA_DIRECTORY);
}

export function initializeProject(projectRoot, now = new Date()) {
  const resolvedRoot = resolveProjectRoot(projectRoot);
  const stateDirectory = projectStatePath(resolvedRoot);

  if (existsSync(stateDirectory)) {
    const stateStat = lstatSync(stateDirectory);
    if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
      throw new ProjectConfigurationError(
        `FWA state path must be a real directory: ${stateDirectory}`,
        'unsafe-state-path'
      );
    }
  } else {
    mkdirSync(stateDirectory, { mode: 0o700 });
  }

  const configPath = path.join(stateDirectory, 'project.json');
  if (existsSync(configPath)) {
    return { initialized: false, config: loadProject(resolvedRoot) };
  }

  const lockPath = path.join(stateDirectory, '.init.lock');
  let lockDescriptor;
  let lockCreated = false;
  try {
    lockDescriptor = openSync(lockPath, 'wx', 0o600);
    lockCreated = true;
    writeFileSync(lockDescriptor, `${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() })}\n`);
    fsyncSync(lockDescriptor);
  } catch (error) {
    if (lockDescriptor !== undefined) closeSync(lockDescriptor);
    if (error?.code === 'EEXIST') {
      throw new ProjectConfigurationError(
        `Another FWA initialization owns ${lockPath}.`,
        'project-initialization-busy'
      );
    }
    if (lockCreated && existsSync(lockPath)) unlinkSync(lockPath);
    throw error;
  }

  if (existsSync(configPath)) {
    closeSync(lockDescriptor);
    unlinkSync(lockPath);
    return { initialized: false, config: loadProject(resolvedRoot) };
  }

  const config = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: `project_${randomUUID()}`,
    projectRoot: resolvedRoot,
    initializedAt: now.toISOString(),
    storage: {
      kind: 'file-event-store',
      version: 1
    }
  };

  const tempPath = path.join(stateDirectory, `.project-${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(tempPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, configPath);
    syncDirectoryWhenSupported(stateDirectory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  } finally {
    if (lockDescriptor !== undefined) closeSync(lockDescriptor);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }

  return { initialized: true, config };
}

export function loadProject(projectRoot) {
  const resolvedRoot = resolveProjectRoot(projectRoot);
  const stateDirectory = projectStatePath(resolvedRoot);
  if (!existsSync(stateDirectory)) {
    throw new ProjectConfigurationError(
      `FWA is not initialized in ${resolvedRoot}. Run "fwa init" first.`,
      'project-not-initialized'
    );
  }
  const stateStat = lstatSync(stateDirectory);
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    throw new ProjectConfigurationError(
      `FWA state path must be a real directory: ${stateDirectory}`,
      'unsafe-state-path'
    );
  }

  const configPath = path.join(stateDirectory, 'project.json');
  if (!existsSync(configPath)) {
    throw new ProjectConfigurationError(
      `Missing FWA project configuration: ${configPath}`,
      'project-config-missing'
    );
  }
  const configStat = lstatSync(configPath);
  if (configStat.isSymbolicLink() || !configStat.isFile()) {
    throw new ProjectConfigurationError(
      `FWA project configuration must be a real file: ${configPath}`,
      'unsafe-project-config'
    );
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new ProjectConfigurationError(
      `Invalid FWA project configuration: ${error.message}`,
      'project-config-invalid'
    );
  }

  if (config.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectConfigurationError(
      `Unsupported FWA project schema version: ${config.schemaVersion}`,
      'project-schema-unsupported'
    );
  }
  if (typeof config.projectId !== 'string' || !config.projectId.startsWith('project_')) {
    throw new ProjectConfigurationError(
      'FWA project configuration has an invalid projectId.',
      'project-id-invalid'
    );
  }
  if (config.projectRoot !== resolvedRoot) {
    throw new ProjectConfigurationError(
      `FWA project was initialized for ${config.projectRoot}, not ${resolvedRoot}.`,
      'project-root-mismatch'
    );
  }
  if (config.storage?.kind !== 'file-event-store' || config.storage?.version !== 1) {
    throw new ProjectConfigurationError(
      'FWA project uses an unsupported storage configuration.',
      'project-storage-unsupported'
    );
  }

  return config;
}
