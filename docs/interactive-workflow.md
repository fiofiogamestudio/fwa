# Interactive workflow contract

This is the product contract, not a declaration that every item has passed acceptance.
The original CLI-first V0.1 validation record remains historical. The current
implementation extends it; neither the old exclusions nor the new UI imply a
complete autonomous game-delivery system.

- Import copies of files/folders/ZIP archives inside the project. Keep immutable versions and a hierarchical library. Never modify the dropped originals.
- Reference permissions inherit by path and default to read-only; explicit child rules override parents. Reference permissions are not authority to modify the project or frameworks.
- The project is the work root. `fw/` and FWA internal state are protected by default. Framework modules remain siblings, not nested dependencies.
- Optional prose supplements the inputs. With no prose, use supplied documents; ambiguous inputs produce questions, not an invented plan.
- Plan produces a decomposition hierarchy and a separate dependency DAG, without executing leaves. Work dispatches ready leaves after read/write/resource conflict checks, in independent worktrees. Dependencies and containment are separate edges.
- A node is done only when its current result is accepted, valid and integrated. Parent phases aggregate recursively; failed, paused and waiting-for-feedback flags propagate separately.
- Feedback is durable. Pending messages are never described as consumed. Active-run inputs do not change underneath the executor. Revised definitions create new versions; old Runs, commits and evidence stay visible. Affected downstream nodes are invalidated, unrelated branches are retained.
- Visual acceptance requires actual before/after game captures bound to the relevant Run and revision. Reference art and screenshots of the workbench are not substitutes.
- Plan, execution, evaluation, integration and reversion all retain their distinct states and safety fences. No browser command accepts arbitrary executables, server-side source paths or untrusted evaluation scripts.

The existing standalone CLI contracts and guarded FWE host remain available. UI capability labels describe what this launch can actually do. Missing executor/evaluator capabilities must be shown as blockers, never simulated successes.

An empty candidate remains at `no-changes-awaiting-review`; it is never automatically accepted. Configured machine validation may check independent nonempty peers, while trusted automatic-adoption callbacks pause the mixed batch. This preserves zero-file Run/ChangeSet history while requiring inspection: a no-op is not necessarily a failure, but process exit code zero does not establish task completion. Historical jobs remain immutable; their exact ChangeSet bindings allow the UI to add a zero-change warning.

## Current implementation

- Import copies through the browser from files, directories or a single ZIP.
  Preserve immutable versions and the supplied hierarchy, including empty
  directories when the browser supplies them. Defaults: 16 MiB per file,
  32 MiB total and 2000 entries. Other archive formats are not unpacked.
- Path permissions inherit, with explicit child overrides. Denied files are
  rejected by content reads and omitted from new task snapshots. These are real
  library checks, but not an OS sandbox: copied-file modes and read/write labels
  do not confine an executor. Work treats every input snapshot as read-only;
  a write-enabled copy has no executor write-back/new-version workflow yet.
- A real read-only Codex planner consumes optional prose, pinned library
  versions, bounded text excerpts and supported image attachments. It returns
  validated groups and leaves or explicit questions. Imported audio/video/PDF
  preview does not mean their contents were interpreted by the planner.
- `plan.groups` and leaf `parentId` encode decomposition independently of
  leaf `dependsOn`. Group/Goal phases aggregate the same application facts;
  groups do not create executable Runs. Only accepted, valid and correctly
  integrated current leaves count as done.
- Work calls `runReadyBatch`: one coordinator lease, independent member
  worktrees and immutable Runs/ChangeSets, with declared read/write and exclusive
  resource conflicts deferred. The default controller selects at most four
  leaves per round. With trusted review configuration it validates exact
  candidates automatically, including candidates retained by earlier operations.
  It repairs ordinary failed attempts within the same request, using retained
  candidates and bounded verified log excerpts, and supplies configured checks
  for self-testing before capture. Attempt budgets and consecutive no-progress
  checks remain enforced. Independent ready work can continue around a blocked
  branch. Automatic completion follows the configured policy; manual profiles
  still stop for explicit confirmation.
  The browser's `workflow.finish` records that confirmation, performs gated
  adoption through `change.finish`, and continues eligible downstream work with
  fresh evidence bindings. Successful production or validation alone is not done.
  Recovery remains an explicit CLI/API action. The browser cannot upload an
  executable or acceptance profile. See [change-review.md](change-review.md).
- `node.feedback` records pending input without changing an active Run.
  `workflow.revise` explicitly asks the planner to revise the current authored
  plan; `plan.revise` accepts an explicitly authored revision. Applying either
  requires settled operations and the expected revision. Stable logical IDs
  connect new physical Node versions to their preserved histories. Affected
  dependencies and declared logical-Ref consumers receive replacement versions;
  unrelated branches retain their results. All pending feedback attached to a
  retired Node must be explicitly included. Later dispatch remains blocked
  while feedback is pending. There is no background auto-replan/resume worker.
- Library image/video/audio previews and immutable image/video artifact viewers
  exist. Configured experiments present the same baseline with and without one
  adopted change, including runner-produced image evidence. Automatic game
  capture and visual acceptance remain project-specific. Console recordings
  and reference art are not game evidence; a hash proves byte identity, not content.

Named acceptance contracts cannot be partitioned by the model planner. An
unstarted result can derive bounded children through a versioned revision;
replacement must preserve its acceptance obligations and consumers. Attempted
results retain their logical identity and retry budget. See
[node-workbench.md](node-workbench.md). A revision is not an automatic Git rollback. Original commits and
their acceptance/integration/reversion histories remain separate facts.

## 启动配置

```powershell
node fwa/bin/fwa.js editor --project D:/Games/MyGame --fwe-path D:/Git/fw/fwe --allow-write
# Optional existing native CLI; omission keeps the normal resolver:
node fwa/bin/fwa.js editor --project D:/Games/MyGame --fwe-path D:/Git/fw/fwe --allow-write --codex-path D:/Tools/Codex/codex.exe
```

The CLI validates a fully qualified existing native executable, rejecting
`.cmd`/`.bat` and linked path components; Windows requires `.exe`. This choice
does not install a binary, bypass user configuration or reduce the sandbox.
Opening the editor never starts a planning or execution job by itself.

Hosts that already ship `tools/fwa-ui.mjs` can configure the equivalent route in
their project-local `.fwa/ui-launcher.json`:

```json
{
  "fwaPath": "D:/Git/fw/fwa",
  "fwePath": "D:/Git/fw/fwe",
  "codexPath": "D:/Tools/Codex/codex.exe"
}
```

`codexPath` is optional; the two component paths are required when this config
exists and must identify real compatible component checkouts. Paths above are
examples, not bundled installations. The host's `FWA.cmd` opens its managed
console and `FWA-Stop.cmd` stops only its own instance; changed routes require a
stop/reopen, not reuse of an unrelated manual server. The launcher is host-local,
not a universal file generated or installed by `fwa editor`.

Programmatic composition accepts
`startEditor({ projectRoot, fwePath, allowWrite, workflow: { codexOptions: { executable } } })`.
Only a trusted caller may inject `planner`, `executor` or `acceptAndIntegrate`.
HTTP payloads do not accept these capabilities or arbitrary server-side paths.

## Validation boundary

Focused unit, temporary-Git and HTTP tests cover the contracts, replay, permission
filtering, concurrent execution, feedback fences and UI lifecycles. The explicit
`check-interactive-workflow.mjs` browser script drives real UI/API/Git using
deterministic test adapters; `check-workflow-planner.mjs` invokes real Codex on
a synthetic planning-only brief, with no execution Run or game implementation.
Both retain specific evidence and must not be labelled full game acceptance.

This document does not assert a full-suite result. Consult the actual report for each
source version and the [visual workbench checklist](visual-workbench.md), and
keep failed, skipped, simulated-adapter and real-model checks distinguishable.
