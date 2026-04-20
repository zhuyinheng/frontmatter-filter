import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname } from 'node:path';

import { parseFrontmatter } from '../../src/frontmatter.ts';
import { derivePublicationSelection, normalizeLookupKey, type SnapshotTree } from '../../src/planner.ts';
import { BrokenLinkPolicyError } from '../../src/types.ts';

function makeTree(files: Record<string, string>): SnapshotTree {
  const markdownByPath = new Map();
  const fileByPath = new Map();
  const readmeByDirectory = new Map();

  for (const [relativePath, content] of Object.entries(files)) {
    const isMarkdown = relativePath.toLowerCase().endsWith('.md');
    const entry = {
      relativePath,
      directoryRelativePath: dirname(relativePath) === '.' ? '' : dirname(relativePath),
      basename: basename(relativePath),
      isMarkdown,
      buffer: Buffer.from(content, 'utf8'),
    };

    fileByPath.set(normalizeLookupKey(relativePath), entry);

    if (!isMarkdown) {
      continue;
    }

    const markdownEntry = {
      ...entry,
      content,
      parsed: parseFrontmatter(content),
    };

    markdownByPath.set(normalizeLookupKey(relativePath), markdownEntry);

    if (entry.basename.toLowerCase() === 'readme.md') {
      readmeByDirectory.set(normalizeLookupKey(entry.directoryRelativePath), relativePath);
    }
  }

  return {
    markdownByPath,
    fileByPath,
    readmeByDirectory,
    warnings: [],
  };
}

test('derivePublicationSelection creates a pure, testable content boundary', () => {
  const tree = makeTree({
    'README.md': '---\npublic: true\n---\n',
    'notes/post.md': 'See [draft](./draft.md) and [pdf](../assets/a.pdf).',
    'notes/draft.md': '---\npublic: false\n---\n',
    'assets/a.pdf': 'binary-pdf',
  });

  const plan = derivePublicationSelection(tree, 'warn');

  assert.deepEqual(
    plan.publishedMarkdown.map((item) => item.relativePath),
    ['notes/post.md', 'README.md'],
  );
  assert.deepEqual(plan.copiedAttachments.map((item) => item.relativePath), ['assets/a.pdf']);
  assert.deepEqual(plan.brokenLinks, [
    {
      source: 'notes/post.md',
      target: 'notes/draft.md',
      reason: 'not-public',
    },
  ]);
});

test('derivePublicationSelection honors broken-link policy in one place', () => {
  const tree = makeTree({
    'README.md': '---\npublic: true\n---\n',
    'notes/post.md': '[missing](./none.md)',
  });

  const ignored = derivePublicationSelection(tree, 'ignore');
  assert.deepEqual(ignored.brokenLinks, []);

  assert.throws(() => derivePublicationSelection(tree, 'error'), BrokenLinkPolicyError);
});
