import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter } from '../../src/frontmatter.ts';

test('parses explicit public true through remark frontmatter parsing', () => {
  const result = parseFrontmatter(`---
title: Example
public: true
---

Body`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, true);
  assert.deepEqual(result.warnings, []);
});

test('parses explicit public false', () => {
  const result = parseFrontmatter(`---
title: Private
public: false
---

Body`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, false);
  assert.deepEqual(result.warnings, []);
});

test('returns no publicValue when frontmatter has no public field', () => {
  const result = parseFrontmatter(`---
title: No Public Key
---

Body`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, undefined);
  assert.deepEqual(result.warnings, []);
});

test('returns hasFrontmatter false when no frontmatter block', () => {
  const result = parseFrontmatter(`# Just a heading\n\nNo frontmatter here.`);

  assert.equal(result.hasFrontmatter, false);
  assert.equal(result.publicValue, undefined);
  assert.deepEqual(result.warnings, []);
});

test('returns hasFrontmatter true but no publicValue for empty frontmatter block', () => {
  const result = parseFrontmatter(`---\n---\n\nBody`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, undefined);
  assert.deepEqual(result.warnings, []);
});

test('treats non-boolean public values as unset', () => {
  const result = parseFrontmatter(`---
public: "true"
---
`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, undefined);
  assert.deepEqual(result.warnings, []);
});

test('treats integer public value as unset', () => {
  const result = parseFrontmatter(`---
public: 1
---
`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, undefined);
  assert.deepEqual(result.warnings, []);
});

test('treats null public value as unset', () => {
  const result = parseFrontmatter(`---
public: null
---
`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, undefined);
  assert.deepEqual(result.warnings, []);
});

test('warns when YAML frontmatter cannot be parsed', () => {
  const result = parseFrontmatter(`---
public: [
---
`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, undefined);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /YAML frontmatter/);
});

