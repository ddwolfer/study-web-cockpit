import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureBlock, removeBlock, hasBlock } from './markers.js';

const NAME = 'KG-TEST';
const start = `<!-- ${NAME}:START -->`;
const end = `<!-- ${NAME}:END -->`;

test('ensureBlock: append to empty content', () => {
  const out = ensureBlock('', NAME, 'body');
  assert.equal(out, `${start}\nbody\n${end}\n`);
});

test('ensureBlock: append to content lacking the marker', () => {
  const out = ensureBlock('Existing content\n', NAME, 'body');
  assert.match(out, /^Existing content\n\n<!-- KG-TEST:START -->\nbody\n<!-- KG-TEST:END -->\n$/);
});

test('ensureBlock: replace existing block (idempotent)', () => {
  const initial = `prefix\n\n${start}\nold body\n${end}\n`;
  const updated = ensureBlock(initial, NAME, 'new body');
  assert.match(updated, /prefix/);
  assert.match(updated, /new body/);
  assert.doesNotMatch(updated, /old body/);
});

test('ensureBlock: multiple runs produce identical result', () => {
  const a = ensureBlock('', NAME, 'body');
  const b = ensureBlock(a, NAME, 'body');
  const c = ensureBlock(b, NAME, 'body');
  assert.equal(a, b);
  assert.equal(b, c);
});

test('ensureBlock: preserves other markers nearby', () => {
  const other = `<!-- OTHER:START -->\nother\n<!-- OTHER:END -->\n`;
  const updated = ensureBlock(other, NAME, 'mine');
  assert.match(updated, /OTHER:START/);
  assert.match(updated, /OTHER:END/);
  assert.match(updated, /mine/);
});

test('removeBlock: strips the block (and surrounding blank line)', () => {
  const initial = `prefix\n\n${start}\nbody\n${end}\nsuffix\n`;
  const out = removeBlock(initial, NAME);
  assert.doesNotMatch(out, /KG-TEST/);
  assert.match(out, /prefix/);
  assert.match(out, /suffix/);
});

test('removeBlock: no-op when block absent', () => {
  const initial = 'no markers here';
  assert.equal(removeBlock(initial, NAME), initial);
});

test('hasBlock: true / false', () => {
  assert.equal(hasBlock(`${start}\nx\n${end}`, NAME), true);
  assert.equal(hasBlock('plain', NAME), false);
});

test('ensureBlock: handles body with special regex chars', () => {
  const body = 'foo (bar) [baz] $1 ^* . +';
  const out = ensureBlock('', NAME, body);
  assert.equal(ensureBlock(out, NAME, body), out, 're-running with regex-special body must be idempotent');
});
