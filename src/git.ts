import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { HookPushUpdate, SourceCommitSelection } from './types.ts';
import { ConfigError, GitPublishError } from './types.ts';

const execFileAsync = promisify(execFile);
const ZERO_OID = '0000000000000000000000000000000000000000';

export interface CommitTreeEntry {
  path: string;
  mode: string;
  type: string;
  oid: string;
}

export async function detectGitRoot(cwd = process.cwd()): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveCommit(repoRoot: string, ref = 'HEAD'): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', ref], { cwd: repoRoot });
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      throw new ConfigError(`Unable to resolve source commit: ${ref}`);
    }
    return trimmed;
  } catch (error) {
    const message = extractGitErrorDetail(error) ?? `Unable to resolve source commit: ${ref}`;
    throw new ConfigError(message);
  }
}

export async function getCurrentBranch(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
    });
    const trimmed = stdout.trim();
    if (trimmed.length === 0 || trimmed === 'HEAD') {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

export async function listCommitTree(repoRoot: string, sourceCommit: string): Promise<CommitTreeEntry[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-tree', '-rz', '--full-tree', sourceCommit],
      { cwd: repoRoot, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
    );
    return parseLsTree(stdout as Buffer);
  } catch (error) {
    const message =
      extractGitErrorDetail(error) ?? `Unable to list source commit contents: ${sourceCommit}`;
    throw new ConfigError(message);
  }
}

export async function readCommitFile(
  repoRoot: string,
  sourceCommit: string,
  relativePath: string,
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${sourceCommit}:${relativePath}`],
      { cwd: repoRoot, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
    );
    return Buffer.from(stdout as Buffer);
  } catch (error) {
    const message =
      extractGitErrorDetail(error) ??
      `Unable to read ${relativePath} from source commit ${sourceCommit}`;
    throw new ConfigError(message);
  }
}

export function parsePrePushUpdates(input: string): HookPushUpdate[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length !== 4) {
        throw new ConfigError(`Invalid pre-push update line: ${line}`);
      }

      const [localRef, localOid, remoteRef, remoteOid] = parts;
      return {
        localRef,
        localOid,
        remoteRef,
        remoteOid,
      };
    });
}

export function selectSourceCommitFromUpdates(updates: HookPushUpdate[]): SourceCommitSelection {
  const branchUpdates = updates.filter(
    (update) => isBranchRef(update.localRef) && update.localOid !== ZERO_OID,
  );

  if (branchUpdates.length === 0) {
    return {
      action: 'skip',
      reason: 'No branch update found in pre-push input.',
    };
  }

  if (branchUpdates.length > 1) {
    throw new ConfigError(
      'Multiple branch updates detected in a single push. Re-run manually with --source-commit.',
    );
  }

  const [update] = branchUpdates;
  return {
    action: 'sync',
    sourceCommit: update.localOid,
    sourceBranch: update.localRef.replace(/^refs\/heads\//, ''),
  };
}

export async function gitLsRemote(remote: string, cwd: string): Promise<void> {
  try {
    await execFileAsync('git', ['ls-remote', remote], { cwd, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const message = extractGitErrorDetail(error) ?? `git ls-remote ${remote} failed.`;
    throw new GitPublishError(message);
  }
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const message = extractGitErrorDetail(error) ?? `git ${args.join(' ')} failed.`;
    throw new GitPublishError(message);
  }
}

function parseLsTree(buffer: Buffer): CommitTreeEntry[] {
  const entries: CommitTreeEntry[] = [];

  for (const record of buffer.toString('utf8').split('\0')) {
    if (record.length === 0) {
      continue;
    }

    const tabIndex = record.indexOf('\t');
    if (tabIndex < 0) {
      continue;
    }

    const meta = record.slice(0, tabIndex).split(' ');
    if (meta.length !== 3) {
      continue;
    }

    const [mode, type, oid] = meta;
    const path = record.slice(tabIndex + 1);
    entries.push({ mode, type, oid, path });
  }

  return entries;
}

function isBranchRef(ref: string): boolean {
  return ref.startsWith('refs/heads/');
}

function extractGitErrorDetail(error: unknown): string | undefined {
  const gitError = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
  const detail = [gitError.stdout, gitError.stderr]
    .map((value) => {
      if (value === undefined) {
        return '';
      }
      return Buffer.isBuffer(value) ? value.toString('utf8') : value;
    })
    .join('\n')
    .trim();

  return detail.length > 0 ? detail : undefined;
}
