import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INSTALL_SCRIPT = join(PROJECT_ROOT, 'install.sh');
export const DIST_BINARY = join(PROJECT_ROOT, 'dist', 'frontmatter-filter.mjs');
// Local clone location for the fixture vault. Not tracked by git; populated by
// fetchFixtureRepo() on demand. CI does the same thing in a pre-step.
const FIXTURE_CLONE_ROOT = join(PROJECT_ROOT, 'tests', 'fixtures', 'obsidian_test_vault');
const FIXTURE_REPO_URL =
  process.env.FRONTMATTER_FILTER_FIXTURE_REPO_URL ??
  'https://github.com/zhuyinheng/obsidian_test_vault.git';

export interface FixtureManifest {
  files: string[];
  sha256: Record<string, string>;
  sourceBranch: string;
  warnings: string[];
}

let distCheck: Promise<void> | undefined;

export function ensureBuiltDist(): Promise<void> {
  if (!distCheck) {
    distCheck = access(DIST_BINARY, fsConstants.F_OK);
  }
  return distCheck;
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

export async function installFrontmatterFilterViaPipe(
  repoRoot: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  await ensureBuiltDist();
  const script = await readFile(INSTALL_SCRIPT, 'utf8');
  return runShellStdin(script, ['-s', '--', '--repo', repoRoot, ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...env,
    },
  });
}

export function localFileUrl(path: string): string {
  return pathToFileURL(path).href;
}

function runShellStdin(
  script: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('sh', args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const error = Object.assign(
        new Error(`sh exited with code ${code}: ${stderr}`),
        { code, stdout, stderr },
      );
      reject(error);
    });
    child.stdin.end(script);
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

export const FIXTURE_LOCK_PATH = join(PROJECT_ROOT, 'tests', 'fixtures', 'obsidian_test_vault.lock');

export async function readFixturePinnedCommit(): Promise<string> {
  try {
    const raw = await readFile(FIXTURE_LOCK_PATH, 'utf8');
    const pin = raw.trim();
    if (!/^[0-9a-f]{40}$/i.test(pin)) {
      throw new Error(
        `Invalid fixture pin in ${FIXTURE_LOCK_PATH}: ${pin || '(empty)'}. Expected a 40-char git commit hash.`,
      );
    }
    return pin;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Fixture pin file missing: ${FIXTURE_LOCK_PATH}. ` +
          `Write the expected submodule commit into this file to stabilise integration tests.`,
      );
    }
    throw error;
  }
}

export async function exportFixtureToRepo(repoRoot: string, commitMessage = 'fixture snapshot'): Promise<void> {
  const fixtureRoot = await fetchFixtureRepo();
  const archivePath = join(dirname(repoRoot), 'fixture.tar');
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync('git', ['archive', '--format=tar', 'HEAD', '-o', archivePath], {
    cwd: fixtureRoot,
  });
  await execFileAsync('tar', ['-xf', archivePath, '-C', repoRoot]);
  await initRepo(repoRoot);
  await commitAll(repoRoot, commitMessage);
}

let fixtureFetch: Promise<string> | undefined;

// Fetches the vault fixture at the pinned commit into FIXTURE_CLONE_ROOT and
// returns that path. Idempotent: if the clone already exists at the correct pin,
// it is left alone. If it exists at a wrong pin, it is wiped and re-cloned.
export function fetchFixtureRepo(): Promise<string> {
  if (!fixtureFetch) {
    fixtureFetch = (async () => {
      const pin = await readFixturePinnedCommit();

      const existingHead = await readGitHeadIfPresent(FIXTURE_CLONE_ROOT);
      if (existingHead === pin) {
        return FIXTURE_CLONE_ROOT;
      }

      // Either missing or at a stale pin: discard and re-clone. The directory
      // is not tracked by the outer repo (see .gitignore), so this is safe.
      await rm(FIXTURE_CLONE_ROOT, { recursive: true, force: true });
      await mkdir(FIXTURE_CLONE_ROOT, { recursive: true });
      await execFileAsync('git', ['init', '--quiet'], { cwd: FIXTURE_CLONE_ROOT });
      await execFileAsync('git', ['remote', 'add', 'origin', FIXTURE_REPO_URL], {
        cwd: FIXTURE_CLONE_ROOT,
      });
      await execFileAsync('git', ['fetch', '--depth', '1', 'origin', pin], {
        cwd: FIXTURE_CLONE_ROOT,
      });
      await execFileAsync(
        'git',
        ['-c', 'advice.detachedHead=false', 'checkout', pin],
        { cwd: FIXTURE_CLONE_ROOT },
      );
      return FIXTURE_CLONE_ROOT;
    })();
  }
  return fixtureFetch;
}

async function readGitHeadIfPresent(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return undefined;
  }
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

export async function getHeadCommit(repoRoot: string): Promise<string> {
  const { stdout } = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export interface InstallScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runInstallScript(
  repoRoot: string,
  extraArgs: string[] = [],
  env?: NodeJS.ProcessEnv,
): Promise<InstallScriptResult> {
  await ensureBuiltDist();
  try {
    const { stdout, stderr } = await execFileAsync(
      'sh',
      [INSTALL_SCRIPT, '--repo', repoRoot, ...extraArgs],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const exitError = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    // Surface spawn-level failures (ENOENT on sh, permission denied) instead of masking them
    // as exit code 1, which callers would interpret as a normal non-zero install result.
    if (exitError.stdout === undefined && exitError.stderr === undefined) {
      throw error;
    }
    return {
      code: typeof exitError.code === 'number' ? exitError.code : 1,
      stdout: exitError.stdout ?? '',
      stderr: exitError.stderr ?? '',
    };
  }
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
