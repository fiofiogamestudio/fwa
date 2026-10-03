import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlannerResponse } from '../src/adapters/codex-planner.js';

const node = (id, extra = {}) => ({ id, title: 'JSON 导入', parentId: '',
  instruction: '实现原子导入并验证错误时保持原数据。', outcome: '合法记录导入成功，非法批次不改变原数据。',
  dependencyReasons: [], derivedFrom: null, resources: [], dependsOn: [],
  reads: ['src/store.cjs'], writes: ['src/import.cjs', 'checks/import.test.cjs'], checks: ['import-behavior'],
  maxFiles: 2, maxDiffLines: 300, ...extra });
const response = nodes => ({ title: '导入需求', questions: [], groups: [], nodes });

test('new planner results cannot duplicate the same work under separate IDs or stage titles', () => {
  const duplicate = node('verify', { title: '验证导入', reads: ['src/store.cjs'], writes: ['checks/import.test.cjs', 'src/import.cjs'] });
  assert.throws(() => parsePlannerResponse(response([node('implement'), duplicate]), { prefix: 'p' }), /duplicate the same outcome/);
});

test('shared checks or similar outcomes never by themselves collapse distinct deliverables or direct consumers', () => {
  const plan = parsePlannerResponse(response([
    node('index', { writes: ['generated/index.json'] }),
    node('preview', { writes: ['src/preview.cjs'], dependsOn: ['index'], dependencyReasons: [{ nodeId: 'index', reason: '消费索引数据。' }] }),
    node('export', { writes: ['src/export.cjs'], dependsOn: ['index', 'preview'], dependencyReasons: [
      { nodeId: 'index', reason: '直接读取索引中的原始帧信息。' }, { nodeId: 'preview', reason: '使用预览中已确认的播放次序。' }
    ] })
  ]), { prefix: 'p' }).plan;
  assert.equal(plan.nodes.length, 3);
  assert.deepEqual(plan.nodes[2].dependsOn, ['p-index', 'p-preview']);
});

test('new empty verification stages are rejected while historical empty results remain readable', () => {
  assert.throws(() => parsePlannerResponse(response([node('review', { writes: [] })]), { prefix: 'p' }), /concrete project write scope/);
  const old = parsePlannerResponse(response([node('legacy')]), { prefix: 'old' }).plan;
  assert.throws(() => parsePlannerResponse(response([node('old-legacy', { writes: [] })]), { prefix: 'new', existingPlan: old }), /concrete project write scope/);
  old.nodes[0].writes = [];
  const revised = parsePlannerResponse(response([node('old-legacy', { writes: [] })]), { prefix: 'new', existingPlan: old }).plan;
  assert.deepEqual(revised.nodes[0].writes, []);
});

test('existing duplicate definitions are preserved when a planner merely revises a legacy graph', () => {
  const old = parsePlannerResponse(response([node('a'), node('b', { writes: ['src/other.cjs'] })]), { prefix: 'old' }).plan;
  old.nodes[1].writes = [...old.nodes[0].writes];
  const revised = parsePlannerResponse(response([node('old-a'), node('old-b')]), { prefix: 'new', existingPlan: old }).plan;
  assert.equal(revised.nodes.length, 2);
});

test('a revision cannot turn two existing different results into duplicate work', () => {
  const old = parsePlannerResponse(response([node('a'), node('b', { writes: ['src/other.cjs'] })]), { prefix: 'old' }).plan;
  assert.throws(() => parsePlannerResponse(response([node('old-a'), node('old-b')]), { prefix: 'new', existingPlan: old }), /duplicate the same outcome/);
});
