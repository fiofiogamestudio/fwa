import { lstat, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import { CommandEvaluator } from './adapters/command-evaluator.js';
import { CodexExecutor } from './adapters/codex-executor.js';
import { FileOperationsExecutor } from './adapters/file-operations-executor.js';
import { GitIntegrationAdapter } from './adapters/git-integration.js';
import { GitIntegrationWorkspaceAdapter } from './adapters/git-integration-workspace.js';
import { GitWorktreeAdapter } from './adapters/git-worktree.js';
import { FwaApplication } from './application/fwa-application.js';

const HELP = `FWA - traceable agentic development orchestration

Usage:
  fwa init [--project <path>] [--json]
  fwa goal create <title> [--request <text>] [--command-id <id>] [--project <path>] [--json]
  fwa ref register <ref.json> [--command-id <id>] [--project <path>] [--json]
  fwa ref list [--project <path>] [--json]
  fwa ref show <ref-id> [--project <path>] [--json]
  fwa plan load <goal-id> <plan.json> [--command-id <id>] [--project <path>] [--json]
  fwa node retry <node-id> [--reason <text>] [--command-id <id>] [--project <path>] [--json]
  fwa git fence [--project <path>] [--json]
  fwa git recover --fence-id <id> --confirm-processes-stopped [--project <path>] [--json]
  fwa run next <input.json> [--executor <file-operations|codex>] [--base <revision>] [--node <id>] [--command-id <id>] [--project <path>] [--json]
  fwa run reconcile [--correlation-id <id>] [--project <path>] [--json]
  fwa evaluate run <changeset-id> <profile.json> [--command-id <id>] [--project <path>] [--json]
  fwa evaluate reconcile [--correlation-id <id>] [--project <path>] [--json]
  fwa integrate apply <changeset-id> --target <branch> [--command-id <id>] [--project <path>] [--json]
  fwa integrate gated <changeset-id> <profile.json> --target <branch> [--command-id <id>] [--project <path>] [--json]
  fwa integrate reconcile [--confirm-processes-stopped] [--correlation-id <id>] [--project <path>] [--json]
  fwa revert run <changeset-id> <profile.json> --target <branch> [--command-id <id>] [--project <path>] [--json]
  fwa revert reconcile [--confirm-processes-stopped] [--correlation-id <id>] [--project <path>] [--json]
  fwa status [--project <path>] [--json]
  fwa events [--project <path>] [--json]
  fwa verify [--project <path>] [--json]
  fwa editor --fwe-path <absolute FWE root> [--project <path>] [--port <port>] [--allow-write] [--codex-path <absolute native executable>] [--review-config <trusted JSON>] [--json]
  fwa help

The target must be a Git worktree whose ignore rules exclude .fwa/**. Runtime
state is stored in <target>/.fwa; produced changes remain on an fwa/runs/* ref,
evaluation checks run against that exact commit in a detached worktree, and
direct integration fast-forwards an exact-base local target branch. Gated
integration and reversion prepare isolated candidates and require compile and
test regression evidence before moving the target.
`;

export class CliUsageError extends Error {
  constructor(message, code = 'invalid-usage') {
    super(message);
    this.name = 'CliUsageError';
    this.code = code;
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    throw new TypeError('argv must be an array of strings.');
  }
  const options = {};
  const positionals = [];
  const valuedOptions = new Map([
    ['--project', 'project'],
    ['--fwe-path', 'fwePath'],
    ['--codex-path', 'codexPath'],
    ['--review-config', 'reviewConfig'],
    ['--port', 'port'],
    ['--request', 'request'],
    ['--reason', 'reason'],
    ['--fence-id', 'expectedFenceId'],
    ['--command-id', 'commandId'],
    ['--correlation-id', 'correlationId'],
    ['--base', 'baseRevision'],
    ['--node', 'nodeId'],
    ['--executor', 'executor'],
    ['--target', 'targetRef']
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      if (options.json) throw new CliUsageError('--json may be provided only once.');
      options.json = true;
      continue;
    }
    if (argument === '--allow-write') {
      if (options.allowWrite) throw new CliUsageError('--allow-write may be provided only once.');
      options.allowWrite = true;
      continue;
    }
    if (argument === '--confirm-processes-stopped') {
      if (options.confirmProcessesStopped) {
        throw new CliUsageError('--confirm-processes-stopped may be provided only once.');
      }
      options.confirmProcessesStopped = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    const equalsIndex = argument.indexOf('=');
    const optionName = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (valuedOptions.has(optionName)) {
      const optionKey = valuedOptions.get(optionName);
      if (Object.hasOwn(options, optionKey)) {
        throw new CliUsageError(`${optionName} may be provided only once.`);
      }
      const optionValue = equalsIndex === -1 ? argv[++index] : argument.slice(equalsIndex + 1);
      if (typeof optionValue !== 'string'
        || optionValue.length === 0
        || (equalsIndex === -1 && optionValue.startsWith('-'))) {
        throw new CliUsageError(`${optionName} requires a value.`);
      }
      options[optionKey] = optionValue;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new CliUsageError(`Unknown option ${argument}.`);
    }
    positionals.push(argument);
  }

  return { options, positionals };
}

function rejectOptions(options, allowed) {
  const unexpected = Object.keys(options)
    .filter((key) => !['json', 'help', ...allowed].includes(key));
  if (unexpected.length > 0) {
    throw new CliUsageError(
      `Option(s) not valid for this command: ${unexpected.map((key) => `--${key}`).join(', ')}.`
    );
  }
}

async function nativeCodexPath(value) {
  if (typeof value !== 'string' || value !== value.trim() || !path.isAbsolute(value)
    || (process.platform === 'win32' && ['\\', '/'].includes(path.parse(value).root))
    || /\.(?:cmd|bat)$/iu.test(value)
    || (process.platform === 'win32' && path.extname(value).toLowerCase() !== '.exe')) {
    throw new CliUsageError('--codex-path must be a fully qualified native executable path (not a .cmd/.bat wrapper).', 'invalid-codex-path');
  }
  const absolute = path.resolve(value);
  let cursor = path.parse(absolute).root;
  const parts = absolute.slice(cursor.length).split(path.sep).filter(Boolean);
  try {
    for (let index = 0; index < parts.length; index += 1) {
      cursor = path.join(cursor, parts[index]);
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink() || (index === parts.length - 1 ? !stats.isFile() : !stats.isDirectory())) {
        throw new Error('Path must not traverse symbolic links or junctions and must end in a regular file.');
      }
    }
    if (!parts.length) throw new Error('A directory is not an executable.');
    return realpathSync.native(absolute);
  } catch (error) {
    throw new CliUsageError(`Invalid --codex-path: ${error.message}`, 'invalid-codex-path');
  }
}

function requireShape(positionals, expected, usage) {
  if (positionals.length !== expected.length
    || expected.some((value, index) => value !== null && positionals[index] !== value)) {
    throw new CliUsageError(`Expected: ${usage}`);
  }
}

function writeLine(stream, value = '') {
  stream.write(`${value}\n`);
}

function writeJson(stream, value) {
  writeLine(stream, JSON.stringify(value, null, 2));
}

async function readJsonFile(file, cwd, label = 'JSON') {
  const filePath = path.resolve(cwd, file);
  let contents;
  try {
    contents = await readFile(filePath);
  } catch (error) {
    throw new CliUsageError(
      `Cannot read ${label} file ${filePath}: ${error.message}`,
      'json-file-unreadable'
    );
  }
  let source;
  if (contents.length >= 2 && contents[0] === 0xff && contents[1] === 0xfe) {
    source = contents.subarray(2).toString('utf16le');
  } else {
    const offset = contents.length >= 3
      && contents[0] === 0xef
      && contents[1] === 0xbb
      && contents[2] === 0xbf
      ? 3
      : 0;
    source = contents.subarray(offset).toString('utf8');
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new CliUsageError(
      `${label} file is not valid JSON: ${error.message}`,
      'json-file-invalid'
    );
  }
}

function errorBody(error) {
  const body = {
    ok: false,
    error: {
      code: error?.code ?? 'unexpected-error',
      message: error?.message ?? String(error)
    }
  };
  if (error?.details !== undefined) body.error.details = error.details;
  if (error?.errors !== undefined) body.error.errors = error.errors;
  return body;
}

function formatStatus(status) {
  const lines = [
    `Project: ${status.projectRoot}`,
    `Position: ${status.lastSequence} (${status.batchCount} batches, ${status.eventCount} events)`,
    `Goals: ${status.goals.length}`
  ];
  for (const goal of status.goals) {
    lines.push(`  ${goal.id}  [${goal.status}]  ${goal.title}`);
  }
  lines.push(`Refs: ${status.refs.length}`);
  for (const ref of status.refs) {
    lines.push(`  ${ref.id}  ${ref.uri}  version=${ref.version}`);
  }
  lines.push(`Nodes: ${status.nodes.length}`);
  for (const node of status.nodes) {
    const title = node.title ? `  ${node.title}` : '';
    lines.push(
      `  ${node.id}  [${node.status}; ${node.validity}; integration=${node.integrationStatus ?? 'not-integrated'}]${title}`
    );
  }
  const staleNodes = status.nodes.filter((node) => node.validity === 'stale');
  lines.push(`Stale nodes: ${staleNodes.length}`);
  for (const node of staleNodes) {
    lines.push(
      `  ${node.id}  integrations=${(node.staleByIntegrationIds ?? []).join(',') || '-'}  reversions=${(node.staleByReversionIds ?? []).join(',') || '-'}`
    );
  }
  lines.push(`Runs: ${status.runs.length}`);
  for (const run of status.runs) {
    const cleanupFailures = Array.isArray(run.cleanupFailures)
      ? run.cleanupFailures.length
      : 0;
    lines.push(
      `  ${run.id}  [${run.status}; workspace=${run.workspaceStatus}; cleanup-failures=${cleanupFailures}]  node=${run.nodeId}`
    );
  }
  lines.push(`ChangeSets: ${status.changeSets.length}`);
  lines.push(`Evaluations: ${status.evaluations.length}`);
  for (const evaluation of status.evaluations) {
    lines.push(
      `  ${evaluation.id}  [${evaluation.status}; workspace=${evaluation.workspaceStatus}]  changeset=${evaluation.changeSetId}`
    );
  }
  lines.push(`Evidence: ${status.evidence.length}`);
  lines.push(`Integrations: ${status.integrations.length}`);
  for (const integration of status.integrations) {
    lines.push(
      `  ${integration.id}  [${integration.status}]  changeset=${integration.changeSetId}  target=${integration.targetRef}`
    );
  }
  lines.push(`Reversions: ${(status.reversions ?? []).length}`);
  for (const reversion of status.reversions ?? []) {
    lines.push(
      `  ${reversion.id}  [${reversion.status}]  changeset=${reversion.sourceChangeSetId}  target=${reversion.targetRef}  affected=${reversion.affectedNodeIds?.length ?? 0}`
    );
  }
  const recoveryEvaluations = status.evaluations.filter(
    (evaluation) => evaluation.status === 'recovery-required'
  ).length;
  const recoveryIntegrations = status.integrations.filter(
    (integration) => integration.status === 'recovery-required'
  ).length;
  const recoveryReversions = (status.reversions ?? []).filter(
    (reversion) => reversion.status === 'recovery-required'
  ).length;
  lines.push(
    `Recovery required: evaluations=${recoveryEvaluations}, integrations=${recoveryIntegrations}, reversions=${recoveryReversions}`
  );
  lines.push(`Project revisions: ${status.projectRevisions.length}`);
  for (const revision of status.projectRevisions) {
    const origin = revision.kind === 'reversion'
      ? `reversion=${revision.reversionId}`
      : `integration=${revision.integrationId}`;
    lines.push(
      `  ${revision.targetRef}  ${revision.previousRevision} -> ${revision.revision}  ${origin}`
    );
  }
  return lines.join('\n');
}

export async function runCli(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const signal = io.signal;
  let wantsJson = Array.isArray(argv) && argv.some((item) => (
    typeof item === 'string' && (item === '--json' || item.startsWith('--json='))
  ));

  try {
    const { options, positionals } = parseArguments(argv);
    wantsJson = options.json === true;
    if (options.help || positionals.length === 0 || positionals[0] === 'help') {
      rejectOptions(options, []);
      if (positionals.length > 1) throw new CliUsageError('help takes no arguments.');
      writeLine(stdout, HELP.trimEnd());
      return 0;
    }

    const projectRoot = path.resolve(cwd, options.project ?? '.');
    const application = () => new FwaApplication(projectRoot);
    let result;

    if (positionals[0] === 'editor') {
      requireShape(positionals, ['editor'], 'fwa editor --fwe-path <absolute path> [--project <path>] [--port <port>] [--allow-write] [--codex-path <absolute native executable>]');
      rejectOptions(options, ['project', 'fwePath', 'port', 'allowWrite', 'codexPath', 'reviewConfig']);
      if (!options.fwePath || !path.isAbsolute(options.fwePath)) throw new CliUsageError('--fwe-path must be an absolute FWE checkout path.');
      if (options.port !== undefined && (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535)) {
        throw new CliUsageError('--port must be an integer from 1 to 65535.');
      }
      const codexPath = options.codexPath === undefined ? undefined : await nativeCodexPath(options.codexPath);
      const startEditor = io.startEditor ?? (await import('./editor/server.js')).startEditor;
      const editor = await startEditor({ projectRoot, fwePath: options.fwePath,
        port: options.port === undefined ? 3220 : Number(options.port), allowWrite: options.allowWrite === true, signal,
        ...(options.reviewConfig === undefined ? {} : { reviewConfig: path.resolve(cwd, options.reviewConfig) }),
        ...(codexPath === undefined ? {} : { workflow: { codexOptions: { executable: codexPath } } }) });
      const ready = { url: editor.url, projectRoot: editor.projectRoot, projectId: editor.projectId,
        allowWrite: editor.allowWrite, fingerprint: editor.fingerprint, protocol: editor.protocol, fwePath: editor.fwePath,
        ...(codexPath === undefined ? {} : { codexPath }) };
      if (wantsJson) writeJson(stdout, ready);
      else writeLine(stdout, `FWA console (${editor.allowWrite ? 'controlled write' : 'read-only'}): ${editor.url}\nProject: ${editor.projectRoot}\nFWE: ${editor.fwePath}${codexPath === undefined ? '' : `\nCodex: ${codexPath}`}\nOpening the console does not start a Run; workflow actions require an explicit request.`);
      await editor.closed;
      return 0;
    }

    if (positionals[0] === 'init') {
      requireShape(positionals, ['init'], 'fwa init [--project <path>] [--json]');
      rejectOptions(options, ['project']);
      result = await application().init();
      if (wantsJson) writeJson(stdout, result);
      else {
        writeLine(
          stdout,
          `${result.initialized ? 'Initialized' : 'Already initialized'} FWA project ${result.project.projectId} at ${result.project.projectRoot}.`
        );
      }
      return 0;
    }

    if (positionals[0] === 'goal' && positionals[1] === 'create') {
      requireShape(
        positionals,
        ['goal', 'create', null],
        'fwa goal create <title> [--request <text>] [--command-id <id>]'
      );
      rejectOptions(options, ['project', 'request', 'commandId']);
      result = await application().createGoal({
        title: positionals[2],
        request: options.request,
        commandId: options.commandId
      });
      if (wantsJson) writeJson(stdout, result);
      else writeLine(stdout, `${result.appended ? 'Created' : 'Reused'} goal ${result.goal.id}: ${result.goal.title}`);
      return 0;
    }

    if (positionals[0] === 'ref' && positionals[1] === 'register') {
      requireShape(
        positionals,
        ['ref', 'register', null],
        'fwa ref register <ref.json> [--command-id <id>] [--project <path>] [--json]'
      );
      rejectOptions(options, ['project', 'commandId']);
      result = await application().registerRef({
        ref: await readJsonFile(positionals[2], cwd, 'Ref'),
        commandId: options.commandId
      });
      if (wantsJson) writeJson(stdout, result);
      else writeLine(
        stdout,
        `${result.appended ? 'Registered' : 'Reused'} ${result.ref.id} -> ${result.ref.uri} @ ${result.ref.version}.`
      );
      return 0;
    }

    if (positionals[0] === 'ref' && positionals[1] === 'list') {
      requireShape(positionals, ['ref', 'list'], 'fwa ref list [--project <path>] [--json]');
      rejectOptions(options, ['project']);
      result = (await application().getStatus()).refs;
      if (wantsJson) writeJson(stdout, result);
      else if (result.length === 0) writeLine(stdout, 'No Refs.');
      else for (const ref of result) {
        writeLine(stdout, `${ref.id}  ${ref.uri}  ${ref.version}  ${ref.hash}`);
      }
      return 0;
    }

    if (positionals[0] === 'ref' && positionals[1] === 'show') {
      requireShape(
        positionals,
        ['ref', 'show', null],
        'fwa ref show <ref-id> [--project <path>] [--json]'
      );
      rejectOptions(options, ['project']);
      result = (await application().getStatus()).refs.find(
        (ref) => ref.id === positionals[2]
      );
      if (!result) throw new CliUsageError(`Ref ${positionals[2]} does not exist.`, 'ref-not-found');
      if (wantsJson) writeJson(stdout, result);
      else writeLine(stdout, `${result.id}\n  kind: ${result.kind}\n  uri: ${result.uri}\n  version: ${result.version}\n  hash: ${result.hash}`);
      return 0;
    }

    if (positionals[0] === 'plan' && positionals[1] === 'load') {
      requireShape(
        positionals,
        ['plan', 'load', null, null],
        'fwa plan load <goal-id> <plan.json> [--command-id <id>]'
      );
      rejectOptions(options, ['project', 'commandId']);
      result = await application().loadPlan({
        goalId: positionals[2],
        plan: await readJsonFile(positionals[3], cwd, 'Plan'),
        commandId: options.commandId
      });
      if (wantsJson) writeJson(stdout, result);
      else {
        writeLine(
          stdout,
          `${result.appended ? 'Loaded' : 'Reused'} plan ${result.planId} for ${result.goal.id}; ${result.nodes.length} node(s).`
        );
      }
      return 0;
    }

    if (positionals[0] === 'git' && positionals[1] === 'fence') {
      requireShape(positionals, ['git', 'fence'], 'fwa git fence [--project <path>] [--json]');
      rejectOptions(options, ['project']);
      result = await new GitWorktreeAdapter(projectRoot).inspectProcessFence();
      if (wantsJson) writeJson(stdout, result);
      else writeLine(stdout, result.held
        ? `Git operations are blocked by ${result.fence.id}. Independently stop the recorded process tree before explicit recovery. Fence: ${result.path}`
        : 'No Git process safety fence. This does not verify the whole project.');
      return result.held ? 1 : 0;
    }

    if (positionals[0] === 'git' && positionals[1] === 'recover') {
      requireShape(
        positionals, ['git', 'recover'],
        'fwa git recover --fence-id <id> --confirm-processes-stopped'
      );
      rejectOptions(options, ['project', 'expectedFenceId', 'confirmProcessesStopped']);
      if (!options.expectedFenceId || options.confirmProcessesStopped !== true) {
        throw new CliUsageError('Git recovery requires --fence-id and --confirm-processes-stopped after independently stopping the recorded process tree.');
      }
      result = await new GitWorktreeAdapter(projectRoot).recoverProcessFence({
        expectedFenceId: options.expectedFenceId,
        confirmProcessesStopped: true
      });
      if (wantsJson) writeJson(stdout, result);
      else {
        writeLine(stdout, `Released Git fence ${result.fenceId}; receipt: ${result.receiptPath}. No operation was replayed and no worktree was removed.`);
        writeLine(stdout, result.held
          ? `Git operations remain blocked by ${result.remainingFenceId ?? 'another safety record'}. Inspect 'fwa git fence' before continuing.`
          : "Run 'fwa verify' before continuing.");
      }
      return result.recovered && !result.held ? 0 : 1;
    }

    if (positionals[0] === 'node' && positionals[1] === 'retry') {
      requireShape(
        positionals,
        ['node', 'retry', null],
        'fwa node retry <node-id> [--reason <text>] [--command-id <id>]'
      );
      rejectOptions(options, ['project', 'reason', 'commandId']);
      result = await application().retryNode({
        nodeId: positionals[2],
        reason: options.reason,
        commandId: options.commandId
      });
      if (wantsJson) writeJson(stdout, result);
      else writeLine(
        stdout,
        `${result.appended ? 'Queued' : 'Reused'} ${result.mode} for node ${result.node.id}; no executor was started. Run 'fwa run next' with the corrected input.`
      );
      return 0;
    }

    if (positionals[0] === 'run' && positionals[1] === 'next') {
      requireShape(
        positionals,
        ['run', 'next', null],
        'fwa run next <input.json> [--executor <file-operations|codex>] [--base <revision>] [--node <id>] [--command-id <id>]'
      );
      rejectOptions(options, [
        'project', 'baseRevision', 'nodeId', 'commandId', 'executor'
      ]);
      const executorKind = options.executor ?? 'file-operations';
      if (!['file-operations', 'codex'].includes(executorKind)) {
        throw new CliUsageError(
          '--executor must be file-operations or codex.',
          'invalid-executor'
        );
      }
      result = await application().runNext({
        executor: executorKind === 'codex'
          ? new CodexExecutor()
          : new FileOperationsExecutor(),
        workspace: new GitWorktreeAdapter(projectRoot),
        input: await readJsonFile(
          positionals[2],
          cwd,
          executorKind === 'codex' ? 'Codex input' : 'Operations'
        ),
        baseRevision: options.baseRevision,
        nodeId: options.nodeId,
        commandId: options.commandId,
        signal
      });
      if (wantsJson) writeJson(stdout, result);
      else if (result.ok) {
        writeLine(
          stdout,
          `Produced ChangeSet ${result.changeSet.id} on ${result.changeSet.ref} for node ${result.node.id}.`
        );
        for (const warning of result.cleanup?.warnings ?? []) {
          writeLine(
            stderr,
            `[cleanup-warning] ${warning.phase}: ${warning.failure?.message ?? 'cleanup did not complete'}`
          );
        }
      } else {
        writeLine(
          stderr,
          `Run ${result.run.id} failed in ${result.run.failure?.phase ?? 'unknown'}: ${result.run.failure?.message ?? 'unknown failure'}`
        );
      }
      const cleanupComplete = result.cleanup?.worktreeRemoved === true
        && result.cleanup?.leaseReleased === true;
      return result.ok && cleanupComplete ? 0 : 1;
    }

    if (positionals[0] === 'run' && positionals[1] === 'reconcile') {
      requireShape(
        positionals,
        ['run', 'reconcile'],
        'fwa run reconcile [--correlation-id <id>] [--project <path>] [--json]'
      );
      rejectOptions(options, ['project', 'correlationId']);
      result = await application().reconcileRun({
        correlationId: options.correlationId,
        workspace: new GitWorktreeAdapter(projectRoot)
      });
      if (wantsJson) writeJson(stdout, result);
      else {
        writeLine(stdout, result.reconciled
          ? `Reconciled abandoned run (${result.reason}).`
          : `No reconciliation performed (${result.reason}).`);
        for (const item of result.cleanupResults ?? []) {
          for (const warning of item.cleanup?.warnings ?? []) {
            writeLine(
              stderr,
              `[cleanup-warning] ${item.runId} ${warning.phase}: ${warning.failure?.message ?? 'cleanup did not complete'}`
            );
          }
        }
      }
      const cleanupFailed = (result.cleanupResults ?? []).some((item) => (
        item.cleanup?.worktreeRemoved !== true || item.cleanup?.leaseReleased !== true
      ));
      return cleanupFailed ? 1 : 0;
    }

    if (positionals[0] === 'evaluate' && positionals[1] === 'run') {
      requireShape(
        positionals,
        ['evaluate', 'run', null, null],
        'fwa evaluate run <changeset-id> <profile.json> [--command-id <id>] [--project <path>] [--json]'
      );
      rejectOptions(options, ['project', 'commandId']);
      result = await application().evaluateChangeSet({
        changeSetId: positionals[2],
        profile: await readJsonFile(positionals[3], cwd, 'Evaluation profile'),
        evaluator: new CommandEvaluator(),
        workspace: new GitWorktreeAdapter(projectRoot),
        commandId: options.commandId,
        signal
      });
      if (wantsJson) writeJson(stdout, result);
      else if (result.ok) {
        writeLine(
          stdout,
          `Accepted ChangeSet ${result.changeSet.id} with Evidence ${result.evidence.id}.`
        );
      } else {
        const summary = result.evidence
          ? `Evidence ${result.evidence.id} rejected ChangeSet ${result.changeSet.id}.`
          : `Evaluation ${result.evaluation.id} stopped in state ${result.evaluation.status}.`;
        writeLine(stderr, summary);
      }
      for (const warning of result.cleanup?.warnings ?? []) {
        writeLine(
          stderr,
          `[cleanup-warning] ${warning.phase}: ${warning.failure?.message ?? 'cleanup did not complete'}`
        );
      }
      const evaluationClean = result.evaluation?.workspaceStatus === 'removed'
        && result.cleanup?.leaseReleased !== false;
      return result.ok && evaluationClean ? 0 : 1;
    }

    if (positionals[0] === 'evaluate' && positionals[1] === 'reconcile') {
      requireShape(
        positionals,
        ['evaluate', 'reconcile'],
        'fwa evaluate reconcile [--correlation-id <id>] [--project <path>] [--json]'
      );
      rejectOptions(options, ['project', 'correlationId']);
      result = await application().reconcileEvaluation({
        correlationId: options.correlationId,
        workspace: new GitWorktreeAdapter(projectRoot)
      });
      if (wantsJson) writeJson(stdout, result);
      else {
        writeLine(stdout, result.reconciled
          ? `Reconciled evaluation state (${result.reason}).`
          : `No evaluation reconciliation performed (${result.reason}).`);
        for (const warning of result.cleanup?.warnings ?? []) {
          writeLine(
            stderr,
            `[cleanup-warning] ${warning.phase}: ${warning.failure?.message ?? 'cleanup did not complete'}`
          );
        }
      }
      return result.ok ? 0 : 1;
    }

    if (positionals[0] === 'integrate' && positionals[1] === 'gated') {
      requireShape(
        positionals,
        ['integrate', 'gated', null, null],
        'fwa integrate gated <changeset-id> <profile.json> --target <branch> [--command-id <id>] [--project <path>] [--json]'
      );
      rejectOptions(options, ['project', 'targetRef', 'commandId']);
      if (options.targetRef === undefined) {
        throw new CliUsageError('--target is required for integrate gated.');
      }
      result = await application().integrateChangeSetGated({
        changeSetId: positionals[2],
        targetRef: options.targetRef,
        candidateWorkspace: new GitIntegrationWorkspaceAdapter(projectRoot),
        promotion: new GitIntegrationAdapter(projectRoot),
        evaluator: new CommandEvaluator(),
        profile: await readJsonFile(positionals[3], cwd, 'Integration regression profile'),
        evaluationWorkspace: new GitWorktreeAdapter(projectRoot),
        commandId: options.commandId,
        signal
      });
      if (wantsJson) writeJson(stdout, result);
      else if (result.ok) {
        writeLine(
          stdout,
          `Regression-gated integration ${result.integration.id} promoted ChangeSet ${result.changeSet.id} to ${result.integration.targetRef}.`
        );
      } else {
        writeLine(
          stderr,
          `Regression-gated integration ${result.integration?.id ?? 'unknown'} stopped in state ${result.integration?.status ?? 'unknown'}.`
        );
      }
      for (const warning of result.cleanup?.warnings ?? []) {
        writeLine(
          stderr,
          `[cleanup-warning] ${warning.phase}: ${warning.failure?.message ?? 'cleanup did not complete'}`
        );
      }
      const candidateClean = result.cleanup?.candidateWorkspaceRemoved === true;
      return result.ok
        && result.integration?.status === 'integrated'
        && candidateClean
        && result.cleanup?.leaseReleased === true
        ? 0
        : 1;
    }

    if (positionals[0] === 'integrate' && positionals[1] === 'apply') {
      requireShape(
        positionals,
        ['integrate', 'apply', null],
        'fwa integrate apply <changeset-id> --target <branch> [--command-id <id>] [--project <path>] [--json]'
      );
      rejectOptions(options, ['project', 'targetRef', 'commandId']);
      if (options.targetRef === undefined) {
        throw new CliUsageError('--target is required for integrate apply.');
      }
      result = await application().integrateChangeSet({
        changeSetId: positionals[2],
        targetRef: options.targetRef,
        workspace: new GitIntegrationAdapter(projectRoot),
        commandId: options.commandId,
        signal
      });
      if (wantsJson) writeJson(stdout, result);
      else if (result.ok) {
        writeLine(
          stdout,
          `Integrated ChangeSet ${result.changeSet.id} into ${result.integration.targetRef}; node ${result.node.id} remains ${result.node.status}.`
        );
      } else {
        writeLine(
          stderr,
          `Integration ${result.integration?.id ?? 'unknown'} stopped in state ${result.integration?.status ?? 'unknown'}.`
        );
      }
      for (const warning of result.cleanup?.warnings ?? []) {
        writeLine(
          stderr,
          `[cleanup-warning] ${warning.phase}: ${warning.failure?.message ?? 'cleanup did not complete'}`
        );
      }
      const integrationClean = result.cleanup?.leaseReleased === true;
      return result.ok
        && result.integration?.status === 'integrated'
        && integrationClean
        ? 0
        : 1;
    }

    if (positionals[0] === 'integrate' && positionals[1] === 'reconcile') {
      requireShape(
        positionals,
        ['integrate', 'reconcile'],
        'fwa integrate reconcile [--confirm-processes-stopped] [--correlation-id <id>] [--project <path>] [--json]'
      );
      rejectOptions(options, ['project', 'correlationId', 'confirmProcessesStopped']);
      result = await application().reconcileIntegration({
        correlationId: options.correlationId,
        confirmProcessesStopped: options.confirmProcessesStopped === true,
        workspace: new GitIntegrationAdapter(projectRoot),
        candidateWorkspace: new GitIntegrationWorkspaceAdapter(projectRoot),
        evaluationWorkspace: new GitWorktreeAdapter(projectRoot)
      });
      if (wantsJson) writeJson(stdout, result);
      else {
        writeLine(stdout, result.reconciled
          ? `Reconciled integration state (${result.reason}).`
          : `No integration reconciliation performed (${result.reason}).`);
      }
      for (const warning of result.cleanup?.warnings ?? []) {
        writeLine(
          stderr,
          `[cleanup-warning] ${warning.phase}: ${warning.failure?.message ?? 'cleanup did not complete'}`
        );
      }
      return result.ok
        && result.cleanup?.leaseReleased !== false
        && result.cleanup?.candidateWorkspaceRemoved !== false
        ? 0
        : 1;
    }

    if (positionals[0] === 'revert' && positionals[1] === 'run') {
      requireShape(
        positionals,
        ['revert', 'run', null, null],
        'fwa revert run <changeset-id> <profile.json> --target <branch> [--command-id <id>] [--project <path>] [--json]'
      );
      rejectOptions(options, ['project', 'targetRef', 'commandId']);
      if (options.targetRef === undefined) {
        throw new CliUsageError('--target is required for revert run.');
      }
      result = await application().revertChangeSet({
        changeSetId: positionals[2],
        targetRef: options.targetRef,
        candidateWorkspace: new GitIntegrationWorkspaceAdapter(projectRoot),
        promotion: new GitIntegrationAdapter(projectRoot),
        evaluator: new CommandEvaluator(),
        profile: await readJsonFile(positionals[3], cwd, 'Reversion regression profile'),
        evaluationWorkspace: new GitWorktreeAdapter(projectRoot),
        commandId: options.commandId,
        signal
      });
      if (wantsJson) writeJson(stdout, result);
      else if (result.ok) {
        writeLine(
          stdout,
          `Reversion ${result.reversion.id} reverted ChangeSet ${result.reversion.sourceChangeSetId} on ${result.reversion.targetRef}; ${result.reversion.affectedNodeIds.length} dependent node(s) invalidated.`
        );
      } else {
        writeLine(
          stderr,
          `Reversion ${result.reversion?.id ?? 'unknown'} stopped in state ${result.reversion?.status ?? 'unknown'}.`
        );
      }
      for (const warning of result.cleanup?.warnings ?? []) {
        writeLine(
          stderr,
          `[cleanup-warning] ${warning.phase}: ${warning.failure?.message ?? 'cleanup did not complete'}`
        );
      }
      const candidateClean = result.cleanup?.candidateWorkspaceRemoved === true;
      return result.ok
        && result.reversion?.status === 'reverted'
        && candidateClean
        && result.cleanup?.leaseReleased === true
        ? 0
        : 1;
    }

    if (positionals[0] === 'revert' && positionals[1] === 'reconcile') {
      requireShape(
        positionals,
        ['revert', 'reconcile'],
        'fwa revert reconcile [--confirm-processes-stopped] [--correlation-id <id>] [--project <path>] [--json]'
      );
      rejectOptions(options, ['project', 'correlationId', 'confirmProcessesStopped']);
      result = await application().reconcileReversion({
        correlationId: options.correlationId,
        confirmProcessesStopped: options.confirmProcessesStopped === true,
        promotion: new GitIntegrationAdapter(projectRoot),
        candidateWorkspace: new GitIntegrationWorkspaceAdapter(projectRoot),
        evaluationWorkspace: new GitWorktreeAdapter(projectRoot)
      });
      if (wantsJson) writeJson(stdout, result);
      else {
        writeLine(stdout, result.reconciled
          ? `Reconciled Reversion state (${result.reason}).`
          : `No Reversion reconciliation performed (${result.reason}).`);
      }
      for (const warning of result.cleanup?.warnings ?? []) {
        writeLine(
          stderr,
          `[cleanup-warning] ${warning.phase}: ${warning.failure?.message ?? 'cleanup did not complete'}`
        );
      }
      return result.ok
        && result.cleanup?.leaseReleased !== false
        && result.cleanup?.candidateWorkspaceRemoved !== false
        ? 0
        : 1;
    }

    if (positionals[0] === 'status') {
      requireShape(positionals, ['status'], 'fwa status [--project <path>] [--json]');
      rejectOptions(options, ['project']);
      result = await application().getStatus();
      if (wantsJson) writeJson(stdout, result);
      else writeLine(stdout, formatStatus(result));
      return 0;
    }

    if (positionals[0] === 'events') {
      requireShape(positionals, ['events'], 'fwa events [--project <path>] [--json]');
      rejectOptions(options, ['project']);
      result = await application().listEvents();
      if (wantsJson) writeJson(stdout, result);
      else {
        for (const event of result) {
          writeLine(
            stdout,
            `${String(event.sequence).padStart(6, ' ')}  ${event.type.padEnd(16, ' ')}  ${event.streamId}  ${event.eventId}`
          );
        }
        if (result.length === 0) writeLine(stdout, 'No events.');
      }
      return 0;
    }

    if (positionals[0] === 'verify') {
      requireShape(positionals, ['verify'], 'fwa verify [--project <path>] [--json]');
      rejectOptions(options, ['project']);
      result = await application().verify({
        workspace: new GitWorktreeAdapter(projectRoot),
        integration: new GitIntegrationAdapter(projectRoot),
        candidateWorkspace: new GitIntegrationWorkspaceAdapter(projectRoot)
      });
      if (wantsJson) writeJson(stdout, result);
      else {
        writeLine(
          stdout,
          `FWA integrity OK: ${result.batchCount} batch(es), ${result.eventCount} event(s), ${result.goalCount} goal(s), ${result.nodeCount} node(s), ${result.runCount} run(s), ${result.evaluationCount} evaluation(s), ${result.evidenceCount} evidence item(s), ${result.integrationCount} integration(s), ${result.reversionCount ?? 0} reversion(s), ${result.projectRevisionCount} project revision(s), ${result.artifactCount} artifact(s).`
        );
        if (!result.operationallyClean) {
          writeLine(
            stderr,
            `[operational-residue] active-runs=${result.activeRuns.length}, active-evaluations=${result.activeEvaluations.length}, evaluation-recovery-required=${result.evaluationRecoveryRequired.length}, active-integrations=${result.activeIntegrations.length}, integration-recovery-required=${result.integrationRecoveryRequired.length}, active-reversions=${(result.activeReversions ?? []).length}, reversion-recovery-required=${(result.reversionRecoveryRequired ?? []).length}, lease=${result.lease.held ? 'held' : 'free'}, run-cleanup=${result.pendingWorkspaceCleanup.length}, evaluation-cleanup=${result.pendingEvaluationCleanup.length}, regression-cleanup=${(result.integrationRegressionCleanupFailures ?? []).length + (result.reversionRegressionCleanupFailures ?? []).length}, evaluation-workspaces=${(result.evaluationWorkspaceResidue ?? []).length}, candidate-workspaces=${(result.candidateWorkspaceResidue ?? []).length}, orphan-candidate-refs=${(result.orphanCandidateRefs ?? []).length}, preserved=${result.preservedWorkspaces.length + result.preservedEvaluationWorkspaces.length}, unknown=${result.unknownWorkspaces.length + result.unknownEvaluationWorkspaces.length}, unreferenced-artifacts=${result.unreferencedArtifacts.length}.`
          );
        }
      }
      return result.operationallyClean ? 0 : 1;
    }

    throw new CliUsageError(`Unknown command: ${positionals.join(' ')}`);
  } catch (error) {
    if (wantsJson) writeJson(stderr, errorBody(error));
    else {
      writeLine(stderr, `[${error?.code ?? 'unexpected-error'}] ${error?.message ?? String(error)}`);
      const errors = Array.isArray(error?.errors) ? error.errors : error?.details?.errors;
      if (Array.isArray(errors)) {
        for (const detail of errors) {
          writeLine(stderr, `  - ${detail.path}: ${detail.message} (${detail.code})`);
        }
      }
    }
    return error instanceof CliUsageError ? 2 : 1;
  }
}
