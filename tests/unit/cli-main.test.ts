// This file monkey-patches global `console`. Safe while no sibling test file reads
// console output; if that changes, thread explicit writer streams through main().
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../../src/cli.ts';
import { commitAll, initRepo } from '../helpers/e2e.ts';

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  restore(): void;
}

function captureConsole(): CapturedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };
  return {
    stdout,
    stderr,
    restore() {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

async function initRepoWithCommit(repoRoot: string, contents: string): Promise<void> {
  await initRepo(repoRoot);
  await writeFile(join(repoRoot, 'note.md'), contents);
  await commitAll(repoRoot, 'init');
}

test('main exits 0 on --help', async () => {
  const output = captureConsole();
  try {
    assert.equal(await main(['--help']), 0);
  } finally {
    output.restore();
  }
});

test('main exits 0 on --version and prints a version string', async () => {
  const output = captureConsole();
  try {
    assert.equal(await main(['--version']), 0);
    assert.ok(output.stdout.some((line) => /\d+\.\d+\.\d+/.test(line)));
  } finally {
    output.restore();
  }
});

test('main exits 1 when no subcommand is given', async () => {
  const output = captureConsole();
  try {
    assert.equal(await main([]), 1);
    assert.ok(output.stderr.some((line) => /subcommand is required/i.test(line)));
  } finally {
    output.restore();
  }
});

test('main exits 3 (ConfigError) when --repo points at a non-existent path', async () => {
  const output = captureConsole();
  try {
    assert.equal(
      await main(['check', '--repo', join(tmpdir(), `frontmatter-filter-does-not-exist-${Date.now()}`)]),
      3,
    );
  } finally {
    output.restore();
  }
});

test('main exits 3 (ConfigError) when publish is run without --remote or configured remote', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-clitest-'));
  const output = captureConsole();
  try {
    await initRepoWithCommit(repoRoot, `---
public: true
---

hi`);
    assert.equal(await main(['publish', '--repo', repoRoot]), 3);
    assert.ok(output.stderr.some((line) => /publish requires --remote/i.test(line)));
  } finally {
    output.restore();
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('main exits 2 (SensitivePatternError) when default patterns detect a leaked credential', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-clitest-'));
  const output = captureConsole();
  try {
    await initRepoWithCommit(repoRoot, `---
public: true
---

api_key: leaked`);
    assert.equal(await main(['check', '--repo', repoRoot, '--quiet']), 2);
  } finally {
    output.restore();
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('main exits 5 (BrokenLinkPolicyError) when broken links are present and policy=error', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-clitest-'));
  const configPath = join(repoRoot, 'config.json');
  const output = captureConsole();
  try {
    await initRepoWithCommit(repoRoot, `---
public: true
---

[missing](./nope.md)`);
    await writeFile(configPath, `${JSON.stringify({ brokenLinkPolicy: 'error' })}\n`);
    assert.equal(await main(['check', '--repo', repoRoot, '--config', configPath, '--quiet']), 5);
  } finally {
    output.restore();
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('main exits 4 (GitPublishError) and reports preserved staging when publish push fails', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-clitest-'));
  const output = captureConsole();
  const stagingDir = join(tmpdir(), `frontmatter-filter-clitest-staging-${Date.now()}`);
  try {
    await initRepoWithCommit(repoRoot, `---
public: true
---

hi`);
    assert.equal(
      await main([
        'publish',
        '--repo',
        repoRoot,
        '--remote',
        join(tmpdir(), `does-not-exist-remote-${Date.now()}.git`),
        '--staging-dir',
        stagingDir,
        '--quiet',
      ]),
      4,
    );
    assert.ok(
      output.stderr.some((line) => line.includes('staging preserved at:')),
      `expected staging-preserved message, got: ${output.stderr.join(' | ')}`,
    );
  } finally {
    output.restore();
    await rm(repoRoot, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
  }
});
