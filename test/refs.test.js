import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changedRefsForFiles,
  isRefId,
  normalizeRef,
  RefValidationError,
  refVersionDigest,
  resolveNodeEffects
} from '../src/core/refs.js';

const ZERO_HASH = `sha256:${'0'.repeat(64)}`;

function ref(id, uri) {
  return {
    id,
    kind: id.split('/')[2],
    uri,
    version: 'initial',
    hash: ZERO_HASH,
    metadata: {}
  };
}

test('logical Ref ids and schema are strict and canonical', () => {
  assert.equal(isRefId('ref://code/player-controller'), true);
  assert.equal(isRefId('REF://code/player-controller'), false);
  assert.equal(isRefId('ref://code/../player'), false);
  assert.deepEqual(normalizeRef(ref('ref://code/player', 'Assets/Player.cs')), {
    id: 'ref://code/player',
    kind: 'code',
    uri: 'Assets/Player.cs',
    version: 'initial',
    hash: ZERO_HASH,
    metadata: {}
  });
  assert.throws(() => normalizeRef({
    ...ref('ref://code/player', 'Assets/Player.cs'),
    kind: 'asset'
  }), RefValidationError);
});

test('node logical effects resolve without erasing Ref identity', () => {
  const refs = [
    ref('ref://code/player', 'Assets/Scripts/Player.cs'),
    ref('ref://test/player', 'Assets/Tests/PlayerTests.cs')
  ];
  const result = resolveNodeEffects({
    reads: ['ref://code/player', 'README.md'],
    writes: ['ref://code/player', 'ref://test/player']
  }, refs);
  assert.deepEqual(result.reads, ['Assets/Scripts/Player.cs', 'README.md']);
  assert.deepEqual(result.writes, [
    'Assets/Scripts/Player.cs',
    'Assets/Tests/PlayerTests.cs'
  ]);
  assert.deepEqual(result.consumedRefs.map((item) => item.id), ['ref://code/player']);
  assert.deepEqual(result.producedRefs.map((item) => item.id), [
    'ref://code/player',
    'ref://test/player'
  ]);
  assert.throws(() => resolveNodeEffects({
    reads: [], writes: ['ref://code/missing']
  }, refs), (error) => (
    error instanceof RefValidationError
    && error.errors[0]?.code === 'UNKNOWN_REF'
  ));
});

test('changed Ref detection and version digests are deterministic and scoped', () => {
  const refs = [
    ref('ref://code/player', 'Assets/Scripts/Player.cs'),
    ref('ref://test/player', 'Assets/Tests/**/*.cs')
  ];
  assert.deepEqual(changedRefsForFiles(refs, [
    'Assets/Scripts/Player.cs',
    'Assets/Other.cs'
  ]), ['ref://code/player']);
  assert.deepEqual(changedRefsForFiles([
    ref('ref://test/z-last', 'ASSETS/TESTS/**/*.CS'),
    ref('ref://code/a-first', 'ASSETS/SCRIPTS/PLAYER.CS')
  ], [
    'assets/scripts/player.cs',
    'assets/tests/unit/player.cs'
  ], { ignoreCase: true }), [
    'ref://code/a-first',
    'ref://test/z-last'
  ]);
  assert.deepEqual(changedRefsForFiles([
    ref('ref://code/player', 'ASSETS/SCRIPTS/PLAYER.CS')
  ], ['assets/scripts/player.cs']), []);

  const input = {
    ref: refs[0],
    revision: 'a'.repeat(40),
    changedFiles: ['Assets/Other.cs', 'Assets/Scripts/Player.cs'],
    changes: [
      { status: 'M', path: 'Assets/Scripts/Player.cs' },
      { status: 'M', path: 'Assets/Other.cs' }
    ]
  };
  const first = refVersionDigest(input);
  const second = refVersionDigest({
    ...input,
    changedFiles: [...input.changedFiles].reverse(),
    changes: [...input.changes].reverse()
  });
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, refVersionDigest({ ...input, ignoreCase: true }));
});
