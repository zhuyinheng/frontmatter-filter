import { access, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import { detectGitRoot } from './git.ts';
import type { CliOptions, FileConfig, ResolvedConfig } from './types.ts';
import { ConfigError } from './types.ts';

export const DEFAULT_SENSITIVE_PATTERNS = [
  '\\b(api[_-]?key|password|secret|token|bearer)\\s*[:=]',
];

export async function resolveRepoRoot(
  cliRepoPath: string | undefined,
  cwd = process.cwd(),
): Promise<string> {
  if (cliRepoPath) {
    const repoRoot = resolveUserPath(cliRepoPath, cwd);
    await assertDirectoryExists(repoRoot, 'Repository path');
    return repoRoot;
  }

  const gitRoot = await detectGitRoot(cwd);
  if (!gitRoot) {
    throw new ConfigError('Unable to detect git repository root. Use --repo to specify one.');
  }

  return gitRoot;
}

export async function resolveConfig(
  cli: CliOptions,
  cwd = process.cwd(),
  repoRoot?: string,
): Promise<ResolvedConfig> {
  const resolvedRepoRoot = repoRoot ?? (await resolveRepoRoot(cli.repoPath, cwd));
  const configPath = cli.configPath
    ? resolveUserPath(cli.configPath, cwd)
    : resolve(resolvedRepoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json');

  const fileConfig = await loadConfigFile(configPath, Boolean(cli.configPath));
  const configDir = dirname(configPath);

  const targetValue =
    cli.target ?? fileConfig.target ?? joinTmpTargetPath(basename(resolvedRepoRoot));
  const target = resolveUserPath(targetValue, cli.target ? cwd : configDir);

  const remote = cli.remote ?? fileConfig.remote;
  const branch = cli.branch ?? fileConfig.branch ?? 'main';
  const brokenLinkPolicy = cliPolicy(fileConfig.brokenLinkPolicy);
  const sensitivePatterns = fileConfig.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS;

  validateRegexes(sensitivePatterns);

  return {
    repoRoot: resolvedRepoRoot,
    configPath,
    target,
    remote,
    branch,
    sensitivePatterns,
    brokenLinkPolicy,
    verbose: cli.verbose,
    quiet: cli.quiet,
  };
}

function cliPolicy(value: FileConfig['brokenLinkPolicy']): ResolvedConfig['brokenLinkPolicy'] {
  const policy = value ?? 'warn';
  if (!['warn', 'error', 'ignore'].includes(policy)) {
    throw new ConfigError('brokenLinkPolicy must be "warn", "error", or "ignore".');
  }
  return policy;
}

function resolveUserPath(value: string, baseDir: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function expandHome(value: string): string {
  if (value === '~') {
    return homedir();
  }

  if (value.startsWith('~/')) {
    return resolve(homedir(), value.slice(2));
  }

  return value;
}

function joinTmpTargetPath(repoName: string): string {
  return resolve(tmpdir(), `frontmatter-filter-${repoName}`);
}

async function loadConfigFile(configPath: string, explicit: boolean): Promise<FileConfig> {
  const exists = await fileExists(configPath);
  if (!exists) {
    if (explicit) {
      throw new ConfigError(`Config file not found: ${configPath}`);
    }
    return {};
  }

  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError('Config file must contain a JSON object.');
    }

    const config = parsed as Record<string, unknown>;
    assertOptionalString(config.target, 'target');
    assertOptionalString(config.remote, 'remote');
    assertOptionalString(config.branch, 'branch');
    assertOptionalStringArray(config.sensitivePatterns, 'sensitivePatterns');
    assertOptionalString(config.brokenLinkPolicy, 'brokenLinkPolicy');

    return config as FileConfig;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Failed to parse config file ${configPath}: ${message}`);
  }
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new ConfigError(`${field} must be a string.`);
  }
}

function assertOptionalStringArray(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(`${field} must be an array of strings.`);
  }
}

async function assertDirectoryExists(path: string, label: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new ConfigError(`${label} is not a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`${label} not found: ${path}`);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function validateRegexes(patterns: string[]): void {
  for (const pattern of patterns) {
    try {
      void new RegExp(pattern, 'i');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`Invalid sensitive pattern "${pattern}": ${message}`);
    }
  }
}
