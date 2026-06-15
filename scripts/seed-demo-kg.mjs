#!/usr/bin/env node
/**
 * seed-demo-kg — faithfully import kg/demo-seeds.json into a knowledge-graph db.
 *
 *   node scripts/seed-demo-kg.mjs                 # → kg/demo.db (default)
 *   node scripts/seed-demo-kg.mjs --db kg/x.db    # custom db
 *   node scripts/seed-demo-kg.mjs --db kg/demo.db path/to/seeds.json
 *
 * Unlike the engine's generic kg/scripts/seed-principles.js (which infers trust
 * from quote-presence and keeps only `category`), this importer preserves the
 * full seed shape — trust, quote, source, and the whole metadata object
 * (domain / lesson / section / category) — i.e. exactly what the coach's
 * `store_knowledge` MCP tool writes during a live lesson.
 *
 * It also VALIDATES every node against the engine's schema enums up front, so a
 * malformed seed (e.g. a `trust` word in the `type` field) fails loudly here
 * instead of silently hitting a SQLite CHECK on the first row.
 *
 * FTS5 full-text search works immediately. Vector (semantic) search is NOT
 * populated here to avoid the one-time embedding-model download; backfill it
 * later with: node kg/scripts/backfill-embeddings.js --db kg/demo.db
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { getDb, closeDb, setDbPath } from '../kg/lib/db.js'

// Must mirror the CHECK constraints in kg/lib/db.js.
const TYPES = ['rule', 'procedure', 'observation', 'insight', 'core', 'preference']
const TRUSTS = ['principle', 'pattern', 'inference']

const __dirname = dirname(fileURLToPath(import.meta.url))
const { values, positionals } = parseArgs({
  options: { db: { type: 'string' } },
  allowPositionals: true,
  strict: false,
})

const dbPath = values.db || 'kg/demo.db'
setDbPath(dbPath)

const seedsPath = positionals[0]
  ? resolve(positionals[0])
  : join(__dirname, '..', 'kg', 'demo-seeds.json')

if (!existsSync(seedsPath)) {
  console.error(`✗ seeds file not found: ${seedsPath}`)
  process.exit(1)
}

let seeds
try {
  seeds = JSON.parse(readFileSync(seedsPath, 'utf8'))
} catch (e) {
  console.error(`✗ failed to parse ${seedsPath}: ${e.message}`)
  process.exit(1)
}
if (!Array.isArray(seeds) || !seeds.length) {
  console.error('✗ seeds file is empty or not an array')
  process.exit(1)
}

// ---- validate BEFORE touching the db, so bad data fails loudly + atomically ----
const errors = []
seeds.forEach((n, i) => {
  const at = `node[${i}] "${n.name ?? '(unnamed)'}"`
  if (!n.name || !n.content) errors.push(`${at}: missing name/content`)
  if (!TYPES.includes(n.type)) errors.push(`${at}: invalid type "${n.type}" — must be one of ${TYPES.join('/')}`)
  if (!TRUSTS.includes(n.trust)) errors.push(`${at}: invalid trust "${n.trust}" — must be one of ${TRUSTS.join('/')}`)
  if (n.trust === 'principle' && !n.quote) errors.push(`${at}: trust=principle requires a "quote" (anti-fabrication rule)`)
})
if (errors.length) {
  console.error(`✗ ${errors.length} seed validation error(s):`)
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}

const now = new Date().toISOString()
const db = getDb()

const findByName = db.prepare('SELECT id FROM nodes WHERE name = ?')
const insertNode = db.prepare(`
  INSERT INTO nodes (id, type, trust, name, content, source, quote, metadata, stability, memory_level, valid_from, access_count, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const insertFts = db.prepare('INSERT INTO fts_nodes (node_id, name, content) VALUES (?, ?, ?)')

let inserted = 0, skipped = 0
const seedAll = db.transaction(() => {
  for (const n of seeds) {
    if (findByName.get(n.name)) { skipped++; continue }   // idempotent by name
    const id = randomUUID()
    const meta = n.metadata && typeof n.metadata === 'object' ? n.metadata : {}
    const fundamental = meta.category === 'fundamental'
    const stability = fundamental ? 365 : 30
    const level = fundamental ? 4 : 3
    insertNode.run(
      id, n.type, n.trust, n.name, n.content,
      n.source || null, n.quote || null, JSON.stringify(meta),
      stability, level, now, 0, now, now,
    )
    insertFts.run(id, n.name, n.content)
    inserted++
  }
})
seedAll()
closeDb()

console.log(`✓ ${dbPath}: inserted ${inserted}, skipped ${skipped} (already present) — ${seeds.length} seed nodes total`)
if (inserted) console.log('  FTS5 search ready. For semantic search: node kg/scripts/backfill-embeddings.js --db ' + dbPath)
