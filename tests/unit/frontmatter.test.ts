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

test('treats non-boolean public values as unset', () => {
  const result = parseFrontmatter(`---
public: "true"
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

test('parses explicit public false', () => {
  const result = parseFrontmatter(`---
title: Draft
public: false
---

Body`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, false);
  assert.deepEqual(result.warnings, []);
});

test('returns hasFrontmatter false when the document has no frontmatter block', () => {
  const result = parseFrontmatter(`# No frontmatter

just body text`);

  assert.equal(result.hasFrontmatter, false);
  assert.equal(result.publicValue, undefined);
  assert.deepEqual(result.warnings, []);
});

test('treats missing public field as unset when frontmatter is otherwise valid', () => {
  const result = parseFrontmatter(`---
title: Only title
---

Body`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, undefined);
  assert.deepEqual(result.warnings, []);
});

test('treats null public as unset', () => {
  const result = parseFrontmatter(`---
public: null
---
`);

  assert.equal(result.hasFrontmatter, true);
  assert.equal(result.publicValue, undefined);
  assert.deepEqual(result.warnings, []);
});
