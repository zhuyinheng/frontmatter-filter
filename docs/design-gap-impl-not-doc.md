# Code behaviors not declared in design doc (v3 audit)

Scope: observable behaviors implemented in `src/` that `docs/design_doc_v3.md`
does NOT describe. These are implicit contracts — real users and tests depend
on them, but the design doc does not pin them.

Severity scale:

- **High**: behavior is a fail-closed or safety guarantee that deserves a spec
- **Medium**: behavior is surprising or cross-platform-sensitive
- **Low**: convenience/formatting detail, not a contract

---

## High

### H1. `SKIP_SENSITIVE=1` env var bypass

- Code: `src/core.ts` `buildPublishPlan`
  - `sensitiveMatches = process.env.SKIP_SENSITIVE === '1' ? [] : scanSensitivePatterns(...)`
- Unit test: `tests/unit/core.test.ts` asserts this contract.
- Doc: no mention.

This is an explicit *fail-open* switch on a fail-closed scanner. Users can
disable sensitive scanning from the environment. Without documentation, a
reviewer cannot tell if this is intentional or a leftover debug knob.

Recommendation: document explicitly in §10, name the use case (CI bootstrap,
recovery after false positive), and consider whether it should also be
opt-in per config file instead of env-only.

### H2. Cross-platform case sensitivity via `normalizeLookupKey`

- Code: `src/core.ts`
  - `normalizeLookupKey` lowercases on `darwin` and `win32`, preserves case on
    Linux.
- Doc: no mention.

Every path lookup (visibility cache, README inheritance, file resolution,
broken-link dedup, diff keys) is affected. Same vault produces different
filter decisions on Linux vs macOS runners.

Recommendation: either pick one policy and document it, or make it explicit
config. The status quo is the worst of both worlds: determinism depends on OS.

### H3. Wikilink extension inference (`.md` auto-append)

- Code: `src/core.ts` `buildReferenceCandidates`
  - For every candidate with `extname(candidate) === ''`, code also tries
    `${candidate}.md`.
- Doc: §8 enumerates supported syntaxes but doesn't state the extension rule.

This is the Obsidian convention: `[[Home]]` resolves to `Home.md`. Users
depend on it. If it ever regresses, the entire vault publish would break.

Recommendation: add to §8 as an explicit rule: "wikilink / embed / link
targets without an extension are resolved with an appended `.md` as well as
the bare form."

---

## Medium

### M1. URL-decoding of link/image targets

- Code: `src/core.ts` `prepareReferenceTarget` → `safelyDecode(target)` using
  `decodeURI`.
- Doc: no mention.

This is what makes `[child](./My%20Notes.md)` resolve to `./My Notes.md`. The
behavior is tested (`core.test.ts` "URL-encoded markdown link resolves to a
filename with spaces"). Without doc, users copy/pasting links from browsers
could rely on this silently.

Recommendation: document in §8.

### M2. Angle-bracket link target stripping

- Code: `src/core.ts` `prepareReferenceTarget` → `trimAngleBrackets`.
- Doc: no mention.

CommonMark `[x](<path with spaces>)` style. Tested. Should be documented as
part of the reference syntax matrix in §8.

### M3. Heading-fragment and alias stripping differs by syntax

- Code: `src/core.ts`
  - Standard links: `stripQueryAndHash` drops `#` and `?` tails.
  - Wikilinks: `stripHeadingFragment` drops the earlier of `#` / `|` (the alias
    pipe).
- Doc: no mention.

Two different strip rules for different syntaxes. Without docs, a reader has
to look at the code to know that `[[foo#heading|alias]]` resolves to `foo`.

Recommendation: add explicit bullets to §8 for each syntax.

### M4. Broken-link deduplication by source→target pair

- Code: `src/core.ts` `addBrokenLink` keys broken links by
  `${source}->${target}`.
- Doc: no mention.

If the same note references the same missing target in ten places, only one
broken-link entry is emitted. This is reasonable but load-bearing for the
manifest warning shape.

Recommendation: mention in §10.

### M5. Mirror re-run always rewrites `.frontmatter-filter-meta.json` even when source-commit is unchanged

- Code: `src/core.ts` `buildPublishPlan` rebuilds metadata with a fresh
  `publishedAt` timestamp each call. `diffMirror` detects the byte change on
  the metadata file and lists it in `diff.changed`.
- Unit test: `tests/unit/core.test.ts` asserts exactly this behavior.
- Doc: §12 defines metadata shape but doesn't say re-runs always bump
  `publishedAt`.

This leaks into any caller that compares two runs (e.g. a retry loop or a
downstream sync integrity check). A consumer expecting "no change, no
metadata write" would be surprised.

Recommendation: either specify "metadata is always rewritten" in §12, or
make the `publishedAt` refresh conditional on an actual change to the
published set.

### M6. Sensitive scan emits one match per regex per file, not per occurrence

- Code: `src/core.ts` `scanSensitivePatterns` uses `regex.exec` once per regex
  per file (with `regex.lastIndex = 0`).
- Doc: §10 says "命中则抛出错误并中止" without saying how many matches are
  reported.

Means the error surface can understate how widespread a leak is. Acceptable
for a fail-closed scanner (one is enough), but should be noted.

### M7. Install.sh preflight creates and pushes a "preflight\n" README.md file

- Code: `install.sh` `run_remote_preflight` initializes a fresh temp repo,
  writes `preflight\n` to `README.md`, commits, and runs `git push --dry-run
  --force`.
- Doc: §13 says only "临时仓库上的 `git push --dry-run --force`".

The dry-run guarantees nothing gets written remotely. But the design doc
should spell out that preflight requires a ref that can accept a dry-run
update — e.g. the remote must not reject the ref name outright.

---

## Low

### L1. Stable output ordering via `localeCompare`

All output arrays — `publishedMarkdown`, `copiedAttachments`, `brokenLinks`,
`sensitiveMatches`, diff lists — are sorted with `localeCompare`. Doc does
not say outputs are sorted. Tests depend on it.

Recommendation: document "output lists are locale-compared alphabetically"
once in §11 or §12.

### L2. `git ls-tree -rz --full-tree` input format constraints

`core.ts` `collectSourceTree` consumes a specific git ls-tree format. Entries
that are not `blob` produce a `Skipping unsupported git entry:` warning
(e.g. submodule gitlink mode 160000). Doc's §9 calls out only symlinks.

### L3. `.git` preservation across target rewrites

- Code: `writeMirror` preserves `.git/` inside the target root across writes.
- Unit test: asserts exact `.git/HEAD` / object preservation.
- Doc: §11.1 says "清空 target 下除 .git 外的内容" — close but not clearly
  calling out that the preservation is deep (full subtree, not just top-level
  entries).

### L4. CLI error prefix format (`error: ...`)

Doc does not specify CLI stderr format. Consumers scripting around it rely
on the `error: ` prefix. Not a gap in behavior, but a presentation contract.

### L5. `sync` command swallows `--staging-dir` and `--keep-staging` when
degrading to mirror

Code: when `sync` runs without a configured remote, it falls back to a
`mirror`-equivalent call. `--staging-dir` / `--keep-staging` are silently
ignored in that path rather than being errors.

Doc §4 lists these flags for sync; doc does not say they may be ignored.

### L6. Hidden directories under the target (not named `.git`) are rewritten

Only `.git` is treated as a sacred top-level entry. Any other dotfile or
dot-directory — `.obsidian/`, `.vscode/` — is wiped during writeMirror. For
a filter whose source is an Obsidian vault, this matters because
`.obsidian/` would otherwise be rewritten each sync.

Recommendation: explicitly list exceptions, or generalize to "any
top-level `.git` directory" in §11.1.

---

## Summary severity rollup

- High: 3 (sensitive-scan bypass env, cross-OS case sensitivity, `.md` inference)
- Medium: 7
- Low: 6

The three High items are each worth a small change in the design doc or in
code. H2 in particular is worth a code-side decision, not just documentation,
because the platform-dependent behavior makes CI vs local dev diverge.
