#!/usr/bin/env node
/**
 * check-web-notes.mjs — validate notes/**\/web-notes*.md against the study-web
 * term contract (see .claude/skills/study-web/SKILL.md):
 *   1. exactly one ```glossary block, holding strictly valid JSON
 *   2. every [[id]] / [[id|surface]] marker in the body has a glossary entry
 *      (nested markers inside glossary `short` strings too)
 *   3. no [[id|surface]] pipe form inside markdown table rows (| splits cells)
 *
 * Usage: node scripts/check-web-notes.mjs [notesDir]
 * Exits 1 if any file fails.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2] || join(process.cwd(), 'notes')
const TERM_RE = /\[\[([\w-]+)(?:\|([^\]]+))?\]\]/g

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/^web-notes.*\.md$/.test(e.name)) yield p
  }
}

let files = 0
let failed = 0

for (const file of walk(ROOT)) {
  files++
  const md = readFileSync(file, 'utf8')
  const problems = []

  // 1. exactly one glossary block with valid JSON
  const blocks = [...md.matchAll(/```glossary\s*\n([\s\S]*?)```/g)]
  let gloss = {}
  if (blocks.length !== 1) {
    problems.push(`glossary 區塊數量 = ${blocks.length}(必須恰好 1)`)
  }
  if (blocks.length >= 1) {
    try { gloss = JSON.parse(blocks[0][1]) }
    catch (e) { problems.push(`glossary JSON 解析失敗:${e.message}`) }
  }

  // body = everything outside fenced code blocks (mermaid/code/glossary)
  const body = md.replace(/```[\s\S]*?```/g, '')

  // 2. every marker resolves to a glossary entry
  const used = new Set()
  for (const m of body.matchAll(TERM_RE)) used.add(m[1])
  for (const def of Object.values(gloss)) {
    if (def && typeof def.short === 'string')
      for (const m of def.short.matchAll(TERM_RE)) used.add(m[1])
  }
  const missing = [...used].filter(id => !(id in gloss))
  if (missing.length) problems.push(`標記無 glossary 條目:${missing.join(', ')}`)

  // 3. pipe-form markers inside table rows break the table
  const tablePipe = body.split('\n')
    .filter(line => line.trimStart().startsWith('|') && /\[\[[\w-]+\|/.test(line))
  if (tablePipe.length) problems.push(`表格列含 [[id|…]] 豎線形式 ×${tablePipe.length}`)

  if (problems.length) {
    failed++
    console.log(`❌ ${file}`)
    for (const p of problems) console.log(`   - ${p}`)
  } else {
    console.log(`✅ ${file} (glossary ${Object.keys(gloss).length} 條, 標記 ${used.size} 個)`)
  }
}

console.log(`\n${files} 檔, ${failed} 檔有問題`)
process.exit(failed ? 1 : 0)
