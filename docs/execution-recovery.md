# Predictable execution and recovery

FWA preserves the source, failed attempts and acceptance evidence. A live process
or a growing event count does not establish progress or delivery.

## Before execution

`getStatus()` includes `planDiagnostics`: dependency-chain length, theoretical
ready batches, shared writes/resources and check-reference counts. These are
bounded, static advisories, not proof that tasks can run in parallel. Unresolved
Refs and truncated analysis are marked incomplete. Existing authored dependencies
remain authoritative; no dependency is deleted automatically.

Group plans by outcomes that a user can review. Introduce an ordering dependency
only when a task needs another task's actual output. Scope shared source and
generated files precisely before enabling concurrency. Count new test and
evidence infrastructure as work; naming a check does not implement that check.

Executors may implement a synchronous `validateInput(input)` preflight. Serial and
batch admission invoke it before creating a Run or worktree. Codex preflight uses
the same validator as execution, including UTF-8 prompt size, whitespace and NUL
checks. Replaying an already-recorded command still returns its durable result.

## Bounded recovery

The workbench connects ordinary failure recovery inside one Work request.
Produced and accepted candidates are processed first; rejected validation uses
the existing retry API, while an execution failure already returned to ready
can run again directly. The executor receives the retained candidate identity,
configured validation commands and at most 8 KiB of verified failure-log tails.
It recovers useful changes in its assigned worktree and self-tests before
returning; final validation and gated integration remain independent.

History stays immutable. Stop decisions use each node's latest outcome, so a
successful repair does not retain the earlier failure as its current result.
Two consecutive matching code/failure signatures block automatic repair even
when new record IDs or log references change the serialized prompt. Budgets,
pending feedback, independent review, zero changes and infrastructure/cleanup
uncertainty remain explicit boundaries. Core admission refusals are not
resubmitted repeatedly within the same job. A new Work request may continue
retained settled candidates; process-death reconciliation is still explicit.

- Full failed execution diagnostics are verified immutable artifacts. Events and
  ChangeSet violations contain bounded summaries and artifact references instead
  of recursively embedding stdout/stderr into the next prompt. Keep the references
  when composing a repair request; do not reload entire logs into it.
  The console requests `/api/fwa/status?view=summary` and native display resources
  use the same preview policy for older history: selected diagnostic text is
  limited to 8192 UTF-8 bytes, with explicit truncation metadata. The default
  `/api/fwa/status` stays complete. Plans, instructions, acceptance contracts,
  identities and collection members remain intact, so large historical plans
  can still make this display response large. Never submit a display summary as
  executable configuration.
- `retryNode` checks pending feedback before changing the node to ready. Feedback
  needs a scoped plan revision. It is never silently approved or dropped in order
  to restart a task. Ordinary implementation failures without feedback can use
  the existing retry API.
- The configured `maxRetries + 1` attempt budget also spans physical revisions of
  the same logical task. A verified integration advances that task and resets the
  consecutive count. Reopening a plan or changing instructions alone does not.
  The original per-node budget remains enforced as well.
- Two consecutive matching failures with the same base and patch block an
  unchanged execution request. New commit IDs, empty checkpoints and heartbeat
  events do not count as new code. Deterministic input/output-limit failures demand
  corrected execution input immediately. Diagnose and change the repair input,
  source baseline or executor configuration before retrying; an explicit budget
  revision is needed when the logical budget is exhausted.
  Publish repaired adapter configuration under a new executor `version`, since
  admission compares its recorded identity rather than private adapter options.
- Input comparison uses the canonical submitted input hash, not semantic
  equivalence. A coordinator must keep timestamps and other volatile metadata out
  of its repair input. The cross-revision budget remains the backstop when requests
  differ without producing useful work.
- Workbench reference snapshots use stable paths bound to the imported version
  and that library's permission hash. Every reuse verifies the complete tree and
  file bytes; unexpected, missing, linked or changed entries stop preparation.
  Fresh snapshots publish only after their files are complete. An unrelated
  library event, repeated request or editor restart does not change execution
  input merely by creating another temporary directory or global journal number.
  A relevant version or permission change still changes the input. Historical
  Run inputs remain unchanged.
- A plan revision that corrects a captured file-count or diff-line budget failure
  can proceed when the new limits cover the recorded output and no other
  violations remain. Renaming a node, creating another physical revision or
  changing an unrelated limit is not a repair. This exception neither resets nor
  overrides the logical attempt budget, and it does not count as completed work.

`getStatus().retryDiagnostics` explains the current admission blocker, cumulative
attempt count, attempts since integration, repeated failures and next action.
The latest distinct valid source patch or integration supplies the recorded
progress time. Historical streams are replayed unchanged; these policies govern
new commands and do not invalidate older results.

Implicit `runNext()` examines ready tasks in order and skips attempts blocked by
retry admission, allowing independent tasks to continue. If none is admissible,
the error contains bounded deferred reasons. An explicit node selection retains
its specific refusal, and neither path loops to manufacture a new attempt.

## Long-running execution

The standalone Codex executor has no default total execution deadline. The
workbench supplies a three-minute planning deadline and a thirty-minute execution
deadline unless trusted `workflow.codexOptions.timeoutMs` overrides them;
`null` or `0` explicitly disables these total deadlines. Existing per-node
wall-time budgets remain independent. The executor's separate `idleTimeoutMs`
defaults to 15 minutes without stdout or stderr bytes and uses the same confirmed
process-termination and workspace-preservation path as other execution failures.
Set a positive duration for the expected tool silence, or `null`/`0` to disable
this watchdog. Lease heartbeats do not reset it. Output activity is evidence that
the executor is communicating, not proof that the requested feature is improving.

## What the progress screen means

The progress screen groups current tasks by the authored deliverables. It shows
integrated/total counts, activity, blocker/next action, cumulative attempts and
recorded progress, with technical details folded away. Failure, waiting for
review and blocked work are distinct from active execution. A produced candidate
or accepted-but-unintegrated change is not reported as delivered.
When the editor confirms that the lease owner has died, its still-recorded active
run is shown as requiring recovery. This does not rewrite the historical run or
release the lease automatically.

Framework or environment repairs should be visibly separate from product
delivery. A trusted integration profile must still verify the target revision;
do not remove it or treat compilation as gameplay/visual acceptance to speed up a
run. Put critical behavior checks and independent review before adoption.

## Updating a running installation

Keep active executor and editor processes on a frozen source version. Validate
changes in isolation, wait for an idle execution boundary, preserve the existing
working changes, and install only verified file deltas. Restart editor processes
after installation because source fingerprints intentionally reject hot changes.
Retain the old events, candidates and artifact store; never clear them to obtain
a clean-looking progress screen.

Artifact-store instances in one process serialize public operations against the
same physical directory, including reads that inspect or recover temporary
files. An active publication is therefore not mistaken for an orphan by a peer
operation. A failed queued operation releases the queue; genuinely orphaned or
corrupt files still require inspection under the existing rules. This queue
does not coordinate separate processes or workers and does not replace leases.
