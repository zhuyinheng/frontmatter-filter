declare const __VERSION__: string | undefined;

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveConfig, resolveRepoRoot } from './config.ts';
import { checkSourceCommit, mirrorSourceCommit, publishSourceCommit } from './core.ts';
import { parsePrePushUpdates, selectSourceCommitFromUpdates } from './git.ts';
import type { CliOptions, MirrorResult, PublishResult, ResolvedConfig } from './types.ts';
import {
  BrokenLinkPolicyError,
  ConfigError,
  GitPublishError,
  SensitivePatternError,
} from './types.ts';

const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.1.0';

export async function main(argv: string[]): Promise<number> {
  let cliOptions: CliOptions;
  try {
    cliOptions = parseArgs(argv);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (cliOptions.help) {
    printHelp();
    return 0;
  }

  if (cliOptions.version) {
    console.log(VERSION);
    return 0;
  }

  if (!cliOptions.command) {
    printError('A subcommand is required. Use --help for usage.');
    return 1;
  }

  try {
    const repoRoot = await resolveRepoRoot(cliOptions.repoPath);
    const config = await resolveConfig(cliOptions, process.cwd(), repoRoot);

    switch (cliOptions.command) {
      case 'check': {
        const source = await resolveSourceSelection(cliOptions);
        assertSyncSelection(source, cliOptions.command);
        const result = await checkSourceCommit(config, {
          sourceCommit: source.sourceCommit,
          sourceBranch: source.sourceBranch,
          toolVersion: VERSION,
        });
        renderCheckResult(config, result);
        return 0;
      }
      case 'mirror': {
        const source = await resolveSourceSelection(cliOptions);
        assertSyncSelection(source, cliOptions.command);
        const targetPath = resolveCliPath(cliOptions.target ?? config.target);
        const result = await mirrorSourceCommit(config, {
          sourceCommit: source.sourceCommit,
          sourceBranch: source.sourceBranch,
          targetPath,
          toolVersion: VERSION,
        });
        renderMirrorResult(config, result);
        return 0;
      }
      case 'publish': {
        const source = await resolveSourceSelection(cliOptions);
        assertSyncSelection(source, cliOptions.command);
        const remote = cliOptions.remote ?? config.remote;
        const branch = cliOptions.branch ?? config.branch;
        if (!remote) {
          throw new ConfigError('publish requires --remote or a configured remote.');
        }

        const result = await publishSourceCommit(config, {
          sourceCommit: source.sourceCommit,
          sourceBranch: source.sourceBranch,
          remote,
          branch,
          stagingDir: cliOptions.stagingDir ? resolveCliPath(cliOptions.stagingDir) : undefined,
          keepStaging: cliOptions.keepStaging,
          toolVersion: VERSION,
        });
        renderPublishResult(config, result);
        return 0;
      }
      case 'sync': {
        const source = await resolveSourceSelection(cliOptions);
        if (source.action === 'skip') {
          if (!config.quiet && source.reason) {
            console.log(`skip: ${source.reason}`);
          }
          return 0;
        }

        if (config.remote) {
          const result = await publishSourceCommit(config, {
            sourceCommit: source.sourceCommit,
            sourceBranch: source.sourceBranch,
            remote: config.remote,
            branch: config.branch,
            stagingDir: cliOptions.stagingDir ? resolveCliPath(cliOptions.stagingDir) : undefined,
            keepStaging: cliOptions.keepStaging,
            toolVersion: VERSION,
          });
          renderPublishResult(config, result);
          return 0;
        }

        const result = await mirrorSourceCommit(config, {
          sourceCommit: source.sourceCommit,
          sourceBranch: source.sourceBranch,
          targetPath: config.target,
          toolVersion: VERSION,
        });
        renderMirrorResult(config, result);
        return 0;
      }
      default:
        throw new Error(`Unsupported command: ${cliOptions.command satisfies never}`);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      printError(error.message);
      return 3;
    }

    if (error instanceof SensitivePatternError) {
      printError('Sensitive patterns detected; aborting publish.');
      for (const match of error.matches) {
        printError(`  ${match.path}: ${match.snippet} (${match.pattern})`);
      }
      return 2;
    }

    if (error instanceof GitPublishError) {
      printError(error.message);
      if (error.stagingDir) {
        printError(`staging preserved at: ${error.stagingDir}`);
      }
      return 4;
    }

    if (error instanceof BrokenLinkPolicyError) {
      printError(error.message);
      return 5;
    }

    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    keepStaging: false,
    verbose: false,
    quiet: false,
    help: false,
    version: false,
    hookArgs: [],
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];

    if (!options.command && isCommandName(arg)) {
      options.command = arg;
      index += 1;
      continue;
    }

    switch (arg) {
      case '--repo':
        options.repoPath = requireValue(argv, ++index, '--repo');
        break;
      case '--config':
        options.configPath = requireValue(argv, ++index, '--config');
        break;
      case '--target':
        options.target = requireValue(argv, ++index, '--target');
        break;
      case '--remote':
        options.remote = requireValue(argv, ++index, '--remote');
        break;
      case '--branch':
        options.branch = requireValue(argv, ++index, '--branch');
        break;
      case '--staging-dir':
        options.stagingDir = requireValue(argv, ++index, '--staging-dir');
        break;
      case '--source-commit':
        options.sourceCommit = requireValue(argv, ++index, '--source-commit');
        break;
      case '--keep-staging':
        options.keepStaging = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
        options.version = true;
        break;
      default:
        if (options.command === 'sync') {
          options.hookArgs.push(arg);
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }

    index += 1;
  }

  if (options.verbose && options.quiet) {
    throw new Error('--verbose and --quiet cannot be used together.');
  }

  if (options.command !== 'publish' && options.keepStaging) {
    throw new Error('--keep-staging is only valid with publish or sync.');
  }

  if (options.command !== 'publish' && options.command !== 'sync' && options.stagingDir) {
    throw new Error('--staging-dir is only valid with publish or sync.');
  }

  if (options.command === 'publish' && options.target) {
    throw new Error('publish does not accept --target; use --staging-dir.');
  }

  return options;
}

async function resolveSourceSelection(
  cliOptions: CliOptions,
): Promise<
  | { action: 'sync'; sourceCommit?: string; sourceBranch?: string }
  | { action: 'skip'; reason?: string }
> {
  if (cliOptions.sourceCommit) {
    return {
      action: 'sync',
      sourceCommit: cliOptions.sourceCommit,
    };
  }

  if (cliOptions.command === 'sync' && cliOptions.hookArgs.length > 0) {
    const stdin = await readStdIn();
    const updates = parsePrePushUpdates(stdin);
    return selectSourceCommitFromUpdates(updates);
  }

  return {
    action: 'sync',
    sourceCommit: 'HEAD',
  };
}

function assertSyncSelection(
  selection: Awaited<ReturnType<typeof resolveSourceSelection>>,
  command: Exclude<CliOptions['command'], undefined>,
): asserts selection is { action: 'sync'; sourceCommit: string; sourceBranch?: string } {
  if (selection.action !== 'sync' || !selection.sourceCommit) {
    throw new ConfigError(`${command} requires a source commit.`);
  }
}

function renderCheckResult(config: ResolvedConfig, result: Awaited<ReturnType<typeof checkSourceCommit>>): void {
  if (config.quiet) {
    return;
  }

  renderWarningsAndBrokenLinks(config, result.warnings, result.brokenLinks);
  console.log(`source commit: ${result.sourceCommit}`);
  console.log(
    `check ok: ${result.publishedMarkdown.length} markdown, ${result.copiedAttachments.length} attachments`,
  );

  if (config.verbose) {
    renderPathGroup('Published markdown', result.publishedMarkdown);
    renderPathGroup('Copied attachments', result.copiedAttachments);
  }
}

function renderMirrorResult(config: ResolvedConfig, result: MirrorResult): void {
  if (config.quiet) {
    return;
  }

  renderWarningsAndBrokenLinks(config, result.warnings, result.brokenLinks);

  if (result.didWrite) {
    console.log(
      `mirrored ${result.publishedMarkdown.length + result.copiedAttachments.length + 1} files to ${result.targetPath}`,
    );
  } else {
    console.log(`mirror is up to date at ${result.targetPath}`);
  }

  if (config.verbose) {
    renderDiff(result.diff);
    renderPathGroup('Published markdown', result.publishedMarkdown);
    renderPathGroup('Copied attachments', result.copiedAttachments);
  }
}

function renderPublishResult(config: ResolvedConfig, result: PublishResult): void {
  if (config.quiet) {
    return;
  }

  renderWarningsAndBrokenLinks(config, result.warnings, result.brokenLinks);
  console.log(
    `published source commit ${result.sourceCommit} to ${result.remote} (${result.branch})`,
  );

  if (result.didKeepStaging) {
    console.log(`staging kept at ${result.stagingDir}`);
  }

  if (config.verbose) {
    renderDiff(result.diff);
    renderPathGroup('Published markdown', result.publishedMarkdown);
    renderPathGroup('Copied attachments', result.copiedAttachments);
  }
}

function renderWarningsAndBrokenLinks(
  config: ResolvedConfig,
  warnings: string[],
  brokenLinks: ReadonlyArray<{ source: string; target: string; reason: string }>,
): void {
  for (const warning of warnings) {
    console.warn(`warn: ${warning}`);
  }

  if (config.brokenLinkPolicy === 'warn') {
    for (const brokenLink of brokenLinks) {
      console.warn(
        `warn: broken reference ${brokenLink.source} -> ${brokenLink.target} (${brokenLink.reason})`,
      );
    }
  }
}

function renderDiff(diff: MirrorResult['diff']): void {
  const totalChanges = diff.added.length + diff.changed.length + diff.deleted.length;
  if (totalChanges === 0) {
    console.log('diff: no changes');
    return;
  }

  console.log('diff:');
  renderPathGroup('  add', diff.added);
  renderPathGroup('  change', diff.changed);
  renderPathGroup('  delete', diff.deleted);
}

function renderPathGroup(label: string, paths: string[]): void {
  if (paths.length === 0) {
    return;
  }

  console.log(`${label}:`);
  for (const path of paths) {
    console.log(`  ${path}`);
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

async function readStdIn(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function isCommandName(value: string): value is NonNullable<CliOptions['command']> {
  return value === 'check' || value === 'mirror' || value === 'publish' || value === 'sync';
}

function printHelp(): void {
  console.log(`frontmatter-filter check
  [--repo <path>]
  [--config <path>]
  [--source-commit <oid>]
  [--verbose]
  [--quiet]

frontmatter-filter mirror
  [--repo <path>]
  [--config <path>]
  [--source-commit <oid>]
  [--target <path>]
  [--verbose]
  [--quiet]

frontmatter-filter publish
  [--repo <path>]
  [--config <path>]
  [--source-commit <oid>]
  [--remote <url>]
  [--branch <name>]
  [--staging-dir <path>]
  [--keep-staging]
  [--verbose]
  [--quiet]

frontmatter-filter sync
  [--repo <path>]
  [--config <path>]
  [--source-commit <oid>]
  [--staging-dir <path>]
  [--keep-staging]
  [--verbose]
  [--quiet]

frontmatter-filter --help
frontmatter-filter --version`);
}

function printError(message: string): void {
  console.error(`error: ${message}`);
}

const entryHref =
  typeof process.argv[1] === 'string' && process.argv[1].length > 0
    ? pathToFileURL(process.argv[1]).href
    : '';
if (entryHref === import.meta.url) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}
