import { basename, dirname, extname } from 'node:path';

import { parseMarkdownReferences, type MarkdownReferenceSyntax } from './references.ts';
import type { BrokenLink, BrokenLinkPolicy } from './types.ts';
import { BrokenLinkPolicyError } from './types.ts';

const README_LOOKUP = normalizeLookupKey('README.md');

export interface SnapshotFileEntry {
  relativePath: string;
  directoryRelativePath: string;
  basename: string;
  isMarkdown: boolean;
  buffer?: Buffer;
}

export interface MarkdownCandidate extends SnapshotFileEntry {
  content: string;
  parsed: {
    publicValue?: boolean;
    warnings: string[];
  };
}

export interface SnapshotTree {
  markdownByPath: Map<string, MarkdownCandidate>;
  fileByPath: Map<string, SnapshotFileEntry>;
  readmeByDirectory: Map<string, string>;
  warnings: string[];
}

interface ReferenceResolution {
  status: 'resolved' | 'missing' | 'ignored';
  file?: SnapshotFileEntry;
  target: string;
}

export interface PublicationSelection {
  publishedMarkdown: MarkdownCandidate[];
  copiedAttachments: SnapshotFileEntry[];
  warnings: string[];
  brokenLinks: BrokenLink[];
}

export function derivePublicationSelection(
  sourceTree: SnapshotTree,
  brokenLinkPolicy: BrokenLinkPolicy,
): PublicationSelection {
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

  const copiedAttachments = referencedFiles.attachments.sort((left, right) =>
    comparePaths(left.relativePath, right.relativePath),
  );

  const brokenLinks = brokenLinkPolicy === 'ignore' ? [] : referencedFiles.brokenLinks;

  if (brokenLinks.length > 0 && brokenLinkPolicy === 'error') {
    throw new BrokenLinkPolicyError(brokenLinks);
  }

  return {
    publishedMarkdown,
    copiedAttachments,
    warnings,
    brokenLinks,
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

export function isMarkdownFile(relativePath: string): boolean {
  return extname(relativePath).toLowerCase() === '.md';
}

export function normalizeRelativePosix(path: string): string | undefined {
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

export function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}

export function normalizeLookupKey(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLowerCase()
    : value;
}

export function isReadmeBasename(pathBasename: string): boolean {
  return normalizeLookupKey(pathBasename) === README_LOOKUP;
}
