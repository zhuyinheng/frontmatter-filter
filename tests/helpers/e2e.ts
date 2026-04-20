import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INSTALL_SCRIPT = join(PROJECT_ROOT, 'install.sh');
export const DIST_BINARY = join(PROJECT_ROOT, 'dist', 'frontmatter-filter.mjs');
export const FIXTURE_REPO_ROOT = join(PROJECT_ROOT, 'tests', 'fixtures', 'obsidian_test_vault');

export interface FixtureManifest {
  files: string[];
  sha256: Record<string, string>;
  metadata: {
    sourceBranch: string;
    toolVersion: string;
  };
  warnings: string[];
}

export async function ensureBuiltDist(): Promise<void> {
  await access(DIST_BINARY, fsConstants.F_OK);
}

export async function initRepo(repoRoot: string, branch = 'main'): Promise<void> {
  await runGit(dirname(repoRoot), ['init', '-b', branch, repoRoot]);
  await runGit(repoRoot, ['config', 'user.name', 'Test User']);
  await runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
}

export async function createBareRemote(prefix: string): Promise<string> {
  const remoteRoot = await mkdtemp(join(tmpdir(), prefix));
  await runGit(dirname(remoteRoot), ['init', '--bare', remoteRoot]);
  return remoteRoot;
}

export async function addRemote(repoRoot: string, name: string, remotePath: string): Promise<void> {
  await runGit(repoRoot, ['remote', 'add', name, remotePath]);
}

export async function writePublicNote(
  repoRoot: string,
  body: string,
  relativePath = 'note.md',
): Promise<void> {
  const absolutePath = join(repoRoot, ...relativePath.split('/'));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    `---
public: true
---

${body}
`,
  );
}

export async function commitAll(repoRoot: string, message: string): Promise<void> {
  await runGit(repoRoot, ['add', '-A']);
  await runGit(repoRoot, ['commit', '-m', message, '--no-gpg-sign']);
}

export async function installFrontmatterFilter(
  repoRoot: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await ensureBuiltDist();
  await execFileAsync('sh', [INSTALL_SCRIPT, '--repo', repoRoot, ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    maxBuffer: 1024 * 1024,
  });
}

export async function pushOrigin(
  repoRoot: string,
  refspec = 'main',
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['push', '-u', 'origin', refspec], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    maxBuffer: 1024 * 1024,
  });
}

export async function runInstalledCli(
  repoRoot: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    'node',
    [join(repoRoot, '.githooks', 'frontmatter-filter', 'frontmatter-filter.mjs'), ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
      },
      maxBuffer: 1024 * 1024,
    },
  );
}

export async function gitShow(gitDir: string, spec: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [`--git-dir=${gitDir}`, 'show', spec]);
  return stdout;
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(root, root, files);
  return files.sort();
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function exportFixtureToRepo(repoRoot: string, commitMessage = 'fixture snapshot'): Promise<void> {
  const archivePath = join(dirname(repoRoot), 'fixture.tar');
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync('git', ['archive', '--format=tar', 'HEAD', '-o', archivePath], {
    cwd: FIXTURE_REPO_ROOT,
  });
  await execFileAsync('tar', ['-xf', archivePath, '-C', repoRoot]);
  await initRepo(repoRoot);
  await commitAll(repoRoot, commitMessage);
}

export async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    maxBuffer: 1024 * 1024,
  });
}

async function walkFiles(root: string, dir: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, absolutePath, files);
      continue;
    }

    files.push(absolutePath.slice(root.length + 1));
  }
}
