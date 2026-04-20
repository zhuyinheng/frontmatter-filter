# Testing

## Layers

The test matrix is split into four layers:

- `unit`
  - fast semantic tests for frontmatter parsing, pre-push input parsing, config resolution, and direct publish/mirror helpers
- `integration-local`
  - full local user-flow tests with the built `dist/frontmatter-filter.mjs`, real `install.sh`, real Git hooks, and real `git push`
  - remotes are local bare repositories, so no external authentication is required
- `live-publish-smoke`
  - GitHub-backed publish smoke against `zhuyinheng/frontmatter-filter-live`
  - source remains local; only the public publish target is live
  - uses the `E2E_LIVE_SSH_KEY` secret
- `e2e-live`
  - full source-to-public GitHub path
  - source push goes to `zhuyinheng/obsidian_test_vault` on a dedicated smoke branch
  - publish goes to `zhuyinheng/frontmatter-filter-live`
  - uses `E2E_SOURCE_LIVE_SSH_KEY` and `E2E_LIVE_SSH_KEY`

## Success Criteria

### Unit

Success means:

- all unit tests pass
- parser, config, pre-push update parsing, and direct mirror/publish helpers stay deterministic

### Integration Local

Success means:

- the built `dist/frontmatter-filter.mjs` is used
- `install.sh` installs the real `.githooks/pre-push`
- a real `git push` triggers the hook
- mirror mode writes the expected local target and metadata
- publish mode pushes to a local bare public remote
- publish failure blocks the source push

### Live Publish Smoke

Success means:

- a local source repo installs successfully with a real GitHub public remote
- a real `git push` triggers publish to `zhuyinheng/frontmatter-filter-live`
- the live branch can be cloned back over HTTPS
- the published marker content exists
- `.frontmatter-filter-meta.json.sourceCommit` matches the local source commit

### E2E Live

Success means:

- a local repo built from the real Obsidian fixture pushes to the live source repo branch
- hook-driven publish writes to the live public repo branch
- the source branch HEAD on GitHub equals the local pushed commit
- the public repo tree matches the locally mirrored tree for the same source commit
- metadata points back to the exact source commit

### Real Vault Fixture Contract

For the real vault fixture, success means:

- the generated file tree exactly matches `tests/fixtures/obsidian_test_vault.manifest.json`
- every stable output file matches the expected SHA-256
- metadata points back to the exact source commit
- expected warnings are emitted

## Commands

```sh
npm run test:unit
npm run test:integration:local
npm test
```

The live publish smoke is intentionally separate:

```sh
npm run test:live:publish-smoke
```

The full live end-to-end test is also separate:

```sh
npm run test:e2e:live
```

Required environment for local live publish smoke runs:

- `E2E_LIVE_SSH_KEY_PATH`
- optional: `E2E_LIVE_REMOTE`
- optional: `E2E_LIVE_BRANCH`
- optional: `E2E_LIVE_KNOWN_HOSTS_PATH`

Required environment for local live end-to-end runs:

- `E2E_LIVE_GIT_SSH_COMMAND`
- optional: `E2E_SOURCE_LIVE_REMOTE`
- optional: `E2E_SOURCE_LIVE_HTTPS_URL`
- optional: `E2E_SOURCE_LIVE_BRANCH`
- optional: `E2E_PUBLIC_LIVE_REMOTE`
- optional: `E2E_PUBLIC_LIVE_HTTPS_URL`
- optional: `E2E_PUBLIC_LIVE_BRANCH`

## CI

- `.github/workflows/ci.yml`
  - runs `unit` and `integration-local`
- `.github/workflows/live-publish-smoke.yml`
  - manual `workflow_dispatch`
  - runs the GitHub-backed publish smoke
- `.github/workflows/e2e-live.yml`
  - manual `workflow_dispatch`
  - runs the full dual-GitHub end-to-end path
  - requires write access to `zhuyinheng/obsidian_test_vault` plus `E2E_SOURCE_LIVE_SSH_KEY`

## `act`

`act` is supported for `.github/workflows/ci.yml`.

Known non-blocking `act` noise:

- repeated `unable to get git ref/revision`
- `actions/setup-node` internal clone warnings
- npm cache save warnings when the local checkout path contains spaces

Treat the workflow as passing when the job itself ends in success.
