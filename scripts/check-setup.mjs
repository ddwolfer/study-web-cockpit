#!/usr/bin/env node
/**
 * check-setup.mjs — verify a clone of the system-design study coach is ready to run.
 *
 * Cross-platform (Windows / macOS / Linux). Run from anywhere:
 *     node scripts/check-setup.mjs
 *
 * It checks every prerequisite the coach needs (Node, installed native deps,
 * Gemini key, KG db, course material, launcher, and that no Windows-absolute
 * paths leaked into the config) and prints a ✅/⚠️/❌ report with fixes.
 *
 * Exit code 0 if nothing is broken (warnings allowed), 1 if any ❌ blocker.
 */
import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

let blockers = 0
let warns = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const warn = (m) => { warns++; console.log(`  ⚠️  ${m}`) }
const bad = (m) => { blockers++; console.log(`  ❌ ${m}`) }
const head = (m) => console.log(`\n—— ${m} ——`)

const rpath = (p) => join(ROOT, p)
const exists = (p) => existsSync(rpath(p))

console.log(`\nsystem-design study coach — setup check`)
console.log(`project root: ${ROOT}`)
console.log(`platform: ${process.platform}  node: ${process.version}`)

// 1) Node version ---------------------------------------------------------
head('Node.js')
{
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 18) ok(`Node ${process.version} (>=18)`)
  else bad(`Node ${process.version} too old — install Node 18+ (20 LTS recommended)`)
}

// 2) Dependencies installed (native modules must be built ON THIS machine) -
head('Dependencies (npm install per sub-package)')
for (const pkg of ['kg', 'mcp-gemini-video', 'study-web']) {
  if (exists(join(pkg, 'node_modules'))) ok(`${pkg}/node_modules present`)
  else bad(`${pkg}/node_modules missing — run:  cd ${pkg} && npm install`)
}
// native module load test (catches node_modules copied from another OS/arch)
head('Native modules load (better-sqlite3 / sqlite-vec)')
{
  const kgDir = rpath('kg')
  if (!existsSync(join(kgDir, 'node_modules'))) {
    warn('skipped — kg deps not installed yet')
  } else {
    for (const mod of ['better-sqlite3', 'sqlite-vec']) {
      const r = spawnSync(process.execPath, ['-e', `require('${mod}')`], { cwd: kgDir, encoding: 'utf8' })
      if (r.status === 0) ok(`${mod} loads`)
      else bad(`${mod} fails to load — reinstall on THIS machine: cd kg && rm -rf node_modules && npm install\n       (${(r.stderr || '').split('\n')[0]})`)
    }
  }
}

// 3) Gemini API key -------------------------------------------------------
head('GEMINI_API_KEY (for reading slides/videos)')
{
  const mask = (k) => k.length <= 8 ? '****' : `${k.slice(0, 4)}…${k.slice(-4)}`
  let key = process.env.GEMINI_API_KEY || ''
  let src = key ? 'env var' : ''
  const envFile = rpath(join('mcp-gemini-video', '.env'))
  if (!key && existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/m)
    if (m) { key = m[1].replace(/^["']|["']$/g, ''); src = 'mcp-gemini-video/.env' }
  }
  if (key && !/your.*key|xxxx|placeholder/i.test(key)) ok(`set via ${src} (${mask(key)})`)
  else bad('not set — cp mcp-gemini-video/.env.example mcp-gemini-video/.env and add your key,\n       or export GEMINI_API_KEY=... in your shell')
}

// 4) Knowledge graph db (your captured knowledge) -------------------------
head('Knowledge graph (kg/demo.db)')
{
  const db = 'kg/demo.db'
  if (exists(db) && statSync(rpath(db)).size > 0) ok(`${db} present (${(statSync(rpath(db)).size / 1024).toFixed(0)} KB)`)
  else warn(`${db} not built yet — optional; build the demo KG per README (npm install + seed)`)
}

// 5) Course material (gitignored — copy manually) -----------------------
head('Demo lessons (demo-lessons/)')
{
  let lessonsDir = 'demo-lessons'
  try {
    const mcp = JSON.parse(readFileSync(rpath('.mcp.json'), 'utf8'))
    lessonsDir = mcp.mcpServers?.['gemini-video']?.env?.LESSONS_DIR || lessonsDir
  } catch { /* fall back to default */ }
  if (exists(lessonsDir)) {
    const subs = readdirSync(rpath(lessonsDir)).filter(d => { try { return statSync(rpath(join(lessonsDir, d))).isDirectory() } catch { return false } })
    if (subs.length) ok(`${lessonsDir}/ present (${subs.length} chapters)`)
    else warn(`${lessonsDir}/ exists but is empty — copy the course folders in`)
  } else {
    warn(`${lessonsDir}/ missing — gitignored (copyright/size); copy it from Google Drive.\n       Needed only to OPEN/REREAD lessons; reviewing the KG works without it.`)
  }
}

// 6) Launcher -------------------------------------------------------------
head('Launcher')
{
  if (isWin) {
    if (exists('study-coach.cmd')) ok('study-coach.cmd present (Windows)')
    else bad('study-coach.cmd missing')
  } else {
    if (exists('study-coach.command')) {
      ok('study-coach.command present')
      try {
        if (statSync(rpath('study-coach.command')).mode & 0o111) ok('study-coach.command is executable')
        else warn('not executable yet — run:  chmod +x study-coach.command')
      } catch { /* ignore */ }
    } else bad('study-coach.command missing (macOS/Linux launcher)')
  }
}

// 7) Channel trust list (enabledMcpjsonServers) ---------------------------
head('study-web channel trust (enabledMcpjsonServers)')
{
  let trusted = []
  for (const f of ['.claude/settings.local.json', '.claude/settings.json']) {
    if (exists(f)) {
      try {
        const j = JSON.parse(readFileSync(rpath(f), 'utf8'))
        if (Array.isArray(j.enabledMcpjsonServers)) trusted = trusted.concat(j.enabledMcpjsonServers)
      } catch { /* ignore parse errors */ }
    }
  }
  const need = ['knowledge-graph', 'gemini-video', 'study-web']
  const missing = need.filter(s => !trusted.includes(s))
  if (!missing.length) ok('all three servers trusted')
  else warn(`not trusted: ${missing.join(', ')} — cp .claude/settings.local.json.example .claude/settings.local.json\n       (or approve each server once when Claude Code prompts)`)
}

// 8) No leftover Windows-absolute paths in config -------------------------
head('Config paths are portable (no hard-coded drive letters)')
{
  let leaked = false
  for (const f of ['.mcp.json', '.claude/settings.json']) {
    if (!exists(f)) continue
    const txt = readFileSync(rpath(f), 'utf8')
    const hits = txt.match(/(?<![A-Za-z])[A-Za-z]:[\\/]/g)
    if (hits) { leaked = true; warn(`${f} has absolute path(s) like "${hits[0]}…" — works on the original machine but breaks on others; change to relative (e.g. kg/main.js). See SETUP.md step 6 for ${f === '.claude/settings.json' ? 'the hook fix' : 'this'}.`) }
  }
  if (!leaked) ok('.mcp.json and .claude/settings.json use relative paths')
}

// summary -----------------------------------------------------------------
console.log(`\n${'='.repeat(48)}`)
if (blockers) console.log(`❌ ${blockers} blocker(s), ${warns} warning(s). Fix the ❌ items above, then re-run.`)
else if (warns) console.log(`✅ No blockers. ${warns} warning(s) — review above (often just course material / chmod).`)
else console.log('✅ All checks passed. Launch with the study-coach launcher and open http://127.0.0.1:7654')
console.log(`${'='.repeat(48)}\n`)
process.exit(blockers ? 1 : 0)
