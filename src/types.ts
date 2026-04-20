export type CommandName = 'check' | 'mirror' | 'publish' | 'sync';
export type BrokenLinkPolicy = 'warn' | 'error' | 'ignore';

export interface CliOptions {
  command?: CommandName;
  repoPath?: string;
  configPath?: string;
  target?: string;
  remote?: string;
  branch?: string;
  stagingDir?: string;
  keepStaging: boolean;
  sourceCommit?: string;
  verbose: boolean;
  quiet: boolean;
  help: boolean;
  version: boolean;
  hookArgs: string[];
}

export interface FileConfig {
  target?: string;
  remote?: string;
  branch?: string;
  sensitivePatterns?: string[];
  brokenLinkPolicy?: BrokenLinkPolicy;
}

export interface ResolvedConfig {
  repoRoot: string;
  configPath: string;
  target: string;
  remote?: string;
  branch: string;
  sensitivePatterns: string[];
  brokenLinkPolicy: BrokenLinkPolicy;
  verbose: boolean;
  quiet: boolean;
}

export interface FrontmatterParseResult {
  hasFrontmatter: boolean;
  publicValue?: boolean;
  warnings: string[];
}

export interface BrokenLink {
  source: string;
  target: string;
  reason: 'missing' | 'not-public';
}

export interface SensitiveMatch {
  path: string;
  pattern: string;
  snippet: string;
}

export interface MirrorDiff {
  added: string[];
  changed: string[];
  deleted: string[];
}

export interface SyncMetadata {
  sourceCommit: string;
  sourceBranch?: string;
  publishedAt: string;
  toolVersion: string;
}

export interface CheckResult {
  sourceCommit: string;
  sourceBranch?: string;
  publishedMarkdown: string[];
  copiedAttachments: string[];
  warnings: string[];
  brokenLinks: BrokenLink[];
  sensitiveMatches: SensitiveMatch[];
  metadata: SyncMetadata;
}

export interface MirrorResult extends CheckResult {
  targetPath: string;
  diff: MirrorDiff;
  didWrite: boolean;
}

export interface PublishResult extends MirrorResult {
  remote: string;
  branch: string;
  stagingDir: string;
  didKeepStaging: boolean;
}

export interface HookPushUpdate {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
}

export interface SourceCommitSelection {
  action: 'sync' | 'skip';
  sourceCommit?: string;
  sourceBranch?: string;
  reason?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class SensitivePatternError extends Error {
  readonly matches: SensitiveMatch[];

  constructor(matches: SensitiveMatch[]) {
    super('Sensitive patterns detected.');
    this.name = 'SensitivePatternError';
    this.matches = matches;
  }
}

export class GitPublishError extends Error {
  readonly stagingDir?: string;

  constructor(
    message: string,
    stagingDir?: string,
  ) {
    super(message);
    this.name = 'GitPublishError';
    this.stagingDir = stagingDir;
  }
}

export class BrokenLinkPolicyError extends Error {
  readonly brokenLinks: BrokenLink[];

  constructor(brokenLinks: BrokenLink[]) {
    const body = brokenLinks
      .map((link) => `  ${link.source} -> ${link.target} (${link.reason})`)
      .join('\n');
    super(`Broken references detected:\n${body}`);
    this.name = 'BrokenLinkPolicyError';
    this.brokenLinks = brokenLinks;
  }
}
