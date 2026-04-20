import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdownReferences } from '../../src/references.ts';

test('parses wikilink and embed nodes with their raw target', () => {
  const result = parseMarkdownReferences(`See [[foo]]
Embed: ![[bar.png]]`);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.references, [
    { rawTarget: 'foo', syntax: 'wikilink' },
    { rawTarget: 'bar.png', syntax: 'embed' },
  ]);
});

test('parses regular markdown link and image', () => {
  const result = parseMarkdownReferences(`[child](./child.md)
![photo](../assets/photo.png)`);

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.references.map((ref) => ({ ...ref })).sort((left, right) =>
      `${left.syntax}:${left.rawTarget}`.localeCompare(`${right.syntax}:${right.rawTarget}`),
    ),
    [
      { rawTarget: '../assets/photo.png', syntax: 'image' },
      { rawTarget: './child.md', syntax: 'link' },
    ],
  );
});

test('resolves reference-style links and images through their definitions', () => {
  const result = parseMarkdownReferences(`Intro [alpha][A] text.

![logo][LOGO]

[a]: ./alpha.md
[logo]: ./logo.svg`);

  assert.deepEqual(result.warnings, []);
  const byRaw = new Map(result.references.map((ref) => [ref.rawTarget, ref.syntax]));
  assert.equal(byRaw.get('./alpha.md'), 'linkReference');
  assert.equal(byRaw.get('./logo.svg'), 'imageReference');
});

test('reference identifiers are case-insensitive and trimmed', () => {
  const result = parseMarkdownReferences(`[link][  id  ]

[ID]: ./foo.md`);

  assert.deepEqual(result.warnings, []);
  const rawTargets = result.references.map((ref) => ref.rawTarget);
  assert.ok(rawTargets.includes('./foo.md'));
});

test('deduplicates repeated references by syntax and target', () => {
  const result = parseMarkdownReferences(`[[foo]] then [[foo]] again.
Also [child](./child.md) and [child](./child.md).
Image ![alt](./foo.png) and ![again](./foo.png).`);

  const counts = new Map<string, number>();
  for (const ref of result.references) {
    const key = `${ref.syntax}:${ref.rawTarget}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  assert.equal(counts.get('wikilink:foo'), 1);
  assert.equal(counts.get('link:./child.md'), 1);
  assert.equal(counts.get('image:./foo.png'), 1);
});

test('ignores references with empty or whitespace-only targets', () => {
  const result = parseMarkdownReferences(`[x](  )
[y]()
[[   ]]`);

  for (const ref of result.references) {
    assert.ok(ref.rawTarget.trim().length > 0, `unexpected empty target: ${JSON.stringify(ref)}`);
  }
});

test('unresolved reference-style link produces no reference and no throw', () => {
  const result = parseMarkdownReferences(`See [ghost][missing-def]`);

  assert.deepEqual(result.warnings, []);
  assert.equal(result.references.length, 0);
});

test('trims surrounding whitespace in targets', () => {
  const result = parseMarkdownReferences(`[[  foo  ]]`);

  assert.deepEqual(result.references, [{ rawTarget: 'foo', syntax: 'wikilink' }]);
});
