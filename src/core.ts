import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { parseFrontmatter } from './frontmatter.ts';
import {
  getCurrentBranch,
  listCommitTree,
  readCommitFile,
  resolveCommit,
  runGit,
} from './git.ts';
import {
  planPublication,
  type MarkdownSourceEntry,
  type SourceFileEntry,
} from './publication-domain.ts';
import type {
  CheckResult,
  MirrorDiff,
  MirrorResult,
  PublishResult,
  ResolvedConfig,
  SensitiveMatch,
  SyncMetadata,
} from './types.ts';
import {
  BrokenLinkPolicyError,
  ConfigError,
  GitPublishError,
  SensitivePatternError,
} from './types.ts';

const META_FILE_NAME = '.frontmatter-filter-meta.json';

interface SnapshotFileEntry extends SourceFileEntry {
  buffer?: Buffer;
}

interface MarkdownCandidate extends SnapshotFileEntry, MarkdownSourceEntry {
  content: string;
  parsed: ReturnType<typeof parseFrontmatter>;
}

interface SnapshotTree {
  markdownByPath: Map<string, MarkdownCandidate>;
  fileByPath: Map<string, SnapshotFileEntry>;
  warnings: string[];
}

interface PublishAsset {
  relativePath: string;
  kind: 'markdown' | 'attachment' | 'metadata';
  buffer: Buffer;
}

interface PublishPlan extends CheckResult {
  files: PublishAsset[];
}

interface CheckOptions {
  sourceCommit?: string;
  sourceBranch?: string;
  toolVersion: string;
}

interface MirrorOptions extends CheckOptions {
  targetPath: string;
}

interface PublishOptions extends CheckOptions {
  remote: string;
  branch: string;
  stagingDir?: string;
  keepStaging: boolean;
}

export async function checkSourceCommit(
  config: ResolvedConfig,
  options: CheckOptions,
): Promise<CheckResult> {
  const plan = await buildPublishPlan(config, options);
  return {
    sourceCommit: plan.sourceCommit,
    sourceBranch: plan.sourceBranch,
    publishedMarkdown: plan.publishedMarkdown,
    copiedAttachments: plan.copiedAttachments,
    warnings: plan.warnings,
    brokenLinks: plan.brokenLinks,
    sensitiveMatches: plan.sensitiveMatches,
    metadata: plan.metadata,
  };
}

export async function mirrorSourceCommit(
  config: ResolvedConfig,
  options: MirrorOptions,
): Promise<MirrorResult> {
  const plan = await buildPublishPlan(config, options);
  const diff = await diffMirror(options.targetPath, plan.files);
  const hasChanges = diff.added.length > 0 || diff.changed.length > 0 || diff.deleted.length > 0;

  if (hasChanges) {
    await writeMirror(options.targetPath, plan.files);
  }

  return {
    sourceCommit: plan.sourceCommit,
    sourceBranch: plan.sourceBranch,
    publishedMarkdown: plan.publishedMarkdown,
    copiedAttachments: plan.copiedAttachments,
    warnings: plan.warnings,
    brokenLinks: plan.brokenLinks,
    sensitiveMatches: plan.sensitiveMatches,
    metadata: plan.metadata,
    targetPath: options.targetPath,
    diff,
    didWrite: hasChanges,
  };
}

export async function publishSourceCommit(
  config: ResolvedConfig,
  options: PublishOptions,
): Promise<PublishResult> {
  const userProvidedStagingDir = options.stagingDir !== undefined;
  const stagingDir =
    options.stagingDir ?? (await mkdtemp(join(tmpdir(), 'frontmatter-filter-staging-')));
  // A directory the user chose is never touched — only auto-created temp dirs
  // may be cleaned up, either on success or on pre-write errors in the catch.
  const shouldKeepOnSuccess = options.keepStaging || userProvidedStagingDir;

  try {
    const mirrorResult = await mirrorSourceCommit(config, {
      ...options,
      targetPath: stagingDir,
    });

    await recreateGitRepository(stagingDir);
    await runGit(stagingDir, ['remote', 'add', 'origin', options.remote]);
    await runGit(stagingDir, ['add', '-A']);
    await runGit(stagingDir, ['commit', '-m', `snapshot: ${new Date().toISOString()}`, '--no-gpg-sign']);
    await runGit(stagingDir, ['push', '--force', 'origin', `HEAD:${options.branch}`]);

    if (!shouldKeepOnSuccess) {
      await rm(stagingDir, { recursive: true, force: true });
    }

    return {
      ...mirrorResult,
      remote: options.remote,
      branch: options.branch,
      stagingDir,
      didKeepStaging: shouldKeepOnSuccess,
    };
  } catch (error) {
    if (error instanceof GitPublishError) {
      throw new GitPublishError(error.message, stagingDir);
    }

    if (
      error instanceof ConfigError ||
      error instanceof SensitivePatternError ||
      error instanceof BrokenLinkPolicyError
    ) {
      // These three errors fire inside buildPublishPlan, before writeMirror
      // touches the staging dir, so it's guaranteed empty here.
      if (!userProvidedStagingDir) {
        await rmdir(stagingDir);
      }
      throw error;
    }

    throw new GitPublishError(
      error instanceof Error ? error.message : String(error),
      stagingDir,
    );
  }
}

async function buildPublishPlan(
  config: ResolvedConfig,
  options: CheckOptions,
): Promise<PublishPlan> {
  const sourceCommit = await resolveCommit(config.repoRoot, options.sourceCommit ?? 'HEAD');
  const sourceBranch = options.sourceBranch ?? (await getCurrentBranch(config.repoRoot));
  const sourceTree = await collectSourceTree(config.repoRoot, sourceCommit);
  const domainPlan = planPublication({
    markdownCandidates: Array.from(sourceTree.markdownByPath.values()),
    fileEntries: Array.from(sourceTree.fileByPath.values()),
    brokenLinkPolicy: config.brokenLinkPolicy,
  });
  const warnings = [...sourceTree.warnings, ...domainPlan.warnings];
  const publishedMarkdown = domainPlan.publishedMarkdown;
  const attachmentFiles = domainPlan.attachments;
  const brokenLinks = domainPlan.brokenLinks;

  if (brokenLinks.length > 0 && config.brokenLinkPolicy === 'error') {
    throw new BrokenLinkPolicyError(brokenLinks);
  }

  const publishFiles: PublishAsset[] = [
    ...publishedMarkdown.map((candidate) => ({
      relativePath: candidate.relativePath,
      kind: 'markdown' as const,
      buffer: candidate.buffer ?? Buffer.from(candidate.content, 'utf8'),
    })),
  ];

  for (const entry of attachmentFiles) {
    publishFiles.push({
      relativePath: entry.relativePath,
      kind: 'attachment',
      buffer: entry.buffer ?? (await readCommitFile(config.repoRoot, sourceCommit, entry.relativePath)),
    });
  }

  const sensitiveMatches =
    process.env.SKIP_SENSITIVE === '1'
      ? []
      : scanSensitivePatterns(publishFiles, config.sensitivePatterns);

  if (sensitiveMatches.length > 0) {
    throw new SensitivePatternError(sensitiveMatches);
  }

  const metadata: SyncMetadata = {
    sourceCommit,
    sourceBranch,
    publishedAt: new Date().toISOString(),
    toolVersion: options.toolVersion,
  };

  publishFiles.push({
    relativePath: META_FILE_NAME,
    kind: 'metadata',
    buffer: Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8'),
  });

  return {
    sourceCommit,
    sourceBranch,
    publishedMarkdown: publishedMarkdown.map((candidate) => candidate.relativePath),
    copiedAttachments: attachmentFiles.map((entry) => entry.relativePath),
    warnings,
    brokenLinks,
    sensitiveMatches,
    metadata,
    files: publishFiles,
  };
}

async function collectSourceTree(repoRoot: string, sourceCommit: string): Promise<SnapshotTree> {
  const markdownByPath = new Map<string, MarkdownCandidate>();
  const fileByPath = new Map<string, SnapshotFileEntry>();
  const warnings: string[] = [];
  const entries = await listCommitTree(repoRoot, sourceCommit);

  for (const entry of entries) {
    if (entry.mode === '120000') {
      warnings.push(`Skipping tracked symlink: ${entry.path}`);
      continue;
    }

    if (entry.type !== 'blob') {
      warnings.push(`Skipping unsupported git entry: ${entry.path}`);
      continue;
    }

    const relativePath = normalizeRelativePosix(entry.path);
    if (!relativePath) {
      continue;
    }

    const fileEntry: SnapshotFileEntry = {
      relativePath,
      directoryRelativePath: dirname(relativePath) === '.' ? '' : dirname(relativePath),
      basename: basename(relativePath),
      isMarkdown: isMarkdownFile(relativePath),
    };

    fileByPath.set(normalizeLookupKey(relativePath), fileEntry);

    if (!fileEntry.isMarkdown) {
      continue;
    }

    const buffer = await readCommitFile(repoRoot, sourceCommit, relativePath);
    const content = buffer.toString('utf8');
    const parsed = parseFrontmatter(content);
    const markdownCandidate: MarkdownCandidate = {
      ...fileEntry,
      buffer,
      content,
      parsed,
    };

    markdownByPath.set(normalizeLookupKey(relativePath), markdownCandidate);
  }

  return {
    markdownByPath,
    fileByPath,
    warnings,
  };
}

function scanSensitivePatterns(publishFiles: PublishAsset[], patterns: string[]): SensitiveMatch[] {
  const regexes = patterns.map((pattern) => ({
    pattern,
    regex: new RegExp(pattern, 'i'),
  }));
  const matches: SensitiveMatch[] = [];

  for (const file of publishFiles) {
    if (file.kind === 'metadata' || !isProbablyText(file.buffer)) {
      continue;
    }

    const content = file.buffer.toString('utf8');

    for (const { pattern, regex } of regexes) {
      regex.lastIndex = 0;
      const match = regex.exec(content);
      if (!match || match.index === undefined) {
        continue;
      }

      matches.push({
        path: file.relativePath,
        pattern,
        snippet: buildSnippet(content, match.index, match[0].length),
      });
    }
  }

  return matches.sort((left, right) => comparePaths(left.path, right.path));
}

async function diffMirror(targetRoot: string, publishFiles: PublishAsset[]): Promise<MirrorDiff> {
  const desiredFiles = new Map(
    publishFiles.map((file) => [normalizeLookupKey(file.relativePath), file] as const),
  );
  const existingFiles = await collectExistingTargetFiles(targetRoot);

  const diff: MirrorDiff = {
    added: [],
    changed: [],
    deleted: [],
  };

  for (const [existingKey, existingRelativePath] of existingFiles.entries()) {
    if (!desiredFiles.has(existingKey)) {
      diff.deleted.push(existingRelativePath);
    }
  }

  for (const [desiredKey, desiredFile] of desiredFiles.entries()) {
    const existingRelativePath = existingFiles.get(desiredKey);
    if (!existingRelativePath) {
      diff.added.push(desiredFile.relativePath);
      continue;
    }

    const existingPath = join(targetRoot, ...existingRelativePath.split('/'));
    const targetBuffer = await readFile(existingPath);
    if (!desiredFile.buffer.equals(targetBuffer)) {
      diff.changed.push(desiredFile.relativePath);
    }
  }

  diff.added.sort(comparePaths);
  diff.changed.sort(comparePaths);
  diff.deleted.sort(comparePaths);
  return diff;
}

async function collectExistingTargetFiles(targetRoot: string): Promise<Map<string, string>> {
  const existingFiles = new Map<string, string>();

  try {
    await walkTarget(targetRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return existingFiles;
    }
    throw error;
  }

  return existingFiles;

  async function walkTarget(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (directoryPath === targetRoot && entry.name === '.git') {
        continue;
      }

      const absolutePath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await walkTarget(absolutePath);
        continue;
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        const relativePath = toRelativePosix(targetRoot, absolutePath);
        existingFiles.set(normalizeLookupKey(relativePath), relativePath);
      }
    }
  }
}

async function writeMirror(targetRoot: string, publishFiles: PublishAsset[]): Promise<void> {
  await mkdir(targetRoot, { recursive: true });
  const entries = await readdir(targetRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }
    await rm(join(targetRoot, entry.name), { recursive: true, force: true });
  }

  for (const file of publishFiles) {
    const destination = join(targetRoot, ...file.relativePath.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.buffer);
  }
}

async function recreateGitRepository(stagingDir: string): Promise<void> {
  await rm(join(stagingDir, '.git'), { recursive: true, force: true });
  await runGit(stagingDir, ['init']);
  await runGit(stagingDir, ['config', 'user.name', 'frontmatter-filter']);
  await runGit(stagingDir, ['config', 'user.email', 'frontmatter-filter@local']);
}

function buildSnippet(content: string, start: number, length: number): string {
  const windowStart = Math.max(0, start - 20);
  const windowEnd = Math.min(content.length, start + length + 20);
  return content.slice(windowStart, windowEnd).replace(/\s+/g, ' ').trim();
}

function isMarkdownFile(relativePath: string): boolean {
  return extname(relativePath).toLowerCase() === '.md';
}

function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 1024);
  return !sample.includes(0);
}

function toRelativePosix(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

function normalizeRelativePosix(path: string): string | undefined {
  const parts: string[] = [];

  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
      continue;
    }

    parts.push(segment);
  }

  return parts.join('/');
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}

function normalizeLookupKey(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLowerCase()
    : value;
}
