import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { checkSourceCommit, mirrorSourceCommit } from '../../src/core.ts';
import type { ResolvedConfig } from '../../src/types.ts';
import { SensitivePatternError } from '../../src/types.ts';

const execFileAsync = promisify(execFile);

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

test('publishes nothing when no markdown files have public visibility', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'private.md'), `---
public: false
---

Private content.`);
    await writeFile(join(repoRoot, 'no-frontmatter.md'), `# Just a heading\n\nNo frontmatter.`);
    await commitAll(repoRoot, 'all private');

    const config = makeConfig(repoRoot, targetRoot);
    const result = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.deepEqual(result.publishedMarkdown, []);
    assert.deepEqual(result.copiedAttachments, []);
    assert.deepEqual(result.brokenLinks, []);
    assert.equal(result.didWrite, true);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('explicit public:true overrides public:false inherited from parent README', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await mkdir(join(repoRoot, 'private-section'), { recursive: true });

    await writeFile(join(repoRoot, 'private-section', 'README.md'), `---
public: false
---
`);
    await writeFile(join(repoRoot, 'private-section', 'secret.md'), `---
title: Secret
---

Top secret.`);
    await writeFile(join(repoRoot, 'private-section', 'override.md'), `---
public: true
---

This note is explicitly public even though the directory README is private.`);
    await commitAll(repoRoot, 'mixed visibility');

    const config = makeConfig(repoRoot, targetRoot);
    const result = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.deepEqual(result.publishedMarkdown, ['private-section/override.md']);
    await assert.rejects(() => readFile(join(targetRoot, 'private-section', 'secret.md'), 'utf8'));
    assert.ok(await readFile(join(targetRoot, 'private-section', 'override.md'), 'utf8'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('multi-hop README inheritance reaches notes without intermediate README', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await mkdir(join(repoRoot, 'section', 'level1', 'level2'), { recursive: true });

    await writeFile(join(repoRoot, 'section', 'README.md'), `---
public: true
---
`);
    // No README.md in section/level1 or section/level1/level2
    await writeFile(join(repoRoot, 'section', 'level1', 'level2', 'deep.md'), `---
title: Deep Note
---

Inherits public from grandparent README.`);
    await commitAll(repoRoot, 'deep inheritance');

    const config = makeConfig(repoRoot, targetRoot);
    const result = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.ok(result.publishedMarkdown.includes('section/level1/level2/deep.md'));
    assert.ok(await readFile(join(targetRoot, 'section', 'level1', 'level2', 'deep.md'), 'utf8'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('brokenLinkPolicy error throws when broken references are detected', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

See [[missing-note]]`);
    await commitAll(repoRoot, 'broken link');

    const config = { ...makeConfig(repoRoot, targetRoot), brokenLinkPolicy: 'error' as const };

    await assert.rejects(
      () => mirrorSourceCommit(config, { sourceCommit: 'HEAD', toolVersion: 'test-version', targetPath: targetRoot }),
      /Broken references detected/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('brokenLinkPolicy ignore suppresses broken reference reporting', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

See [[missing-note]]`);
    await commitAll(repoRoot, 'broken link ignored');

    const config = { ...makeConfig(repoRoot, targetRoot), brokenLinkPolicy: 'ignore' as const };

    const result = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.deepEqual(result.brokenLinks, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('second mirror run reports no new content changes when source has not changed', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

Stable content.`);
    await commitAll(repoRoot, 'stable');

    const config = makeConfig(repoRoot, targetRoot);
    const options = { sourceCommit: 'HEAD', toolVersion: 'test-version', targetPath: targetRoot };

    const first = await mirrorSourceCommit(config, options);
    assert.equal(first.didWrite, true);
    assert.ok(first.diff.added.includes('note.md'));

    const second = await mirrorSourceCommit(config, options);
    // The metadata file timestamp changes each run so diff.changed will include it,
    // but no content files should be added or deleted.
    assert.deepEqual(second.diff.added, []);
    assert.deepEqual(second.diff.deleted, []);
    assert.deepEqual(second.publishedMarkdown, ['note.md']);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('URL-encoded relative link resolves to the correct file', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

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

    const config = makeConfig(repoRoot, targetRoot);
    const result = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.ok(result.publishedMarkdown.includes('notes/My Notes.md'));
    assert.deepEqual(result.brokenLinks, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('external URLs and anchor-only links are not treated as broken references', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

[External](https://example.com)
[Anchor only](#section)
[Email](mailto:user@example.com)`);
    await commitAll(repoRoot, 'external links');

    const config = makeConfig(repoRoot, targetRoot);
    const result = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.deepEqual(result.brokenLinks, []);
    assert.deepEqual(result.copiedAttachments, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('angle-bracket link resolves attachment with spaces in filename', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));

  try {
    await initRepo(repoRoot);
    await mkdir(join(repoRoot, 'docs'), { recursive: true });

    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

[Report](<docs/my report.pdf>)`);
    await writeFile(join(repoRoot, 'docs', 'my report.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]));
    await commitAll(repoRoot, 'angle bracket link');

    const config = makeConfig(repoRoot, targetRoot);
    const result = await mirrorSourceCommit(config, {
      sourceCommit: 'HEAD',
      toolVersion: 'test-version',
      targetPath: targetRoot,
    });

    assert.deepEqual(result.copiedAttachments, ['docs/my report.pdf']);
    assert.deepEqual(result.brokenLinks, []);
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
    sensitivePatterns: ['\\b(api[_-]?key|password|secret|token|bearer)\\s*[:=]'],
    brokenLinkPolicy: 'warn',
    verbose: false,
    quiet: true,
  };
}

async function initRepo(repoRoot: string): Promise<void> {
  await runGit(repoRoot, ['init']);
  await runGit(repoRoot, ['config', 'user.name', 'Test User']);
  await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
}

async function commitAll(repoRoot: string, message: string): Promise<void> {
  await runGit(repoRoot, ['add', '-A']);
  await runGit(repoRoot, ['commit', '-m', message, '--no-gpg-sign']);
}

async function getHeadCommit(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  return stdout.trim();
}

async function runGit(repoRoot: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: repoRoot });
}

