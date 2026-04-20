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

test('returns skip for empty pre-push input', () => {
  const updates = parsePrePushUpdates('');

  const selection = selectSourceCommitFromUpdates(updates);
  assert.deepEqual(selection, {
    action: 'skip',
    reason: 'No branch update found in pre-push input.',
  });
});

test('throws ConfigError for malformed pre-push input line', () => {
  assert.throws(
    () => parsePrePushUpdates('refs/heads/main abcdef1234567890\n'),
    ConfigError,
  );
});

test('ignores branch delete when mixed with a tag update', () => {
  // Branch delete (localOid is zero) mixed with tag — should skip, no branch update
  const updates = parsePrePushUpdates(
    [
      '(delete) 0000000000000000000000000000000000000000 refs/heads/old abcdef1234567890',
      'refs/tags/v2 fedcba0987654321 refs/tags/v2 0000000000000000000000000000000000000000',
    ].join('\n'),
  );

  const selection = selectSourceCommitFromUpdates(updates);
  assert.deepEqual(selection, {
    action: 'skip',
    reason: 'No branch update found in pre-push input.',
  });
});

test('selects branch update when mixed with tag push', () => {
  const updates = parsePrePushUpdates(
    [
      'refs/heads/main abcdef1234567890 refs/heads/main 0000000000000000000000000000000000000000',
      'refs/tags/v2 fedcba0987654321 refs/tags/v2 0000000000000000000000000000000000000000',
    ].join('\n'),
  );

  const selection = selectSourceCommitFromUpdates(updates);
  assert.deepEqual(selection, {
    action: 'sync',
    sourceCommit: 'abcdef1234567890',
    sourceBranch: 'main',
  });
});

