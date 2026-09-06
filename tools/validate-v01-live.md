# FWA V0.1 live composition validator

`validate-v01-live.mjs` proves the V0.1 path against one temporary Unity Git
project. It does not use the FWA repository as the target and it refuses to
place its output inside the FWA source tree.

The validator executes this sequence:

1. ask the supplied Unity Editor to create the temporary project, then verify
   both its version and revision from `ProjectVersion.txt`;
2. scaffold the minimal project, run a one-time settings normalizer, remove the
   helper, and execute the baseline Unity profile;
3. initialize the owned temporary Git repository with fsmonitor disabled, then
   rerun the baseline from a fresh detached worktree and prove its cleanup;
4. initialize FWA, register and resolve the logical source Ref, and materialize
   a bounded consumer of the baseline Ref version;
5. create the requested Goal and strict human-authored two-Node DAG;
6. invoke the real Codex CLI in an isolated Git worktree to add a C# `Fwa.Live`
   counter source and its EditMode test;
7. record the Run and capture its immutable ChangeSet and execution artifact;
8. compile and run every expected EditMode test with the real Unity Editor,
   parse strict NUnit XML, store Evidence, and accept the source Node;
9. regression-gate and merge the source ChangeSet, advance only its Ref, prove
   the old-version consumer stale, and prove the unrun consumer still valid and
   ready;
10. materialize, Unity-evaluate, and exact-base integrate the downstream
    consumer of the new Ref version;
11. regression-gate a source revert as a new ChangeSet and ProjectRevision;
12. prove the source history remains, the new-version consumer is stale, the
    earlier stale history remains, and the completed Goal reopens;
13. verify FWA artifacts, events, worktrees, candidate refs, Git objects, and
    operation cleanliness;
14. prove the FWA source snapshot and host Git state did not change and the
    temporary target is clean. Shared Codex configuration is fingerprinted only
    as observational external state.

On this Windows host, the explicit reproducible invocation is:

```powershell
npm.cmd run validate:v01:live -- `
  --unity 'D:\Unity Editor\2022.3.62f3c1\Editor\Unity.exe' `
  --ignore-user-config `
  --windows-elevated `
  --editmode-no-batch
```

Neither Codex option is silently enabled. `--ignore-user-config` is a per-run
configuration bypass. `--windows-elevated` is a separate privilege-expanding
Windows opt-in. Omit either option when the local Codex installation does not
need it.

`--editmode-no-batch` affects only the EditMode test launch and is available for
Unity hosts affected by batch-mode teardown hangs. Compile remains batch-mode
and no-graphics. The production Unity profile defaults EditMode to batch mode;
the successful validation on this host explicitly disabled it. Compile and
EditMode commands use `-forgetProjectPath`. Their stdout/stderr pipes are not
captured; separate Unity log files and NUnit XML are required expected
artifacts.

The validator's live-only retry wrapper can retry at most three times and only
for the exact fail-closed shape “compile passed, EditMode timed out with process
termination confirmed, report check skipped.” A timed-out attempt is never
converted into passing Evidence, and other failure shapes are never retried.

The script prints progress to stderr and, on success, one compact JSON result
to stdout. A failed runtime validation prints a structured error to stderr and
exits nonzero. A successful retained run contains:

```text
<run-root>/
  project/                 temporary Unity Git project and .fwa ledger
  evidence/summary.json    bound source/config/runtime evidence
  evidence/summary.md      compact human-readable verdict and timings
  evidence/events.json     complete append-only event history
  evidence/final-status.json
  evidence/unity-attempts/ one record for every Unity evaluation attempt
```

The summary binds the run to SHA-256 hashes of the FWA source files and records
the real Codex invocation metadata, Unity criteria, exact all-passing NUnit
counts, integration/reversion revisions, Ref state, stale propagation, Git
graph and the final `verify()` report. On failure the directory is retained and
`evidence/failure.json` and `evidence/failure.md` identify the last phase and
the exact failed assertion or runtime error.

The retained directory is sensitive local engineering evidence. It can contain
absolute paths, host Git status, model output, command output, Unity Editor or
licensing logs, and NUnit reports. Do not commit or publish it without review.

## Retained successful run

The 2026-09-06 completion run is retained at:

```text
C:\Users\kaiji\AppData\Local\Temp\fwa-v01-live-2BP7I0
```

Its `evidence/summary.json` binds the pass to source digest
`69cb36fe6042620bbc493ba14fc192c6605bda2493d0bce866ed5958f6b6f830`.
It ran from `2026-09-06T05:12:48.214Z` through
`2026-09-06T05:19:51.441Z` in 423,227 ms with Node v24.14.1, Unity
2022.3.62f3c1 revision 1623fc0bbb97, Unity Test Framework 1.1.33, and
EditMode batch mode explicitly disabled.

The real `codex@1` executor exited 0 with 12 parsed JSONL events. Source
acceptance, source integration, consumer acceptance, and reversion ran and
passed 2/2, 2/2, 2/2, and 1/1 NUnit tests respectively. The source integration
revision was `3ea97832ce611c04d39a2091b9ceb71cbf0fab8b`, the consumer revision was
`95ebf57c538d857d925495fe2797495e39f810d8`, and the revert/final revision was
`29ff478a80f968e0b8c1feea4f1c6b197a9c6994`.

All six Unity evaluation attempts passed without a retry. Final verification
reported 85 events in 39 batches, 27 referenced artifacts totaling 2,413,419
bytes, an operationally clean store, no candidate-worktree residue, and no
orphan candidate refs. Three expected candidate refs remain bound to their
durable Integration/Reversion records as Git reachability anchors and were
verified. The Goal reopened as active; both the pre-integration and
post-integration consumers were stale for their respective
Integration/Reversion causes.

The shared Codex configuration fingerprint changed during this run. The
validator records that fact as `observational-only-shared-external-state`: the
configuration is not owned or locked by FWA, so the drift is not attributed to
FWA. The execution artifact independently records `ignoreUserConfig=true` for
the Codex invocation; that proves the invocation bypassed user configuration,
not that the shared file remained unchanged.

Use `node tools/validate-v01-live.mjs --help` for environment-variable aliases,
timeouts and version overrides. The minimal generated Unity project defaults
to `com.unity.test-framework` 1.1.33; use `--test-framework-version` if another
Unity line requires a different compatible package version.
