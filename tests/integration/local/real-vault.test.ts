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

    const mirroredHomeNote = await readFile(join(targetRoot, 'Projects', 'Launch', 'Home.md'), 'utf8');
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

    // Core content checks
    assert.match(pushedSourceNote, /Launch Home/);
    assert.match(mirroredHomeNote, /\[\[Private\/Secret Plan\]\]/);
    assert.match(mirroredHomeNote, /Ambiguous basename: !\[\[diagram\.png\]\]/);

    // Corner case: angle-bracket link resolves report.pdf
    assert.ok(
      actualFiles.includes('Assets/Documents/report.pdf'),
      'angle-bracket link should include Assets/Documents/report.pdf',
    );

    // Corner case: URL-encoded link (Meeting%20Notes.md) resolves correctly
    assert.ok(
      actualFiles.includes('Projects/Launch/Notes/Meeting Notes.md'),
      'URL-encoded link should resolve Meeting Notes.md',
    );

    // Corner case: image link reference ([crew-img]: ...) resolves launch-crew.jpg
    assert.ok(
      actualFiles.includes('Assets/Images/launch-crew.jpg'),
      'image link reference should include launch-crew.jpg',
    );

    // Corner case: explicit public:true overrides parent public:false in Archived directory
    assert.ok(
      actualFiles.includes('Projects/Archived/Rediscovered.md'),
      'explicit public:true should override parent public:false',
    );
    await assert.rejects(
      () => readFile(join(targetRoot, 'Projects', 'Archived', 'Old Note.md'), 'utf8'),
      'inherited public:false note should not be published',
    );

    // Corner case: multi-hop README.md inheritance (Spaces/Deep/Nested inherits from Spaces/README.md)
    assert.ok(
      actualFiles.includes('Spaces/Deep/Nested/Note.md'),
      'multi-hop README inheritance should publish deeply nested note',
    );

    // Root README with no public value should NOT be published
    await assert.rejects(
      () => readFile(join(targetRoot, 'README.md'), 'utf8'),
      'root README without public value should not be published',
    );

    // Full file tree matches manifest
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

