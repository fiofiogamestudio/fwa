# Start with an ordinary Git project

FWA V0.1 needs Node.js 20.10+ and Git. It does not require fw, fwe, Unity,
Codex, or an npm dependency installation for this example. Run these commands
from the FWA package directory:

```powershell
node examples/basic/run.mjs --api
node examples/basic/run.mjs --cli
```

Both modes execute the same workflow in a newly created temporary Git
repository: register a Ref, load a one-Node plan, change a counter from 0 to 1,
evaluate it, merge through a regression gate, revert through a regression
gate, then verify the retained history and clean working state. Each mode uses
real Git and Node subprocesses. `--api` calls `FwaApplication`; `--cli` invokes
the actual `bin/fwa.js` entry point for every command. Neither changes the FWA
source repository or the user's global Git configuration.

The script prints progress to stderr and a JSON result to stdout. A failed
assertion or command exits nonzero. Temporary projects are retained so the
paths and evidence printed at the end remain inspectable:

```text
<temporary root>/
  project/                 ordinary Git repository with counter.mjs and tests
    .fwa/                  ignored, local FWA events and artifacts
  inputs/
    ref.json               initial Ref, with digest generated from real bytes
    plan.json              complete human-authored DAG
    operations.json        deterministic bounded executor input
    acceptance.json        syntax, regression, and feature-specific checks
    regression.json        syntax and general behavior checks
    summary.json           written after a full example succeeds
```

The profile generator uses the current Node executable's absolute path, making
the generated JSON directly executable on that host. Regenerate it on another
host. The acceptance profile demands value 1; the regression profile accepts
both valid baseline value 0 and new value 1. This distinction allows a legitimate
revert without demanding that a removed feature still exists.

## Complete manual CLI flow

`--prepare` creates only the temporary baseline and input files. The following
PowerShell example then executes every FWA command explicitly. Its helper
checks the process exit code before reading JSON:

```powershell
$fwaCli = (Resolve-Path .\bin\fwa.js).Path
$prepared = node .\examples\basic\run.mjs --prepare | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Example preparation failed.' }

function Invoke-FwaJson {
  param([string[]]$FwaArgs)
  $resultJson = & node $fwaCli @FwaArgs --project $prepared.projectRoot --json
  if ($LASTEXITCODE -ne 0) { throw "FWA failed: $FwaArgs" }
  $resultJson | ConvertFrom-Json
}

Invoke-FwaJson -FwaArgs @('init')
Invoke-FwaJson -FwaArgs @('ref', 'register', $prepared.files.ref)
$goal = Invoke-FwaJson -FwaArgs @('goal', 'create', 'Increment a standalone counter')
Invoke-FwaJson -FwaArgs @('plan', 'load', $goal.goal.id, $prepared.files.plan)
$run = Invoke-FwaJson -FwaArgs @('run', 'next', $prepared.files.operations, '--executor', 'file-operations')
Invoke-FwaJson -FwaArgs @('evaluate', 'run', $run.changeSet.id, $prepared.files.acceptance)
Invoke-FwaJson -FwaArgs @('integrate', 'gated', $run.changeSet.id, $prepared.files.regression, '--target', 'main')
Invoke-FwaJson -FwaArgs @('status')
Invoke-FwaJson -FwaArgs @('revert', 'run', $run.changeSet.id, $prepared.files.regression, '--target', 'main')
Invoke-FwaJson -FwaArgs @('events')
Invoke-FwaJson -FwaArgs @('verify')
```

After the revert, `counter.mjs` again contains value 0. The source Node keeps
its accepted history, has invalid current validity and reverted integration,
and the Goal is reopened. A clean `verify` describes operational integrity;
it does not mean the Goal is complete again.

## API composition

[`examples/basic/run.mjs`](../examples/basic/run.mjs) is the complete executable
API example.

The bundled script imports its adjacent checkout directly. In another Node
project, make this local package available before using `import ... from 'fwa'`,
for example with `npm.cmd install --save-dev D:\Git\fw\fwa` from that project's
directory. This local-development install is separate from installing fw/fwe;
this checkout's package manifest is private. The important composition is:

```js
import {
  FwaApplication, FileOperationsExecutor, CommandEvaluator,
  GitWorktreeAdapter, GitIntegrationAdapter, GitIntegrationWorkspaceAdapter
} from 'fwa';

const app = new FwaApplication(projectRoot);
const workspace = new GitWorktreeAdapter(projectRoot);
const evaluator = new CommandEvaluator();
const promotion = new GitIntegrationAdapter(projectRoot);
const candidateWorkspace = new GitIntegrationWorkspaceAdapter(projectRoot);

const run = await app.runNext({
  workspace, executor: new FileOperationsExecutor(), input: operations
});
const evaluation = await app.evaluateChangeSet({
  changeSetId: run.changeSet.id, workspace, evaluator, profile: acceptance
});
if (!evaluation.ok) throw new Error('Acceptance failed; integration must not proceed.');
const integration = await app.integrateChangeSetGated({
  changeSetId: run.changeSet.id, targetRef: 'main',
  candidateWorkspace, promotion, evaluator,
  evaluationWorkspace: workspace, profile: regression
});
if (!integration.ok) throw new Error('Integration did not complete.');
```

The snippet assumes the example's initialized application, registered Ref,
loaded plan, and generated inputs. Use the full script for runnable setup and
reversion. The package's Git ports are part of a Git-specific application
protocol; a non-Git repository is not supported by swapping one constructor.

## Declare dependencies accurately

Use `dependsOn` for execution prerequisites, and logical `reads`/`writes` for
versioned data dependencies. A dependency must be accepted, valid, and
integrated on the relevant target. Ref matching alone does not make a reverted
prerequisite usable. Conversely, unrelated Ref data does not need to become
stale merely because another output changed.

Ref tracking is based on these explicit declarations. It does not observe all
actual filesystem reads. An executor can physically read undeclared files, so
authors must declare relevant configuration, generated sources, and other
inputs; regression tests remain necessary.

The initial `hash` is a version token. For one existing file, generate a
SHA-256 from its committed bytes and retain the initial Git commit in the Ref's
version or metadata, as the example does. Use a deterministic sorted
path/content manifest for multiple files. FWA derives later hashes from its
version protocol; it does not continuously compare them with current file
contents. This is not external file-drift detection.

## Retry or recompute without deleting history

After diagnosing a failed attempt or changed input, enqueue the existing Node:

```powershell
node .\bin\fwa.js node retry increment-counter --reason 'Recompute after revert' --project <project-path> --json
node .\bin\fwa.js run next <operations.json> --node increment-counter --executor file-operations --project <project-path> --json
```

In the API, use `await app.retryNode({ nodeId: 'increment-counter', reason:
'Recompute after revert' })`. The result contains `mode: 'retry'` or
`mode: 'recompute'`, `appended`, `commandId`, and the current `node`.

Retry only changes scheduling state. It does not execute commands or reset
`budget.maxRetries`. FWA preserves old Runs, ChangeSets, and Evidence while
clearing the current attempt's acceptance/integration pointers. The next Run
freezes the latest Ref versions. Requeueing requires a planned/active Goal,
settled previous workspaces, no active operation, and usable dependencies on
the same target. A blocked dependency must be repaired first. A retry of the
same command id returns its original result; use a new command id for a new
intent.

## Git command timeouts and recovery

The three Git adapter constructors accept `gitTimeoutMs` (120,000 ms by
default, range 1..3,600,000) and `gitTerminationGraceMs` (5,000 ms by default,
range 1..60,000). These are per-command limits, not a whole-Node wall-time
budget. A timed-out process is asked to stop with its process tree; confirmation
means the managed child closed, not proof that arbitrary detached processes
cannot exist.

If closure is unconfirmed, a durable `.fwa/git-process-fence.json` prevents new
Git commands and managed workspace deletion. Additional unconfirmed commands
retain independent ids and process records in `.fwa/git-process-fences/`,
including a command already in flight when another fence is recovered. Inspect
the current blocker with:

```powershell
node .\bin\fwa.js git fence --project <project-path> --json
```

After independently confirming that all relevant processes stopped, use the
exact returned fence id:

```powershell
node .\bin\fwa.js git recover --fence-id <fence-id> --confirm-processes-stopped --project <project-path> --json
```

Recovery archives the marker and an assertion receipt under
`.fwa/git-process-recoveries/`. It clears the matching fence only; it does not
replay the interrupted command, promote a candidate, or remove a worktree.
The result includes `held` and `remainingFenceId`. If another fence remains,
the CLI exits 1 even though this particular recovery succeeded. Run `git fence`
again and confirm the next associated process has stopped before recovering
that exact id. Continue with the matching Run/Evaluation/Integration/Reversion
reconciliation command only after the Git process blockers are cleared.
The API equivalents on all three Git adapters are
`inspectProcessFence()` and `recoverProcessFence({ expectedFenceId,
confirmProcessesStopped: true })`. Time elapsed or a missing PID is not
automatic recovery authority.

During recovery, `.fwa/git-process-recovery.json` keeps new Git operations
blocked even while the original fence is being archived. `git fence` exposes
`recoveryActive` and the recorded recovery owner. If the recovery process
crashes, this guard may remain. A later process does not treat a missing owner
PID or an old timestamp as permission to clear it: inspect the guard,
associated processes, and archived recovery records before taking further
operator action.

## Generate a real Unity profile

For an existing Unity project and installed matching Editor, generate a
profile outside the target checkout (or in a directory that target ignores):

```powershell
node examples/unity/generate-profile.mjs `
  'D:\Git\my-unity-game' `
  'D:\Unity Editor\2022.3.62f3c1\Editor\Unity.exe' `
  'D:\Temp\unity-profile.json'
```

The output parent directory must already exist; the generator refuses to
overwrite an existing file. It inspects the Unity project and executable but
does not run Unity. Use the resulting JSON for both `evaluate run` and the
integration/reversion regression profile. The Node's acceptance checks must
match all three generated ids: `unity-compile`, `unity-editmode-tests`, and
`unity-editmode-results`.

When the local Unity host needs the documented EditMode teardown workaround,
append `--editmode-no-batch`. Compile stays batch-mode; only EditMode omits it.
The default is batch-mode, and successful XML alone never overrides an
unsuccessful or unconfirmed Unity process. See
[`tools/validate-v01-live.md`](../tools/validate-v01-live.md) for the separate
real Codex/Unity composition validator and its historical evidence.
