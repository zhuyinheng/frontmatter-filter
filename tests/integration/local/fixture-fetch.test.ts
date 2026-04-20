import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PROJECT_ROOT, runGit } from '../../helpers/e2e.ts';

const execFileAsync = promisify(execFile);
const PREPARE_SCRIPT = join(PROJECT_ROOT, 'scripts', 'prepare-fixture.mjs');

// Covers the contract described in README / TESTING:
//   - "if the local fixture directory is missing, prepare-fixture clones and
//      checks out the pinned commit"
//   - "if the lock file points at a different commit, prepare-fixture wipes
//      and refreshes"
// Uses a local bare repo as a fake remote so the test has no network
// dependency.

test('prepare-fixture auto-clones when the fixture directory is missing, and auto-refreshes when the pin changes', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'frontmatter-filter-fixture-fetch-'));
  const fakeRemote = join(workDir, 'remote.git');
  const seedRepo = join(workDir, 'seed');
  const cloneRoot = join(workDir, 'clone');
  const lockPath = join(workDir, 'lock');

  try {
    await execFileAsync('git', ['init', '--bare', fakeRemote]);

    // Seed two commits in a working repo, then push both to the bare remote.
    await execFileAsync('git', ['init', '-b', 'main', seedRepo]);
    await runGit(seedRepo, ['config', 'user.name', 'Test']);
    await runGit(seedRepo, ['config', 'user.email', 'test@example.com']);

    await writeFile(join(seedRepo, 'marker.txt'), 'first\n');
    await runGit(seedRepo, ['add', '.']);
    await runGit(seedRepo, ['commit', '-m', 'first', '--no-gpg-sign']);
    const commitA = (await runGit(seedRepo, ['rev-parse', 'HEAD'])).stdout.trim();

    await writeFile(join(seedRepo, 'marker.txt'), 'second\n');
    await runGit(seedRepo, ['add', '.']);
    await runGit(seedRepo, ['commit', '-m', 'second', '--no-gpg-sign']);
    const commitB = (await runGit(seedRepo, ['rev-parse', 'HEAD'])).stdout.trim();

    await runGit(seedRepo, ['remote', 'add', 'origin', fakeRemote]);
    await runGit(seedRepo, ['push', 'origin', 'main']);

    const runPrepare = (): Promise<void> =>
      execFileAsync('node', [PREPARE_SCRIPT], {
        env: {
          ...process.env,
          FRONTMATTER_FILTER_FIXTURE_CLONE_ROOT: cloneRoot,
          FRONTMATTER_FILTER_FIXTURE_LOCK_PATH: lockPath,
          FRONTMATTER_FILTER_FIXTURE_REPO_URL: fakeRemote,
        },
      }).then(() => undefined);

    // Scenario 1: clone missing. Lock points at commit A. Expect a fresh
    // clone with HEAD == commitA and the corresponding marker content.
    await writeFile(lockPath, `${commitA}\n`);
    await runPrepare();

    const headAfterFirst = (await runGit(cloneRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(headAfterFirst, commitA, 'first run should check out commit A');
    assert.equal(await readFile(join(cloneRoot, 'marker.txt'), 'utf8'), 'first\n');

    // Scenario 2: clone exists but lock now points at commit B. Expect the
    // existing clone to be wiped and replaced at commitB.
    await writeFile(lockPath, `${commitB}\n`);
    await runPrepare();

    const headAfterRefresh = (await runGit(cloneRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(headAfterRefresh, commitB, 'pin change should refresh to commit B');
    assert.equal(await readFile(join(cloneRoot, 'marker.txt'), 'utf8'), 'second\n');

    // Scenario 3: idempotent. Running with the same pin again is a no-op
    // (doesn't throw, still at commitB).
    await runPrepare();
    const headAfterNoop = (await runGit(cloneRoot, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(headAfterNoop, commitB, 'second run at same pin should be a no-op');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
