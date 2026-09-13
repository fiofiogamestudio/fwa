import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createGitEnvironment } from './git-environment.js';
import { GitProcessGuard, runGitProcess } from './git-process.js';

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const fail = (message, code = 'experiment-workspace-invalid', details) => Object.assign(new Error(message), { code, details });

async function directory(target, create = false) {
  if (create) await mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Experiment storage must use physical directories.');
}

/** Owns two detached worktrees; never changes the project's target branch or checkout. */
export class GitExperimentWorkspace {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.guard = new GitProcessGuard(this.projectRoot);
  }

  async git(args, { cwd = this.projectRoot, allowedExitCodes = [0], env } = {}) {
    return this.guard.run(runGitProcess, 'git', ['-c', 'submodule.recurse=false', ...args], {
      cwd, allowedExitCodes, env: env ?? createGitEnvironment(), timeoutMs: 120000,
    });
  }

  async target(targetRef) {
    if (typeof targetRef !== 'string' || !targetRef.startsWith('refs/heads/')
      || /[\s~^:?*\[\\]/.test(targetRef) || targetRef.includes('..') || targetRef.includes('@{')) {
      throw fail('An experiment requires one explicit local target branch.');
    }
    await directory(this.projectRoot);
    const root = (await this.git(['rev-parse', '--show-toplevel'])).stdout.trim();
    const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (comparable(await realpath(root)) !== comparable(await realpath(this.projectRoot))) {
      throw fail('Experiment project must be a Git repository root.');
    }
    const revision = (await this.git(['rev-parse', '--verify', '--end-of-options', `${targetRef}^{commit}`])).stdout.trim();
    if (!objectId.test(revision)) throw fail('Git returned an invalid target revision.');
    return revision;
  }

  async createPair({ experimentId, targetRef, baselineRevision, excludedRevision }) {
    if (!/^exp-[a-f0-9]{32}$/.test(experimentId) || !objectId.test(baselineRevision) || !objectId.test(excludedRevision)) {
      throw fail('Invalid experiment identity or immutable revisions.');
    }
    if (await this.target(targetRef) !== baselineRevision) throw fail('Target changed before experiment preparation.', 'experiment-stale');
    const ancestor = await this.git(['merge-base', '--is-ancestor', excludedRevision, baselineRevision], { allowedExitCodes: [0, 1] });
    if (ancestor.status !== 0) throw fail('The selected integrated change is not in the experiment baseline.');
    const parents = (await this.git(['rev-list', '--parents', '-n', '1', excludedRevision])).stdout.trim().split(/\s+/).slice(1);
    if (parents.length < 1 || parents.length > 2) throw fail('Only ordinary and two-parent integration commits can be excluded.');
    await directory(path.join(this.projectRoot, '.fwa'));
    await directory(path.join(this.projectRoot, '.fwa', 'experiments'), true);
    const root = path.join(this.projectRoot, '.fwa', 'experiments', experimentId);
    await mkdir(root); // An existing operation is preserved, never reused or overwritten.
    const a = { label: '包含该变化', revision: baselineRevision, workspacePath: path.join(root, 'with') };
    const b = { label: '排除该变化', revision: null, workspacePath: path.join(root, 'without') };
    await this.git(['worktree', 'add', '--detach', a.workspacePath, baselineRevision]);
    await this.git(['worktree', 'add', '--detach', b.workspacePath, baselineRevision]);
    const reverted = await this.git(['-c', 'rerere.enabled=false', 'revert', '--no-commit', '--no-edit',
      ...(parents.length === 2 ? ['--mainline', '1'] : []), excludedRevision], { cwd: b.workspacePath, allowedExitCodes: [0, 1] });
    const conflicts = (await this.git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: b.workspacePath })).stdout.split('\0').filter(Boolean);
    if (conflicts.length) return { status: 'conflict', experimentId, a, b, conflicts };
    if (reverted.status !== 0) throw fail('Git could not exclude the selected change.', 'experiment-revert-failed', { stderr: reverted.stderr });
    const tree = (await this.git(['write-tree'], { cwd: b.workspacePath })).stdout.trim();
    const baseTree = (await this.git(['rev-parse', `${baselineRevision}^{tree}`])).stdout.trim();
    if (tree === baseTree) throw fail('Excluding this change does not alter the current version.', 'experiment-empty-difference');
    const env = createGitEnvironment({ GIT_AUTHOR_NAME: 'FWA Experiment', GIT_AUTHOR_EMAIL: 'fwa@localhost',
      GIT_COMMITTER_NAME: 'FWA Experiment', GIT_COMMITTER_EMAIL: 'fwa@localhost' });
    b.revision = (await this.git(['commit-tree', tree, '-p', baselineRevision, '-m', `FWA experiment: exclude ${excludedRevision}`],
      { cwd: b.workspacePath, env })).stdout.trim();
    if (!objectId.test(b.revision)) throw fail('Git returned an invalid experiment candidate.');
    await this.git(['update-ref', 'HEAD', b.revision, baselineRevision], { cwd: b.workspacePath });
    await this.git(['revert', '--quit'], { cwd: b.workspacePath });
    await this.git(['update-ref', `refs/fwa/experiments/${experimentId}/with`, a.revision, '']);
    await this.git(['update-ref', `refs/fwa/experiments/${experimentId}/without`, b.revision, '']);
    const patch = (await this.git(['diff', '--binary', '--full-index', a.revision, b.revision, '--'])).stdout;
    const changedFiles = (await this.git(['diff', '--name-only', '-z', a.revision, b.revision, '--'])).stdout.split('\0').filter(Boolean);
    if (await this.target(targetRef) !== baselineRevision) throw fail('Target changed while preparing the experiment.', 'experiment-stale');
    return { status: 'prepared', experimentId, a, b, changedFiles, patch };
  }

  async inspectSide(side) {
    await directory(side.workspacePath);
    const revision = (await this.git(['rev-parse', 'HEAD'], { cwd: side.workspacePath })).stdout.trim();
    const branch = (await this.git(['symbolic-ref', '-q', 'HEAD'], { cwd: side.workspacePath, allowedExitCodes: [0, 1] })).stdout.trim();
    const changes = (await this.git(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: side.workspacePath })).stdout.trim();
    if (revision !== side.revision || branch || changes) throw fail('An experiment runner changed its checked-out source.', 'experiment-source-changed', { revision, changes });
  }
}
