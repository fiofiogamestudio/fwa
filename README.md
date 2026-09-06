# FWA — FW Agentic

FWA turns agent-assisted game development into a traceable sequence of Goals,
Nodes, Runs, ChangeSets, Evidence, integrations, and reversions.

**Status:** the V0.1 Goal-to-revert engineering spine is implemented. A retained
live composition run validates the frozen source recorded in
[`docs/v0.1-validation.md`](docs/v0.1-validation.md).
That historical record does not automatically validate later changes or the
future runtime, visual, learning, or multi-engine roadmap.

## Relationship to `fw` and `fwe`

FWA is a standalone component. Its current directory, `fw/fwa`, is a convenient
co-location, not a runtime dependency.

V0.1 is Git-first: it uses Git commits, refs, worktrees, merge parents, and
compare-and-swap promotion throughout the application contract. Executors and
evaluators are straightforward extension points. Replacing Git would require
a repository-protocol redesign and equivalent recovery guarantees, not just
renaming an adapter.

- `fw` is the optional game runtime/framework.
- `fwe` is the optional editor/control surface.
- `fwa` is development orchestration.

A game may use any one of them without the others. The architecture
specification's earlier “FW Agentic” and `fw` command examples map here to the
independent `fwa` package, `fwa` CLI, and `.fwa` state directory; they do not
turn FWA into part of the `fw` runtime.

An optional FWE control console now consumes FWA application commands and
projections through an outer adapter. Neither core imports the other. The
console uses an explicitly selected independent FWE checkout, not a nested
copy or npm dependency. FWA's package boundary test rejects dependencies from
core to `fw`, `fwe`, adapters, or third-party packages.

## What V0.1 implements

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

Automatic planning, vector/embedding/RAG knowledge systems, planner or reviewer
swarms, a full visual execution/recovery workflow, Unity runtime/PlayMode scenarios, screenshots, telemetry,
semantic conflicts, learning, distributed execution, multiple engine adapters,
authenticated approval, automated game design, and hostile code confinement
are intentionally outside V0.1.

## Requirements

- Node.js 20.10.0 or newer;
- Git available on `PATH`;
- a local Git repository whose ignore rules exclude `.fwa/**`;
- Git author configuration for generated commits;
- Codex CLI only when selecting the Codex executor;
- Unity Editor only when using the Unity evaluator profile.

FWA has no npm dependencies.

## Optional FWE control console

From the directory containing the independent `fwa/` and `fwe/` checkouts:

```powershell
node fwa/bin/fwa.js editor --project D:/Games/MyGame --fwe-path D:/Git/fw/fwe
# Enable only goal.create, plan.load and node.retry:
node fwa/bin/fwa.js editor --project D:/Games/MyGame --fwe-path D:/Git/fw/fwe --port 3220 --allow-write
```

The project must already be initialized with `fwa init --project ...`. Launch
does not initialize, repair, clone, update, reuse or stop another server. It
binds only `127.0.0.1`; the default port is `3220`. `--json` prints the ready
URL/project/fingerprint, then the command remains running until stopped.

The Chinese-first console shows the project, Goals, dependency Nodes, Runs,
Evidence, ChangeSets, Refs, integrations, reversions, and persisted Git fence
and workspace-lease snapshots. A fence snapshot is not a full `fwa verify`.
Generic create/save/delete and FWE's stop API are disabled server-side, not
just hidden in the toolbar. In read-only mode no application commands are
submitted; existing storage inspection may use its short-lived read guards.

With explicit `--allow-write`, the only accepted commands are `goal.create`,
`plan.load` (JSON content, never a file path) and `node.retry`. Each command
goes through `FwaApplication`, requires a command ID, and retains its durable
idempotency and validation rules. Unconfirmed browser requests retain their
ID in project-scoped `sessionStorage` across refresh, tab changes and reload;
successful acknowledgement removes it. If storage is unavailable, dispatch
fails rather than risking a lost ID. Closing the browser tab or clearing its
storage loses this local pending lookup: inspect CLI events before repeating
an uncertain command. Run, evaluate, integrate, revert and all recovery still
require explicit CLI/API operations; the console never clears a lease or Git
safety fence on the operator's behalf.

The adapter requires FWE `0.2.0` **with guarded server integration contract v1**.
Older `0.2.0` checkouts without that capability are rejected. FWE's launch and
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
`startEditor({ projectRoot, fwePath, port, allowWrite, signal })`; the result
contains `url`, identity/fingerprint fields, `server`, `closed` and `close()`.
The API permits port `0` for isolated tests, while the CLI requires `1..65535`.
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
fwa editor --fwe-path <absolute FWE checkout> [--port <port>] [--allow-write]
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
