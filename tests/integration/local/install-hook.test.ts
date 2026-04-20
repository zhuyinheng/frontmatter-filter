import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addRemote,
  commitAll,
  createBareRemote,
  DIST_BINARY,
  gitShow,
  initRepo,
  installFrontmatterFilter,
  installFrontmatterFilterViaPipe,
  localFileUrl,
  pushOrigin,
  readJsonFile,
  runGit,
  runInstallScript,
  writePublicNote,
} from '../../helpers/e2e.ts';

test('pre-push hook mirrors to a local target after install.sh', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-repo-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-target-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-e2e-source-');

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'hello from hook mirror');
    await commitAll(repoRoot, 'init');

    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);
    const pushResult = await pushOrigin(repoRoot, 'main');

    const mirroredNote = await readFile(join(targetRoot, 'note.md'), 'utf8');
    const metadata = await readJsonFile<{ sourceCommit: string }>(
      join(targetRoot, '.frontmatter-filter-meta.json'),
    );
    const pushedSourceNote = await gitShow(sourceRemote, 'refs/heads/main:note.md');
    const combinedOutput = `${pushResult.stdout}\n${pushResult.stderr}`;

    assert.match(mirroredNote, /hello from hook mirror/);
    assert.match(pushedSourceNote, /hello from hook mirror/);
    assert.equal(metadata.sourceCommit.length, 40);
    assert.match(combinedOutput, /mirrored \d+ files to/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
  }
});

test('pre-push hook publishes to a configured remote snapshot repo after install.sh', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-repo-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-e2e-source-');
  const publicRemote = await createBareRemote('frontmatter-filter-e2e-public-');

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'hello from hook publish');
    await commitAll(repoRoot, 'init');

    await installFrontmatterFilter(repoRoot, ['--remote', publicRemote]);
    const pushResult = await pushOrigin(repoRoot, 'main');

    const publishedNote = await gitShow(publicRemote, 'refs/heads/main:note.md');
    const installedConfig = await readJsonFile<{ remote: string; branch: string }>(
      join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json'),
    );
    const remoteMetadata = JSON.parse(
      await gitShow(publicRemote, 'refs/heads/main:.frontmatter-filter-meta.json'),
    ) as { sourceCommit: string };
    const combinedOutput = `${pushResult.stdout}\n${pushResult.stderr}`;

    assert.match(publishedNote, /hello from hook publish/);
    assert.equal(remoteMetadata.sourceCommit.length, 40);
    assert.equal(installedConfig.remote, publicRemote);
    assert.equal(installedConfig.branch, 'main');
    assert.match(combinedOutput, /published source commit/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
    await rm(publicRemote, { recursive: true, force: true });
  }
});

test('pre-push hook blocks the source push when publish to the public remote fails', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-repo-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-e2e-source-');
  const publicRemote = await createBareRemote('frontmatter-filter-e2e-public-');

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'hello from hook failure');
    await commitAll(repoRoot, 'init');

    await installFrontmatterFilter(repoRoot, ['--remote', publicRemote]);
    await rm(publicRemote, { recursive: true, force: true });

    let rejection: NodeJS.ErrnoException & { stderr?: string } = new Error();
    await assert.rejects(async () => {
      try {
        await pushOrigin(repoRoot, 'main');
      } catch (error) {
        rejection = error as NodeJS.ErrnoException & { stderr?: string };
        throw error;
      }
    });
    assert.match(
      rejection.stderr ?? '',
      /staging preserved at:/,
      'hook failure must surface the preserved staging path',
    );
    await assert.rejects(() => gitShow(sourceRemote, 'refs/heads/main:note.md'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
    await rm(publicRemote, { recursive: true, force: true });
  }
});

test('install.sh refuses to run when core.hooksPath already points elsewhere', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-guard-'));
  try {
    await initRepo(repoRoot);
    await runGit(repoRoot, ['config', 'core.hooksPath', 'custom-hooks']);

    const result = await runInstallScript(repoRoot, []);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /core\.hooksPath/);

    await assert.rejects(
      () => readFile(join(repoRoot, '.githooks', 'pre-push'), 'utf8'),
      'pre-push must not be written when core.hooksPath guard fires',
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('install.sh refuses to overwrite an unmanaged .githooks/pre-push', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-guard-'));
  try {
    await initRepo(repoRoot);
    await mkdir(join(repoRoot, '.githooks'), { recursive: true });
    const existingHook = '#!/bin/sh\n# user-managed hook\necho user-hook\n';
    await writeFile(join(repoRoot, '.githooks', 'pre-push'), existingHook);

    const result = await runInstallScript(repoRoot, []);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not managed by frontmatter-filter/);

    const current = await readFile(join(repoRoot, '.githooks', 'pre-push'), 'utf8');
    assert.equal(current, existingHook, 'unmanaged pre-push must be preserved as-is');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('install.sh aborts when the remote preflight cannot reach the remote', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-guard-'));
  const unreachableRemote = join(tmpdir(), `frontmatter-filter-missing-remote-${Date.now()}.git`);
  try {
    await initRepo(repoRoot);

    const result = await runInstallScript(repoRoot, ['--remote', unreachableRemote]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /preflight failed/i);

    await assert.rejects(
      () => readFile(join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json'), 'utf8'),
      'config must not be written when preflight fails',
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('install.sh preserves user-authored sensitivePatterns and brokenLinkPolicy across reinstall', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-reinstall-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-reinstall-target-'));
  try {
    await initRepo(repoRoot);
    await writePublicNote(repoRoot, 'hello reinstall');
    await commitAll(repoRoot, 'init');

    await installFrontmatterFilter(repoRoot, []);
    const configPath = join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json');
    const original = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      `${JSON.stringify({ ...original, sensitivePatterns: ['custom-pattern'], brokenLinkPolicy: 'error' }, null, 2)}\n`,
    );

    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);
    const reinstalled = JSON.parse(await readFile(configPath, 'utf8')) as {
      sensitivePatterns: string[];
      brokenLinkPolicy: string;
    };
    assert.deepEqual(reinstalled.sensitivePatterns, ['custom-pattern']);
    assert.equal(reinstalled.brokenLinkPolicy, 'error');
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
    ]);
  }
});

test('curl | sh style pipe install uses FRONTMATTER_FILTER_BIN_URL to fetch the binary', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-pipe-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-pipe-target-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-e2e-pipe-source-');

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'hello from pipe install');
    await commitAll(repoRoot, 'init');

    await installFrontmatterFilterViaPipe(
      repoRoot,
      ['--target', targetRoot],
      { FRONTMATTER_FILTER_BIN_URL: localFileUrl(DIST_BINARY) },
    );

    const installedBin = join(repoRoot, '.githooks', 'frontmatter-filter', 'frontmatter-filter.mjs');
    await access(installedBin, fsConstants.X_OK);
    const installedConfig = await readJsonFile<{ target: string }>(
      join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json'),
    );
    assert.equal(installedConfig.target, targetRoot);

    const installedPrePush = await readFile(join(repoRoot, '.githooks', 'pre-push'), 'utf8');
    assert.match(installedPrePush, /managed by frontmatter-filter/);

    const installedBytes = await readFile(installedBin);
    const sourceBytes = await readFile(DIST_BINARY);
    assert.ok(
      installedBytes.equals(sourceBytes),
      'pipe install must produce byte-identical binary',
    );

    const pushResult = await pushOrigin(repoRoot, 'main');
    const mirroredNote = await readFile(join(targetRoot, 'note.md'), 'utf8');
    assert.match(mirroredNote, /hello from pipe install/);
    assert.match(`${pushResult.stdout}\n${pushResult.stderr}`, /mirrored \d+ files to/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
  }
});
