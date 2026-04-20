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
