# Design doc claims not backed by code (v3 audit)

Scope: behaviors asserted in `docs/design_doc_v3.md` that the current source in
`src/` does NOT implement, or implements differently. Each finding lists the
doc section, the code reference, and a severity.

Severity scale:

- **High**: user-observable promise broken or fail-closed guarantee missing
- **Medium**: subtle behavioral mismatch that a test or user could trip on
- **Low**: wording imprecision, not a functional gap

Overall, very few gaps exist. The design doc is tight against code. Most findings
below are Low/Medium.

---

## 1. Low — "外部 URL 会被忽略" is only honored for standard links/images, not wikilinks/embeds

- Doc: §8 "外部 URL 会被忽略"
- Code: `src/core.ts` `prepareReferenceTarget` → `isIgnoredUrl` is only consulted
  for `link | image | linkReference | imageReference`. Wikilink/embed targets go
  straight to path resolution.

In practice a wikilink target like `[[https://example.com]]` will not resolve to
any file and becomes a broken reference (reason `missing`). So the outcome
matches the spirit of the spec — nothing is exfiltrated — but the code path is
different and the warning/broken-link classification differs from the docs'
claim.

Severity: **Low**. No data leak, but the wording "会被忽略" (will be ignored)
implies the reference is silently dropped rather than classified as broken.

Fix options:

- Update doc to say the URL filter applies only to standard link/image syntaxes.
- Or extend `isIgnoredUrl` to wikilink/embed so they are truly ignored (no
  broken-link entry).

---

## 2. Low — Publish staging cleanup on pre-write errors isn't specified

- Doc: §11.2 "默认 staging ... 成功后删除" and "失败时保留并通过错误信息返回路径"
- Code: `src/core.ts` `publishSourceCommit` catch block distinguishes three pre-write
  error classes (`ConfigError | SensitivePatternError | BrokenLinkPolicyError`)
  and, when the staging dir was auto-created, calls `rmdir(stagingDir)` to clean
  up. `GitPublishError` alone is kept on disk.

The doc says failure → keep staging. Code actually keeps the dir only for
git-level failures (where writes already happened); for pre-write errors it
deletes the empty temp dir. This is arguably more correct than the doc — the
empty dir carries no debug value — but the doc promises keeping it.

Severity: **Low**. No user-visible confusion because these errors never touch
the staging dir anyway.

Fix options:

- Clarify §11.2 to distinguish "pre-write errors" vs "git-publish errors".
- Or keep the dir for all failure classes, at the cost of leaving empty temp
  dirs behind.

---

## 3. Medium — Install guard checks only `core.hooksPath` and `.githooks/pre-push`, not other existing hooks

- Doc: §2 "如果检测到 ... 现有 `.githooks/pre-push` 不是本工具管理 则直接中断，要求手动接入"
- Code: `install.sh` checks `core.hooksPath != .githooks` and
  `.githooks/pre-push` not having the managed marker. It does not check for the
  existence of any other hook files under `.githooks/` that the user may have
  authored (e.g. `pre-commit`, `commit-msg`).

The doc implies "this install is safe because it will fail on anything unowned."
In practice setting `core.hooksPath=.githooks` can silently route a user's
other hooks through the frontmatter-filter-installed directory, overriding
whatever they had before.

Severity: **Medium**. Not a data-safety issue (frontmatter-filter does not
overwrite them), but a UX surprise: arbitrary `.githooks/*` files will start
running once `core.hooksPath` is pointed at the directory.

Fix options:

- Extend install.sh to warn or refuse if `.githooks/` already contains
  non-managed hook files.
- Or document the narrower guarantee: "install.sh ensures `pre-push` is
  managed; it does not audit other hooks."

---

## 4. Low — "按 `public` frontmatter 和 `README.md` 继承规则决定哪些 Markdown 可发布" does not mention case-sensitive README detection

- Doc: §7 treats `README.md` as a literal filename.
- Code: `src/core.ts` uses `normalizeLookupKey` for README detection. On
  Linux, the lookup key is case-sensitive; on macOS/Windows, it's lowercased.
  That means `readme.md` / `Readme.md` variants can also carry the visibility
  value on macOS/Windows but won't on Linux.

Severity: **Low**. Minor cross-platform divergence; a real user committing
`readme.md` on Linux and running the CLI in CI (Linux) would see different
behavior than running locally on macOS.

Fix options:

- Always normalize README lookups case-insensitively regardless of platform
  (recommended for determinism).
- Or explicitly document the platform-dependent behavior.

---

## 5. Low — The design doc does not mention any exit-code contract

- Doc: §4 CLI design lists flags but is silent on exit codes.
- Code: `src/cli.ts` maps errors to distinct codes: 0 success, 1 generic, 2
  sensitive patterns, 3 config, 4 GitPublishError, 5 BrokenLinkPolicyError.

Severity: **Low**. Not a gap the CLI breaks — but any hook or CI wrapper
relying on these codes has only the source to consult.

Fix options:

- Add a short exit-code table to design doc §4 or §10.

---

## Absences the doc promises that are actually present in code

The following §N claims were verified to be fully implemented and are called out
here only so future drift can be caught quickly:

| Doc §  | Claim                                                                | Code reference                              |
| ------ | -------------------------------------------------------------------- | ------------------------------------------- |
| §3     | single-branch update only; tag-only/delete-only skip; multi-branch fails | `git.ts` `selectSourceCommitFromUpdates` |
| §6     | input reads committed tree only, never index/worktree                 | `git.ts` `listCommitTree` / `readCommitFile` |
| §7     | explicit child `public` wins over ancestor README                      | `core.ts` `resolveEffectiveVisibility`      |
| §7     | YAML parse failure yields a warning, not an error                      | `frontmatter.ts`                            |
| §8     | wikilink/embed basename fallback only if candidate is unique           | `core.ts` `resolveReferenceTarget`          |
| §9     | tracked symlinks (mode 120000) skipped with warning                    | `core.ts` `collectSourceTree`               |
| §10    | broken reasons limited to `missing` and `not-public`                   | `core.ts` `collectReferencedFiles`          |
| §10    | sensitive scan runs after the publish set is finalized                 | `core.ts` `buildPublishPlan`                |
| §10    | metadata and binary-looking files are skipped by sensitive scan        | `core.ts` `scanSensitivePatterns`           |
| §11.1  | mirror clears target contents except `.git`                            | `core.ts` `writeMirror`                     |
| §11.2  | publish recreates git in staging, force-pushes, cleans auto-staging   | `core.ts` `publishSourceCommit`             |
| §12    | metadata schema (`sourceCommit/sourceBranch/publishedAt/toolVersion`) | `core.ts` `buildPublishPlan`                |
| §13    | install.sh order: bin → pre-push → local check → preflight → config → hooksPath | `install.sh` bottom                 |
