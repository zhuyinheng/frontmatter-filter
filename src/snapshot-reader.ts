import { getCurrentBranch, listCommitTree, readCommitFile, resolveCommit } from './git.ts';
import type { SnapshotFile, SnapshotReader } from './types.ts';

interface SnapshotReaderOptions {
  sourceCommit?: string;
  sourceBranch?: string;
}

export async function createGitSnapshotReader(
  repoRoot: string,
  options: SnapshotReaderOptions,
): Promise<SnapshotReader> {
  const sourceCommit = await resolveCommit(repoRoot, options.sourceCommit ?? 'HEAD');
  const sourceBranch = options.sourceBranch ?? (await getCurrentBranch(repoRoot));

  return {
    sourceCommit,
    sourceBranch,
    async listFiles(): Promise<SnapshotFile[]> {
      const entries = await listCommitTree(repoRoot, sourceCommit);
      return entries.map((entry) => ({
        relativePath: entry.path,
        mode: entry.mode,
      }));
    },
    readBlob(relativePath: string): Promise<Buffer> {
      return readCommitFile(repoRoot, sourceCommit, relativePath);
    },
  };
}

export function createInMemorySnapshotReader(
  files: Record<string, Buffer | string>,
  options: SnapshotReaderOptions & { sourceCommit?: string } = {},
): SnapshotReader {
  const normalized = new Map<string, Buffer>();
  for (const [relativePath, content] of Object.entries(files)) {
    normalized.set(relativePath, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }

  return {
    sourceCommit: options.sourceCommit ?? 'IN_MEMORY',
    sourceBranch: options.sourceBranch,
    async listFiles(): Promise<SnapshotFile[]> {
      return Array.from(normalized.keys())
        .sort((left, right) => left.localeCompare(right))
        .map((relativePath) => ({ relativePath, mode: '100644' }));
    },
    async readBlob(relativePath: string): Promise<Buffer> {
      const buffer = normalized.get(relativePath);
      if (!buffer) {
        throw new Error(`In-memory blob not found: ${relativePath}`);
      }
      return buffer;
    },
  };
}
