import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addRemote,
  commitAll,
  createBareRemote,
  ensureBuiltDist,
  initRepo,
  installFrontmatterFilter,
  pushOrigin,
  readJsonFile,
  runInstalledCli,
  writePublicNote,
} from '../../helpers/e2e.ts';

test('check command reports published markdown count without writing files', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-check-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-e2e-check-remote-');

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'check command content');
    await commitAll(repoRoot, 'init');
    await ensureBuiltDist();
    await installFrontmatterFilter(repoRoot, ['--remote', sourceRemote]);

    const { stdout } = await runInstalledCli(repoRoot, ['check']);
    assert.match(stdout, /check ok: \d+ markdown/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
  }
});

test('mirror command writes files to a specified target directory', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-mirror-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-mirror-target-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-e2e-mirror-remote-');

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'mirror command content', 'notes/page.md');
    await commitAll(repoRoot, 'init');
    await ensureBuiltDist();
    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    const { stdout } = await runInstalledCli(repoRoot, ['mirror', '--target', targetRoot]);
    assert.match(stdout, /mirrored \d+ files to/);

    const mirrored = await readFile(join(targetRoot, 'notes', 'page.md'), 'utf8');
    assert.match(mirrored, /mirror command content/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
  }
});

test('second push with no source content changes only updates the metadata file', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-incremental-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-incremental-target-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-e2e-incremental-remote-');

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await writePublicNote(repoRoot, 'stable content');
    await commitAll(repoRoot, 'init');
    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    const firstPush = await pushOrigin(repoRoot, 'main');
    const firstOutput = `${firstPush.stdout}\n${firstPush.stderr}`;
    assert.match(firstOutput, /mirrored \d+ files to/);

    const firstNote = await readFile(join(targetRoot, 'note.md'), 'utf8');

    // Make a non-content change (add empty commit) then push again
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'empty commit', '--no-gpg-sign'], {
      cwd: repoRoot,
    });

    await pushOrigin(repoRoot, 'main');

    // Note content should be unchanged between pushes
    const secondNote = await readFile(join(targetRoot, 'note.md'), 'utf8');
    assert.equal(secondNote, firstNote);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
  }
});

test('pre-push hook blocks source push when sensitive pattern is detected in a new commit', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-sensitive-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-e2e-sensitive-remote-');
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-sensitive-target-'));

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    // First commit has clean content so install.sh local check passes
    await writePublicNote(repoRoot, 'clean content');
    await commitAll(repoRoot, 'init');
    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    // Now add a note with a sensitive pattern and commit it
    await writeFile(
      join(repoRoot, 'secret.md'),
      `---\npublic: true\n---\n\npassword: hunter2\n`,
    );
    await commitAll(repoRoot, 'add sensitive note');

    // The push should fail because the hook detects the sensitive pattern
    await assert.rejects(() => pushOrigin(repoRoot, 'main'));

    // The source remote should not have received the push (only the first commit was already not there)
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await assert.rejects(
      () =>
        execFileAsync('git', [`--git-dir=${sourceRemote}`, 'show', 'refs/heads/main:secret.md']),
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('mirror --source-commit flag uses specified commit instead of HEAD', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-srccommit-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-e2e-srccommit-target-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-e2e-srccommit-remote-');

  try {
    await initRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);

    await writePublicNote(repoRoot, 'first version');
    await commitAll(repoRoot, 'v1');

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout: firstCommitRaw } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
    });
    const firstCommit = firstCommitRaw.trim();

    await writePublicNote(repoRoot, 'second version');
    await commitAll(repoRoot, 'v2');

    await ensureBuiltDist();
    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    // Mirror the first commit explicitly
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
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
  }
});
