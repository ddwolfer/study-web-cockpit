import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './args.js';

test('parseArgs: no flags → all defaults / nulls', () => {
  const o = parseArgs([]);
  assert.equal(o.db, null);
  assert.equal(o.platforms, null);
  assert.equal(o.kgDir, null);
  assert.equal(o.briefing, true);
  assert.equal(o.interactive, false);
  assert.equal(o.resetGit, false);
});

test('parseArgs: --db single --platforms claude', () => {
  const o = parseArgs(['--db', 'single', '--platforms', 'claude']);
  assert.equal(o.db, 'single');
  assert.deepEqual(o.platforms, ['claude']);
});

test('parseArgs: --platforms with multiple', () => {
  const o = parseArgs(['--platforms', 'claude,codex,gemini']);
  assert.deepEqual(o.platforms, ['claude', 'codex', 'gemini']);
});

test('parseArgs: --custom-dbs splits and trims', () => {
  const o = parseArgs(['--custom-dbs', 'main, research, scratch']);
  assert.deepEqual(o.customDbs, ['main', 'research', 'scratch']);
});

test('parseArgs: --no-briefing flips briefing', () => {
  const o = parseArgs(['--no-briefing']);
  assert.equal(o.briefing, false);
});

test('parseArgs: --interactive and --reset-git', () => {
  const o = parseArgs(['--interactive', '--reset-git']);
  assert.equal(o.interactive, true);
  assert.equal(o.resetGit, true);
});

test('parseArgs: --kg-dir and --project-root', () => {
  const o = parseArgs(['--kg-dir', './kg', '--project-root', '/tmp/x']);
  assert.equal(o.kgDir, './kg');
  assert.equal(o.projectRoot, '/tmp/x');
});

test('parseArgs: --help and -h both set help', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs: unknown flag throws', () => {
  assert.throws(() => parseArgs(['--bogus']), /Unknown flag/);
});

test('parseArgs: missing value throws', () => {
  assert.throws(() => parseArgs(['--db']), /requires a value/);
});

test('parseArgs: positional arg throws', () => {
  assert.throws(() => parseArgs(['somefile.txt']), /Unexpected positional/);
});
