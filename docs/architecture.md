# FWA architecture

## Component boundary

FWA (FW Agentic) is a standalone development-time orchestration component. It
is currently co-located at `fw/fwa` for development convenience; that path does
not make it part of the `fw` runtime.

```text
game project ──optional──> fw runtime
game project ──optional──> fwe editor
game project ──optional──> FWA orchestration
                              │
                              ├── executor adapter (Codex or another tool)
                              ├── repository adapter (Git)
                              └── evaluator adapter (Unity or another engine)
```

The package has no code or package dependency on `fw`, `fwe`, a Unity SDK, or a
model SDK. Unity Editor is an optional external process used only when the Unity
evaluator adapter is selected. The core imports only Node standard-library
modules and other core modules. A boundary test enforces this direction and
verifies that the package has no third-party runtime or development dependency.

Consequences:

- a game made with `fw` does not need FWA or FWE;
- V0.1 contains no FWE adapter, FWE UI, or shared FWA/FWE configuration
  contract;
- a future FWE surface can consume FWA through an adapter without changing
  either core;
- FWA can operate on a plain Git repository through its API or CLI;
- executors, evaluators, storage ports, and a future UI can be implemented
  independently while preserving their contracts.

This is a Git-first V0.1, not a repository-neutral workflow engine. Commit ids,
Git refs, worktrees, merge parents, exact-base checks, and compare-and-swap
promotion are visible in persisted application records and validation. A
different Git implementation can satisfy those ports; replacing Git with a
different version-control model requires application/protocol changes and new
recovery evidence. Keeping Git code out of `src/core` does not make that change
free.

## Layers

```text
CLI / future UI
       ↓
FwaApplication
       ↓
RunOrchestrator ─ EvaluationOrchestrator ─ IntegrationOrchestrator
       ↓                    ↓                       ↓
core contracts       injected evaluator      injected Git ports
       ↓
event store + artifact store + operation lease
```

`src/core` owns schemas, validation, DAG readiness, effects, Ref resolution,
fine-grained invalidation, state machines, and event envelopes. It does not
spawn processes or invoke Git.

`src/application` owns use cases and durable cross-aggregate transitions. It
accepts executor, evaluator, workspace, promotion, artifact, event-store, and
lease ports.

`src/adapters` contains concrete local integrations:

- `GitWorktreeAdapter` isolates Runs and Evaluations at exact commits;
- `GitIntegrationAdapter` verifies and promotes candidates with compare-and-swap;
- `GitIntegrationWorkspaceAdapter` prepares two-parent merges and one-parent
  revert commits without moving the target;
- `FileOperationsExecutor` is a deterministic reference executor;
- `CodexExecutor` invokes the Codex CLI as a replaceable executor;
- `CommandEvaluator` runs deterministic checks without a command shell;
- `createUnityEvaluatorProfile` supplies Unity compile, EditMode, and NUnit
  result checks to `CommandEvaluator`.

## Durable model

The seven primary domain concepts remain:

```text
Goal  Ref  Node  Run  ChangeSet  Evidence  Event
```

Integration and Reversion are durable workflow records rather than hidden Git
side effects. `ProjectRevision` is a projected target-history entry. These
records do not displace the seven primary concepts.

Every accepted and integrated execution has a complete binding:

```text
Goal
  → Node
  → Run + executor identity + frozen Ref snapshots
  → execution ChangeSet + immutable Git object ids
  → Evaluation + immutable Evidence
  → Integration + regression Evidence when gated
  → ProjectRevision
```

A revert appends, rather than deletes:

```text
source ChangeSet
  → Reversion + compile/test regression Evidence
  → revert ChangeSet
  → new ProjectRevision
  → source Node invalid + affected consumers stale
```

## Event and artifact integrity

The append-only event stream is the workflow source of truth. Status is rebuilt
by strict replay. Each batch records a sequence range, command id, normalized
intent hash, previous-batch hash, and schema version. Replay rejects unknown
events, stream-version gaps, malformed payloads, illegal transitions, and
cross-aggregate binding mismatches.

Patches, execution envelopes, evaluation profiles and results, command output,
expected artifacts, merge/revert patches, and regression results are stored by
SHA-256. `verify` re-hashes referenced artifacts, reparses canonical evidence,
rechecks Git objects and candidate reachability when Git ports are supplied,
and reports unreferenced artifacts or operational residue.

These hashes detect accidental or out-of-band mutation. They are not digital
signatures: an actor able to rewrite the entire local state directory can also
forge a new chain. Signed approvals and remote audit replication are outside
V0.1.

Hashes also provide no confidentiality or redaction. The `.fwa` artifact store
and retained live-validator directory can contain patches, model JSONL,
command output, absolute paths, Git status, Unity Editor or licensing logs, and
NUnit XML. Treat them as sensitive local engineering evidence. A compact
summary may omit log bodies while the referenced immutable artifacts still
contain the original bytes.

## Scheduling and recovery

V0.1 schedules one mutating operation at a time. A project-wide lease has an
owner kind (`run`, `evaluation`, `integration`, or `reversion`), owner id,
token, heartbeat, and bounded lifetime. A stale owner is reclaimed only after
the implementation can conclude that it is dead; age alone is insufficient.

The event-store lock and operation lease are separate fences. Every use case
rereads durable state after acquiring its fence. Public command ids are
idempotency keys: replay is allowed only when the normalized intent is exactly
the same.

`retryNode` is an explicit scheduling command. It requeues rejected attempts
or stale/invalid produced and accepted output only after dependency, target,
budget, and cleanup checks. It appends history instead of erasing old Runs or
Evidence, and does not reset the attempt budget. Recompute clears current
acceptance/integration pointers; its next Run resolves fresh Ref snapshots.
Requeueing and starting an executor are separate commands.

Every Git adapter subprocess receives a sanitized `GIT_*` environment and a
process-scoped `core.fsmonitor=false`. This prevents FWA-owned temporary
worktrees from inheriting a machine-level filesystem-monitor daemon without
changing the user's system, global, or repository configuration. The live
validator additionally disables fsmonitor in the temporary repository it
creates and owns.

Interrupted Run, Evaluation, Integration, and Reversion operations have
explicit reconciliation paths. Promotion uses old-object-id compare-and-swap.
If promotion may have happened but inspection is unavailable, the operation
becomes `recovery-required`; it is never guessed successful or blindly applied
again.

An interrupted gated evaluator whose process termination is unproven retains
its exact detached worktree and stays fenced. Integration/Reversion reconcile
accepts `--confirm-processes-stopped` only as an explicit operator assertion.
It then removes the worktree after exact revision/ownership checks and records
the operation as failed; it does not manufacture Evidence or continue
promotion. The durable `regressionProfileHash` is also a content-addressed
reachability edge for the canonical profile artifact when interruption occurs
before a complete regression Evidence envelope is recorded.

Windows can report a nonzero `git worktree remove`, or report success, after
unregistering a worktree but before deleting its directory. Run, Evaluation,
and Integration cleanup therefore captures the canonical managed parent and
exact direct-child worktree identity before Git removal. Filesystem fallback is
allowed only when Git no longer registers the worktree and the parent/worktree
remain the same real directories with the same device and inode identities.
Links, identity replacement, foreign paths, or a surviving registration fail
closed. The fallback is bounded (`maxRetries=5`, `retryDelay=100ms`), and cleanup
then verifies that both registration and path are gone. Results expose whether
`filesystemFallbackUsed` was necessary.

V0.1 does not claim an atomic transaction spanning artifact publication and
event append. A hard process crash in that narrow window can leave an immutable
blob with no durable event reference. Such a blob cannot affect projection or
promotion; `fwa verify` reports it in `unreferencedArtifacts` and sets
`operationallyClean=false`. V0.1 deliberately does not delete it automatically.
A future audited prune must take the project lease, rescan reachability after a
grace period, verify file identity, and record what it removes.

A second hard-crash boundary exists after Git has unregistered a worktree but
before the validated filesystem fallback completes. A later process lacks the
captured directory identity needed to prove that an unregistered residual is
still the same owned directory, so V0.1 leaves it for explicit operator review
rather than guessing and recursively deleting it.

## Effects and logical Refs

`dependsOn` and `reads` answer different questions. A DAG edge is an execution
precondition: a prerequisite must have an accepted, valid result integrated on
the relevant target before dependent work may proceed. A logical Ref read
declares the versioned data on which produced output depends. Staleness follows
those data declarations; satisfying a Ref version does not waive the DAG
precondition. In particular, reverting a prerequisite blocks its dependants
even when their declared Ref reads are unrelated and need no data invalidation.

A Node keeps logical reads/writes. At Run creation, FWA freezes every consumed
and produced Ref's id, kind, URI, version, and hash, and resolves its URI to the
physical workspace effect pattern passed to the executor.

```text
ref://code/player-controller
  → Assets/Scripts/PlayerController.cs
```

After capture, changed files are matched back to produced Refs. Integration
advances only those Ref versions. Consumers that already produced output from
an older version become stale; consumers not yet run stay ready and will freeze
the new version. Transitive, already-materialized dependants are also stale.
Reversion performs the same precise invalidation and exposes the minimal direct
recomputation roots. Plans without logical Refs use conservative DAG-dependent
invalidation on revert.

Execution status and validity are deliberately independent. For example,
`status=accepted, validity=stale` means that Evidence proved an earlier result,
but the result no longer matches current inputs.

Refs track explicitly authored dependency declarations. Executors receive a
normal worktree and may physically read undeclared files; FWA does not intercept
every filesystem read or prove complete read isolation. A missing logical read
can therefore prevent the intended data invalidation. Authors should declare
all inputs that materially affect output, including configuration and generated
sources, and keep regression checks for behavior not captured by those claims.

The initial `Ref.hash` is a registered version token, not an automatic watcher
or a promise that FWA continuously hashes its URI's files. For a single file,
seed it with the SHA-256 of the bytes at the recorded initial Git commit and
record that commit in `version` or metadata. For a directory/pattern, define a
stable sorted path-and-content manifest and hash that manifest; for a future
output, hash an explicit `absent` seed associated with its URI and base commit.
Use one documented convention per project. FWA's later Ref hashes are derived
from its integration/reversion version protocol, so they should not be compared
directly with a current file checksum. External Git edits or undeclared reads
are not automatically detected as Ref drift. The executable basic example
generates a real initial file digest instead of using a zero placeholder.

## Evaluation and integration

An executor never accepts its own output. `CommandEvaluator` normalizes a
profile before execution, evaluates a detached worktree at the exact ChangeSet
commit, bounds output, terminates the managed process tree on timeout/abort,
checks expected artifacts, and rejects tracked mutations.

There are two integration strategies:

1. `exact-base-single-commit` is the narrow direct path. The target must still
   be the ChangeSet base.
2. `merge-commit-regression-gated` prepares a deterministic two-parent merge,
   records physical conflicts, runs a profile containing both `compile` and
   `test` checks, and promotes only a passing candidate.

Reversion prepares a one-parent revert candidate (mainline 1 for a merge
commit), applies the same compile/test gate, then promotes it with CAS. Candidate
refs use `refs/fwa/integrations/*/candidate`. Once a durable Integration or
Reversion records a candidate revision, its matching ref remains a durable Git
reachability anchor even after terminal workspace cleanup, and `verify` requires
the ref to keep naming that exact revision. Only unbound/orphan candidate refs
are eligible for compare-and-swap pruning. `verify` reports candidate-worktree
residue and orphan refs separately from these expected bound refs.

## Trust boundary

Git, evaluator commands, and executors are trusted local tools in V0.1. A Git
worktree is isolation from ordinary edits to the main checkout, not a hostile
sandbox. Git hooks, filters, helpers, child processes, filesystem access, and
network access remain host capabilities.

`CodexExecutor` uses `shell:false`, a fixed working directory, JSONL output,
bounded capture, timeouts, abort handling, attempted process-tree termination,
and confirmation that the managed child has closed. It
inherits user configuration by default. `ignoreUserConfig` and the Windows-only
`windowsSandboxOverride: "elevated"` are explicit per-Run opt-ins; the latter is
recorded as `windows-elevated` and expands privileges, so it should be used only
in a separately controlled workspace. FWA itself has no write path to global
Codex files, while the invoked CLI and desktop application remain external
shared state. A before/after fingerprint is therefore observational only:
concurrent external drift must not be attributed to FWA without causal
evidence. An invocation recorded with
`ignoreUserConfig=true` proves that invocation bypassed the shared user config;
it does not prove that no other process changed the file.
Git adapters invoke trusted local Git, including configured hooks, filters, and
helpers. Each adapter accepts `gitTimeoutMs` (default 120,000, range 1 through
3,600,000) and `gitTerminationGraceMs` (default 5,000, range 1 through 60,000).
The timeout is per Git command, not a budget for the whole Node operation.
Output remains bounded to 64 MiB. Timeout handling attempts process-tree
termination and waits for managed-child closure. That confirmation does not
prove that an arbitrary detached or hostile descendant cannot remain; trusted
local execution remains the V0.1 boundary.

If closure cannot be confirmed, `.fwa/git-process-fence.json` durably blocks
later Git commands and managed workspace deletion, including from a new
adapter instance. Every newly unconfirmed command receives its own fence id
and process record; additional records are retained under
`.fwa/git-process-fences/`. An already-running command that fails during another
fence's recovery therefore keeps a separate blocker. Elapsed time alone does
not clear these fences. After an
operator independently confirms that every associated process has stopped,
`fwa git recover --fence-id <id> --confirm-processes-stopped` clears only the
matching fence and retains a recovery receipt. It neither replays the command
nor deletes a workspace; normal operation reconciliation remains separate.
Its result reports `held` and `remainingFenceId`; `recovered=true` alone does
not mean the project is fully unlocked. The CLI exits nonzero while a remaining
fence still blocks Git. Inspect and recover each remaining id only after the
corresponding process-stop confirmation.

Recovery itself publishes an exclusive `.fwa/git-process-recovery.json` guard.
New Git operations remain blocked throughout recovery, including while the
original fence is being archived. `fwa git fence` reports `recoveryActive` and
the guard's owner when present. A hard crash of the recovery process can leave
this guard behind; FWA does not remove it based on owner PID or elapsed time.
That state requires operator inspection of the guard, archived records, and
associated processes before further recovery.

## V0.1 boundary

Implemented engine integration is a deterministic Unity evaluation-profile
adapter: project/editor validation, batch compile, EditMode tests, and strict
NUnit result validation. It is not the V0.2 Game Runtime abstraction.

V0.1 intentionally excludes automatic planning, vector/embedding/RAG knowledge
systems, agent or reviewer swarms, parallel scheduling, an FWE adapter or UI,
shared FWA/FWE configuration, authenticated human approval, hostile-code
confinement, PlayMode/runtime scenarios, screenshots, video, telemetry,
semantic/behavioral/visual conflict detection, caching, automated game design,
learning, cloud/distributed execution, web dashboards, and multiple engine
adapters.
