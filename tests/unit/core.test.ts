import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SENSITIVE_PATTERNS } from '../../src/config.ts';
import { checkSourceCommit, mirrorSourceCommit } from '../../src/core.ts';
import type { ResolvedConfig } from '../../src/types.ts';
import { SensitivePatternError } from '../../src/types.ts';
import { commitAll, getHeadCommit, initRepo, runGit } from '../helpers/e2e.ts';

test('mirrors only public markdown and referenced attachments from the committed source snapshot', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await mkdir(join(repoRoot, 'blog', 'drafts'), { recursive: true });
    await mkdir(join(repoRoot, 'assets'), { recursive: true });

    const committedPost = `---
title: Post
---

See [[drafts/wip]]
See [child](./child.md)
[guide](../assets/guide.pdf)
![Photo](../assets/photo.png)
![Logo][logo]
![[../assets/embed.pdf]]

[logo]: ../assets/logo.svg`;

    await writeFile(join(repoRoot, 'README.md'), `---
title: Root
---
`);
    await writeFile(join(repoRoot, 'blog', 'README.md'), `---
public: true
---

# Blog`);
    await writeFile(join(repoRoot, 'blog', 'post.md'), committedPost);
    await writeFile(join(repoRoot, 'blog', 'child.md'), `---
title: Child
---

Public child.`);
    await writeFile(join(repoRoot, 'blog', 'drafts', 'README.md'), `---
public: false
---
`);
    await writeFile(join(repoRoot, 'blog', 'drafts', 'wip.md'), `---
title: Draft
---
`);
    await writeFile(join(repoRoot, 'blog', 'unreferenced.txt'), 'do not copy');
    await writeFile(join(repoRoot, 'assets', 'guide.pdf'), Buffer.from([1, 2, 3]));
    await writeFile(join(repoRoot, 'assets', 'photo.png'), Buffer.from([4, 5, 6]));
    await writeFile(join(repoRoot, 'assets', 'logo.svg'), Buffer.from([7, 8, 9]));
    await writeFile(join(repoRoot, 'assets', 'embed.pdf'), Buffer.from([10, 11, 12]));
    await writeFile(join(repoRoot, 'assets', 'ignored.bin'), Buffer.from([13, 14, 15]));

    await commitAll(repoRoot, 'initial snapshot');
    const sourceCommit = await getHeadCommit(repoRoot);

    await writeFile(join(repoRoot, 'blog', 'post.md'), '# working tree change should be ignored');
    await writeFile(join(repoRoot, 'blog', 'new-uncommitted.md'), `---
public: true
---
`);

    const config = makeConfig(repoRoot, targetRoot);
    const result = await mirrorSourceCommit(config, {
      sourceCommit,
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.equal(result.sourceCommit, sourceCommit);
    assert.equal(result.didWrite, true);
    assert.deepEqual(result.publishedMarkdown, ['blog/child.md', 'blog/post.md', 'blog/README.md']);
    assert.deepEqual(result.copiedAttachments, [
      'assets/embed.pdf',
      'assets/guide.pdf',
      'assets/logo.svg',
      'assets/photo.png',
    ]);
    assert.deepEqual(result.brokenLinks, [
      {
        source: 'blog/post.md',
        target: 'blog/drafts/wip.md',
        reason: 'not-public',
      },
    ]);

    assert.equal(await readFile(join(targetRoot, 'blog', 'post.md'), 'utf8'), committedPost);
    await assert.rejects(() => readFile(join(targetRoot, 'blog', 'new-uncommitted.md'), 'utf8'));
    await assert.rejects(() => readFile(join(targetRoot, 'blog', 'unreferenced.txt'), 'utf8'));
    await assert.rejects(() => readFile(join(targetRoot, 'assets', 'ignored.bin'), 'utf8'));

    const metadata = JSON.parse(
      await readFile(join(targetRoot, '.frontmatter-filter-meta.json'), 'utf8'),
    ) as { sourceCommit: string; toolVersion: string };
    assert.equal(metadata.sourceCommit, sourceCommit);
    assert.equal(metadata.toolVersion, 'test-version');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('checks sensitive patterns against the committed source snapshot', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

api_key: super-secret`);
    await commitAll(repoRoot, 'sensitive');

    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

sanitized in working tree`);

    const config = {
      ...makeConfig(repoRoot, targetRoot),
      sensitivePatterns: ['\\bapi_key\\s*:'],
    };

    await assert.rejects(
      () =>
        checkSourceCommit(config, {
          sourceCommit: 'HEAD',
          toolVersion: 'test-version',
        }),
      SensitivePatternError,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('records broken reference with reason "missing" for non-existent targets', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

Broken md: [gone](./gone.md)
Broken img: ![nope](./missing.png)
`);
    await commitAll(repoRoot, 'missing refs');

    const config = makeConfig(repoRoot, targetRoot);
    const result = await checkSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
    });

    const reasons = result.brokenLinks.map((link) => ({
      target: link.target,
      reason: link.reason,
    }));
    assert.deepEqual(
      reasons.sort((left, right) => left.target.localeCompare(right.target)),
      [
        { target: 'gone.md', reason: 'missing' },
        { target: 'missing.png', reason: 'missing' },
      ],
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('brokenLinkPolicy "error" causes buildPublishPlan to reject when broken links exist', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

[missing](./nope.md)
`);
    await commitAll(repoRoot, 'broken');

    const config = {
      ...makeConfig(repoRoot, targetRoot),
      brokenLinkPolicy: 'error' as const,
    };

    await assert.rejects(
      () => checkSourceCommit(config, { sourceCommit: 'HEAD', toolVersion: 'test-version' }),
      /[Bb]roken/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('brokenLinkPolicy "ignore" returns an empty brokenLinks list', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

[missing](./nope.md)
`);
    await commitAll(repoRoot, 'broken');

    const config = {
      ...makeConfig(repoRoot, targetRoot),
      brokenLinkPolicy: 'ignore' as const,
    };

    const result = await checkSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
    });
    assert.deepEqual(result.brokenLinks, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('visibility inheritance walks multiple directory levels up to find an explicit README value', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await mkdir(join(repoRoot, 'a', 'b', 'c'), { recursive: true });

    await writeFile(join(repoRoot, 'a', 'README.md'), `---
public: true
---

# A README
`);
    await writeFile(join(repoRoot, 'a', 'b', 'README.md'), `---
title: B readme without explicit public
---
`);
    await writeFile(join(repoRoot, 'a', 'b', 'c', 'README.md'), `---
title: C readme also without explicit public
---
`);
    await writeFile(join(repoRoot, 'a', 'b', 'c', 'leaf.md'), `---
title: Leaf
---

Just a leaf.
`);
    await commitAll(repoRoot, 'multi-level readme');

    const config = makeConfig(repoRoot, targetRoot);
    const result = await checkSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
    });

    assert.ok(
      result.publishedMarkdown.includes('a/b/c/leaf.md'),
      `expected leaf.md to inherit public=true from a/README.md, got: ${result.publishedMarkdown.join(', ')}`,
    );
    assert.ok(result.publishedMarkdown.includes('a/README.md'));
    assert.ok(result.publishedMarkdown.includes('a/b/README.md'));
    assert.ok(result.publishedMarkdown.includes('a/b/c/README.md'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('explicit public false on a child wins over an ancestor README set to true', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await mkdir(join(repoRoot, 'pub', 'inner'), { recursive: true });
    await writeFile(join(repoRoot, 'pub', 'README.md'), `---
public: true
---
`);
    await writeFile(join(repoRoot, 'pub', 'inner', 'child.md'), `---
public: false
---
`);
    await commitAll(repoRoot, 'explicit child override');

    const config = makeConfig(repoRoot, targetRoot);
    const result = await checkSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
    });

    assert.ok(!result.publishedMarkdown.includes('pub/inner/child.md'));
    assert.ok(result.publishedMarkdown.includes('pub/README.md'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('sensitive scan is bypassed when SKIP_SENSITIVE=1', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  const original = process.env.SKIP_SENSITIVE;
  process.env.SKIP_SENSITIVE = '1';
  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

api_key: leaked`);
    await commitAll(repoRoot, 'leak');

    const result = await checkSourceCommit(makeConfig(repoRoot, targetRoot), {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
    });
    assert.deepEqual(result.sensitiveMatches, []);
  } finally {
    if (original === undefined) {
      delete process.env.SKIP_SENSITIVE;
    } else {
      process.env.SKIP_SENSITIVE = original;
    }
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('sensitive scan skips binary-looking files (leading NUL) and still scans textual ones', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

See [binary](./secret.bin)`);

    const binaryPayload = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      Buffer.from('api_key: should-not-trigger-because-leading-nul', 'utf8'),
    ]);
    await writeFile(join(repoRoot, 'secret.bin'), binaryPayload);
    await commitAll(repoRoot, 'binary');

    const result = await checkSourceCommit(makeConfig(repoRoot, targetRoot), {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
    });
    assert.deepEqual(result.sensitiveMatches, []);
    assert.ok(result.copiedAttachments.includes('secret.bin'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('default sensitive patterns catch password, token and bearer markers (checked per marker in a single repo)', async () => {
  const markers = ['password:', 'token=', 'bearer: abc', 'Secret=xyz'];
  const [repoRoot, targetRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-target-')),
  ]);

  try {
    await initRepo(repoRoot);

    for (const marker of markers) {
      await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

leaking ${marker} value`);
      await commitAll(repoRoot, `leak-${marker}`);

      await assert.rejects(
        () =>
          checkSourceCommit(makeConfig(repoRoot, targetRoot), {
            sourceCommit: 'HEAD',
            toolVersion: 'test-version',
          }),
        SensitivePatternError,
        `expected default patterns to trigger on: ${marker}`,
      );
    }
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
    ]);
  }
});

test('custom sensitivePatterns replace the defaults entirely', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

api_key: still-here-but-not-scanned
custom-marker: THIS-TRIGGERS
`);
    await commitAll(repoRoot, 'custom');

    const config = {
      ...makeConfig(repoRoot, targetRoot),
      sensitivePatterns: ['custom-marker'],
    };

    await assert.rejects(
      () => checkSourceCommit(config, { sourceCommit: 'HEAD', toolVersion: 'test-version' }),
      SensitivePatternError,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('re-running mirror with the same source commit keeps all files intact; only the metadata file differs because publishedAt changes', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

Hello`);
    await commitAll(repoRoot, 'mirror-rerun');

    const config = makeConfig(repoRoot, targetRoot);
    const first = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      targetPath: targetRoot,
      toolVersion: 'test-version',
    });
    assert.equal(first.didWrite, true);

    const second = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      targetPath: targetRoot,
      toolVersion: 'test-version',
    });

    assert.deepEqual(second.diff.added, []);
    assert.deepEqual(second.diff.deleted, []);
    assert.deepEqual(second.diff.changed, ['.frontmatter-filter-meta.json']);
    assert.equal(second.didWrite, true);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('mirror preserves a .git directory inside the target across writes', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

Hello`);
    await commitAll(repoRoot, 'mirror-git');

    await mkdir(join(targetRoot, '.git', 'objects'), { recursive: true });
    await writeFile(join(targetRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(targetRoot, '.git', 'objects', 'marker'), 'preserve-me');
    await writeFile(join(targetRoot, 'leftover.txt'), 'should be removed');

    const config = makeConfig(repoRoot, targetRoot);
    const result = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      targetPath: targetRoot,
      toolVersion: 'test-version',
    });

    assert.equal(result.didWrite, true);
    assert.equal(
      await readFile(join(targetRoot, '.git', 'HEAD'), 'utf8'),
      'ref: refs/heads/main\n',
    );
    assert.equal(
      await readFile(join(targetRoot, '.git', 'objects', 'marker'), 'utf8'),
      'preserve-me',
    );
    await assert.rejects(() => readFile(join(targetRoot, 'leftover.txt'), 'utf8'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('mirror reports deleted entries when the desired set shrinks', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'a.md'), `---
public: true
---

a`);
    await writeFile(join(repoRoot, 'b.md'), `---
public: true
---

b`);
    await commitAll(repoRoot, 'two files');

    const config = makeConfig(repoRoot, targetRoot);
    await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      targetPath: targetRoot,
      toolVersion: 'test-version',
    });

    await writeFile(join(repoRoot, 'b.md'), `---
public: false
---

b no longer public`);
    await commitAll(repoRoot, 'drop b');

    const second = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      targetPath: targetRoot,
      toolVersion: 'test-version',
    });

    assert.ok(second.diff.deleted.includes('b.md'), `expected b.md in deleted, got: ${JSON.stringify(second.diff)}`);
    await assert.rejects(() => readFile(join(targetRoot, 'b.md'), 'utf8'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('repo where no markdown has public visibility publishes an empty set with no broken links', async () => {
  const [repoRoot, targetRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-target-')),
  ]);

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'private.md'), `---
public: false
---

Private content.`);
    await writeFile(join(repoRoot, 'no-frontmatter.md'), `# Just a heading\n\nNo frontmatter.`);
    await commitAll(repoRoot, 'all private');

    const result = await mirrorSourceCommit(makeConfig(repoRoot, targetRoot), {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.deepEqual(result.publishedMarkdown, []);
    assert.deepEqual(result.copiedAttachments, []);
    assert.deepEqual(result.brokenLinks, []);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
    ]);
  }
});

test('URL-encoded markdown link resolves to a filename with spaces', async () => {
  const [repoRoot, targetRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-target-')),
  ]);

  try {
    await initRepo(repoRoot);
    await mkdir(join(repoRoot, 'notes'), { recursive: true });
    await writeFile(join(repoRoot, 'notes', 'index.md'), `---
public: true
---

See [notes](My%20Notes.md) for details.`);
    await writeFile(join(repoRoot, 'notes', 'My Notes.md'), `---
public: true
---

Referenced via URL-encoded path.`);
    await commitAll(repoRoot, 'url-encoded link');

    const result = await mirrorSourceCommit(makeConfig(repoRoot, targetRoot), {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.ok(result.publishedMarkdown.includes('notes/My Notes.md'));
    assert.deepEqual(result.brokenLinks, []);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
    ]);
  }
});

test('external URLs, fragment-only links, and mail URIs are ignored rather than flagged as broken', async () => {
  const [repoRoot, targetRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-target-')),
  ]);

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

[External](https://example.com)
[Anchor only](#section)
[Email](mailto:user@example.com)`);
    await commitAll(repoRoot, 'external links');

    const result = await mirrorSourceCommit(makeConfig(repoRoot, targetRoot), {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.deepEqual(result.brokenLinks, []);
    assert.deepEqual(result.copiedAttachments, []);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
    ]);
  }
});

test('angle-bracket markdown link resolves an attachment whose filename contains spaces', async () => {
  const [repoRoot, targetRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-target-')),
  ]);

  try {
    await initRepo(repoRoot);
    await mkdir(join(repoRoot, 'docs'), { recursive: true });
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

[Report](<docs/my report.pdf>)`);
    await writeFile(join(repoRoot, 'docs', 'my report.pdf'), Buffer.from('pdf-bytes'));
    await commitAll(repoRoot, 'angle bracket link');

    const result = await mirrorSourceCommit(makeConfig(repoRoot, targetRoot), {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.deepEqual(result.copiedAttachments, ['docs/my report.pdf']);
    assert.deepEqual(result.brokenLinks, []);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
    ]);
  }
});

test('duplicate-basename attachments are disambiguated by relative or root-relative wikilink, and the copied bytes match the selected source', async () => {
  const [repoRoot, targetRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-target-')),
  ]);

  try {
    await initRepo(repoRoot);
    await Promise.all([
      mkdir(join(repoRoot, 'a'), { recursive: true }),
      mkdir(join(repoRoot, 'b'), { recursive: true }),
      mkdir(join(repoRoot, 'x'), { recursive: true }),
    ]);

    const aBytes = Buffer.from('a-diagram-bytes');
    const bBytes = Buffer.from('b-diagram-bytes');
    await writeFile(join(repoRoot, 'a', 'diagram.png'), aBytes);
    await writeFile(join(repoRoot, 'b', 'diagram.png'), bBytes);

    await writeFile(join(repoRoot, 'x', 'README.md'), `---
public: true
---
`);
    await writeFile(join(repoRoot, 'x', 'note.md'), `---
public: true
---

Ambiguous: ![[diagram.png]]
Root-relative to a: ![[/a/diagram.png]]
Root-relative to b: ![[/b/diagram.png]]
`);
    await commitAll(repoRoot, 'duplicate basename fixture');

    const result = await mirrorSourceCommit(makeConfig(repoRoot, targetRoot), {
      sourceCommit: 'HEAD',
      targetPath: targetRoot,
      toolVersion: 'test-version',
    });

    assert.deepEqual(result.copiedAttachments.sort(), ['a/diagram.png', 'b/diagram.png']);
    assert.ok(
      (await readFile(join(targetRoot, 'a', 'diagram.png'))).equals(aBytes),
      'a/diagram.png must be copied from the a/ source',
    );
    assert.ok(
      (await readFile(join(targetRoot, 'b', 'diagram.png'))).equals(bBytes),
      'b/diagram.png must be copied from the b/ source',
    );

    assert.deepEqual(result.brokenLinks, [
      {
        source: 'x/note.md',
        target: 'x/diagram.png',
        reason: 'missing',
      },
    ]);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
    ]);
  }
});

test('tracked git symlinks are skipped with a warning and never published', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

Embed: ![[link-to-real.png]]`);
    await writeFile(join(repoRoot, 'real.png'), Buffer.from([1, 2, 3]));
    await commitAll(repoRoot, 'regular files');

    const symlinkBlobPath = join(repoRoot, '.tmp-symlink-blob');
    await writeFile(symlinkBlobPath, 'real.png');
    const { stdout: blob } = await runGit(repoRoot, ['hash-object', '-w', '.tmp-symlink-blob']);
    await rm(symlinkBlobPath, { force: true });
    const oid = blob.trim();
    await runGit(repoRoot, [
      'update-index',
      '--add',
      '--cacheinfo',
      `120000,${oid},link-to-real.png`,
    ]);
    await runGit(repoRoot, ['commit', '-m', 'add symlink', '--no-gpg-sign']);

    const config = makeConfig(repoRoot, targetRoot);
    const result = await checkSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
    });

    assert.ok(
      result.warnings.some((warning) => warning === 'Skipping tracked symlink: link-to-real.png'),
      `expected symlink skip warning, got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(!result.copiedAttachments.includes('link-to-real.png'));
    assert.ok(!result.publishedMarkdown.includes('link-to-real.png'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

function makeConfig(repoRoot: string, targetRoot: string): ResolvedConfig {
  return {
    repoRoot,
    configPath: join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json'),
    target: targetRoot,
    remote: undefined,
    branch: 'main',
    sensitivePatterns: [...DEFAULT_SENSITIVE_PATTERNS],
    brokenLinkPolicy: 'warn',
    verbose: false,
    quiet: true,
  };
}
