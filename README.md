# FWA — FW Agentic

FWA turns agent-assisted game development into a traceable sequence of Goals,
Nodes, Runs, ChangeSets, Evidence, integrations, and reversions.

**Status:** the V0.1 Goal-to-revert engineering spine is implemented. The current
workbench additionally implements reference-library import, real Codex planning,
hierarchical plans, isolated parallel Run batches and explicit feedback revisions.
Default Work stops after candidate production awaiting acceptance; this is not a
complete autonomous game-delivery loop. See the current boundaries below.
A retained
live composition run validates the frozen source recorded in
[`docs/v0.1-validation.md`](docs/v0.1-validation.md).
That historical record does not automatically validate later changes or the
future runtime, visual, learning, or multi-engine roadmap.

## Relationship to FW, FWC and FWE

FWA is a standalone component. Its current directory, `fw/fwa`, is a convenient
co-location, not a runtime dependency.

V0.1 is Git-first: it uses Git commits, refs, worktrees, merge parents, and
compare-and-swap promotion throughout the application contract. Executors and
evaluators are straightforward extension points. Replacing Git would require
a repository-protocol redesign and equivalent recovery guarantees, not just
renaming an adapter.

- `fw` is the top-level workspace/project and component manager.
- `fwc` is the optional Godot/C# game runtime/framework.
- `fwe` is the optional editor/control surface.
- `fwa` is development orchestration.

These components are siblings; FWA does not require a game to use FWC. The architecture
specification's earlier “FW Agentic” and `fw` command examples map here to the
independent `fwa` package, `fwa` CLI, and `.fwa` state directory; they do not
turn FWA into part of FWC or make the top-level FW package a game runtime.

An optional FWE control console now consumes FWA application commands and
projections through an outer adapter. Neither core imports the other. The
console uses an explicitly selected independent FWE checkout, not a nested
copy or npm dependency. FWA's package boundary test rejects dependencies from
core to `fw`, `fwe`, adapters, or third-party packages.

## What the historical V0.1 scope implements

- strict Goal and human-authored DAG validation;
- logical, versioned Refs resolved to physical workspace paths;
- deterministic ready-Node selection and a project-wide operation fence;
- isolated Git worktrees and immutable Run/ChangeSet history;
- replaceable executors, including a real Codex CLI adapter;
- deterministic compile/test evaluation and immutable Evidence;
- Unity compile + EditMode + NUnit-result evaluation profile;
- exact-base direct integration;
- isolated two-parent merge, physical-conflict recording, and compile/test
  regression gating;
- isolated, gated Git revert represented as a new ChangeSet;
- precise Ref-version updates, stale propagation, and recomputation roots;
- explicit retry/recompute scheduling with preserved attempts and budgets;
- per-command Git timeouts and a durable fence for unconfirmed process closure;
- append-only hash-chained events, idempotent commands, recovery, status, and
  offline integrity verification.

The frozen V0.1 scope excluded automatic planning, vector/embedding/RAG knowledge systems, planner or reviewer
swarms, a full visual execution/recovery workflow, Unity runtime/PlayMode scenarios, screenshots, telemetry,
semantic conflicts, learning, distributed execution, multiple engine adapters,
authenticated approval, automated game design, and hostile code confinement.
This is a historical boundary, not a list of
everything still missing today: the current planning, batch execution and
revision capabilities are described below and in
[`docs/interactive-workflow.md`](docs/interactive-workflow.md).

## Requirements

- Node.js 20.10.0 or newer;
- Git available on `PATH`;
- a local Git repository whose ignore rules exclude `.fwa/**`;
- Git author configuration for generated commits;
- a compatible, configured Codex CLI for real Plan or the Codex executor;
- Unity Editor only when using the Unity evaluator profile.

FWA has no npm dependencies.

## Windows quick launch

Double-click `start.bat`, or run `npm.cmd start`. The launcher opens the FWA
console in your browser using the sibling `../fwe` checkout. The first launch
creates an isolated Git demo at `.local/demo`; later launches preserve its
goals, files and history. The demo enables the console's controlled write
commands. Plan and Work still require an installed, configured Codex CLI.
Local demos and verification reports live under ignored `.local/`;
retained historical reports are in `.local/reports/`.

```powershell
.\start.bat --check
.\start.bat --project D:/Games/MyGame
.\start.bat --project D:/Games/MyGame --allow-write --fwe-path D:/Tools/fwe
.\start.bat --no-open --port 3220
```

`--check` only checks launcher prerequisites and prints the selected paths and
options; it creates no demo or server. An explicit `--project` must already
be initialized, and defaults to read-only. The launcher never initializes a
supplied project. `--port` defaults to `0` (an available local port); the
actual URL opens after the server is ready. Keep the terminal running while
using the console, and press Ctrl+C to stop it. Errors remain visible in the
BAT window. Full FWE server-contract compatibility is checked when starting.

## Optional FWE control console

From the directory containing the independent `fwa/` and `fwe/` checkouts:

```powershell
node fwa/bin/fwa.js editor --project D:/Games/MyGame --fwe-path D:/Git/fw/fwe
# Enable the bounded import/planning/work/revision commands:
node fwa/bin/fwa.js editor --project D:/Games/MyGame --fwe-path D:/Git/fw/fwe --port 3220 --allow-write
# Optional: select an already-installed native CLI for this launch:
node fwa/bin/fwa.js editor --project D:/Games/MyGame --fwe-path D:/Git/fw/fwe --allow-write --codex-path D:/Tools/Codex/codex.exe
```

The project must already be initialized with `fwa init --project ...`. Launch
does not initialize, repair, clone, update, reuse or stop another server. It
binds only `127.0.0.1`; the default port is `3220`. `--json` prints the ready
URL/project/fingerprint, then the command remains running until stopped.

`--codex-path` requires an existing fully qualified native executable, not a
`.cmd`/`.bat` wrapper; Windows requires `.exe`. Omitting it retains the existing
resolver. It does not install a CLI, bypass user configuration or lower the
sandbox. Plan requests read-only execution; Work uses workspace-write in its
assigned worktree. The executable is trusted launch configuration, never a
browser payload field. Hosts that already provide `tools/fwa-ui.mjs` may use
the optional `codexPath` beside `fwaPath`/`fwePath` in `.fwa/ui-launcher.json`;
that host launcher is not installed by `fwa editor`.

The Chinese-first workbench imports copies of files, directory trees or one ZIP
and stores immutable library versions with inherited path permissions. It
previews supported documents, images, video and audio, with a separate PDF link.
Plan combines optional prose and selected library versions through the real
Codex planning adapter, validates the result and loads an authored plan; missing
information returns questions, not invented work. Parent/child decomposition is
separate from executable dependency edges. Only leaf Nodes can run.

Work dispatches ready leaves through `runReadyBatch`, with declared read/write
and exclusive-resource conflict checks, one coordinator lease and independent
Git worktrees. The default controller selects up to four leaves per round.
Without a trusted acceptance/integration adapter, a successful batch stops at
`awaiting-acceptance`; it does not automatically reach downstream leaves or
done. With an explicit trusted `--review-config`, ChangeSet details now provide
candidate validation, a separate recorded human acceptance, regression-gated
adoption, and gated single-change reversion with dependency impact. See
[`docs/change-review.md`](docs/change-review.md) for setup and exact boundaries.

A batch containing any zero-file ChangeSet stops earlier at
`no-changes-awaiting-review`, before automatic acceptance or integration.
Inspect the exact Run output: a no-op may be legitimate or may reflect blocked
tools. Neither process exit code zero nor an empty candidate proves completion.
Older job records stay immutable; the UI adds warnings using their bound
ChangeSets instead of relabeling their history.

Node feedback is durable and blocks later dispatch until explicitly resolved.
The operator requests a model-assisted or authored plan revision after active
operations settle. Affected leaves get new physical Node versions while stable
logical IDs, prior Runs, commits and Evidence remain traceable; unrelated
branches retain their current results. Revisions do not automatically restart
Work or silently consume feedback received during an active Run.

The workbench also provides a hierarchy/dependency graph, a separate
declared-Ref relationship graph, per-Node attempt history, ChangeSet file/patch
inspection, Evidence criteria and log viewers, immutable image/video artifact
viewers, and a paginated persisted-event timeline. Selecting
a graph node or record opens its linked facts in the inspector. The same
independent FWE checkout supplies the reusable pan/zoom/selection graph
component; FWA supplies the domain projection, not a second graph engine.

Execution status, validity and integration status remain separate. `produced`
does not mean accepted or integrated, and Ref graph edges mean **declared**
reads/writes, not observed file access or semantic requirement coverage.
Ref previews show current workspace bytes, not historical Run inputs;
library snapshots and immutable execution/evaluation artifacts are separate
sources. The recursive plan/ready/work/done projection does not replace these
states: a leaf is done only with a valid accepted result integrated into its
Goal's target, and a parent is done only when all children are done.

Library `deny` is enforced by content reads and snapshot omission, but read/write
labels and copied-file modes are not an OS sandbox. The current executor treats
all input snapshots as read-only; allowing modification of a library copy does
not yet implement a write-back/new-version workflow. Media display does not
automatically capture or pair before/after game revisions, or prove visual
acceptance. Reference art and console recordings are not game-result evidence.

The workbench checks for updates every five seconds while visible. Background
updates preserve command drafts and pending-submit locks; drafts survive
section changes, not page reloads. Project, Goal, integration, reversion and
persisted Git fence/workspace-lease facts remain inspectable. A fence snapshot
is not a full `fwa verify`. Generic create/save/delete and FWE's stop API are
disabled server-side, not just hidden in the toolbar. In read-only mode no
application commands are submitted; existing storage inspection may use its
short-lived read guards. See [`docs/visual-workbench.md`](docs/visual-workbench.md)
for view semantics, current limitations and a browser acceptance checklist.

With explicit `--allow-write`, accepted commands are `goal.create`, `plan.load`,
`node.retry`, `library.import`, `library.permission`, `workflow.plan`,
`workflow.work`, `workflow.revise`, `node.feedback` and `plan.revise`.
Trusted review configuration additionally enables `change.validate`,
`change.accept`, `change.integrate`, and `change.revert`; an experiment runner
and fixed conditions enable `experiment.run`. These operations retain durable
jobs, exact-version checks, and the existing Git/evaluation gates.
Plan JSON is content, never a server-side file path. Commands go through the
application, reference library or durable workbench-job coordinator and retain
their command-ID, idempotency and validation rules. Unconfirmed browser requests retain their
ID in project-scoped `sessionStorage` across refresh, tab changes and reload;
successful acknowledgement removes it. If storage is unavailable, dispatch
fails rather than risking a lost ID. Closing the browser tab or clearing its
storage loses this local pending lookup: inspect CLI events before repeating
an uncertain command. Job return/success is not Node acceptance. Review commands
use trusted startup profiles and preserve the existing evaluation, integration
and reversion gates. Recovery remains an explicit CLI/API operation; the console
never clears a lease or Git safety fence on the operator's behalf.
Ordinary workspace Ref registration/update, pause/resume, approval and the
complete autonomous acceptance loop remain outside the current page.

The adapter requires FWE `0.2.0` **with guarded server integration contract v1**.
Older `0.2.0` checkouts without that capability are rejected; the visual
workbench also needs `fwe.ui.createGraph` from the graph-component checkout.
FWE's launch and
load-time runtime fingerprints, FWA's `src/`, `bin/` and package bytes, fixed
project identity and write capability participate in the handshake. Every
HTTP request rechecks source fingerprints. A detected edit, added/removed
runtime file or unreadable source permanently blocks that server with HTTP
503; stop it and start a fresh process. Hot replacement is unsupported.

Host and Origin checks cover every route. Mutations additionally require a
same-origin request, random process-local CSRF token, JSON content type and
matching console fingerprint. Requests cannot select another project, shell,
executor, profile or arbitrary file. This is a loopback, trusted-local-user
control surface, not remote authentication, a plugin sandbox or hostile-code
containment. Anyone already controlling the local process/browser or source
checkout is within the trust boundary. Do not expose the port through a proxy
or port-forward. Concurrent local CLI use still follows the application's
optimistic event writes, workspace leases and Git fences; the console does
not create a new cross-process transaction protocol.

For embedding, import `src/editor/server.js` and call
`startEditor({ projectRoot, fwePath, port, allowWrite, open, signal, workflow })`; the result
contains `url`, identity/fingerprint fields, `server`, `closed` and `close()`.
The optional trusted `workflow` object may inject `planner`, `executor`,
`codexOptions` and `acceptAndIntegrate`; browser requests cannot supply them.
The API permits port `0` for isolated tests, while the CLI requires `1..65535`.
The optional `open` flag defaults to `false`; the Windows launcher enables it
to open the actual bound URL through FWE's existing browser helper.
The read APIs accept only this project's persisted events, registered Refs,
and complete artifact references reachable from events or verified JSON
artifacts. Separate library reads address registered immutable versions and
apply their current access rules. They reject arbitrary file paths, glob scanning, symlink/junction
traversal and oversized previews; artifact bytes must match their authorized
SHA-256 and size. Image metadata links bind the subsequent image response to
the observed content hash. Reading evidence never triggers verification,
recovery, cleanup, or an application mutation.

HTTP integration tests use the sibling FWE when present, or the explicit
`FWA_TEST_FWE_PATH`; standalone FWA tests report those optional tests skipped
when FWE is absent. Core and normal CLI operations remain independent.

The ignored `.fwa/**` directory is local engineering evidence, not a publishing
directory. It can contain model and command output, Unity logs, NUnit reports,
patches, and local paths; keep it access-controlled and do not commit or publish
it without review.

## Validate this package

```powershell
cd D:\Git\fw\fwa
npm.cmd run check
npm.cmd test
```

`npm.cmd` avoids PowerShell execution-policy interception of `npm.ps1` on
Windows. The retained real Codex/Unity composition validator is documented in
[`tools/validate-v01-live.md`](tools/validate-v01-live.md). The frozen completion
snapshot's test, coverage, live-run, and package evidence stays in
[`docs/v0.1-validation.md`](docs/v0.1-validation.md).

Current focused tests cover library import/permissions, hierarchy/revision
replay, parallel execution, HTTP commands and UI lifecycles. The explicit
`tools/check-workflow-planner.mjs` smoke invokes real Codex on a generated
planning-only brief; `tools/check-interactive-workflow.mjs` exercises a real
browser/API/Git pipeline with deterministic test adapters. Neither proves game
delivery or visual acceptance. No complete-suite pass is asserted by this
documentation; verify the report for the tested source version. See
[`docs/visual-workbench.md`](docs/visual-workbench.md#浏览器验收清单) for the
scripts' scopes and the evidence that must be checked separately.

## Try it without an engine or model account

```powershell
node examples/basic/run.mjs --api
node examples/basic/run.mjs --cli
```

Each command creates a separate temporary ordinary Git repository, generates
the complete Ref/plan/operations/acceptance/regression inputs, makes a bounded
edit, evaluates it, regression-gates a merge and revert, and verifies the final
state. Only Node and Git are required. The printed directory is retained for
inspection, including its `.fwa` history. The example sets Git identity only
inside that temporary repository.

[`docs/getting-started.md`](docs/getting-started.md) provides the complete manual
CLI flow, API composition, Unity-profile generator, Ref rules, and retry flow.

## CLI

```text
fwa init
fwa goal create <title>
fwa ref register <ref.json>
fwa ref list
fwa ref show <ref-id>
fwa plan load <goal-id> <plan.json>
fwa run next <input.json> --executor file-operations|codex
fwa node retry <node-id> [--reason <text>]
fwa run reconcile
fwa evaluate run <changeset-id> <profile.json>
fwa evaluate reconcile
fwa integrate apply <changeset-id> --target <branch>
fwa integrate gated <changeset-id> <profile.json> --target <branch>
fwa integrate reconcile [--confirm-processes-stopped]
fwa revert run <changeset-id> <profile.json> --target <branch>
fwa revert reconcile [--confirm-processes-stopped]
fwa git fence
fwa git recover --fence-id <id> --confirm-processes-stopped
fwa status
fwa events
fwa verify
fwa editor --fwe-path <absolute FWE checkout> [--port <port>] [--allow-write] [--codex-path <absolute native executable>]
```

All commands accept `--project <path>`. Mutating public commands accept a
`--command-id` idempotency key; reconciliation uses `--correlation-id`. Most
commands support `--json`.

The direct `integrate apply` path requires the target to equal the ChangeSet's
base. `integrate gated` can combine an accepted branch with the recorded current
project revision, but it promotes only after a profile containing both compile
and test checks passes.

An interrupted regression remains fenced while its evaluator worktree is
retained. `--confirm-processes-stopped` is an explicit operator assertion for
reconciliation: after all evaluator processes have stopped, FWA removes that
exact candidate-revision worktree and terminates the interrupted Integration or
Reversion as failed. It never treats the assertion as passing Evidence and
never continues promotion.

FWA disables Git's built-in filesystem monitor only in Git subprocesses it
owns, so temporary worktrees do not inherit a machine-level fsmonitor daemon.
It does not rewrite the user's global Git configuration. On Windows, if Git
unregisters an owned worktree but leaves the same physical directory behind,
cleanup may remove that residual only after exact path, parent, directory
identity, and registration checks; any ambiguity fails closed.

Two narrow hard-crash windows remain explicit V0.1 boundaries. A crash after an
artifact blob is written but before its ownership event can leave an
unreferenced blob that `fwa verify` reports. A crash after Git unregisters a
worktree but before the validated filesystem fallback can leave an unregistered
directory that a later process cannot safely identify and must not delete
automatically.

## Optional Codex executor

After loading a plan whose capabilities match the Codex executor, supply:

```json
{
  "schemaVersion": 1,
  "prompt": "Implement only the bounded Node change and run focused checks.",
  "model": "gpt-5.5"
}
```

```powershell
node .\bin\fwa.js run next .\codex-input.json --executor codex `
  --project D:\Git\my-game --json
```

Codex runs non-interactively with `shell:false`, a fixed worktree, JSONL
output, bounded capture, timeout/abort handling, attempted process-tree
termination, and confirmation that the managed child has closed.
It inherits user configuration by default. `ignoreUserConfig: true` is an
explicit per-invocation bypass. The Windows-only
`windowsSandboxOverride: "elevated"` is a separate privilege-expanding opt-in;
FWA records it as such and has no code path that writes global Codex
configuration. The invoked CLI and desktop application remain external shared
state: before/after fingerprints are observations only, because either may
change that configuration during a Run.

## Programmatic API

```js
import {
  CodexExecutor,
  CommandEvaluator,
  FwaApplication,
  GitIntegrationAdapter,
  GitIntegrationWorkspaceAdapter,
  GitWorktreeAdapter,
  createUnityEvaluatorProfile
} from 'fwa';
```

Concrete adapters are also available through explicit package subpaths. The
application accepts injected event store, artifact store, lease, executor,
evaluator, worktree, candidate-workspace, and promotion ports.

Read [`docs/architecture.md`](docs/architecture.md) for invariants and trust
boundaries, and [`docs/v0.1.md`](docs/v0.1.md) for the full definition-of-done
mapping and schemas.
