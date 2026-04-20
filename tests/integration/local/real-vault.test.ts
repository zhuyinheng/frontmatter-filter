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
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-real-fixture-'));
  const targetRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-real-target-'));
  const sourceRemote = await createBareRemote('frontmatter-filter-real-source-');

  try {
    await exportFixtureToRepo(repoRoot);
    await addRemote(repoRoot, 'origin', sourceRemote);
    await installFrontmatterFilter(repoRoot, ['--target', targetRoot]);

    const pushResult = await pushOrigin(repoRoot, 'main');
    const combinedOutput = `${pushResult.stdout}\n${pushResult.stderr}`;
    const { stdout: sourceCommitRaw } = await runGit(repoRoot, ['rev-parse', 'HEAD']);
    const sourceCommit = sourceCommitRaw.trim();
    const manifest = await readJsonFile<FixtureManifest>(FIXTURE_MANIFEST_PATH);

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

    for (const [relativePath, expectedSha] of Object.entries(manifest.sha256)) {
      assert.equal(await sha256File(join(targetRoot, ...relativePath.split('/'))), expectedSha, relativePath);
    }

    assert.equal(mirroredMetadata.sourceCommit, sourceCommit);
    assert.equal(mirroredMetadata.sourceBranch, manifest.metadata.sourceBranch);
    assert.equal(mirroredMetadata.toolVersion, manifest.metadata.toolVersion);
    assert.ok(!Number.isNaN(Date.parse(mirroredMetadata.publishedAt)));

    for (const warning of manifest.warnings) {
      assert.match(combinedOutput, new RegExp(escapeForRegExp(warning)));
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(sourceRemote, { recursive: true, force: true });
  }
});

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
