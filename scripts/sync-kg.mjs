#!/usr/bin/env node
/**
 * sync-kg — push the knowledge graph to git so other machines get it.
 *
 *   node scripts/sync-kg.mjs            # checkpoint WAL → commit kg db → push
 *   node scripts/sync-kg.mjs --no-push  # commit only, don't push
 *
 * The KG runs SQLite in WAL mode: new captures sit in kg/demo.db-wal
 * (gitignored) until checkpointed into the main .db. Plain git therefore shows
 * "db unchanged" even when there's fresh knowledge. This script checkpoints
 * first, then commits ONLY the .db file (it won't touch your other changes),
 * then pushes. Safe to run while the study session / MCP server is open.
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DB = join(ROOT, 'kg', 'demo.db')
const noPush = process.argv.includes('--no-push')
const require = createRequire(import.meta.url)

const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })

// 1) checkpoint WAL → main .db, read counts
let nodes = '?', edges = '?'
try {
  const Database = require(join(ROOT, 'kg', 'node_modules', 'better-sqlite3'))
  const db = new Database(DB)
  const cp = db.pragma('wal_checkpoint(TRUNCATE)')
  console.log('• WAL checkpoint:', JSON.stringify(cp))
  try { nodes = db.prepare('SELECT COUNT(*) c FROM nodes').get().c } catch {}
  try { edges = db.prepare('SELECT COUNT(*) c FROM edges').get().c } catch {}
  db.close()
  console.log(`• KG now: ${nodes} nodes, ${edges} edges`)
} catch (e) {
  console.error('✗ checkpoint failed:', e.message)
  console.error('  (is kg/ installed? run: cd kg && npm install)')
  process.exit(1)
}

// 2) stage ONLY the db, see if it actually changed
git('add', 'kg/demo.db')
const changed = git('diff', '--cached', '--quiet', '--', 'kg/demo.db').status === 1
if (!changed) {
  console.log('✓ KG db already in sync — nothing to commit.')
  process.exit(0)
}

// 3) commit just the db (pathspec commit ignores your other staged/unstaged work)
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
const msg = `chore: sync KG db (${nodes} nodes, ${edges} edges) ${stamp}`
const c = git('commit', 'kg/demo.db', '-m', msg)
process.stdout.write(c.stdout || '')
if (c.status !== 0) { console.error('✗ commit failed:', c.stderr); process.exit(1) }
console.log('✓ committed:', msg)

// 4) push
if (noPush) { console.log('• --no-push: skipped push.'); process.exit(0) }
const branch = (git('rev-parse', '--abbrev-ref', 'HEAD').stdout || 'main').trim()
const p = git('push', 'origin', branch)
process.stderr.write(p.stderr || '')
if (p.status !== 0) {
  console.error('✗ push failed (committed locally though). Check network/auth, then: git push')
  process.exit(1)
}
console.log(`✓ pushed to origin/${branch}. Other machines: git pull`)
