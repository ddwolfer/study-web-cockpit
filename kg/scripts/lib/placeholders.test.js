import { test } from 'node:test';
import assert from 'node:assert/strict';
import { substitute, hasPlaceholders, findPlaceholders } from './placeholders.js';

test('substitute: replaces known keys', () => {
  assert.equal(substitute('Hello {{NAME}}', { NAME: 'world' }), 'Hello world');
});

test('substitute: leaves unknown keys intact', () => {
  assert.equal(substitute('{{A}} and {{B}}', { A: 'x' }), 'x and {{B}}');
});

test('substitute: multiple occurrences of same key', () => {
  assert.equal(substitute('{{X}}-{{X}}-{{X}}', { X: 'a' }), 'a-a-a');
});

test('substitute: no placeholders → unchanged', () => {
  assert.equal(substitute('plain text', { A: 'x' }), 'plain text');
});

test('substitute: numeric value coerced to string', () => {
  assert.equal(substitute('port {{P}}', { P: 3000 }), 'port 3000');
});

test('hasPlaceholders: true when any present', () => {
  assert.equal(hasPlaceholders('{{X}}'), true);
  assert.equal(hasPlaceholders('plain'), false);
  assert.equal(hasPlaceholders('mixed {{Y}} text'), true);
});

test('findPlaceholders: returns unique keys', () => {
  assert.deepEqual(findPlaceholders('{{A}} {{B}} {{A}}').sort(), ['A', 'B']);
  assert.deepEqual(findPlaceholders('no placeholders'), []);
});

test('substitute: only uppercase/digits/underscore are valid keys', () => {
  // {{lowercase}} should NOT be a placeholder
  assert.equal(substitute('{{lowercase}}', { lowercase: 'x' }), '{{lowercase}}');
  // {{Mixed}} should NOT match
  assert.equal(substitute('{{Mixed}}', { Mixed: 'x' }), '{{Mixed}}');
});
