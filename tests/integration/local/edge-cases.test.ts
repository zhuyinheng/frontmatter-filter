import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addRemote,
  commitAll,
  createBareRemote,
  gitShow,
  initRepo,
  installFrontmatterFilter,
  getHeadCommit,
  pushOrigin,
  readJsonFile,
  runGit,
  runInstalledCli,
  writePublicNote,
} from '../../helpers/e2e.ts';

test('check subcommand reports published markdown count on stdout without writing files', async () => {
  const [repoRoot, sourceRemote] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-check-')),
    createBareRemote('frontmatter-filter-e2e-check-remote-'),
  ]);

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'check command content');
    await commitAll(repoRoot, 'init');
    await installFrontmatterFilter(repoRoot, ['--remote', sourceRemote]);

    const { stdout } = await runInstalledCli(repoRoot, ['check']);
    assert.match(stdout, /check ok: \d+ markdown/);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(sourceRemote, { recursive: true, force: true }),
    ]);
  }
});

test('mirror subcommand writes the snapshot into --target when invoked directly', async () => {
  const [repoRoot, targetRoot, sourceRemote] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-mirror-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-mirror-target-')),
    createBareRemote('frontmatter-filter-e2e-mirror-remote-'),
  ]);

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'mirror command content', 'notes/page.md');
    await commitAll(repoRoot, 'init');
    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    const { stdout } = await runInstalledCli(repoRoot, ['mirror', '--target', targetRoot]);
    assert.match(stdout, /mirrored \d+ files to/);

    const mirrored = await readFile(join(targetRoot, 'notes', 'page.md'), 'utf8');
    assert.match(mirrored, /mirror command content/);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
      rm(sourceRemote, { recursive: true, force: true }),
    ]);
  }
});

test('pushing an empty follow-up commit leaves published note content unchanged', async () => {
  const [repoRoot, targetRoot, sourceRemote] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-incremental-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-incremental-target-')),
    createBareRemote('frontmatter-filter-e2e-incremental-remote-'),
  ]);

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'stable content');
    await commitAll(repoRoot, 'init');
    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    const firstPush = await pushOrigin(repoRoot, 'main');
    assert.match(`${firstPush.stdout}\n${firstPush.stderr}`, /mirrored \d+ files to/);
    const firstNote = await readFile(join(targetRoot, 'note.md'), 'utf8');

    await runGit(repoRoot, ['commit', '--allow-empty', '-m', 'empty', '--no-gpg-sign']);
    await pushOrigin(repoRoot, 'main');

    const secondNote = await readFile(join(targetRoot, 'note.md'), 'utf8');
    assert.equal(secondNote, firstNote, 'published note content must be stable across identical content');
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
      rm(sourceRemote, { recursive: true, force: true }),
    ]);
  }
});

test('pre-push hook blocks the push when a new commit introduces a sensitive pattern (install-time check passed)', async () => {
  const [repoRoot, targetRoot, sourceRemote] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-sensitive-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-sensitive-target-')),
    createBareRemote('frontmatter-filter-e2e-sensitive-remote-'),
  ]);

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'clean content');
    await commitAll(repoRoot, 'init');
    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    await writeFile(
      join(repoRoot, 'secret.md'),
      `---\npublic: true\n---\n\npassword: hunter2\n`,
    );
    await commitAll(repoRoot, 'add sensitive note');

    await assert.rejects(() => pushOrigin(repoRoot, 'main'));
    await assert.rejects(() => gitShow(sourceRemote, 'refs/heads/main:secret.md'));
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
      rm(sourceRemote, { recursive: true, force: true }),
    ]);
  }
});

test('mirror --source-commit uses the specified commit instead of HEAD', async () => {
  const [repoRoot, targetRoot, sourceRemote] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-srccommit-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-srccommit-target-')),
    createBareRemote('frontmatter-filter-e2e-srccommit-remote-'),
  ]);

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);

    await writePublicNote(repoRoot, 'first version');
    await commitAll(repoRoot, 'v1');
    const firstCommit = await getHeadCommit(repoRoot);

    await writePublicNote(repoRoot, 'second version');
    await commitAll(repoRoot, 'v2');

    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    await runInstalledCli(repoRoot, [
      'mirror',
      '--source-commit',
      firstCommit,
      '--target',
      targetRoot,
    ]);

    const mirrored = await readFile(join(targetRoot, 'note.md'), 'utf8');
    assert.match(mirrored, /first version/);
    assert.doesNotMatch(mirrored, /second version/);

    const metadata = await readJsonFile<{ sourceCommit: string }>(
      join(targetRoot, '.frontmatter-filter-meta.json'),
    );
    assert.equal(metadata.sourceCommit, firstCommit);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
      rm(sourceRemote, { recursive: true, force: true }),
    ]);
  }
});
