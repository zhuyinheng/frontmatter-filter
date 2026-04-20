import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { parseFrontmatter } from './frontmatter.ts';
import { runGit } from './git.ts';
import { parseMarkdownReferences, type MarkdownReferenceSyntax } from './references.ts';
import { createGitSnapshotReader } from './snapshot-reader.ts';
import type {
  BrokenLink,
  CheckResult,
  MirrorDiff,
  MirrorResult,
  PublishResult,
  ResolvedConfig,
  SensitiveMatch,
  SnapshotReader,
  SyncMetadata,
} from './types.ts';
import {
  BrokenLinkPolicyError,
  ConfigError,
  GitPublishError,
  SensitivePatternError,
} from './types.ts';

const README_LOOKUP = normalizeLookupKey('README.md');
const META_FILE_NAME = '.frontmatter-filter-meta.json';

interface SnapshotFileEntry {
  relativePath: string;
  directoryRelativePath: string;
  basename: string;
  isMarkdown: boolean;
  buffer?: Buffer;
}

interface MarkdownCandidate extends SnapshotFileEntry {
  content: string;
  parsed: ReturnType<typeof parseFrontmatter>;
}

interface SnapshotTree {
  markdownByPath: Map<string, MarkdownCandidate>;
  fileByPath: Map<string, SnapshotFileEntry>;
  readmeByDirectory: Map<string, string>;
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

interface ReferenceResolution {
  status: 'resolved' | 'missing' | 'ignored';
  file?: SnapshotFileEntry;
  target: string;
}

interface CheckOptions {
  sourceCommit?: string;
  sourceBranch?: string;
  snapshotReader?: SnapshotReader;
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
  const snapshotReader =
    options.snapshotReader ??
    (await createGitSnapshotReader(config.repoRoot, {
      sourceCommit: options.sourceCommit,
      sourceBranch: options.sourceBranch,
    }));
  const sourceCommit = snapshotReader.sourceCommit;
  const sourceBranch = snapshotReader.sourceBranch;
  const sourceTree = await collectSourceTree(snapshotReader);
  const warnings = [...sourceTree.warnings];

  for (const candidate of sourceTree.markdownByPath.values()) {
    warnings.push(
      ...candidate.parsed.warnings.map((warning) => `${candidate.relativePath}: ${warning}`),
    );
  }

  const visibilityCache = new Map<string, boolean>();
  const publishedMarkdown = Array.from(sourceTree.markdownByPath.values())
    .filter((candidate) =>
      resolveEffectiveVisibility(
        candidate,
        sourceTree.markdownByPath,
        sourceTree.readmeByDirectory,
        visibilityCache,
      ),
    )
    .sort((left, right) => comparePaths(left.relativePath, right.relativePath));

  const publishedMarkdownKeys = new Set(
    publishedMarkdown.map((candidate) => normalizeLookupKey(candidate.relativePath)),
  );

  const referencedFiles = collectReferencedFiles(
    publishedMarkdown,
    sourceTree.fileByPath,
    publishedMarkdownKeys,
  );
  warnings.push(...referencedFiles.warnings);

  const attachmentFiles = referencedFiles.attachments.sort((left, right) =>
    comparePaths(left.relativePath, right.relativePath),
  );
  const brokenLinks =
    config.brokenLinkPolicy === 'ignore' ? [] : referencedFiles.brokenLinks;

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
      buffer: entry.buffer ?? (await snapshotReader.readBlob(entry.relativePath)),
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

async function collectSourceTree(snapshotReader: SnapshotReader): Promise<SnapshotTree> {
  const markdownByPath = new Map<string, MarkdownCandidate>();
  const fileByPath = new Map<string, SnapshotFileEntry>();
  const readmeByDirectory = new Map<string, string>();
  const warnings: string[] = [];
  const entries = await snapshotReader.listFiles();

  for (const entry of entries) {
    if (entry.mode === '120000') {
      warnings.push(`Skipping tracked symlink: ${entry.relativePath}`);
      continue;
    }

    const relativePath = normalizeRelativePosix(entry.relativePath);
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

    const buffer = await snapshotReader.readBlob(relativePath);
    const content = buffer.toString('utf8');
    const parsed = parseFrontmatter(content);
    const markdownCandidate: MarkdownCandidate = {
      ...fileEntry,
      buffer,
      content,
      parsed,
    };

    markdownByPath.set(normalizeLookupKey(relativePath), markdownCandidate);

    if (normalizeLookupKey(markdownCandidate.basename) === README_LOOKUP) {
      const existing = readmeByDirectory.get(normalizeLookupKey(markdownCandidate.directoryRelativePath));
      if (!existing || markdownCandidate.basename === 'README.md') {
        readmeByDirectory.set(
          normalizeLookupKey(markdownCandidate.directoryRelativePath),
          markdownCandidate.relativePath,
        );
      }
    }
  }

  return {
    markdownByPath,
    fileByPath,
    readmeByDirectory,
    warnings,
  };
}

function resolveEffectiveVisibility(
  candidate: MarkdownCandidate,
  markdownByPath: Map<string, MarkdownCandidate>,
  readmeByDirectory: Map<string, string>,
  cache: Map<string, boolean>,
): boolean {
  const key = normalizeLookupKey(candidate.relativePath);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  if (candidate.parsed.publicValue !== undefined) {
    cache.set(key, candidate.parsed.publicValue);
    return candidate.parsed.publicValue;
  }

  let currentDirectory = candidate.directoryRelativePath;
  while (true) {
    const readmePath = readmeByDirectory.get(normalizeLookupKey(currentDirectory));
    if (readmePath && normalizeLookupKey(readmePath) !== key) {
      const readme = markdownByPath.get(normalizeLookupKey(readmePath));
      if (readme?.parsed.publicValue !== undefined) {
        cache.set(key, readme.parsed.publicValue);
        return readme.parsed.publicValue;
      }
    }

    if (currentDirectory === '') {
      break;
    }
    currentDirectory = dirname(currentDirectory) === '.' ? '' : dirname(currentDirectory);
  }

  cache.set(key, false);
  return false;
}

function collectReferencedFiles(
  publishedMarkdown: MarkdownCandidate[],
  fileByPath: Map<string, SnapshotFileEntry>,
  publishedMarkdownKeys: Set<string>,
): { attachments: SnapshotFileEntry[]; brokenLinks: BrokenLink[]; warnings: string[] } {
  const attachments = new Map<string, SnapshotFileEntry>();
  const brokenLinks = new Map<string, BrokenLink>();
  const warnings: string[] = [];
  const basenameIndex = buildFileBasenameIndex(fileByPath);

  for (const candidate of publishedMarkdown) {
    const parsedReferences = parseMarkdownReferences(candidate.content);
    warnings.push(
      ...parsedReferences.warnings.map((warning) => `${candidate.relativePath}: ${warning}`),
    );

    for (const reference of parsedReferences.references) {
      const resolution = resolveReferenceTarget(
        candidate.relativePath,
        reference.rawTarget,
        reference.syntax,
        fileByPath,
        basenameIndex,
      );

      if (resolution.status === 'ignored') {
        continue;
      }

      if (resolution.status === 'missing' || !resolution.file) {
        addBrokenLink(candidate.relativePath, resolution.target, 'missing');
        continue;
      }

      if (resolution.file.isMarkdown) {
        if (!publishedMarkdownKeys.has(normalizeLookupKey(resolution.file.relativePath))) {
          addBrokenLink(candidate.relativePath, resolution.file.relativePath, 'not-public');
        }
        continue;
      }

      attachments.set(normalizeLookupKey(resolution.file.relativePath), resolution.file);
    }
  }

  return {
    attachments: Array.from(attachments.values()),
    brokenLinks: Array.from(brokenLinks.values()).sort((left, right) =>
      comparePaths(`${left.source}:${left.target}`, `${right.source}:${right.target}`),
    ),
    warnings,
  };

  function addBrokenLink(source: string, target: string, reason: BrokenLink['reason']): void {
    const key = `${normalizeLookupKey(source)}->${normalizeLookupKey(target)}`;
    if (brokenLinks.has(key)) {
      return;
    }

    brokenLinks.set(key, {
      source,
      target,
      reason,
    });
  }
}

function resolveReferenceTarget(
  sourceRelativePath: string,
  rawTarget: string,
  syntax: MarkdownReferenceSyntax,
  fileByPath: Map<string, SnapshotFileEntry>,
  basenameIndex: Map<string, SnapshotFileEntry[]>,
): ReferenceResolution {
  const prepared = prepareReferenceTarget(rawTarget, syntax);
  if (!prepared) {
    return {
      status: 'ignored',
      target: rawTarget,
    };
  }

  const candidates = buildReferenceCandidates(sourceRelativePath, prepared.path, syntax);
  for (const candidate of candidates) {
    const file = fileByPath.get(normalizeLookupKey(candidate));
    if (file) {
      return {
        status: 'resolved',
        file,
        target: file.relativePath,
      };
    }
  }

  if (prepared.allowBasenameFallback) {
    const basenameMatches = basenameIndex.get(normalizeLookupKey(prepared.basenameKey)) ?? [];
    if (basenameMatches.length === 1) {
      return {
        status: 'resolved',
        file: basenameMatches[0],
        target: basenameMatches[0].relativePath,
      };
    }
  }

  return {
    status: 'missing',
    target: candidates[0] ?? prepared.path.replace(/^\/+/, ''),
  };
}

function prepareReferenceTarget(
  rawTarget: string,
  syntax: MarkdownReferenceSyntax,
): { path: string; basenameKey: string; allowBasenameFallback: boolean } | undefined {
  let target = rawTarget.trim();
  if (target.length === 0) {
    return undefined;
  }

  if (syntax === 'link' || syntax === 'image' || syntax === 'linkReference' || syntax === 'imageReference') {
    target = trimAngleBrackets(target);
    if (isIgnoredUrl(target)) {
      return undefined;
    }
    target = safelyDecode(target);
    target = stripQueryAndHash(target);
  } else {
    target = stripHeadingFragment(target);
  }

  target = target.trim().replace(/\\/g, '/');
  if (target.length === 0 || target === '.' || target === '..') {
    return undefined;
  }

  const withoutLeadingSlash = target.replace(/^\/+/, '');
  if (withoutLeadingSlash.length === 0) {
    return undefined;
  }

  return {
    path: target,
    basenameKey: basename(withoutLeadingSlash),
    allowBasenameFallback: syntax === 'wikilink' || syntax === 'embed',
  };
}

function buildReferenceCandidates(
  sourceRelativePath: string,
  targetPath: string,
  syntax: MarkdownReferenceSyntax,
): string[] {
  const candidates = new Set<string>();
  const sourceDirectory = dirname(sourceRelativePath) === '.' ? '' : dirname(sourceRelativePath);
  const normalizedTargetPath = targetPath.replace(/^\/+/, '');
  const isRootRelative = targetPath.startsWith('/');

  const addCandidate = (candidate: string | undefined): void => {
    if (!candidate) {
      return;
    }

    candidates.add(candidate);
    if (extname(candidate) === '') {
      candidates.add(`${candidate}.md`);
    }
  };

  if (isRootRelative) {
    addCandidate(normalizeRelativePosix(normalizedTargetPath));
    return Array.from(candidates);
  }

  if (syntax === 'wikilink' || syntax === 'embed') {
    addCandidate(normalizeRelativePosix(joinPosix(sourceDirectory, normalizedTargetPath)));
    addCandidate(normalizeRelativePosix(normalizedTargetPath));
    return Array.from(candidates);
  }

  addCandidate(normalizeRelativePosix(joinPosix(sourceDirectory, normalizedTargetPath)));
  return Array.from(candidates);
}

function buildFileBasenameIndex(
  fileByPath: Map<string, SnapshotFileEntry>,
): Map<string, SnapshotFileEntry[]> {
  const basenameIndex = new Map<string, SnapshotFileEntry[]>();

  for (const file of fileByPath.values()) {
    addKey(file.basename, file);
    if (file.isMarkdown) {
      addKey(file.basename.replace(/\.md$/i, ''), file);
    }
  }

  return basenameIndex;

  function addKey(key: string, file: SnapshotFileEntry): void {
    const normalizedKey = normalizeLookupKey(key);
    const matches = basenameIndex.get(normalizedKey) ?? [];
    matches.push(file);
    basenameIndex.set(normalizedKey, matches);
  }
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

function joinPosix(left: string, right: string): string {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return `${left}/${right}`;
}

function stripHeadingFragment(target: string): string {
  const aliasIndex = target.indexOf('|');
  const headingIndex = target.indexOf('#');
  const cutIndex =
    aliasIndex >= 0 && headingIndex >= 0
      ? Math.min(aliasIndex, headingIndex)
      : Math.max(aliasIndex, headingIndex);
  return cutIndex >= 0 ? target.slice(0, cutIndex) : target;
}

function trimAngleBrackets(target: string): string {
  if (target.startsWith('<') && target.endsWith('>')) {
    return target.slice(1, -1);
  }
  return target;
}

function stripQueryAndHash(target: string): string {
  const hashIndex = target.indexOf('#');
  const queryIndex = target.indexOf('?');
  const cutIndex =
    hashIndex >= 0 && queryIndex >= 0
      ? Math.min(hashIndex, queryIndex)
      : Math.max(hashIndex, queryIndex);
  return cutIndex >= 0 ? target.slice(0, cutIndex) : target;
}

function safelyDecode(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

function isIgnoredUrl(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}

function normalizeLookupKey(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLowerCase()
    : value;
}
