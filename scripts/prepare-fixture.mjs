#!/usr/bin/env node
// Ensures the external vault fixture is present locally at the commit pinned
// in tests/fixtures/obsidian_test_vault.lock. Same logic used by the
// integration test helpers; kept as a standalone CLI so CI and local dev can
// invoke a single, obvious command.

import { execFile } from 'node:child_process';
import { readFile, rm, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Env overrides exist for test isolation (see tests/integration/local/
// fixture-fetch.test.ts). Production runs default to the repo-internal paths.
const CLONE_ROOT =
  process.env.FRONTMATTER_FILTER_FIXTURE_CLONE_ROOT ??
  resolve(PROJECT_ROOT, 'tests/fixtures/obsidian_test_vault');
const LOCK_PATH =
  process.env.FRONTMATTER_FILTER_FIXTURE_LOCK_PATH ??
  resolve(PROJECT_ROOT, 'tests/fixtures/obsidian_test_vault.lock');
const DEFAULT_REPO_URL = 'https://github.com/zhuyinheng/obsidian_test_vault.git';
const REPO_URL = process.env.FRONTMATTER_FILTER_FIXTURE_REPO_URL ?? DEFAULT_REPO_URL;

async function main() {
  const pin = await readPin();
  const existing = await readHeadOrUndefined(CLONE_ROOT);

  if (existing === pin) {
    console.log(`fixture already at pin ${pin}`);
    return;
  }

  if (existing) {
    console.log(`fixture at ${existing}, refreshing to ${pin}`);
  } else {
    console.log(`fixture missing, cloning at ${pin}`);
  }

  await rm(CLONE_ROOT, { recursive: true, force: true });
  await mkdir(CLONE_ROOT, { recursive: true });
  await execFileAsync('git', ['init', '--quiet'], { cwd: CLONE_ROOT });
  await execFileAsync('git', ['remote', 'add', 'origin', REPO_URL], { cwd: CLONE_ROOT });
  await execFileAsync('git', ['fetch', '--depth', '1', 'origin', pin], { cwd: CLONE_ROOT });
  await execFileAsync('git', ['-c', 'advice.detachedHead=false', 'checkout', pin], {
    cwd: CLONE_ROOT,
  });

  console.log(`fixture pinned at ${pin}`);
}

async function readPin() {
  try {
    const raw = await readFile(LOCK_PATH, 'utf8');
    const pin = raw.trim();
    if (!/^[0-9a-f]{40}$/i.test(pin)) {
      throw new Error(`Invalid pin in ${LOCK_PATH}: ${pin || '(empty)'}`);
    }
    return pin;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Lock file missing: ${LOCK_PATH}`);
    }
    throw error;
  }
}

async function readHeadOrUndefined(repoRoot) {
  try {
    await stat(repoRoot);
  } catch {
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
