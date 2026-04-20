# frontmatter-filter

`frontmatter-filter` is a Node.js CLI that publishes the public subset of a markdown repo.

It reads a committed source snapshot, evaluates `public` frontmatter with `README.md` inheritance, copies only files actually referenced by public markdown, and can mirror locally or force-push a public snapshot repo.

## Install

The runtime lives inside the target repo:

- `.githooks/frontmatter-filter/frontmatter-filter.mjs`
- `.githooks/frontmatter-filter/.frontmatter-filter.json`
- `.githooks/pre-push`

From a built checkout of this repo:

```sh
./install.sh --repo /path/to/your/repo
```

With a public mirror remote:

```sh
./install.sh --repo /path/to/your/repo \
  --remote git@github.com:<user>/<public-repo>.git
```

If you run `install.sh` outside this checkout, pass a binary URL:

```sh
./install.sh --repo /path/to/your/repo \
  --bin-url https://<host>/frontmatter-filter.mjs
```

Remote one-shot install via `curl | sh` (reuses `--bin-url` via env):

```sh
curl -fsSL https://<host>/install.sh \
  | FRONTMATTER_FILTER_BIN_URL=https://<host>/frontmatter-filter.mjs \
    sh -s -- --repo /path/to/your/repo
```

`FRONTMATTER_FILTER_BIN_URL` and any `install.sh` flags (`--repo`, `--remote`, `--branch`, `--target`) can be combined. The script itself has no special mode for pipe installs — the existing `--bin-url` mechanism is reused, so the only requirement is that the URL serves the built `frontmatter-filter.mjs`.

After install, commit `.githooks/` into the repository. New clones still need:

```sh
git config core.hooksPath .githooks
```

## Config

Default config path:

```text
.githooks/frontmatter-filter/.frontmatter-filter.json
```

Example:

```json
{
  "target": "/tmp/frontmatter-filter-myrepo",
  "remote": "git@github.com:user/public-repo.git",
  "branch": "main",
  "sensitivePatterns": [
    "\\b(api[_-]?key|password|secret|token|bearer)\\s*[:=]"
  ],
  "brokenLinkPolicy": "warn"
}
```

## Commands

```sh
frontmatter-filter check [--repo <path>] [--config <path>] [--source-commit <oid>]
frontmatter-filter mirror [--repo <path>] [--config <path>] [--source-commit <oid>] [--target <path>]
frontmatter-filter publish [--repo <path>] [--config <path>] [--source-commit <oid>] [--remote <url>] [--branch <name>] [--staging-dir <path>] [--keep-staging]
frontmatter-filter sync [--repo <path>] [--config <path>] [--source-commit <oid>]
```

`sync` is the hook entrypoint. In `pre-push`, it resolves the pushed branch update to a single source commit, runs checks, then mirrors locally or publishes remotely.

## Development

```sh
npm install
npm run prepare-fixture      # optional; integration tests auto-run this
npm run test:unit
npm run test:integration:local
npm test
./node_modules/.bin/tsc --noEmit
```

The local integration fixture is an external repo, `zhuyinheng/obsidian_test_vault`, pinned by `tests/fixtures/obsidian_test_vault.lock`. `npm run prepare-fixture` (or any integration test helper that calls `fetchFixtureRepo`) clones it over HTTPS into `tests/fixtures/obsidian_test_vault/` at the pinned commit. The directory is gitignored. If the pin changes, the next run wipes and re-checks out automatically. Expected output is defined in `tests/fixtures/obsidian_test_vault.manifest.json`.

The test matrix is documented in [TESTING.md](TESTING.md).

## Local CI With `act`

The repo includes:

- `.github/workflows/ci.yml`
- `.github/workflows/live-publish-smoke.yml`
- `.github/workflows/e2e-live.yml`
- `.actrc`

Run the full GitHub Actions workflow locally with Docker via `act`:

```sh
npm run ci:act
```
