import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureCodexBlock, removeCodexBlock, hasCodexBlock } from './toml-merge.js';

function tmpFile(name) {
  const dir = join(tmpdir(), `kg-toml-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { file: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const KG_BODY = `[mcp_servers.knowledge-graph]
command = "node"
args = ["/abs/main.js"]
`;

test('ensureCodexBlock: appends to non-existent file', () => {
  const { file, cleanup } = tmpFile('config.toml');
  try {
    ensureCodexBlock(file, KG_BODY);
    const content = readFileSync(file, 'utf8');
    assert.match(content, /# KG-BEGIN/);
    assert.match(content, /# KG-END/);
    assert.match(content, /mcp_servers\.knowledge-graph/);
  } finally { cleanup(); }
});

test('ensureCodexBlock: appends to file with other tables (preserves them)', () => {
  const { file, cleanup } = tmpFile('config.toml');
  try {
    writeFileSync(file, '[other_table]\nkey = "value"\n');
    ensureCodexBlock(file, KG_BODY);
    const content = readFileSync(file, 'utf8');
    assert.match(content, /\[other_table\]/);
    assert.match(content, /# KG-BEGIN/);
  } finally { cleanup(); }
});

test('ensureCodexBlock: replaces existing block (idempotent)', () => {
  const { file, cleanup } = tmpFile('config.toml');
  try {
    ensureCodexBlock(file, KG_BODY);
    const after1 = readFileSync(file, 'utf8');
    ensureCodexBlock(file, KG_BODY);
    const after2 = readFileSync(file, 'utf8');
    assert.equal(after1, after2, 'identical content → identical file');
    // count KG-BEGIN occurrences
    const beginCount = (after2.match(/# KG-BEGIN/g) || []).length;
    assert.equal(beginCount, 1, 'no duplicate marker after re-run');
  } finally { cleanup(); }
});

test('ensureCodexBlock: replaces body content but keeps surrounding text', () => {
  const { file, cleanup } = tmpFile('config.toml');
  try {
    const prefix = '[before]\nx = 1\n\n';
    const suffix = '\n[after]\ny = 2\n';
    writeFileSync(file, prefix + '# KG-BEGIN\nold = "body"\n# KG-END\n' + suffix);
    ensureCodexBlock(file, KG_BODY);
    const content = readFileSync(file, 'utf8');
    assert.match(content, /\[before\]/);
    assert.match(content, /\[after\]/);
    assert.match(content, /mcp_servers\.knowledge-graph/);
    assert.doesNotMatch(content, /old = "body"/);
  } finally { cleanup(); }
});

test('removeCodexBlock: strips block, keeps other tables', () => {
  const { file, cleanup } = tmpFile('config.toml');
  try {
    writeFileSync(file, '[other]\nk = 1\n\n# KG-BEGIN\nx = 1\n# KG-END\n\n[after]\ny = 2\n');
    removeCodexBlock(file);
    const content = readFileSync(file, 'utf8');
    assert.match(content, /\[other\]/);
    assert.match(content, /\[after\]/);
    assert.doesNotMatch(content, /KG-BEGIN|KG-END/);
  } finally { cleanup(); }
});

test('hasCodexBlock: detects presence', () => {
  const { file, cleanup } = tmpFile('config.toml');
  try {
    writeFileSync(file, '[x]\n');
    assert.equal(hasCodexBlock(file), false);
    ensureCodexBlock(file, KG_BODY);
    assert.equal(hasCodexBlock(file), true);
  } finally { cleanup(); }
});

test('ensureCodexBlock: handles multiple [mcp_servers.*] tables in body', () => {
  const { file, cleanup } = tmpFile('config.toml');
  try {
    const multiBody = `[mcp_servers.kg-main]
command = "node"
args = ["/m.js"]

[mcp_servers.kg-research]
command = "node"
args = ["/m.js", "--db", "research.db"]
`;
    ensureCodexBlock(file, multiBody);
    const content = readFileSync(file, 'utf8');
    assert.match(content, /mcp_servers\.kg-main/);
    assert.match(content, /mcp_servers\.kg-research/);
    // Re-run: still no duplication
    ensureCodexBlock(file, multiBody);
    const after = readFileSync(file, 'utf8');
    assert.equal((after.match(/# KG-BEGIN/g) || []).length, 1);
  } finally { cleanup(); }
});
