/**
 * Idempotent JSON config merges for .mcp.json (Claude) and .gemini/settings.json.
 *
 * ensureMcpServer(file, name, config)
 *   — read JSON, set data.mcpServers[name] = config, write. Preserves other servers.
 *
 * removeMcpServer(file, name)
 *   — delete a single entry if present. Leaves file as `{}` if last one removed.
 *
 * mergeClaudeHooks(file, hooksObj)
 *   — for .claude/settings.json. Removes our existing hook entries (identified by
 *     commands referencing knowledge-graph hook scripts, or the auto-capture
 *     agent prompt), then appends the fresh entries. Other user hooks preserved.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function readJson(file) {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`Invalid JSON in ${file}: ${e.message}`); }
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function ensureMcpServer(file, name, config) {
  const data = readJson(file);
  data.mcpServers = data.mcpServers || {};
  data.mcpServers[name] = config;
  writeJson(file, data);
}

export function removeMcpServer(file, name) {
  if (!existsSync(file)) return;
  const data = readJson(file);
  if (data.mcpServers && data.mcpServers[name]) {
    delete data.mcpServers[name];
    writeJson(file, data);
  }
}

/** True if this hook entry was created by kg-init (so we can dedup on re-run). */
export function isOurHookEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(h => {
    if (typeof h.command === 'string' &&
        /[\\/]hooks[\\/](session-start|auto-recall|post-compact|search-enforcer)\.js/.test(h.command)) {
      return true;
    }
    if (typeof h.prompt === 'string' && h.prompt.includes('<auto-capture>')) {
      return true;
    }
    return false;
  });
}

export function mergeClaudeHooks(file, hooksObj) {
  const data = readJson(file);
  data.hooks = data.hooks || {};
  for (const [eventName, newEntries] of Object.entries(hooksObj)) {
    const existing = (data.hooks[eventName] || []).filter(e => !isOurHookEntry(e));
    data.hooks[eventName] = [...existing, ...newEntries];
  }
  writeJson(file, data);
}
