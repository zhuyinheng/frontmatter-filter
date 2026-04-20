# frontmatter-filter

> A Node.js CLI tool that mirrors a subset of a markdown directory tree to another directory, filtered by frontmatter rules.

## What it does

Given a source directory full of markdown files (and their attachments), `frontmatter-filter` produces a mirror directory containing only the files that are marked `public: true` — either explicitly on the file, or inherited from a parent folder's `README.md`.

The mirror preserves the original directory structure. Files that aren't public are absent from the mirror; their parent directories remain only as path scaffolding when deeper files are public.

A typical use case: you keep all your writing — drafts, private notes, daily journals, published blog posts — in a single markdown directory, and you want a clean public subset you can feed to a static site generator without leaking anything private.

## Design philosophy

### Fail-closed by default

**Anything ambiguous is treated as private.** No frontmatter, missing `public` field, YAML parse error, unrecognized value, I/O error — all resolve to `public: false`.

The only way a file becomes public is an explicit, strict `public: true` (or inheritance from an ancestor that has it). Even values that look like "true" — `"true"`, `yes`, `1`, `on`, `True`, `TRUE` — do **not** count. Only the lowercase literal `true`.

This is the central safety property. Misconfiguration produces "didn't publish something I wanted to" (recoverable) rather than "leaked something private" (not recoverable).

### Decisions and paths are independent

Whether a file gets published is decided by the inheritance chain. *Where* it ends up in the mirror is determined by its original path — identical to the source, minus the source root prefix.

This means intermediate folders can have no README, no frontmatter, no configuration at all — they're just path segments. A file at `source/a/b/c/note.md` with `public: true` ends up at `mirror/a/b/c/note.md`, even if `a/`, `b/`, `c/` themselves have no metadata. This keeps the directory structure of the source free to evolve.

### Zero runtime dependencies

The shipped tool is a **single `.mjs` file**, built from TypeScript sources via esbuild. Users download it, put it somewhere, and run it with Node.js. No `npm install`, no `node_modules`, no package manager state in the user's project.

This is deliberate. The tool should be readable (open the file, scan a few hundred lines, understand what it does), auditable (no transitive dependency surface), and portable (drop it anywhere that has Node).

### Editor-agnostic

The tool treats markdown directories as markdown directories. It doesn't know or care whether you edit with Obsidian, VS Code, vim, or anything else. Editor-specific directories (`.obsidian`, `.trash`, `.vscode`, etc.) are handled by a single rule documented below — they aren't scanned because they're typically gitignored, not because the tool has a list of editor names.

## Source enumeration

The tool only considers files **tracked by git** in the source repository. Enumeration is `git ls-files` plus any staged additions (so newly-added files are seen when running as a pre-commit hook).

Consequences:
- The source must be inside a git repository. `--source` pointing to a non-git directory is a fatal error.
- Untracked files are never published, even if they contain `public: true` in their frontmatter. To publish a new file, `git add` it.
- Anything matched by `.gitignore` (`node_modules/`, `dist/`, `.obsidian/workspace.json`, editor swap files, OS junk) is automatically excluded. There is no `skipDirs` config — git already encodes "what's part of the repo".
- Removing a file from publication is a git operation: `git rm` it, or move it outside the tracked set.

This piggybacks on git's existing notion of "what belongs to the project" rather than re-inventing it.

## The publication rule

### File-level `public`

Every markdown file may have a YAML frontmatter block at the top:

```markdown
---
title: "My post"
public: true
date: 2025-01-15
---

# Body starts here
```

The `public` field has three states:

| Value                   | Interpretation          |
|-------------------------|-------------------------|
| `public: true`          | Explicitly public       |
| `public: false`         | Explicitly private      |
| Field absent            | Inherit from parent     |
| Anything else           | Treated as absent       |

"Anything else" includes `"true"`, `yes`, `1`, `True`, `TRUE`, unquoted strings, etc. Strict literal parsing keeps the meaning of `public` unambiguous.

### Folder-level `README.md`

A folder's `README.md` serves double duty:

1. Its frontmatter declares defaults for everything in that folder's subtree.
2. Its body, if the README itself is public, becomes a publishable page.

This convention piggybacks on two existing habits — GitHub automatically renders README.md for folder views, and markdown-based PKM tools often treat README as a folder note — so it imposes nothing new on users who already work this way.

```markdown
---
# research/README.md
title: "Research Notes"
description: "Paper reading & ideas"
public: true
---

# Research Notes

Introduction to my research area...
```

With this README in place, all markdown files inside `research/` (and its subfolders) default to `public: true`, unless they override themselves.

### Inheritance chain

For any markdown file, the effective `public` value is determined by walking up the tree. **The first explicit `true` or `false` wins**:

1. The file's own frontmatter.
2. Each directory from the file's own directory up to the source root, in order: that directory's `README.md` frontmatter.
3. If nothing above sets `public` explicitly: default `false`.

A README that exists but has no `public` field (or has `title`, `description`, but not `public`) doesn't terminate the walk — inheritance continues to the next ancestor.

This means you can freely put README files with descriptive frontmatter anywhere without accidentally changing visibility rules.

### Examples

**Example 1**: Whole tree of public blog posts.
```
source/
├── README.md              (public: false)   [root default]
└── blog/
    ├── README.md          (public: true)
    ├── post-1.md          [inherits true]
    ├── post-2.md          [inherits true]
    └── drafts/
        ├── README.md      (public: false)
        └── wip.md         [inherits false]
```
Published: `blog/README.md`, `blog/post-1.md`, `blog/post-2.md`.
Not published: everything in `drafts/`.

**Example 2**: Deep file with no configured ancestors.
```
source/
├── (no README.md)
└── inbox/
    └── fragments/
        └── 2024/
            └── random-thought.md    (public: true)
```
Published: `mirror/inbox/fragments/2024/random-thought.md`.
The intermediate folders have no metadata and aren't "published" themselves — they exist in the mirror only as the path leading to `random-thought.md`.

**Example 3**: Exception in a public folder.
```
source/
└── writing/
    ├── README.md          (public: true)
    ├── essay.md           [inherits true]
    └── not-ready.md       (public: false)   [overrides]
```
Published: `writing/README.md`, `writing/essay.md`.
`not-ready.md` is skipped despite being in a public folder.

**Example 4**: README exists but doesn't set public.
```
source/
├── README.md              (title: "My stuff", no public field)
└── notes/
    └── a.md               (public: true)
```
Root README has `title` but no `public` field — it doesn't terminate the walk.
Published: `mirror/notes/a.md`.
Root README itself and `notes/` folder don't get an explicit visibility from any ancestor → default false → not published.

## Attachments

Non-markdown files (images, PDFs, data files) are copied alongside the markdown files that reference them. The rule:

**A markdown file's siblings (non-md files in the same directory) are copied whenever the markdown file itself is published.**

This matches the common convention of keeping a file's attachments next to it.

Not handled in v1:
- Subfolder attachments (`<filename>/` adjacent to `<filename>.md`, used by some editors).
- Cross-directory references (e.g., a single `attachments/` folder at the root).

Users with these patterns should reorganize, or wait for a future version.

## Safety checks

Before writing the mirror, the tool performs two non-fatal and one fatal checks:

### Sensitive pattern scan (fatal)

A regex scan over the content of all to-be-published files looks for patterns like `api_key:`, `password =`, `secret:`, etc. Matches abort the publish with exit code 2 and list the offending files. The pattern list is configurable.

The scan runs over each file's **markdown body only** — frontmatter is stripped before scanning — so field names like `secret: false` or `token: …` in frontmatter don't trigger false positives on the default patterns.

This isn't a substitute for being careful. It's a last-line defense against copy-pasting credentials into notes.

### Broken links (warning)

Links in published files that point to non-published (or non-existent) markdown targets are reported. Both forms are checked:

- Wikilinks: `[[target]]` and `[[target|display text]]`
- Markdown links: `[text](target.md)` — relative paths to `.md` files. External URLs (`http://`, `https://`, `mailto:`) and non-`.md` targets are ignored.

Non-fatal by default; configurable to be fatal via `brokenLinkPolicy`.

### Frontmatter parse failures (warning, counts as private)

A file whose frontmatter is malformed gets a warning log and is treated as private (fail-closed).

## CLI

```
frontmatter-filter [options]

Options:
  --source <path>       Source directory (default: output of `git rev-parse --show-toplevel`).
                        Must be inside a git repository; fatal error otherwise.
  --target <path>       Target directory (default: reads from config, or ~/filtered)
  --config <path>       Config file path (default: <source>/.frontmatter-filter.json)
  --dry-run             List what would change; don't write. Output is one line per
                        affected path: `+ blog/post.md` (added/changed),
                        `- old-note.md` (removed), `= index.md` (unchanged).
  --commit              After mirroring, run `git commit --amend` and `git push --force-with-lease`
                        in the target directory (requires target to be a git repo)
  --no-commit           Disable commit for this run, even if config sets `commitOnPublish: true`
  --verbose, -v
  --quiet, -q
  --help, -h
  --version

Exit codes:
  0   success
  1   general error
  2   sensitive pattern detected (aborted before write)
  3   config error
  4   git operation failed
```

## Configuration file

A JSON file (default: `.frontmatter-filter.json` in source root) holds persistent options. CLI arguments override config values. Config values override built-in defaults.

```json
{
  "$schema": "https://raw.githubusercontent.com/.../frontmatter-filter.schema.json",
  "target": "~/my-public-mirror",
  "commitOnPublish": true,
  "sensitivePatterns": [
    "\\b(api[_-]?key|password|secret|token|bearer)\\s*[:=]"
  ],
  "brokenLinkPolicy": "warn"
}
```

**Field reference:**

| Field                | Default       | Meaning                                                       |
|----------------------|---------------|---------------------------------------------------------------|
| `target`             | `~/filtered`  | Mirror output directory                                       |
| `commitOnPublish`    | `false`       | After mirroring, commit and push target                       |
| `sensitivePatterns`  | See below     | Regex strings; matches abort with exit code 2                 |
| `brokenLinkPolicy`   | `"warn"`      | `"warn"` \| `"error"` \| `"ignore"`                           |

Default `sensitivePatterns`:

```json
["\\b(api[_-]?key|password|secret|token|bearer)\\s*[:=]"]
```

There is no `skipDirs` option — file discovery goes through `git ls-files`, so `.gitignore` already encodes what's excluded.

JSON is chosen over YAML because:
- JSON's type model matches the strict-boolean philosophy (YAML has too many bool-like values)
- Editor support (schema validation, formatting) is universal
- Node parses it natively, no dependencies
- One less format ambiguity vs. the frontmatter itself (which is YAML)

## Shallow history in the target

When `commitOnPublish: true`, each run:

1. Writes the mirror content to the target directory
2. Runs `git add -A`
3. If HEAD exists, runs `git commit --amend -m "snapshot: <ISO timestamp>"`
4. Else runs `git commit -m "snapshot: <ISO timestamp>"`
5. Runs `git push --force-with-lease`

Result: the target repo always has exactly one commit — the current state. No history accumulates. This is the only commit mode; there is no "accumulate history" variant.

**Why this matters**: the target is a *view* of the source, not a record in its own right. Preserving "the time I accidentally published draft X and fixed it 5 minutes later" in a public git history doesn't serve anyone. A clean snapshot is both tidier and safer (no dredging private content out of old commits).

**Safety net**: before force-pushing, the tool creates a local git tag `backup-<unix-timestamp>` on the old HEAD. If something goes wrong, the previous state is recoverable locally via `git reset --hard backup-<timestamp>`.

## Project architecture

### Repository layout

```
frontmatter-filter/              (this tool's source repo)
├── src/
│   ├── cli.ts                   entry: arg parsing, error handling, exit codes
│   ├── core.ts                  the filter + mirror + git logic (pure, testable)
│   ├── frontmatter.ts           strict YAML parser for the `public` field
│   ├── config.ts                config loading (file + CLI merge)
│   └── types.ts                 shared type definitions
├── tests/
│   ├── frontmatter.test.ts
│   ├── core.test.ts
│   └── fixtures/                sample source trees for testing
├── esbuild.config.mjs           bundles src/ into dist/frontmatter-filter.mjs
├── package.json                 devDependencies only (esbuild, typescript, vitest)
├── tsconfig.json
├── LICENSE
├── README.md                    user-facing docs
└── CHANGELOG.md
```

The shipped artifact is `dist/frontmatter-filter.mjs` — a single self-contained file with an executable shebang. It's attached to GitHub Releases. Users download it directly.

### Module boundaries

**`core.ts`** is pure logic:
- No `import 'obsidian'`, no editor-specific APIs
- No hardcoded paths, no `process.env` access, no CLI parsing
- All inputs through function parameters, all outputs through return values
- Callable from a test without any setup

**`frontmatter.ts`** is a minimal YAML parser. It handles only what's needed for the `public` field and common scalar frontmatter (`title: string`, `date: ISO8601`, etc.). It's strict by design — unparseable input returns `undefined` for `public`, not a best-guess.

A general-purpose YAML library isn't used because:
1. It would be the largest dependency by far
2. Real YAML's flexibility (tags, aliases, multiline strings, truthy aliases) is a liability for a security-critical field
3. The subset needed (top-level scalar key-value pairs, quoted/unquoted strings, booleans, ISO dates) is small enough to implement correctly in one hand-written file — targeting roughly 100–200 lines once quoted strings and escapes are handled

**`config.ts`** merges default config + file config + CLI overrides into a single resolved config object.

**`cli.ts`** is a thin shell: parse argv, call `core.publish(config)`, format result for humans, choose exit code.

### Build

`esbuild.config.mjs`:

```js
import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/frontmatter-filter.mjs',
  banner: {
    js: `#!/usr/bin/env node
// frontmatter-filter v${pkg.version}
// https://github.com/.../frontmatter-filter`
  },
  minify: false,
  treeShaking: true,
});
```

The product **is not minified**. It's expected to be read, audited, and occasionally modified by users. Readability matters more than bytes at this size.

### Release process

1. Development happens on `main`
2. Version bump: update `package.json`
3. `npm run build` produces `dist/frontmatter-filter.mjs`
4. Commit `dist/frontmatter-filter.mjs` (see "Distribution" for rationale)
5. Tag: `git tag v0.1.0 && git push --tags`
6. Create GitHub Release with `dist/frontmatter-filter.mjs` attached

> **Distribution approach TBD** — user wants a `curl | sh` installer that accepts source and target paths. The installer design (what it writes, where it pulls `publisher.mjs` from, idempotency) is a separate discussion. The section below under "First-time setup for this tool" describes the current manual flow; it will be replaced once the installer is designed.

## Integration: using `frontmatter-filter` in a source repository

Here is how to set up a markdown source repository (a "vault", knowledge base, personal site source, etc.) to use this tool.

### Directory layout

```
source-repo/
├── .githooks/
│   ├── pre-commit                       dispatcher
│   └── pre-commit.d/
│       └── publisher.mjs                the tool itself (committed to the repo)
├── .frontmatter-filter.json             config
├── README.md                            optional root config via `public` field
├── (your markdown files and folders)
```

Two design choices worth calling out:

**The tool lives in `.githooks/pre-commit.d/publisher.mjs`.**
This is unusual — most tools sit in a tools directory or on the user's PATH. Putting it here reflects a specific intent: this tool exists *in service of* the pre-commit hook. It's not a general-purpose utility the user invokes manually (though they can). Keeping the tool next to its trigger makes the dependency visible: delete `.githooks/` and the publishing behavior disappears cleanly, no orphan files elsewhere.

**The tool is committed to the source repo's git.**
Cloning the source repo to a new machine gives you everything needed: tool, hook dispatcher, config. The only manual step is `git config core.hooksPath .githooks` once per clone — a git configuration that (by design) isn't version-controlled. Tool updates produce a git commit, which is fine: it's meaningful history ("I upgraded the publisher on this date"). A few dozen KB per update is negligible.

### The hook dispatcher

`.githooks/pre-commit` is a shell script that **explicitly lists** the sub-tasks to run:

```sh
#!/bin/sh
# Pre-commit dispatcher.
# To add a hook: drop an executable in .githooks/pre-commit.d/
# and add a `run_hook` line below. Ordering matters: later hooks
# depend on earlier ones succeeding.

set -e

HOOK_DIR="$(git rev-parse --show-toplevel)/.githooks/pre-commit.d"

run_hook() {
  name=$1; shift
  script="$HOOK_DIR/$name"
  if [ ! -x "$script" ]; then
    echo "⚠️  skipping $name (not executable or missing)"
    return 0
  fi
  echo "→ $name"
  "$script" "$@"
}

# Execution order — add new hooks here.
run_hook publisher.mjs "$@"
```

**Why explicit list, not directory scan:**

Implicit discovery (run whatever's in the directory, sorted by name) has two failure modes: a test script left behind runs in production, or the ordering is controlled by a convention (`10-`, `50-`, `99-` prefixes) the user has to remember. Explicit listing makes the "what runs when" visible in one place — the dispatcher — and treats "add to execution sequence" as a deliberate action.

Adding a future hook is a two-step operation:
1. Drop the executable in `pre-commit.d/`
2. Add a `run_hook <filename>` line to the dispatcher

Temporarily disabling a hook: comment its `run_hook` line.

### The publisher.mjs trigger

`pre-commit.d/publisher.mjs` *is* the tool. It's executable, has a `#!/usr/bin/env node` shebang, and reads its config from `.frontmatter-filter.json` at the repo root (or from CLI args).

To behave correctly as a pre-commit hook, it should:
- Exit 0 when Node isn't available on the machine (don't block commits on a missing runtime)
- Exit non-zero (aborting commit) only on real failures or sensitive-pattern detections

The tool otherwise runs a **full publish every time** — no change-detection short-circuit. Analyzing whether staged files could affect the mirror (they might, via changed `README.md` inheritance or changed config) is more complex than the alternative: re-run the filter, let `git add -A` in the target produce no diff, and exit cleanly without a new commit when nothing changed. For a typical vault the full re-scan is sub-second; correctness beats cleverness.

### Configuration

`.frontmatter-filter.json` at the repo root:

```json
{
  "target": "~/my-public-mirror",
  "commitOnPublish": true
}
```

Minimum viable config: just `target`. Everything else uses defaults.

### First-time setup (new machine)

```sh
git clone <source-repo> vault
cd vault
git config core.hooksPath .githooks
```

Three commands. `core.hooksPath` setting is not version-controlled (git's design — for security; a repo can't silently enable hooks without user consent). After this, every `git commit` triggers the hook, which runs `publisher.mjs`, which mirrors the public subset to the target directory.

### First-time setup for this tool (adopting it in an existing repo)

```sh
# Download the tool into pre-commit.d/
mkdir -p .githooks/pre-commit.d
curl -Lo .githooks/pre-commit.d/publisher.mjs \
  https://github.com/.../releases/latest/download/frontmatter-filter.mjs
chmod +x .githooks/pre-commit.d/publisher.mjs

# Create the dispatcher (see above content)
cat > .githooks/pre-commit <<'EOF'
#!/bin/sh
# ... (dispatcher content above)
EOF
chmod +x .githooks/pre-commit

# Create config
cat > .frontmatter-filter.json <<'EOF'
{
  "target": "~/my-public-mirror",
  "commitOnPublish": true
}
EOF

# Enable hooks
git config core.hooksPath .githooks

# Commit these additions
git add .githooks/ .frontmatter-filter.json
git commit -m "Add frontmatter-filter"

# Initialize target (if it doesn't exist)
mkdir -p ~/my-public-mirror
cd ~/my-public-mirror
git init
git remote add origin <your-public-mirror-repo>
cd -

# Test run
node .githooks/pre-commit.d/publisher.mjs --dry-run
```

## Behaviors in edge cases

### Frontmatter recognition

A markdown file is considered to have frontmatter if its **first line** — after an optional UTF-8 BOM — is exactly `---`. The block ends at the next line containing only `---`. CRLF line endings are accepted (normalized internally). Anything else: no frontmatter, `public` unset, walk continues to ancestors.

### Malformed frontmatter

A file whose frontmatter block is present but unparseable (e.g., `public: tru`, stray tab indentation, unclosed quote) gets a parse warning in the log, and its `public` field is treated as undefined — the walk continues to parent configurations. If no ancestor sets `public`, the file is skipped (fail-closed).

### Target inside source

If the resolved `target` path is inside (or equal to) the `source` path, the tool aborts with exit code 3 before touching the filesystem. Otherwise the mirror would recursively mirror itself.

### Symlinks

A symlink tracked by git appears in `git ls-files` as a symlink entry (git stores the link target path, not the pointed-to content). The tool mirrors the symlink verbatim — link-for-link — into the target. It does not resolve and inline the pointed-to content.

Consequences:
- Symlink cycles within the source cannot cause enumeration loops, since `git ls-files` produces a flat list with no traversal.
- A symlink pointing outside the source tree is copied as-is; whether it resolves on the target machine is the user's responsibility.
- Untracked symlinks (created in the working tree but not `git add`-ed) are ignored, same as any other untracked file.

### Case-insensitive filesystems (macOS default, Windows)

The inheritance walk uses the OS's native path comparison. `README.md`, `Readme.md`, and `readme.md` may all match on macOS/Windows but not on Linux. The tool documents `README.md` as the canonical name and recommends sticking with it for cross-platform reliability.

### Large binary attachments

No special handling. If a PNG sits next to a published markdown file, it gets copied. For repos with GB-scale attachments, performance may suffer; future versions could add an attachment size limit or LFS-aware behavior.

### File moves

The target is fully rewritten each run (cleared except `.git/`, then repopulated). Move operations in the source naturally translate to a mirror where the file appears in the new location and not the old — git in the target shows the diff, `--amend` squashes it into the single commit.

### Runs with no changes

If the mirror content is identical to the target's current state, `git add -A` produces no diff, and the tool exits cleanly without creating a new commit.

## Failure modes to consider

**Force-push corruption**. If a force-push to the public mirror fails midway (network error between amend and push), the local target has the new amended commit but the remote has the old one. The `backup-<timestamp>` tag, and git's reflog, make recovery possible. The tool prints the tag name on success so the user has a recovery anchor.

**Partial mirror write**. If the tool crashes after deleting the old mirror content but before writing all new content, the target is in an inconsistent state. Mitigation: the tool writes to a sibling temp directory (`<target>.tmp-<pid>`) and swaps via `rename(2)` when done. If source and target live on different filesystems and `rename` returns `EXDEV`, the tool falls back to clear-then-write on the target and logs a warning — users wanting atomic replacement must keep temp and target on the same filesystem (trivially true for the default `~/filtered` layout).

**Sensitive pattern false positives**. A markdown file that legitimately discusses API design and contains the phrase "api_key:" in an example would match. The user can adjust `sensitivePatterns` in config, or use `SKIP_SENSITIVE=1 git commit` (environment-variable override; tool-specific convention).

**Broken wikilinks across publish/non-publish boundary**. Published file A links to unpublished file B (`[[B]]`). The default policy is to warn and publish anyway. The user sees a dead link in the public mirror. Stricter policy (`brokenLinkPolicy: "error"`) aborts the publish.

## What this tool does not do

- **Rewrite content**. Markdown bodies are copied verbatim. No wikilink resolution, no image path rewriting, no HTML generation.
- **Process images**. No resizing, no optimization, no WebP conversion.
- **Generate a site**. It produces a directory of markdown; a static site generator consumes that separately.
- **Manage secrets**. The sensitive-pattern scan is a backstop, not a secrets manager.
- **Handle complex attachment conventions**. Only same-directory attachments are copied.
- **Provide an Obsidian plugin UI**. It's a CLI tool; any editor integration is a separate project.

These non-goals keep the tool's surface small and its correctness provable.

## Future extensions

These are *possible* directions, not *planned* ones. Each would be added only if it proved necessary in real use:

- **CI mode**. Run as a GitHub Action, so users don't need Node locally. Trade-off: adds a non-immediate feedback loop.
- **Multiple targets**. One source, multiple mirrors with different rules (different audiences). Config gets a `profiles` structure.
- **Labels**. A second axis of filtering alongside `public`. E.g., `labels: [team-a]` and a target configured to match a label.
- **Cross-directory attachments**. Resolution of `[[image.png]]` references across the tree, not just same-directory.
- **Incremental mode**. Only re-mirror what changed, for performance on very large sources.
- **Schema validation**. Check that frontmatter conforms to a user-supplied JSON Schema during the filter pass.

Each of these expands the scope. The current design intentionally stays small.

## Summary

`frontmatter-filter` is a Node.js CLI tool. It reads a directory of markdown files, decides which ones should be "public" based on strict frontmatter rules with folder-level inheritance via `README.md`, and writes a mirror containing only the public subset. Optionally it commits and force-pushes the mirror as a single-commit shallow history.

The tool is a single `.mjs` file with no runtime dependencies. It's editor-agnostic. It fails closed on any ambiguity. It treats paths as scaffolding independent of the publication decision. It integrates into a git repository as a pre-commit hook using a standard dispatcher pattern.

It makes one hard assumption — that you have Node.js. In exchange, it stays small, debuggable, and free of ecosystem entanglements. Everything about its behavior is visible in the tool's own source and the ~20 lines of shell that invoke it.