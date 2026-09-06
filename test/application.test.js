import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalizePlan,
  FwaApplication
} from '../src/application/fwa-application.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-application-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, app: new FwaApplication(root) };
}

function twoNodePlan(overrides = {}) {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'inspect',
        title: 'Inspect inputs',
        depends_on: [],
        reads: ['src/**'],
        writes: ['evidence/inspection.json'],
        requires: ['script'],
        acceptance_contract: { checks: ['inspection-exists'] },
        budget: {
          max_retries: 1,
          max_files: 2,
          max_diff_lines: 100
        }
      },
      {
        id: 'implement',
        title: 'Implement change',
        depends_on: ['inspect'],
        reads: ['src/**', 'evidence/inspection.json'],
        writes: ['src/**'],
        requires: ['agent'],
        acceptance_contract: 'implementation-contract',
        budget: {
          max_retries: 2,
          max_files: 8,
          max_diff_lines: 500,
          wall_time_minutes: 15
        }
      }
    ],
    ...overrides
  };
}

const ZERO_REF_HASH = `sha256:${'0'.repeat(64)}`;

test('registers versioned logical Refs before accepting a Ref-backed plan', async (t) => {
  const { app } = await fixture(t);
  await app.init();
  const registered = await app.registerRef({
    ref: {
      id: 'ref://code/player-controller',
      kind: 'code',
      uri: 'Assets/Scripts/PlayerController.cs',
      version: 'initial',
      hash: ZERO_REF_HASH,
      metadata: { owner: 'gameplay' }
    },
    commandId: 'register-player-ref'
  });
  assert.equal(registered.appended, true);
  assert.equal(registered.ref.streamVersion, 1);
  assert.equal((await app.registerRef({
    ref: {
      id: 'ref://code/player-controller',
      kind: 'code',
      uri: 'Assets/Scripts/PlayerController.cs',
      version: 'initial',
      hash: ZERO_REF_HASH,
      metadata: { owner: 'gameplay' }
    },
    commandId: 'register-player-ref'
  })).appended, false);

  const goal = await app.createGoal({ title: 'Ref plan', commandId: 'ref-goal' });
  const plan = {
    schemaVersion: 1,
    nodes: [{
      id: 'player',
      dependsOn: [],
      reads: ['ref://code/player-controller'],
      writes: ['ref://code/player-controller'],
      capabilities: ['agent'],
      acceptance: { checks: ['compile'] },
      budget: { maxRetries: 0, maxFiles: 2, maxDiffLines: 50 }
    }]
  };
  const loaded = await app.loadPlan({
    goalId: goal.goal.id,
    plan,
    commandId: 'ref-plan'
  });
  assert.equal(loaded.nodes[0].writes[0], 'ref://code/player-controller');
  const status = await app.getStatus();
  assert.equal(status.refs[0].uri, 'Assets/Scripts/PlayerController.cs');

  const missingGoal = await app.createGoal({ title: 'Missing Ref', commandId: 'missing-goal' });
  await assert.rejects(app.loadPlan({
    goalId: missingGoal.goal.id,
    plan: {
      ...plan,
      nodes: [{ ...plan.nodes[0], id: 'missing', writes: ['ref://code/missing'] }]
    },
    commandId: 'missing-plan'
  }), (error) => error.code === 'plan-ref-not-found');
});

test('runs the phase-one goal and manual-plan golden path', async (t) => {
  const { root, app } = await fixture(t);
  const initialized = await app.init();
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.project.projectRoot, root);
  assert.equal(initialized.storage.eventCount, 0);

  const created = await app.createGoal({
    title: 'Build a vertical slice',
    request: 'Build and verify one deterministic slice.',
    commandId: 'create-goal-1'
  });
  assert.equal(created.appended, true);
  assert.match(created.goal.id, /^goal_/);
  assert.equal(created.goal.status, 'draft');

  const duplicateCreate = await app.createGoal({
    title: 'Build a vertical slice',
    request: 'Build and verify one deterministic slice.',
    commandId: 'create-goal-1'
  });
  assert.equal(duplicateCreate.appended, false);
  assert.equal(duplicateCreate.goal.id, created.goal.id);

  const loaded = await app.loadPlan({
    goalId: created.goal.id,
    plan: twoNodePlan({ goal_id: created.goal.id }),
    commandId: 'load-plan-1'
  });
  assert.equal(loaded.appended, true);
  assert.match(loaded.planId, /^plan_/);
  assert.match(loaded.planHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(loaded.goal.status, 'planned');
  assert.deepEqual(
    loaded.nodes.map((node) => [node.id, node.status]),
    [['implement', 'planned'], ['inspect', 'ready']]
  );

  const duplicateLoad = await app.loadPlan({
    goalId: created.goal.id,
    plan: twoNodePlan({ goalId: created.goal.id }),
    commandId: 'load-plan-1'
  });
  assert.equal(duplicateLoad.appended, false);
  assert.equal(duplicateLoad.planId, loaded.planId);

  const status = await app.getStatus();
  assert.equal(status.batchCount, 2);
  assert.equal(status.eventCount, 5);
  assert.equal(status.lastSequence, 5);
  assert.equal(status.goals[0].status, 'planned');
  assert.deepEqual(status.integrations, []);
  assert.deepEqual(status.projectRevisions, []);
  assert.equal(status.nodes.find((node) => node.id === 'inspect').validity, 'valid');
  assert.equal(status.nodes.find((node) => node.id === 'implement').goalId, created.goal.id);

  const events = await app.listEvents();
  assert.deepEqual(events.map((event) => event.type), [
    'GoalCreated',
    'PlanLoaded',
    'NodePlanned',
    'NodePlanned',
    'NodeReady'
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);

  const verification = await app.verify();
  assert.deepEqual(
    {
      ok: verification.ok,
      batchCount: verification.batchCount,
      eventCount: verification.eventCount,
      goalCount: verification.goalCount,
      nodeCount: verification.nodeCount,
      integrationCount: verification.integrationCount,
      projectRevisionCount: verification.projectRevisionCount,
      gitVerifiedIntegrationCount: verification.gitVerifiedIntegrationCount
    },
    {
      ok: true,
      batchCount: 2,
      eventCount: 5,
      goalCount: 1,
      nodeCount: 2,
      integrationCount: 0,
      projectRevisionCount: 0,
      gitVerifiedIntegrationCount: 0
    }
  );
});

test('verify rejects a malformed integration verification port', async (t) => {
  const { app } = await fixture(t);
  await app.init();

  await assert.rejects(
    app.verify({ integration: {} }),
    (error) => error.code === 'invalid-verification-port'
  );
});

test('rejects command-id reuse with a different normalized intent', async (t) => {
  const { app } = await fixture(t);
  await app.init();
  await app.createGoal({ title: 'First', commandId: 'same-command' });

  await assert.rejects(
    app.createGoal({ title: 'Second', commandId: 'same-command' }),
    (error) => error.code === 'idempotency-conflict'
  );
  assert.equal((await app.getStatus()).eventCount, 1);
});

test('reserves the internal command namespace for orchestration transactions', async (t) => {
  const { app } = await fixture(t);
  await app.init();
  await assert.rejects(
    app.createGoal({ title: 'Must not collide', commandId: '@fwa/run/foreign' }),
    (error) => error.code === 'reserved-command-id'
  );
  assert.equal((await app.getStatus()).eventCount, 0);
});

test('verify reports content-valid artifacts that no ChangeSet references', async (t) => {
  const { app } = await fixture(t);
  await app.init();
  const orphan = await app.artifacts.put('not yet referenced by an event');

  const verification = await app.verify();
  assert.equal(verification.ok, true);
  assert.equal(verification.operationallyClean, false);
  assert.equal(verification.artifactCount, 1);
  assert.equal(verification.referencedArtifactCount, 0);
  assert.deepEqual(verification.unreferencedArtifacts, [orphan.digest]);
});

test('verify reports an unrecorded standard candidate worktree as operational residue', async (t) => {
  const { root, app } = await fixture(t);
  await app.init();
  const residue = path.join(root, '.fwa', 'integrations', 'partial-prepare', 'worktree');
  await mkdir(residue, { recursive: true });

  const verification = await app.verify();
  assert.equal(verification.ok, true);
  assert.equal(verification.operationallyClean, false);
  assert.deepEqual(verification.candidateWorkspaceResidue, [residue]);
});

test('fails closed for mismatched goals, cycles, aliases, and unknown fields', async (t) => {
  const { app } = await fixture(t);
  await app.init();
  const { goal } = await app.createGoal({ title: 'Goal', commandId: 'create' });

  await assert.rejects(
    app.loadPlan({
      goalId: goal.id,
      plan: twoNodePlan({ goalId: 'goal_someone-else' }),
      commandId: 'mismatch'
    }),
    (error) => error.code === 'plan-goal-mismatch'
  );

  const cyclic = twoNodePlan();
  cyclic.nodes[0].depends_on = ['implement'];
  await assert.rejects(
    app.loadPlan({ goalId: goal.id, plan: cyclic, commandId: 'cycle' }),
    (error) => error.code === 'FWA_INVALID_PLAN'
      && error.errors.some((item) => item.code === 'CYCLE_DETECTED')
  );

  const ambiguous = twoNodePlan();
  ambiguous.nodes[0].dependsOn = [];
  assert.throws(
    () => canonicalizePlan(ambiguous),
    (error) => error.errors.some((item) => item.code === 'AMBIGUOUS_FIELD')
  );

  const typo = twoNodePlan();
  typo.nodes[0].write = ['wrong-field'];
  assert.throws(
    () => canonicalizePlan(typo),
    (error) => error.errors.some((item) => item.code === 'UNKNOWN_FIELD')
  );

  const nullSchema = twoNodePlan({ schemaVersion: null });
  assert.throws(
    () => canonicalizePlan(nullSchema),
    (error) => error.errors.some((item) => item.code === 'UNSUPPORTED_SCHEMA')
  );

  assert.equal((await app.getStatus()).eventCount, 1);
});

test('a goal accepts only one plan even under a new command id', async (t) => {
  const { app } = await fixture(t);
  await app.init();
  const { goal } = await app.createGoal({ title: 'Goal', commandId: 'create' });
  await app.loadPlan({ goalId: goal.id, plan: twoNodePlan(), commandId: 'first-plan' });

  await assert.rejects(
    app.loadPlan({ goalId: goal.id, plan: twoNodePlan(), commandId: 'second-plan' }),
    (error) => error.code === 'goal-not-draft'
  );
  assert.equal((await app.getStatus()).batchCount, 2);
});

test('generated goal ids and authored plan ids are globally unique', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'fwa-identities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const collidingIds = new FwaApplication(root, { idFactory: () => 'fixed' });
  await collidingIds.init();
  await collidingIds.createGoal({ title: 'First', commandId: 'create-first' });
  await assert.rejects(
    collidingIds.createGoal({ title: 'Second', commandId: 'create-second' }),
    (error) => error.code === 'goal-already-exists'
  );

  const secondRoot = await mkdtemp(path.join(tmpdir(), 'fwa-plan-identities-'));
  t.after(() => rm(secondRoot, { recursive: true, force: true }));
  const app = new FwaApplication(secondRoot);
  await app.init();
  const first = await app.createGoal({ title: 'First', commandId: 'goal-1' });
  const second = await app.createGoal({ title: 'Second', commandId: 'goal-2' });
  await app.loadPlan({
    goalId: first.goal.id,
    plan: twoNodePlan({ id: 'shared-plan' }),
    commandId: 'plan-1'
  });
  const otherNodes = twoNodePlan({ id: 'shared-plan' });
  otherNodes.nodes[0].id = 'other-inspect';
  otherNodes.nodes[1].id = 'other-implement';
  otherNodes.nodes[1].depends_on = ['other-inspect'];
  await assert.rejects(
    app.loadPlan({
      goalId: second.goal.id,
      plan: otherNodes,
      commandId: 'plan-2'
    }),
    (error) => error.code === 'plan-already-exists'
  );
});

test('simultaneous retries converge under repeated lock contention', async (t) => {
  const { root } = await fixture(t);
  const first = new FwaApplication(root);
  const second = new FwaApplication(root);
  await first.init();

  for (let index = 0; index < 20; index += 1) {
    const commandId = `concurrent-command-${index}`;
    const title = `Concurrent goal ${index}`;
    const results = await Promise.all([
      first.createGoal({ title, commandId }),
      second.createGoal({ title, commandId })
    ]);
    assert.equal(results[0].goal.id, results[1].goal.id);
    assert.deepEqual(results.map((result) => result.appended).sort(), [false, true]);
  }
  const status = await first.getStatus();
  assert.equal(status.batchCount, 20);
  assert.equal(status.eventCount, 20);
});
