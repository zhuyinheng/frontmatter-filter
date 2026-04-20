import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { resolveConfig } from '../../src/config.ts';
import type { CliOptions } from '../../src/types.ts';
import { ConfigError } from '../../src/types.ts';

test('resolveConfig uses repo-relative defaults when config is missing', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-config-'));

  try {
    const cli = makeCliOptions();
    const config = await resolveConfig(cli, repoRoot, repoRoot);

    assert.equal(
      config.configPath,
      join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json'),
    );
    assert.equal(config.target, join(tmpdir(), `frontmatter-filter-${basename(repoRoot)}`));
    assert.equal(config.remote, undefined);
    assert.equal(config.branch, 'main');
    assert.deepEqual(config.sensitivePatterns, ['\\b(api[_-]?key|password|secret|token|bearer)\\s*[:=]']);
    assert.equal(config.brokenLinkPolicy, 'warn');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('resolveConfig applies config file values and CLI overrides', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-config-'));

  try {
    const configPath = join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json');
    await mkdir(join(repoRoot, '.githooks', 'frontmatter-filter'), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          target: './from-config',
          remote: 'ssh://config-remote',
          branch: 'config-branch',
          sensitivePatterns: ['safe'],
          brokenLinkPolicy: 'error',
        },
        null,
        2,
      )}\n`,
    );

    const cli = makeCliOptions({
      target: './from-cli',
      remote: 'ssh://cli-remote',
      branch: 'cli-branch',
    });
    const config = await resolveConfig(cli, repoRoot, repoRoot);

    assert.equal(config.target, join(repoRoot, 'from-cli'));
    assert.equal(config.remote, 'ssh://cli-remote');
    assert.equal(config.branch, 'cli-branch');
    assert.deepEqual(config.sensitivePatterns, ['safe']);
    assert.equal(config.brokenLinkPolicy, 'error');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('resolveConfig rejects invalid sensitive regexes', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'frontmatter-filter-config-'));

  try {
    const configPath = join(repoRoot, '.githooks', 'frontmatter-filter', '.frontmatter-filter.json');
    await mkdir(join(repoRoot, '.githooks', 'frontmatter-filter'), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          sensitivePatterns: ['[unterminated'],
        },
        null,
        2,
      )}\n`,
    );

    await assert.rejects(
      () => resolveConfig(makeCliOptions(), repoRoot, repoRoot),
      ConfigError,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

function makeCliOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    keepStaging: false,
    verbose: false,
    quiet: false,
    help: false,
    version: false,
    hookArgs: [],
    ...overrides,
  };
}
