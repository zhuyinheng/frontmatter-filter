import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSourceCommit } from '../../src/core.ts';
import { createInMemorySnapshotReader } from '../../src/snapshot-reader.ts';
import type { ResolvedConfig } from '../../src/types.ts';
import { BrokenLinkPolicyError } from '../../src/types.ts';

function makeConfig(): ResolvedConfig {
  return {
    repoRoot: '/virtual',
    configPath: '/virtual/.frontmatter-filter.json',
    target: '/virtual/target',
    branch: 'gh-pages',
    sensitivePatterns: [],
    brokenLinkPolicy: 'warn',
    verbose: false,
    quiet: false,
  };
}

test('supports in-memory snapshots to test visibility and references without git setup', async () => {
  const snapshotReader = createInMemorySnapshotReader(
    {
      'README.md': '---\npublic: true\n---\n',
      'docs/post.md': '---\ntitle: Post\n---\n\nSee [guide](../assets/guide.pdf)',
      'docs/drafts/wip.md': '---\npublic: false\n---\n',
      'assets/guide.pdf': Buffer.from([1, 2, 3]),
    },
    {
      sourceCommit: 'in-memory-commit',
      sourceBranch: 'main',
    },
  );

  const result = await checkSourceCommit(makeConfig(), {
    snapshotReader,
    toolVersion: 'test-version',
  });

  assert.equal(result.sourceCommit, 'in-memory-commit');
  assert.equal(result.sourceBranch, 'main');
  assert.deepEqual(result.publishedMarkdown, ['docs/post.md', 'README.md']);
  assert.deepEqual(result.copiedAttachments, ['assets/guide.pdf']);
  assert.deepEqual(result.brokenLinks, []);
});

test('in-memory snapshots still respect brokenLinkPolicy="error"', async () => {
  const snapshotReader = createInMemorySnapshotReader({
    'note.md': '---\npublic: true\n---\n\n[missing](./nope.md)\n',
  });

  const config = {
    ...makeConfig(),
    brokenLinkPolicy: 'error' as const,
  };

  await assert.rejects(
    () =>
      checkSourceCommit(config, {
        snapshotReader,
        toolVersion: 'test-version',
      }),
    BrokenLinkPolicyError,
  );
});
