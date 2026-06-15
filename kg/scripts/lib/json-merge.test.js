import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureMcpServer, mergeClaudeHooks, isOurHookEntry, removeMcpServer } from './json-merge.js';

function tmpFile(name) {
  const dir = join(tmpdir(), `kg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, file: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('ensureMcpServer: creates file with mcpServers', () => {
  const { file, cleanup } = tmpFile('.mcp.json');
  try {
    ensureMcpServer(file, 'knowledge-graph', { command: 'node', args: ['/abs/main.js'] });
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(data, { mcpServers: { 'knowledge-graph': { command: 'node', args: ['/abs/main.js'] } } });
  } finally { cleanup(); }
});

test('ensureMcpServer: preserves other servers', () => {
  const { file, cleanup } = tmpFile('.mcp.json');
  try {
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    ensureMcpServer(file, 'knowledge-graph', { command: 'node', args: ['/m.js'] });
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(data.mcpServers.other);
    assert.ok(data.mcpServers['knowledge-graph']);
  } finally { cleanup(); }
});

test('ensureMcpServer: idempotent on re-run', () => {
  const { file, cleanup } = tmpFile('.mcp.json');
  try {
    const cfg = { command: 'node', args: ['/m.js'] };
    ensureMcpServer(file, 'kg', cfg);
    const after1 = readFileSync(file, 'utf8');
    ensureMcpServer(file, 'kg', cfg);
    const after2 = readFileSync(file, 'utf8');
    assert.equal(after1, after2);
  } finally { cleanup(); }
});

test('ensureMcpServer: replaces same-name server config', () => {
  const { file, cleanup } = tmpFile('.mcp.json');
  try {
    ensureMcpServer(file, 'kg', { command: 'node', args: ['/old.js'] });
    ensureMcpServer(file, 'kg', { command: 'node', args: ['/new.js'] });
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(data.mcpServers.kg.args, ['/new.js']);
  } finally { cleanup(); }
});

test('removeMcpServer: removes one, keeps others', () => {
  const { file, cleanup } = tmpFile('.mcp.json');
  try {
    writeFileSync(file, JSON.stringify({
      mcpServers: { kg: { command: 'x' }, other: { command: 'y' } },
    }));
    removeMcpServer(file, 'kg');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.mcpServers.kg, undefined);
    assert.ok(data.mcpServers.other);
  } finally { cleanup(); }
});

test('isOurHookEntry: matches by hook script path', () => {
  assert.equal(isOurHookEntry({
    hooks: [{ command: 'node /x/hooks/session-start.js' }],
  }), true);
  assert.equal(isOurHookEntry({
    hooks: [{ command: 'node /x/hooks/post-compact.js' }],
  }), true);
});

test('isOurHookEntry: matches by auto-capture sentinel in prompt', () => {
  assert.equal(isOurHookEntry({
    hooks: [{ type: 'agent', prompt: 'Some text with <auto-capture> sentinel.' }],
  }), true);
});

test('isOurHookEntry: false for unrelated hook', () => {
  assert.equal(isOurHookEntry({
    hooks: [{ command: 'node /some/other/script.js' }],
  }), false);
  assert.equal(isOurHookEntry({
    hooks: [{ type: 'agent', prompt: 'Generic prompt' }],
  }), false);
});

test('mergeClaudeHooks: preserves user-defined hooks', () => {
  const { file, cleanup } = tmpFile('settings.json');
  try {
    writeFileSync(file, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ command: 'node /user/own.js' }] },
        ],
      },
    }));
    mergeClaudeHooks(file, {
      SessionStart: [
        { matcher: 'startup', hooks: [{ command: 'node /kg/hooks/session-start.js' }] },
      ],
    });
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.hooks.SessionStart.length, 2, 'preserves user hook + adds ours');
  } finally { cleanup(); }
});

test('mergeClaudeHooks: idempotent — replaces our entries, no duplication', () => {
  const { file, cleanup } = tmpFile('settings.json');
  try {
    const ourHooks = {
      SessionStart: [
        { matcher: 'startup', hooks: [{ command: 'node /kg/hooks/session-start.js' }] },
      ],
    };
    mergeClaudeHooks(file, ourHooks);
    mergeClaudeHooks(file, ourHooks);
    mergeClaudeHooks(file, ourHooks);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.hooks.SessionStart.length, 1, 'three runs = one entry');
  } finally { cleanup(); }
});
