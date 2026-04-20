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
