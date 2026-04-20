import test from 'node:test';
import assert from 'node:assert/strict';

import { planPublication } from '../../src/publication-domain.ts';

test('planPublication separates public markdown, attachments, and broken links without filesystem access', () => {
  const plan = planPublication({
    brokenLinkPolicy: 'warn',
    markdownCandidates: [
      {
        relativePath: 'docs/README.md',
        directoryRelativePath: 'docs',
        basename: 'README.md',
        isMarkdown: true,
        parsed: { hasFrontmatter: true, publicValue: true, warnings: [] },
        content: 'See [child](./child.md)\n![img](./img.png)\nSee [hidden](../drafts/secret.md)\n',
      },
      {
        relativePath: 'docs/child.md',
        directoryRelativePath: 'docs',
        basename: 'child.md',
        isMarkdown: true,
        parsed: { hasFrontmatter: true, warnings: [] },
        content: '',
      },
      {
        relativePath: 'drafts/README.md',
        directoryRelativePath: 'drafts',
        basename: 'README.md',
        isMarkdown: true,
        parsed: { hasFrontmatter: true, publicValue: false, warnings: [] },
        content: '',
      },
      {
        relativePath: 'drafts/secret.md',
        directoryRelativePath: 'drafts',
        basename: 'secret.md',
        isMarkdown: true,
        parsed: { hasFrontmatter: true, warnings: [] },
        content: '',
      },
    ],
    fileEntries: [
      {
        relativePath: 'docs/README.md',
        directoryRelativePath: 'docs',
        basename: 'README.md',
        isMarkdown: true,
      },
      {
        relativePath: 'docs/child.md',
        directoryRelativePath: 'docs',
        basename: 'child.md',
        isMarkdown: true,
      },
      {
        relativePath: 'docs/img.png',
        directoryRelativePath: 'docs',
        basename: 'img.png',
        isMarkdown: false,
      },
      {
        relativePath: 'drafts/README.md',
        directoryRelativePath: 'drafts',
        basename: 'README.md',
        isMarkdown: true,
      },
      {
        relativePath: 'drafts/secret.md',
        directoryRelativePath: 'drafts',
        basename: 'secret.md',
        isMarkdown: true,
      },
    ],
  });

  assert.deepEqual(
    plan.publishedMarkdown.map((entry) => entry.relativePath),
    ['docs/child.md', 'docs/README.md'],
  );
  assert.deepEqual(plan.attachments.map((entry) => entry.relativePath), ['docs/img.png']);
  assert.deepEqual(plan.brokenLinks, [
    {
      source: 'docs/README.md',
      target: 'drafts/secret.md',
      reason: 'not-public',
    },
  ]);
});
