#!/usr/bin/env node
/**
 * Multi-knowledgeGraph project setup engine.
 *
 * Wires this KG repo into a user's project: writes .mcp.json (Claude),
 * .claude/settings.json hooks, .codex/config.toml (Codex), .gemini/settings.json
 * (Gemini), and optional briefing blocks into CLAUDE.md / AGENTS.md / GEMINI.md.
 *
 * Idempotent throughout — re-running with the same flags produces the same
 * config. Existing entries written by the user are preserved; only knowledge-graph
 * entries are merged or replaced.
 *
 * Typical invocations:
 *   node scripts/setup-project.js --interactive
 *   node scripts/setup-project.js --db single --platforms claude
 *   node scripts/setup-project.js --db preset --platforms claude,codex,gemini
 *   node scripts/setup-project.js --db custom --custom-dbs main,research --platforms claude
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, usage } from './lib/args.js';
import { run } from './lib/exec.js';
import { substitute, hasPlaceholders } from './lib/placeholders.js';
import { ensureBlock } from './lib/markers.js';
import { ensureMcpServer, mergeClaudeHooks } from './lib/json-merge.js';
import { ensureCodexBlock } from './lib/toml-merge.js';
import { ask, askChoice, askMultiSelect } from './lib/prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KG_ROOT = resolve(__dirname, '..');           // scripts/ → repo root
const TEMPLATES = join(KG_ROOT, 'templates');

function toPosix(p) { return p.split('\\').join('/'); }

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`Error: ${e.message}\n`);
    process.stdout.write(usage());
    process.exit(2);
  }

  // Q2: no flags + not interactive → print help and exit (gentle nudge)
  const noFlags = opts.db === null && opts.platforms === null
    && opts.kgDir === null && !opts.interactive && !opts.resetGit;
  if (opts.help || noFlags) {
    process.stdout.write(usage());
    process.exit(opts.help ? 0 : 0);
  }

  preflight();
  await collectMissing(opts);
  applyDefaults(opts);

  const projectRoot = resolveProjectRoot(opts);
  const kgRootPosix = toPosix(KG_ROOT);

  console.log(`\nProject root: ${projectRoot}`);
  console.log(`KG root:      ${KG_ROOT}`);
  console.log(`Platforms:    ${opts.platforms.join(', ')}`);
  console.log(`DB mode:      ${opts.db}${opts.db === 'custom' ? ' [' + opts.customDbs.join(', ') + ']' : ''}`);
  console.log(`Briefing:     ${opts.briefing ? 'inject' : 'skip'}`);
  console.log('');

  if (opts.resetGit) resetGit(projectRoot);

  const dbs = resolveDbs(opts);

  if (opts.platforms.includes('claude')) wireClaude(projectRoot, kgRootPosix, dbs, opts);
  if (opts.platforms.includes('codex'))  wireCodex(projectRoot, kgRootPosix, dbs, opts);
  if (opts.platforms.includes('gemini')) wireGemini(projectRoot, kgRootPosix, dbs, opts);

  summary(opts, projectRoot);
}

function preflight() {
  const [maj] = process.versions.node.split('.').map(Number);
  if (maj < 18) throw new Error(`Node ≥18 required, found ${process.versions.node}`);
  if (!existsSync(join(KG_ROOT, 'main.js'))) {
    throw new Error(`main.js missing at ${KG_ROOT} — is this the Multi-knowledgeGraph repo?`);
  }
}

async function collectMissing(opts) {
  if (!opts.interactive) return;

  if (opts.db === null) {
    const labels = [
      'single (just knowledge.db) — recommended',
      'preset (main + research + scratch)',
      'custom (specify names)',
    ];
    const choice = await askChoice('DB setup?', labels, 0);
    opts.db = choice.startsWith('single') ? 'single'
      : choice.startsWith('preset') ? 'preset'
      : 'custom';
    if (opts.db === 'custom' && opts.customDbs.length === 0) {
      const csv = await ask('Custom DB names (comma-separated)', 'main,research');
      opts.customDbs = csv.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  if (opts.platforms === null) {
    opts.platforms = await askMultiSelect(
      'Which platforms to wire?',
      ['claude', 'codex', 'gemini'],
      ['claude']
    );
  }

  if (opts.kgDir === null) {
    opts.kgDir = await ask('KG dir relative to project root', './kg');
  }
}

function applyDefaults(opts) {
  if (opts.db === null) opts.db = 'single';
  if (opts.platforms === null) opts.platforms = ['claude'];
  if (opts.db === 'custom' && opts.customDbs.length === 0) {
    throw new Error('--db=custom requires --custom-dbs <name1,name2,...>');
  }
  const valid = new Set(['claude', 'codex', 'gemini']);
  for (const p of opts.platforms) {
    if (!valid.has(p)) throw new Error(`Unknown platform: ${p} (valid: claude, codex, gemini)`);
  }
}

function resolveProjectRoot(opts) {
  if (opts.projectRoot) return resolve(opts.projectRoot);
  // Auto-detect: parent of KG repo
  return resolve(KG_ROOT, '..');
}

function resolveDbs(opts) {
  if (opts.db === 'single') return [{ name: 'knowledge-graph', dbFile: null }];
  if (opts.db === 'preset') return [
    { name: 'knowledge-graph-main',     dbFile: null },
    { name: 'knowledge-graph-research', dbFile: 'research.db' },
    { name: 'knowledge-graph-scratch',  dbFile: 'scratch.db' },
  ];
  // custom: first DB uses default knowledge.db (primary), rest get explicit files
  return opts.customDbs.map((name, i) => ({
    name: `knowledge-graph-${name}`,
    dbFile: i === 0 ? null : `${name}.db`,
  }));
}

function resetGit(projectRoot) {
  const dotgit = join(projectRoot, '.git');
  if (existsSync(dotgit)) {
    const bak = join(projectRoot, `.git.bak-${Date.now()}`);
    try {
      renameSync(dotgit, bak);
      console.log(`Backed up .git → ${bak}`);
    } catch (e) {
      throw new Error(`Could not move .git to ${bak} (${e.code || e.message}). Close IDE/git processes holding it and re-run (idempotent).`);
    }
  }
  run('git', ['init'], 'git init', { cwd: projectRoot });
}

// ---------- Claude ----------

function wireClaude(projectRoot, kgRootPosix, dbs, opts) {
  // 1. .mcp.json — one entry per DB
  const mcpFile = join(projectRoot, '.mcp.json');
  for (const db of dbs) {
    const args = [`${kgRootPosix}/main.js`];
    if (db.dbFile) args.push('--db', db.dbFile);
    ensureMcpServer(mcpFile, db.name, { command: 'node', args });
  }
  console.log(`✓ .mcp.json: ${dbs.length} knowledge-graph entr${dbs.length === 1 ? 'y' : 'ies'}`);

  // 2. .claude/settings.json hooks — bound to primary DB (the first one)
  const settingsFile = join(projectRoot, '.claude', 'settings.json');
  mkdirSync(dirname(settingsFile), { recursive: true });

  let tmpl = readFileSync(join(TEMPLATES, 'claude', 'settings.json'), 'utf8');
  tmpl = substitute(tmpl, { KG_ROOT: kgRootPosix });
  if (hasPlaceholders(tmpl)) {
    throw new Error('Unresolved placeholders in templates/claude/settings.json');
  }
  const hooksObj = JSON.parse(tmpl).hooks;
  mergeClaudeHooks(settingsFile, hooksObj);
  console.log(`✓ .claude/settings.json: 5 hooks merged (SessionStart×2, UserPromptSubmit, PreToolUse, Stop)`);

  // 3. Optional CLAUDE.md briefing
  if (opts.briefing) {
    const claudeMd = join(projectRoot, 'CLAUDE.md');
    const briefing = readFileSync(join(TEMPLATES, 'claude', 'briefing.md'), 'utf8').trim();
    const existing = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '';
    writeFileSync(claudeMd, ensureBlock(existing, 'KG-BRIEFING-CLAUDE', briefing));
    console.log(`✓ CLAUDE.md: briefing block (KG-BRIEFING-CLAUDE)`);
  }
}

// ---------- Codex ----------

function wireCodex(projectRoot, kgRootPosix, dbs, opts) {
  // 1. .codex/config.toml — one [mcp_servers.<name>] table per DB inside KG-BEGIN/END
  const codexFile = join(projectRoot, '.codex', 'config.toml');
  mkdirSync(dirname(codexFile), { recursive: true });

  const lines = [];
  for (const db of dbs) {
    const args = [`${kgRootPosix}/main.js`];
    if (db.dbFile) args.push('--db', db.dbFile);
    lines.push(`[mcp_servers.${db.name}]`);
    lines.push(`command = "node"`);
    lines.push(`args = [${args.map(tomlString).join(', ')}]`);
    lines.push('');
  }
  ensureCodexBlock(codexFile, lines.join('\n').trimEnd() + '\n');
  console.log(`✓ .codex/config.toml: ${dbs.length} mcp_servers table${dbs.length === 1 ? '' : 's'}`);

  // 2. Optional AGENTS.md briefing (Codex uses AGENTS.md as persona file)
  if (opts.briefing) {
    const agentsMd = join(projectRoot, 'AGENTS.md');
    const briefing = readFileSync(join(TEMPLATES, 'codex', 'briefing.md'), 'utf8').trim();
    const existing = existsSync(agentsMd) ? readFileSync(agentsMd, 'utf8') : '';
    writeFileSync(agentsMd, ensureBlock(existing, 'KG-BRIEFING-CODEX', briefing));
    console.log(`✓ AGENTS.md: briefing block (KG-BRIEFING-CODEX)`);
  }
}

function tomlString(s) {
  // basic TOML string: escape backslash and double-quote
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ---------- Gemini ----------

function wireGemini(projectRoot, kgRootPosix, dbs, opts) {
  // 1. .gemini/settings.json — same shape as Claude .mcp.json
  const geminiFile = join(projectRoot, '.gemini', 'settings.json');
  mkdirSync(dirname(geminiFile), { recursive: true });

  for (const db of dbs) {
    const args = [`${kgRootPosix}/main.js`];
    if (db.dbFile) args.push('--db', db.dbFile);
    ensureMcpServer(geminiFile, db.name, { command: 'node', args });
  }
  console.log(`✓ .gemini/settings.json: ${dbs.length} knowledge-graph entr${dbs.length === 1 ? 'y' : 'ies'}`);

  // 2. Optional GEMINI.md briefing
  if (opts.briefing) {
    const geminiMd = join(projectRoot, 'GEMINI.md');
    const briefing = readFileSync(join(TEMPLATES, 'gemini', 'briefing.md'), 'utf8').trim();
    const existing = existsSync(geminiMd) ? readFileSync(geminiMd, 'utf8') : '';
    writeFileSync(geminiMd, ensureBlock(existing, 'KG-BRIEFING-GEMINI', briefing));
    console.log(`✓ GEMINI.md: briefing block (KG-BRIEFING-GEMINI)`);
  }
}

// ---------- summary ----------

function summary(opts, projectRoot) {
  console.log('\n=== kg-init complete ===');
  console.log('\nNext steps:');
  if (opts.platforms.includes('claude')) {
    console.log('  • Restart Claude Code so MCP servers + hooks load');
  }
  if (opts.platforms.includes('codex')) {
    console.log('  • Trust this project for Codex (project-level .codex/config.toml requires it):');
    console.log('    Edit ~/.codex/trust.toml or run the trust command per your Codex version.');
  }
  if (opts.platforms.includes('gemini')) {
    console.log('  • Restart Gemini CLI so MCP loads');
  }
  console.log('  • Re-running setup-project.js is safe (idempotent).');
  console.log('');
}

main().catch(e => {
  console.error(`\nINIT FAILED: ${e.message}`);
  process.exit(1);
});
