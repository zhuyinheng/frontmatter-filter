import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePrePushUpdates, selectSourceCommitFromUpdates } from '../../src/git.ts';
import { ConfigError } from '../../src/types.ts';

test('selects the single pushed branch update from pre-push input', () => {
  const updates = parsePrePushUpdates(
    'refs/heads/main abcdef1234567890 refs/heads/main 0000000000000000000000000000000000000000\n',
  );

  const selection = selectSourceCommitFromUpdates(updates);
  assert.deepEqual(selection, {
    action: 'sync',
    sourceCommit: 'abcdef1234567890',
    sourceBranch: 'main',
  });
});

test('skips tag-only pushes', () => {
  const updates = parsePrePushUpdates(
    'refs/tags/v1 abcdef1234567890 refs/tags/v1 0000000000000000000000000000000000000000\n',
  );

  const selection = selectSourceCommitFromUpdates(updates);
  assert.deepEqual(selection, {
    action: 'skip',
    reason: 'No branch update found in pre-push input.',
  });
});

test('skips delete-only pushes', () => {
  const updates = parsePrePushUpdates(
    '(delete) 0000000000000000000000000000000000000000 refs/heads/main abcdef1234567890\n',
  );

  const selection = selectSourceCommitFromUpdates(updates);
  assert.deepEqual(selection, {
    action: 'skip',
    reason: 'No branch update found in pre-push input.',
  });
});

test('fails safely when multiple branch updates are pushed together', () => {
  const updates = parsePrePushUpdates(
    [
      'refs/heads/main abcdef1234567890 refs/heads/main 0000000000000000000000000000000000000000',
      'refs/heads/docs fedcba0987654321 refs/heads/docs 0000000000000000000000000000000000000000',
    ].join('\n'),
  );

  assert.throws(() => selectSourceCommitFromUpdates(updates), ConfigError);
});

test('parsePrePushUpdates throws ConfigError on a malformed line', () => {
  assert.throws(
    () => parsePrePushUpdates('refs/heads/main abcdef1234567890 only-three-parts\n'),
    ConfigError,
  );
});

test('parsePrePushUpdates accepts CRLF line endings', () => {
  const updates = parsePrePushUpdates(
    'refs/heads/main abcdef1234567890 refs/heads/main 0000000000000000000000000000000000000000\r\n',
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].localRef, 'refs/heads/main');
});

test('parsePrePushUpdates returns empty array for empty input', () => {
  assert.deepEqual(parsePrePushUpdates(''), []);
  assert.deepEqual(parsePrePushUpdates('\n\n  \n'), []);
});

test('selects the branch update when a branch and a tag are pushed together', () => {
  const updates = parsePrePushUpdates(
    [
      'refs/heads/main abcdef1234567890 refs/heads/main 0000000000000000000000000000000000000000',
      'refs/tags/v1 fedcba0987654321 refs/tags/v1 0000000000000000000000000000000000000000',
    ].join('\n'),
  );

  const selection = selectSourceCommitFromUpdates(updates);
  assert.deepEqual(selection, {
    action: 'sync',
    sourceCommit: 'abcdef1234567890',
    sourceBranch: 'main',
  });
});

test('refs that are neither branches nor tags are skipped', () => {
  const updates = parsePrePushUpdates(
    'refs/remotes/origin/main abcdef1234567890 refs/remotes/origin/main 0000000000000000000000000000000000000000\n',
  );

  assert.deepEqual(selectSourceCommitFromUpdates(updates), {
    action: 'skip',
    reason: 'No branch update found in pre-push input.',
  });
});

test('branch delete mixed with tag push skips without error', () => {
  const updates = parsePrePushUpdates(
    [
      '(delete) 0000000000000000000000000000000000000000 refs/heads/old abcdef1234567890',
      'refs/tags/v2 fedcba0987654321 refs/tags/v2 0000000000000000000000000000000000000000',
    ].join('\n'),
  );

  assert.deepEqual(selectSourceCommitFromUpdates(updates), {
    action: 'skip',
    reason: 'No branch update found in pre-push input.',
  });
});
