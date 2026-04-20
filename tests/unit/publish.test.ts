import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SENSITIVE_PATTERNS } from '../../src/config.ts';
import { publishSourceCommit } from '../../src/core.ts';
import type { ResolvedConfig } from '../../src/types.ts';
import { GitPublishError, SensitivePatternError } from '../../src/types.ts';
import {
  commitAll,
  gitShow,
  initRepo,
  pathExists,
  runGit,
  writePublicNote,
} from '../helpers/e2e.ts';

test('publishes to a remote snapshot repo and removes the temporary staging directory on success', async () => {
  const [repoRoot, targetRoot, remoteRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-target-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-remote-')),
  ]);

  try {
    await seedRepo(repoRoot);
    await runGit(remoteRoot, ['init', '--bare']);

    const result = await publishSourceCommit(makeConfig(repoRoot, targetRoot, remoteRoot), {
      sourceCommit: 'HEAD',
      remote: remoteRoot,
      branch: 'main',
      keepStaging: false,
      toolVersion: 'test-version',
    });

    assert.equal(result.didKeepStaging, false);
    assert.equal(await pathExists(result.stagingDir), false, 'auto staging dir should be removed');

    const note = await gitShow(remoteRoot, 'refs/heads/main:note.md');
    const metadata = JSON.parse(
      await gitShow(remoteRoot, 'refs/heads/main:.frontmatter-filter-meta.json'),
    ) as { sourceCommit: string };

    assert.match(note, /hello world/);
    assert.equal(metadata.sourceCommit, result.sourceCommit);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
      rm(remoteRoot, { recursive: true, force: true }),
    ]);
  }
});

test('publish preserves the staging directory when the user passes --staging-dir explicitly (fail-closed against data loss)', async () => {
  const [repoRoot, remoteRoot, userStagingDir] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-remote-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-user-staging-')),
  ]);

  try {
    await seedRepo(repoRoot);
    await runGit(remoteRoot, ['init', '--bare']);

    const result = await publishSourceCommit(makeConfig(repoRoot, userStagingDir, remoteRoot), {
      sourceCommit: 'HEAD',
      remote: remoteRoot,
      branch: 'main',
      stagingDir: userStagingDir,
      keepStaging: false,
      toolVersion: 'test-version',
    });

    assert.equal(result.stagingDir, userStagingDir);
    assert.equal(result.didKeepStaging, true, 'user-provided staging dir must not be deleted');
    assert.equal(await pathExists(userStagingDir), true);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(remoteRoot, { recursive: true, force: true }),
      rm(userStagingDir, { recursive: true, force: true }),
    ]);
  }
});

test('publish preserves an auto-created staging directory when keepStaging=true', async () => {
  const [repoRoot, remoteRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-remote-')),
  ]);

  try {
    await seedRepo(repoRoot);
    await runGit(remoteRoot, ['init', '--bare']);

    const result = await publishSourceCommit(makeConfig(repoRoot, remoteRoot), {
      sourceCommit: 'HEAD',
      remote: remoteRoot,
      branch: 'main',
      keepStaging: true,
      toolVersion: 'test-version',
    });

    assert.equal(result.didKeepStaging, true);
    assert.equal(await pathExists(result.stagingDir), true);
    await rm(result.stagingDir, { recursive: true, force: true });
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(remoteRoot, { recursive: true, force: true }),
    ]);
  }
});

test('publish failure raises GitPublishError that carries the still-existing staging path', async () => {
  const [repoRoot, remoteRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-remote-')),
  ]);

  try {
    await seedRepo(repoRoot);
    await runGit(remoteRoot, ['init', '--bare']);
    await rm(remoteRoot, { recursive: true, force: true });

    let capturedStagingDir: string | undefined;

    await assert.rejects(
      async () => {
        try {
          await publishSourceCommit(makeConfig(repoRoot, remoteRoot), {
            sourceCommit: 'HEAD',
            remote: remoteRoot,
            branch: 'main',
            keepStaging: false,
            toolVersion: 'test-version',
          });
        } catch (error) {
          if (error instanceof GitPublishError) {
            capturedStagingDir = error.stagingDir;
          }
          throw error;
        }
      },
      GitPublishError,
    );

    if (!capturedStagingDir) {
      assert.fail('GitPublishError should expose the staging directory path');
    }
    assert.equal(
      await pathExists(capturedStagingDir),
      true,
      `staging should be preserved on failure: ${capturedStagingDir}`,
    );
    await rm(capturedStagingDir, { recursive: true, force: true });
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('publish cleans up the auto-created staging dir when a SensitivePatternError fires before any write', async () => {
  const [repoRoot, remoteRoot, scopedTmp] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-repo-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-remote-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-leak-scope-')),
  ]);
  // Redirect os.tmpdir() for the publishSourceCommit call so the auto-mkdtemp
  // lands in scopedTmp, isolating this test from any sibling tmp activity.
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = scopedTmp;

  try {
    await initRepo(repoRoot);
    await writePublicNote(repoRoot, 'api_key: leaked');
    await commitAll(repoRoot, 'sensitive');
    await runGit(remoteRoot, ['init', '--bare']);

    await assert.rejects(
      () =>
        publishSourceCommit(makeConfig(repoRoot, remoteRoot), {
          sourceCommit: 'HEAD',
          remote: remoteRoot,
          branch: 'main',
          keepStaging: false,
          toolVersion: 'test-version',
        }),
      SensitivePatternError,
    );

    const leaked = (await readdir(scopedTmp)).filter((name) =>
      name.startsWith('frontmatter-filter-staging-'),
    );
    assert.deepEqual(
      leaked,
      [],
      `auto staging dir leaked on SensitivePatternError: ${leaked.join(', ')}`,
    );
  } finally {
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(remoteRoot, { recursive: true, force: true }),
      rm(scopedTmp, { recursive: true, force: true }),
    ]);
  }
});

async function seedRepo(repoRoot: string): Promise<void> {
  await initRepo(repoRoot);
  await writePublicNote(repoRoot, 'hello world');
  await commitAll(repoRoot, 'snapshot');
}

function makeConfig(repoRoot: string, targetRoot: string, remoteRoot?: string): ResolvedConfig {
  return {
    repoRoot,
    configPath: join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json'),
    target: targetRoot,
    remote: remoteRoot,
    branch: 'main',
    sensitivePatterns: [...DEFAULT_SENSITIVE_PATTERNS],
    brokenLinkPolicy: 'warn',
    verbose: false,
    quiet: true,
  };
}
