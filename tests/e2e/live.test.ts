import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addRemote,
  exportFixtureToRepo,
  installFrontmatterFilter,
  listRelativeFiles,
  readJsonFile,
  runInstalledCli,
  runGit,
  sha256File,
  writePublicNote,
} from '../helpers/e2e.ts';

const SOURCE_REMOTE =
  process.env.E2E_SOURCE_LIVE_REMOTE ??
  'git@github-source-live:zhuyinheng/obsidian_test_vault.git';
const SOURCE_HTTPS_URL =
  process.env.E2E_SOURCE_LIVE_HTTPS_URL ??
  'https://github.com/zhuyinheng/obsidian_test_vault.git';
const SOURCE_BRANCH = process.env.E2E_SOURCE_LIVE_BRANCH ?? 'live-smoke';
const PUBLIC_REMOTE =
  process.env.E2E_PUBLIC_LIVE_REMOTE ??
  'git@github-public-live:zhuyinheng/frontmatter-filter-live.git';
const PUBLIC_HTTPS_URL =
  process.env.E2E_PUBLIC_LIVE_HTTPS_URL ??
  'https://github.com/zhuyinheng/frontmatter-filter-live.git';
const PUBLIC_BRANCH = process.env.E2E_PUBLIC_LIVE_BRANCH ?? 'live-smoke';
const LIVE_GIT_SSH_COMMAND = process.env.E2E_LIVE_GIT_SSH_COMMAND;
const ALLOW_SKIP = process.env.E2E_LIVE_ALLOW_SKIP === '1';

if (!LIVE_GIT_SSH_COMMAND && !ALLOW_SKIP) {
  throw new Error(
    'E2E_LIVE_GIT_SSH_COMMAND is required to run the live end-to-end test. ' +
      'Set E2E_LIVE_ALLOW_SKIP=1 only when you explicitly want to skip (and understand you get no live signal).',
  );
}

test(
  'pushes to the live source remote and publishes the matching snapshot to the live public remote',
  {
    skip: LIVE_GIT_SSH_COMMAND
      ? false
      : 'Explicit skip via E2E_LIVE_ALLOW_SKIP=1.',
  },
  async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-live-source-'));
    const checkoutRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-live-checkout-'));
    const expectedRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-live-expected-'));
    const sourceClone = join(checkoutRoot, 'source');
    const publicClone = join(checkoutRoot, 'public');
    const marker = `e2e-live-marker-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const gitEnv = { GIT_SSH_COMMAND: LIVE_GIT_SSH_COMMAND };

    try {
      await exportFixtureToRepo(repoRoot, 'e2e live fixture snapshot');
      await addRemote(repoRoot, 'origin', SOURCE_REMOTE);
      await writePublicNote(repoRoot, marker, 'Live Smoke.md');
      await runGit(repoRoot, ['add', '-A']);
      await runGit(repoRoot, ['commit', '-m', 'e2e live marker', '--no-gpg-sign']);
      await installFrontmatterFilter(repoRoot, ['--remote', PUBLIC_REMOTE, '--branch', PUBLIC_BRANCH], gitEnv);
      await runGit(repoRoot, ['push', '--force', '-u', 'origin', `main:${SOURCE_BRANCH}`], gitEnv);

      const { stdout: sourceCommitRaw } = await runGit(repoRoot, ['rev-parse', 'HEAD']);
      const sourceCommit = sourceCommitRaw.trim();
      await runInstalledCli(repoRoot, ['mirror', '--source-commit', sourceCommit, '--target', expectedRoot], gitEnv);

      await runGit(checkoutRoot, [
        'clone',
        '--depth',
        '1',
        '--branch',
        SOURCE_BRANCH,
        SOURCE_HTTPS_URL,
        sourceClone,
      ]);
      await runGit(checkoutRoot, [
        'clone',
        '--depth',
        '1',
        '--branch',
        PUBLIC_BRANCH,
        PUBLIC_HTTPS_URL,
        publicClone,
      ]);

      const { stdout: sourceRemoteCommitRaw } = await runGit(sourceClone, ['rev-parse', 'HEAD']);
      const sourceRemoteCommit = sourceRemoteCommitRaw.trim();
      const sourceNote = await readFile(join(sourceClone, 'Live Smoke.md'), 'utf8');
      const publicNote = await readFile(join(publicClone, 'Live Smoke.md'), 'utf8');
      const metadata = await readJsonFile<{
        sourceCommit: string;
        sourceBranch?: string;
        publishedAt: string;
        toolVersion: string;
      }>(join(publicClone, '.frontmatter-filter-meta.json'));
      const expectedFiles = (await listRelativeFiles(expectedRoot)).filter((path) => path !== '.frontmatter-filter-meta.json');
      const publishedFiles = (await listRelativeFiles(publicClone))
        .filter((path) => !path.startsWith('.git/'))
        .filter((path) => path !== '.frontmatter-filter-meta.json');

      assert.equal(sourceRemoteCommit, sourceCommit);
      assert.match(sourceNote, new RegExp(marker));
      assert.match(publicNote, new RegExp(marker));
      assert.deepEqual(publishedFiles, expectedFiles);

      for (const relativePath of expectedFiles) {
        assert.equal(
          await sha256File(join(publicClone, ...relativePath.split('/'))),
          await sha256File(join(expectedRoot, ...relativePath.split('/'))),
          relativePath,
        );
      }

      assert.equal(metadata.sourceCommit, sourceCommit);
      assert.equal(metadata.sourceBranch, 'main');
      assert.ok(!Number.isNaN(Date.parse(metadata.publishedAt)));
      assert.match(metadata.toolVersion, /\S/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(checkoutRoot, { recursive: true, force: true });
      await rm(expectedRoot, { recursive: true, force: true });
    }
  },
);
