import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { publishSourceCommit } from '../../src/core.ts';
import type { ResolvedConfig } from '../../src/types.ts';

const execFileAsync = promisify(execFile);

test('publishes to a remote snapshot repo and removes the temporary staging directory on success', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-target-'));
  const remoteRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-remote-'));

  try {
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.name', 'Test User']);
    await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(repoRoot, 'note.md'), `---
public: true
---

hello world`);
    await runGit(repoRoot, ['add', '-A']);
    await runGit(repoRoot, ['commit', '-m', 'snapshot', '--no-gpg-sign']);

    await runGit(remoteRoot, ['init', '--bare']);

    const config: ResolvedConfig = {
      repoRoot,
      configPath: join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json'),
      target: targetRoot,
      remote: remoteRoot,
      branch: 'main',
      sensitivePatterns: ['\\b(api[_-]?key|password|secret|token|bearer)\\s*[:=]'],
      brokenLinkPolicy: 'warn',
      verbose: false,
      quiet: true,
    };

    const result = await publishSourceCommit(config, {
      sourceCommit: 'HEAD',
      remote: remoteRoot,
      branch: 'main',
      keepStaging: false,
      toolVersion: 'test-version',
    });

    assert.equal(result.didKeepStaging, false);
    await assert.rejects(() => readFile(join(result.stagingDir, 'note.md'), 'utf8'));

    const note = await gitShow(remoteRoot, 'refs/heads/main:note.md');
    const metadata = JSON.parse(
      await gitShow(remoteRoot, 'refs/heads/main:.frontmatter-filter-meta.json'),
    ) as { sourceCommit: string };

    assert.match(note, /hello world/);
    assert.equal(metadata.sourceCommit, result.sourceCommit);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});

async function gitShow(gitDir: string, spec: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [`--git-dir=${gitDir}`, 'show', spec]);
  return stdout;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}
