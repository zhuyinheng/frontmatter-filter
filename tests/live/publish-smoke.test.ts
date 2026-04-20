import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addRemote,
  commitAll,
  createBareRemote,
  initRepo,
  installFrontmatterFilter,
  pushOrigin,
  readJsonFile,
  runGit,
  writePublicNote,
} from '../helpers/e2e.ts';

const LIVE_REMOTE = process.env.E2E_LIVE_REMOTE ?? 'git@github.com:zhuyinheng/frontmatter-filter-live.git';
const LIVE_BRANCH = process.env.E2E_LIVE_BRANCH ?? 'live-smoke';
const LIVE_KEY_PATH = process.env.E2E_LIVE_SSH_KEY_PATH;
const LIVE_KNOWN_HOSTS_PATH = process.env.E2E_LIVE_KNOWN_HOSTS_PATH;
const ALLOW_SKIP = process.env.E2E_LIVE_ALLOW_SKIP === '1';

if (!LIVE_KEY_PATH && !ALLOW_SKIP) {
  throw new Error(
    'E2E_LIVE_SSH_KEY_PATH is required to run the live publish smoke test. ' +
      'Set E2E_LIVE_ALLOW_SKIP=1 only when you explicitly want to skip (and understand you get no live signal).',
  );
}

test(
  'publishes a live snapshot to the GitHub public smoke target',
  {
    skip: LIVE_KEY_PATH ? false : 'Explicit skip via E2E_LIVE_ALLOW_SKIP=1.',
  },
  async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-live-source-'));
    const sourceRemote = await createBareRemote('frontmatter-filter-live-source-remote-');
    const checkoutRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-live-checkout-'));
    const publishedClone = join(checkoutRoot, 'published');
    const marker = `live-marker-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      await initRepo(repoRoot);
      await addRemote(repoRoot, 'origin', sourceRemote);
      await writePublicNote(repoRoot, marker);
      await commitAll(repoRoot, 'live smoke');

      const liveEnv = {
        GIT_SSH_COMMAND: buildGitSshCommand(LIVE_KEY_PATH, LIVE_KNOWN_HOSTS_PATH),
      };

      await installFrontmatterFilter(repoRoot, ['--remote', LIVE_REMOTE, '--branch', LIVE_BRANCH], liveEnv);
      await pushOrigin(repoRoot, 'main', liveEnv);

      const { stdout: sourceCommitRaw } = await runGit(repoRoot, ['rev-parse', 'HEAD']);
      const sourceCommit = sourceCommitRaw.trim();

      await runGit(checkoutRoot, [
        'clone',
        '--depth',
        '1',
        '--branch',
        LIVE_BRANCH,
        'https://github.com/zhuyinheng/frontmatter-filter-live.git',
        publishedClone,
      ]);

      const publishedNote = await readFile(join(publishedClone, 'note.md'), 'utf8');
      const metadata = await readJsonFile<{ sourceCommit: string }>(
        join(publishedClone, '.frontmatter-filter-meta.json'),
      );

      assert.match(publishedNote, new RegExp(marker));
      assert.equal(metadata.sourceCommit, sourceCommit);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(sourceRemote, { recursive: true, force: true });
      await rm(checkoutRoot, { recursive: true, force: true });
    }
  },
);

function buildGitSshCommand(keyPath: string | undefined, knownHostsPath: string | undefined): string {
  if (!keyPath) {
    throw new Error('E2E_LIVE_SSH_KEY_PATH is required for the live publish smoke test.');
  }

  const options = [
    'ssh',
    `-i "${keyPath}"`,
    '-o IdentitiesOnly=yes',
  ];

  if (knownHostsPath) {
    options.push('-o StrictHostKeyChecking=yes', `-o UserKnownHostsFile="${knownHostsPath}"`);
  } else {
    options.push('-o StrictHostKeyChecking=no');
  }

  return options.join(' ');
}
