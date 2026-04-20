import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addRemote,
  commitAll,
  createBareRemote,
  gitShow,
  initRepo,
  installFrontmatterFilter,
  pushOrigin,
  readJsonFile,
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

    await assert.rejects(() => pushOrigin(repoRoot, 'main'));
    await assert.rejects(() => gitShow(sourceRemote, 'refs/heads/main:note.md'));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
    await rm(publicRemote, { recursive: true, force: true });
  }
});
