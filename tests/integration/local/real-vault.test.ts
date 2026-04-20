import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addRemote,
  createBareRemote,
  exportFixtureToRepo,
  gitShow,
  installFrontmatterFilter,
  listRelativeFiles,
  pushOrigin,
  readJsonFile,
  sha256File,
  type FixtureManifest,
  PROJECT_ROOT,
  runGit,
} from '../../helpers/e2e.ts';

const FIXTURE_MANIFEST_PATH = join(PROJECT_ROOT, 'tests', 'fixtures', 'obsidian_test_vault.manifest.json');

test('real vault fixture flows through install.sh and pre-push hook into the mirror target', async () => {
  const [repoRoot, targetRoot, sourceRemote] = await Promise.all([
    mkdtemp(join(tmpdir(), 'frontmatter-filter-real-fixture-')),
    mkdtemp(join(tmpdir(), 'frontmatter-filter-real-target-')),
    createBareRemote('frontmatter-filter-real-source-'),
  ]);

  try {
    await exportFixtureToRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    const pushResult = await pushOrigin(repoRoot, 'main');
    const { stdout: sourceCommitRaw } = await runGit(repoRoot, ['rev-parse', 'HEAD']);
    const sourceCommit = sourceCommitRaw.trim();
    const manifest = await readJsonFile<FixtureManifest>(FIXTURE_MANIFEST_PATH);
    const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };

    const mirroredNote = await readFile(join(targetRoot, 'Projects', 'Launch', 'Home.md'), 'utf8');
    const mirroredMetadata = await readJsonFile<{
      sourceCommit: string;
      sourceBranch?: string;
      publishedAt: string;
      toolVersion: string;
    }>(
      join(targetRoot, '.frontmatter-filter-meta.json'),
    );
    const pushedSourceNote = await gitShow(sourceRemote, 'refs/heads/main:Projects/Launch/Home.md');
    const actualFiles = await listRelativeFiles(targetRoot);

    assert.match(pushedSourceNote, /Launch Home/);
    assert.match(mirroredNote, /\[\[Private\/Secret Plan\]\]/);
    assert.match(mirroredNote, /Ambiguous basename: !\[\[diagram\.png\]\]/);
    assert.deepEqual(actualFiles, manifest.files);

    await Promise.all(
      Object.entries(manifest.sha256).map(async ([relativePath, expectedSha]) => {
        const actualSha = await sha256File(join(targetRoot, ...relativePath.split('/')));
        assert.equal(actualSha, expectedSha, relativePath);
      }),
    );

    assert.equal(mirroredMetadata.sourceCommit, sourceCommit);
    assert.equal(mirroredMetadata.sourceBranch, manifest.sourceBranch);
    assert.equal(
      mirroredMetadata.toolVersion,
      pkg.version,
      'mirrored toolVersion must equal the current package.json version',
    );
    assert.ok(!Number.isNaN(Date.parse(mirroredMetadata.publishedAt)));

    const emittedWarnings = pushResult.stderr
      .split(/\r?\n/)
      .filter((line) => line.startsWith('warn: '))
      .sort();
    const expectedWarnings = [...manifest.warnings].sort();
    assert.deepEqual(
      emittedWarnings,
      expectedWarnings,
      'warnings on stderr must exactly match the manifest',
    );
    assert.match(pushResult.stdout, /mirrored \d+ files to/);
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(targetRoot, { recursive: true, force: true }),
      rm(sourceRemote, { recursive: true, force: true }),
    ]);
  }
});
