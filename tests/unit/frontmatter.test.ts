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
