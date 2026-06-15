/**
 * Merge one or more knowledge-graph SQLite databases into a target DB.
 *
 * Each source is opened as its own connection (sqlite-vec loaded) and its rows
 * are copied into the target — we avoid ATTACH so the fts5/vec0 virtual tables
 * copy reliably. Returns a per-source + totals report.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { initSchema } from '../../lib/db.js';

const NODE_COLS = [
  'id', 'type', 'trust', 'name', 'content', 'source', 'quote', 'metadata',
  'valid_from', 'valid_until', 'access_count', 'last_accessed',
  'created_at', 'updated_at', 'stability', 'memory_level',
];
const EDGE_COLS = [
  'id', 'source_id', 'target_id', 'relation_type', 'reasoning', 'weight',
  'source_session', 'valid_from', 'valid_until', 'created_at',
];
const EPISODE_COLS = ['id', 'type', 'context', 'summary', 'outcome', 'session_id', 'created_at'];
const STEP_COLS = ['id', 'episode_id', 'step_order', 'element', 'action', 'decision', 'reason', 'result'];

// Tables copied verbatim, in FK-safe order (parents before children).
const TABLES = [
  { name: 'nodes', cols: NODE_COLS, key: 'nodes' },
  { name: 'edges', cols: EDGE_COLS, key: 'edges' },
  { name: 'episodes', cols: EPISODE_COLS, key: 'episodes' },
  { name: 'episode_steps', cols: STEP_COLS, key: 'episode_steps' },
];

/**
 * Parse argv (without node/script) for merge-db.js.
 *   --into <file>     target DB (created if absent)
 *   --from <file>     source DB (repeatable)
 *   --tag-domain      stamp metadata.domain = source basename on copied nodes
 *   --help, -h        usage
 */
export function parseMergeArgs(argv) {
  const opts = { into: null, from: [], tagDomain: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`Flag ${a} requires a value`);
      return argv[++i];
    };
    switch (a) {
      case '--into':       opts.into = need(); break;
      case '--from':       opts.from.push(need()); break;
      case '--tag-domain': opts.tagDomain = true; break;
      case '--help':
      case '-h':           opts.help = true; break;
      default:             throw new Error(`Unknown flag: ${a}`);
    }
  }
  return opts;
}

export function mergeDatabases({ into, from, tagDomain = false } = {}) {
  if (!into) throw new Error('mergeDatabases: `into` is required');
  const sources = Array.isArray(from) ? from : (from ? [from] : []);
  if (sources.length === 0) throw new Error('mergeDatabases: at least one `from` source is required');

  // Safety: a non-empty -wal/-shm sidecar means the source DB has uncheckpointed
  // writes (its MCP server is likely still running). Reading it now risks a torn
  // copy — refuse BEFORE touching the target so there is no partial merge.
  for (const srcPath of sources) {
    const live = liveSidecar(srcPath);
    if (live) {
      throw new Error(
        `Refusing to merge: "${srcPath}" has an uncheckpointed WAL sidecar (${live}). ` +
        `Stop that DB's MCP server (or checkpoint it) before merging.`
      );
    }
  }

  const target = new Database(into);
  sqliteVec.load(target);
  initSchema(target);

  const totals = { nodes: 0, edges: 0, episodes: 0, episode_steps: 0, vec_nodes: 0 };
  const report = { sources: [], totals };

  // Prepared inserts for each verbatim table. OR IGNORE → existing PK (UUID)
  // is skipped rather than overwritten, so re-merging is safe and idempotent.
  const inserts = {};
  for (const t of TABLES) {
    inserts[t.name] = target.prepare(
      `INSERT OR IGNORE INTO ${t.name} (${t.cols.join(', ')}) VALUES (${t.cols.map(() => '?').join(', ')})`
    );
  }
  const insVec = target.prepare(`INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)`);
  const hasVec = target.prepare(`SELECT 1 FROM vec_nodes WHERE node_id = ? LIMIT 1`);

  totals.skipped = 0;

  for (const srcPath of sources) {
    const src = new Database(srcPath, { readonly: true });
    sqliteVec.load(src);
    const stat = { from: srcPath, nodes: 0, edges: 0, episodes: 0, episode_steps: 0, vec_nodes: 0, skipped: 0 };
    const domain = basename(srcPath).replace(/\.db$/i, '');

    const copy = target.transaction(() => {
      for (const t of TABLES) {
        const rows = src.prepare(`SELECT ${t.cols.join(', ')} FROM ${t.name}`).all();
        for (const r of rows) {
          if (t.name === 'nodes' && tagDomain) {
            r.metadata = stampDomain(r.metadata, domain);
          }
          const info = inserts[t.name].run(...t.cols.map(c => r[c]));
          if (info.changes > 0) stat[t.key]++;
          else stat.skipped++;
        }
      }
      // vec0 virtual table: re-insert the raw embedding blob, deduped by node_id
      // (vec0 has no UNIQUE constraint, so we guard against duplicates manually).
      const vecRows = src.prepare(`SELECT node_id, embedding FROM vec_nodes`).all();
      for (const v of vecRows) {
        if (hasVec.get(v.node_id)) { stat.skipped++; continue; }
        insVec.run(v.node_id, v.embedding);
        stat.vec_nodes++;
      }
    });
    copy();

    src.close();
    report.sources.push(stat);
    for (const k of Object.keys(stat)) {
      if (k !== 'from' && typeof totals[k] === 'number') totals[k] += stat[k];
    }
  }

  // FTS is derived from nodes — rebuild it from the final active node set so
  // copied nodes are keyword-searchable (sources may not carry an fts index).
  const rebuildFts = target.transaction(() => {
    target.exec('DELETE FROM fts_nodes');
    const insFts = target.prepare('INSERT INTO fts_nodes (node_id, name, content) VALUES (?, ?, ?)');
    const active = target.prepare('SELECT id, name, content FROM nodes WHERE valid_until IS NULL').all();
    for (const n of active) insFts.run(n.id, n.name, n.content);
  });
  rebuildFts();

  target.close();
  return report;
}

// Returns the path of a non-empty -wal/-shm sidecar if one exists (signals an
// uncheckpointed / live DB), else null.
function liveSidecar(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    const f = dbPath + suffix;
    if (existsSync(f)) {
      try { if (statSync(f).size > 0) return f; } catch { /* unreadable → ignore */ }
    }
  }
  return null;
}

// Merge a `domain` key into a node's JSON metadata string (creating it if absent).
function stampDomain(metadata, domain) {
  let meta = {};
  if (metadata) {
    try { meta = JSON.parse(metadata); } catch { meta = {}; }
  }
  meta.domain = domain;
  return JSON.stringify(meta);
}
