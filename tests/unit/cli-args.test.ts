import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../../src/cli.ts';

test('parseArgs collects simple subcommand and common flags', () => {
  const options = parseArgs(['check', '--repo', '/tmp/x', '--source-commit', 'abc', '--verbose']);
  assert.equal(options.command, 'check');
  assert.equal(options.repoPath, '/tmp/x');
  assert.equal(options.sourceCommit, 'abc');
  assert.equal(options.verbose, true);
  assert.equal(options.quiet, false);
});

test('parseArgs throws when a flag is missing its value', () => {
  assert.throws(() => parseArgs(['check', '--repo']), /--repo requires a value/);
  assert.throws(() => parseArgs(['check', '--target', '--verbose']), /--target requires a value/);
});

test('parseArgs rejects --verbose and --quiet together', () => {
  assert.throws(
    () => parseArgs(['check', '--verbose', '--quiet']),
    /--verbose and --quiet cannot be used together/,
  );
});

test('parseArgs rejects --keep-staging on non-publish/sync commands', () => {
  assert.throws(
    () => parseArgs(['check', '--keep-staging']),
    /--keep-staging is only valid with publish or sync/,
  );
  assert.throws(
    () => parseArgs(['mirror', '--keep-staging']),
    /--keep-staging is only valid with publish or sync/,
  );
});

test('parseArgs rejects --staging-dir on non-publish/sync commands', () => {
  assert.throws(
    () => parseArgs(['check', '--staging-dir', '/tmp/s']),
    /--staging-dir is only valid with publish or sync/,
  );
  assert.throws(
    () => parseArgs(['mirror', '--staging-dir', '/tmp/s']),
    /--staging-dir is only valid with publish or sync/,
  );
});

test('parseArgs rejects --target on publish', () => {
  assert.throws(
    () => parseArgs(['publish', '--target', '/tmp/p']),
    /publish does not accept --target/,
  );
});

test('parseArgs accepts publish with --staging-dir + --keep-staging', () => {
  const options = parseArgs([
    'publish',
    '--remote',
    'ssh://example',
    '--staging-dir',
    '/tmp/s',
    '--keep-staging',
  ]);
  assert.equal(options.command, 'publish');
  assert.equal(options.remote, 'ssh://example');
  assert.equal(options.stagingDir, '/tmp/s');
  assert.equal(options.keepStaging, true);
});

test('parseArgs rejects unknown flags on non-sync commands', () => {
  assert.throws(() => parseArgs(['check', '--bogus']), /Unknown argument: --bogus/);
});

test('parseArgs forwards unknown arguments to hookArgs for sync', () => {
  const options = parseArgs(['sync', 'origin', 'ssh://remote']);
  assert.equal(options.command, 'sync');
  assert.deepEqual(options.hookArgs, ['origin', 'ssh://remote']);
});

test('parseArgs recognizes --help and --version without a subcommand', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--version']).version, true);
});

test('parseArgs does not accept a double-dash prefixed value as a flag value', () => {
  assert.throws(
    () => parseArgs(['check', '--repo', '--verbose']),
    /--repo requires a value/,
  );
});
