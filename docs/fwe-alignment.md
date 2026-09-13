# FWA / FWE integration boundary

FWA is a command-driven application hosted by FWE, not a replacement editor framework.

## One authority, configured surfaces

- `src/core/interaction-contract.js` owns transport field constraints, permission values and admission limits. Application and HTTP validation consume that contract.
- `src/editor/editor-model.js` derives the FWE Model and Inspector metadata at the guarded composition root. Projection status enums come from the actual state machines. The static app manifest's authority marker is not a standalone generated schema.
- `src/editor/app/{console,content,workflow,experiment}.ui.json` define ordinary layout, labels, buttons, lists and form presentation. `surface-adapter.js` binds schema paths to the derived model and uses FWE `createSurface` / native Inspector controls.
- FWE supplies ordinary control styling and theme tokens. `console-style.js` only handles graph dimensions, inert document/diff rendering, media containment and drag feedback.

The graph, ZIP/folder traversal, inert document preview and immutable media are domain renderers. They remain explicit slots/controllers rather than general-purpose controls duplicated in FWA.

## Resources and commands are different

The read-only `fwa-projection` source exposes `projection.json` plus canonical virtual object resources. Object resources return the full current projection and an editor-only selection descriptor. They are not copied JSON files and have no write/create/delete handler.

Native resource names include `objects/nodes/<encoded-id>.json`, analogous Ref/Run/ChangeSet/Evidence resources, and goal-scoped `objects/groups/<encoded-goal>/<encoded-group>.json`. Historical physical node IDs remain individually addressable after a plan revision. All-goal graph group IDs are namespaced independently from the execution DAG.

FWA uses FWE `navigation.navigate`, `navigation.href` and `ui.createResourceLink`; reload and new-tab links restore the selected object. Following a reader into a different goal updates the active goal filter. While FWE locks a loading resource, a native disabled fieldset exposes the same unavailable state to keyboard users and automation.

FWA retains the same controller across resource navigation. Command drafts live in that controller; node feedback retains the same connected editor while its facts refresh. Surface fragments, graph instances, drop listeners and timers are released on removal/disposal; late content responses cannot populate another object's inspector.

Business operations still go through guarded FWA command endpoints with project identity, session headers, CSRF and runtime fingerprints. FWE Save/Undo are **not** node acceptance, integration or rollback. Generic CRUD stays disabled. References remain project-local immutable copies with versioned permission policy; no implicit source writeback is introduced.

## Compatibility and evidence

This adapter requires the sibling FWE configured-Surface contract `native-inspector-v1` in addition to its guarded host/graph contracts. No nested FWE copy or core-to-FWE import is introduced. At this change's validation baseline those FWE APIs are present in the local working tree; distributing FWA also requires distributing that compatible FWE version.

Relevant regression entries:

- `test/editor-surface-contract.test.js`: JSON-only presentation, real schema references and theme boundary.
- `test/editor-model-contract.test.js`, `test/editor-resource-http.test.js`: shared validation, source identity, historical routes and guarded HTTP.
- `test/editor-content-lifecycle.test.js`, `test/workflow-panel.test.js`: actual FWE Surface/Inspector behavior, draft/permission/lifecycle contracts.
- `tools/check-object-navigation.mjs`: cross-goal graph/resources, new tabs, reload, native loading and draft preservation.
- Existing workbench, interactive workflow and artifact-media browser checks exercise real DOM, HTTP and isolated Git worktrees.

These checks establish editor integration, not autonomous game acceptance. The deterministic browser workflow is explicitly not a live-model gameplay test. Review and comparison invoke trusted project checks configured at launch; automatic game capture and visual judgement remain the project's responsibility. See [change-review.md](change-review.md).
