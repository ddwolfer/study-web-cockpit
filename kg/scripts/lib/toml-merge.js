/**
 * Idempotent TOML block merge for Codex .codex/config.toml.
 *
 * Strategy: zero TOML parser dependency. We delineate the kg-init managed
 * block with marker comments:
 *
 *   # KG-BEGIN
 *   [mcp_servers.knowledge-graph]
 *   command = "node"
 *   args = ["/abs/path/main.js"]
 *   # KG-END
 *
 * On re-run, we string-replace between markers. If markers absent, we append.
 *
 * ensureCodexBlock(file, blockBody)
 *   — blockBody is the raw text to place between # KG-BEGIN and # KG-END
 *     (do NOT include the markers themselves; this function adds them).
 *
 * removeCodexBlock(file)
 *   — strip the managed block if present.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BLOCK_RE = /# KG-BEGIN\n[\s\S]*?# KG-END\n?/;

export function ensureCodexBlock(file, blockBody) {
  let content = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const body = blockBody.endsWith('\n') ? blockBody : blockBody + '\n';
  const block = `# KG-BEGIN\n${body}# KG-END\n`;

  if (BLOCK_RE.test(content)) {
    content = content.replace(BLOCK_RE, block);
  } else {
    if (content.length > 0) {
      if (!content.endsWith('\n')) content += '\n';
      if (!content.endsWith('\n\n')) content += '\n';
    }
    content += block;
  }
  writeFileSync(file, content);
}

export function removeCodexBlock(file) {
  if (!existsSync(file)) return;
  const content = readFileSync(file, 'utf8');
  if (!BLOCK_RE.test(content)) return;
  const stripped = content.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  writeFileSync(file, stripped);
}

export function hasCodexBlock(file) {
  if (!existsSync(file)) return false;
  return BLOCK_RE.test(readFileSync(file, 'utf8'));
}
