# Architecture & decoupling — should we add a thin seam?

Status: proposal / analysis.
Audience: anyone considering where to add a boundary for test-driven development.

## The question

Task framing: _is a thin architectural layer warranted — even if only
conceptual — to describe code behavior boundaries and make test-driven
development easier?_

## Short answer

**Yes — one seam is worth adding, and it's conceptual, not a rewrite.**

The seam is the boundary between "where does data come from" (the source
snapshot) and "how do we decide what to publish" (the filter rules). Today
these are tangled in `core.ts` via direct calls to `git.ts`. Separating them
gives us two layers that can be tested independently, without changing any
public CLI behavior.

**Do not** add additional layers (service/repository/adapter stacks, DI
containers, or multi-interface facades). The tool is small, single-purpose,
and the cost of over-abstraction would exceed the benefit.

## What we have today

`src/` has six files arranged as a shallow dependency graph:

```
cli.ts ─┐
        ├─► config.ts ─► git.ts (detect root)
        └─► core.ts ─► git.ts (read tree / read blob / resolve commit)
                   ├─► frontmatter.ts
                   └─► references.ts
```

Strengths:

- No cyclic deps.
- Pure parsers (`frontmatter.ts`, `references.ts`) already have unit tests
  that run without git.
- `types.ts` is shared, not layered.

Weaknesses that matter for TDD:

1. **`core.ts` is the elephant (~800 lines)**. Inside it, four concerns
   coexist:
   - snapshot I/O (reading trees, reading blobs, writing mirror)
   - rule engine (visibility inheritance, reference resolution, broken-link
     classification)
   - safety (sensitive scan)
   - orchestration (mirror → diff → write; publish → mirror → git init → push)
2. **Every semantic test has to build a real git repo in a tmpdir**. See
   `tests/unit/core.test.ts`: all 20+ tests call `initRepo` → `writeFile` →
   `commitAll`. This is slow, OS-dependent (git on Windows, permission
   models), and buries the actual behavior under setup noise.
3. **The vault fixture is fetched over HTTPS at a pinned commit**. That
   removes the old submodule sync friction, but the rule tests still spin
   up real git repos for every case — we still need a way to run them
   against synthetic trees without git at all.

## The proposed seam

Introduce a `SnapshotReader` interface inside `src/`:

```ts
// types.ts (additions)
export interface SnapshotFile {
  relativePath: string;
  mode: '100644' | '100755' | '120000' | '160000';
  // Only blobs have buffers; gitlinks/symlinks don't.
  buffer?: Buffer;
}

export interface SnapshotReader {
  sourceCommit: string;
  sourceBranch?: string;
  listFiles(): Promise<SnapshotFile[]>;
  readBlob(relativePath: string): Promise<Buffer>;
}
```

Two implementations:

1. **`GitSnapshotReader`** — wraps the current `git.ts` calls. Production
   code path. Same behavior as today.
2. **`InMemorySnapshotReader`** — used in tests. Constructed from a plain
   object literal of paths → buffers/modes. No git, no fs.

`buildPublishPlan` would take a `SnapshotReader` instead of `(config, options)`
with an implicit `config.repoRoot`. CLI composes the reader from config +
flags; tests pass the in-memory one.

That's it. One interface, two implementations. No DI, no registry.

## What this unlocks

| Today's test                                         | After the seam                                         |
| ---------------------------------------------------- | ------------------------------------------------------ |
| Write 7 files under tmp, `git init`, commit, run    | Build a 7-key object in memory, run                   |
| ~200ms per test (git process spawns)                 | ~5ms per test                                          |
| Can't test git-unreachable scenarios easily          | Trivial: `readBlob` throws                             |
| Symlink test needs `git update-index --cacheinfo` dance | `{ mode: '120000', relativePath: 'link' }`          |
| Can't target Windows path behavior without Windows CI | Inject reader with case-varied keys                   |

Separately: the real-vault integration test in `tests/integration/local/` keeps
using the real `GitSnapshotReader`. That's the correct place for it — it
verifies the git-wiring, which the unit tests no longer bother with.

## What it does not unlock (and don't fake it)

- Publish/push is still a side-effectful ceremony around `git init` /
  `git push`. That belongs in `integration-local`. Don't invent a
  `RemotePublisher` interface just to mock `git push` — the mock would tell
  you nothing new.
- Install.sh is shell; unit-interface abstractions don't help there. The
  `install-hook.test.ts` integration suite stays the testing surface.
- Sensitive-pattern scanning is already pure (input: buffer list + patterns).
  It doesn't need its own interface; it's just a function with a well-defined
  signature today.

## Boundaries written down (the "conceptual layer")

Even without the `SnapshotReader` refactor, it's worth writing down what
each file *owns* — the cheapest possible architectural doc. Here it is:

| Layer              | File                   | Owns                                                             | Must not                          |
| ------------------ | ---------------------- | ---------------------------------------------------------------- | --------------------------------- |
| CLI                | `cli.ts`               | argv parsing, stdin hook input, exit codes, output formatting    | know filter rules                 |
| Config             | `config.ts`            | file discovery, defaults, validation                             | know git or filesystem of target  |
| Git adapter        | `git.ts`               | every `execFile('git', ...)` call, pre-push parse                | know filter rules                 |
| Snapshot + rules   | `core.ts`              | visibility, reference resolution, broken links, sensitive scan   | know CLI argv or stdout           |
| Parsers            | `frontmatter.ts`, `references.ts` | pure text in → structured out                          | do I/O                            |
| Types              | `types.ts`             | shared DTOs                                                      | logic                             |

Today `core.ts` lightly crosses its own lane by calling `git.ts` directly for
reading. The `SnapshotReader` seam cleans exactly that edge.

## Recommendation

1. **Do now (cheap)**: commit the layer-ownership table above as a short
   `docs/architecture.md`. Zero code change. It catches 80% of the value by
   giving every future change a one-page rulebook.
2. **Do soon (small)**: extract `SnapshotReader` as described. Estimated
   effort: <1 day, no behavior change. Flip the existing `core.test.ts`
   to use `InMemorySnapshotReader`. Gains: ~30× faster unit tests, trivial
   edge-case construction.
3. **Do not**: introduce a publisher/mirror abstraction. The publish pipeline
   is intrinsically side-effectful; mocking it reduces test value. Keep
   `integration-local` and `e2e-live` as the covering surfaces.

## Tradeoffs to be honest about

- A `SnapshotReader` adds one interface (~20 lines) and one file (~40 lines
  for the in-memory impl). That's not free.
- Any test that stays on git-backed flow still pays the git cost. We'd be
  splitting the unit suite into "fast semantic" (new, on in-memory reader)
  and "slower, git-backed" (smaller, staying integration-local).
- If the project ever needs to support a second snapshot source (e.g. a
  worktree scan mode, explicitly listed as a non-goal in design-doc §15),
  the seam is there. If we never need it, it was still worth it for TDD
  velocity.

## Decision

Proceeding with (1) and (2) is recommended; (3) is a trap to avoid.
