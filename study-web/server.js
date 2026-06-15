#!/usr/bin/env node
/**
 * study-web — local web cockpit for the system-design study coach.
 *
 * One Node process, two faces:
 *   1. A claude/channel MCP server (stdio) that bridges a browser to the
 *      Claude Code study-coach session.
 *        - inbound  (browser -> Claude): notifications/claude/channel
 *        - outbound (Claude -> browser): the `reply` and `show_notes` tools
 *   2. A localhost HTTP + WebSocket server (127.0.0.1 only) serving the SPA.
 *
 * Modeled on the official `fakechat` channel plugin, ported Bun -> Node, with
 * the stdin-EOF shutdown fakechat omits (so the port is released when the
 * session closes — otherwise the next launch hits EADDRINUSE).
 *
 * IMPORTANT: with MCP stdio transport, stdout is RESERVED for JSON-RPC.
 * Any stray stdout write corrupts the protocol — all logging goes to stderr.
 */

// Hard-guard: a stray console.log anywhere (ours or a dep's) would poison the
// stdio JSON-RPC stream. Route it to stderr.
console.log = console.error
console.info = console.error

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, readdirSync, createReadStream, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { parseRange, parseVideoPath, VIDEO_RE as _VIDEO_RE } from './lib/video-http.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PORT = Number(process.env.STUDY_WEB_PORT ?? 7654)
const INDEX_HTML = join(__dirname, 'public', 'index.html')
const STATE_FILE = join(__dirname, 'state.json')
const PROJECT_ROOT = join(__dirname, '..')
// Public demo: the course-material root and the notes root are unified under a
// single self-contained demo-lessons/ folder (one folder per lesson holds the
// .mp4 + web-notes.md + video-notes.md). In the original private study repo these
// were two separate trees — copyrighted course PDFs/videos vs. the rewritten notes/.
const LESSONS_ROOT = join(PROJECT_ROOT, 'demo-lessons')
const NOTES_ROOT = join(PROJECT_ROOT, 'demo-lessons')
const VIDEO_RE = _VIDEO_RE   // re-export from lib/video-http.js

// ---- WebSocket client registry + broadcast ----
const clients = new Set()
let seq = 0
const nextId = () => `m${++seq}-${process.pid}`

function broadcast(obj) {
  const data = JSON.stringify(obj)
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(data) } catch { /* dead socket — dropped on close */ }
    }
  }
}

// ---- session state, replayed to a (re)connecting browser ----
// The browser holds no persistent state; on refresh/reconnect it would lose the
// notes panel + chat log. We keep the authoritative copy here and send a
// `snapshot` on every WS connection so the page can rebuild (and catch up on
// anything broadcast while it was briefly disconnected).
// It is ALSO persisted to state.json so closing the coach session / rebooting
// doesn't wipe the reading panel — next launch restores the last lesson + chat.
let lastNotes = null            // { lesson, markdown, ts } — last show_notes
const history = []              // [{ from:'user'|'assistant', text, ts }]
const HISTORY_MAX = 200
try {
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  if (s && s.lastNotes && typeof s.lastNotes.markdown === 'string') lastNotes = s.lastNotes
  if (s && Array.isArray(s.history)) history.push(...s.history.slice(-HISTORY_MAX))
} catch { /* first run / corrupt state — start clean */ }

let saveTimer = null
function saveState(immediate = false) {
  if (immediate) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    try { writeFileSync(STATE_FILE, JSON.stringify({ lastNotes, history })) }
    catch (err) { console.error('[study-web] state save failed:', err) }
    return
  }
  if (saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; saveState(true) }, 500)
}

function pushHistory(entry) {
  history.push(entry)
  if (history.length > HISTORY_MAX) history.shift()
  saveState()
}

// ---- lesson catalog (for the welcome screen) ----
// Scans the course-material tree; a lesson is "cached" (⚡ instant load) when
// notes/<chapter>/<lesson>/ already holds a rewritten web-notes*.md.
function listLessons() {
  const chapters = []
  for (const ch of readdirSync(LESSONS_ROOT, { withFileTypes: true })) {
    if (!ch.isDirectory()) continue
    const lessons = []
    for (const ls of readdirSync(join(LESSONS_ROOT, ch.name), { withFileTypes: true })) {
      if (!ls.isDirectory()) continue
      let cached = false
      try {
        // A lesson is "cached" when its notes dir holds a rewritten web-notes*.md
        // (chapters 03-06) OR a video-notes*.md (chapter 07 video lessons).
        cached = readdirSync(join(NOTES_ROOT, ch.name, ls.name))
          .some(f => (f.startsWith('web-notes') || f.startsWith('video-notes')) && f.endsWith('.md'))
      } catch { /* no notes dir yet */ }
      lessons.push({ name: ls.name, cached })
    }
    if (lessons.length) chapters.push({ name: ch.name, lessons })
  }
  return chapters
}

// ---- video lookup ----
// ch07 lessons ship an .mp4 next to the slides. Find it by lesson FOLDER NAME,
// searching across chapters (folder names are unique across the course), so both
// the welcome-screen path (knows the chapter) and a show_notes broadcast (lesson
// name only) resolve. An optional `chapter` short-circuits the search. Returns
// { chapter, file } or null (→ no player for concept lessons).
function findVideo(lesson, chapter = '') {
  let chapterNames = []
  if (chapter) chapterNames = [chapter]
  else {
    try {
      chapterNames = readdirSync(LESSONS_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name)
    } catch { return null }
  }
  for (const ch of chapterNames) {
    let file = null
    try { file = readdirSync(join(LESSONS_ROOT, ch, lesson)).find(f => VIDEO_RE.test(f)) }
    catch { /* lesson folder not in this chapter */ }
    if (file) return { chapter: ch, file }
  }
  return null
}

// ---- MCP channel server (low-level Server: needed to declare experimental caps) ----
const mcp = new Server(
  { name: 'study-web', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      '你正在當「系統設計陪讀教練」。使用者透過瀏覽器 (study-web) 跟你互動,不是看終端機。',
      '使用者的訊息會以 <channel source="study-web" chat_id="web" ...> 進來。',
      '你的終端機輸出「不會」到瀏覽器 —— 想讓使用者看到的東西,一律用工具送:',
      '  - reply(text): 送一則訊息到右側聊天面板 (支援 markdown / mermaid)。',
      '  - show_notes(lesson, markdown): 把你重寫好的「可點網頁筆記」推到左側閱讀面板。',
      '重寫講義成網頁筆記時,遵循專案 study-web skill 的「可點術語約定」(行內 [[id|顯示]] 標記 + 結尾一個 glossary JSON 區塊)。',
      '收到的 chat_id 原樣帶回 reply。其餘遵循 CLAUDE.md 的教練人設、信任規則與 KG 流程。',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a message to the study-web chat panel (right side). Renders as markdown + mermaid. Echo the chat_id from the inbound <channel> tag.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Echo the inbound chat_id (usually "web").' },
          text: { type: 'string', description: 'Markdown message body.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'show_notes',
      description:
        'Push rewritten lesson web-notes to the study-web reading panel (left side). markdown may use [[id|surface]] clickable-term markers plus exactly one ```glossary JSON block per the study-web term contract.',
      inputSchema: {
        type: 'object',
        properties: {
          lesson: { type: 'string', description: 'Lesson folder name, shown as the panel title.' },
          markdown: { type: 'string', description: 'The rewritten notes markdown (with [[term]] markers + a glossary block).' },
        },
        required: ['markdown'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments ?? {}
  try {
    switch (req.params.name) {
      case 'reply': {
        const text = String(args.text ?? '')
        const id = nextId()
        pushHistory({ from: 'assistant', text, ts: Date.now() })
        broadcast({ type: 'msg', id, from: 'assistant', text, ts: Date.now() })
        return { content: [{ type: 'text', text: `sent to chat (${id})` }] }
      }
      case 'show_notes': {
        const markdown = String(args.markdown ?? '')
        const lesson = args.lesson ? String(args.lesson) : ''
        lastNotes = { lesson, markdown, ts: Date.now() }
        saveState()
        broadcast({ type: 'notes', lesson, markdown, ts: Date.now() })
        return { content: [{ type: 'text', text: `notes shown in reading panel (${markdown.length} chars)` }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())

// inbound: browser -> Claude session. Fire-and-forget (dropped silently if the
// session didn't load us as a channel — that's why the UI shows an ack timeout).
function deliver(text, meta = {}) {
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        chat_id: 'web',
        message_id: nextId(),
        user: 'web',
        ts: new Date().toISOString(),
        ...meta,
      },
    },
  }).catch(err => console.error('[study-web] deliver failed:', err))
}

// ---- HTTP + WebSocket server ----
function readBody(req) {
  return new Promise(resolve => {
    let data = ''
    req.on('data', c => { data += c })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')

  // POST /say  {text}  — browser HTTP fallback + curl smoke-tests
  if (req.method === 'POST' && url.pathname === '/say') {
    const body = await readBody(req)
    let text = ''
    try { text = JSON.parse(body).text ?? '' } catch { text = body }
    text = String(text).trim()
    if (text) deliver(text)
    res.writeHead(204).end()
    return
  }

  // GET /api/notes?chapter=&lesson= — serve a cached web-notes*.md directly,
  // so the browser can load a prepared lesson into the reading panel WITHOUT a
  // round-trip through the Claude session (instant, zero-token). Returns the
  // raw markdown; the frontend renders it the same way as a `notes` broadcast.
  if (req.method === 'GET' && url.pathname === '/api/notes') {
    const chapter = url.searchParams.get('chapter') || ''
    const lesson = url.searchParams.get('lesson') || ''
    // Guard against path traversal — names must be single path segments.
    if (!chapter || !lesson || /[\\/]|\.\./.test(chapter) || /[\\/]|\.\./.test(lesson)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'bad chapter/lesson' }))
      return
    }
    const dir = join(NOTES_ROOT, chapter, lesson)
    let file = null
    try {
      // Prefer the canonical web-notes.md; fall back to web-notes*.md, then to
      // video-notes.md / video-notes*.md (ch07 video lessons use that name).
      const mds = readdirSync(dir).filter(f => f.endsWith('.md'))
      const web = mds.filter(f => f.startsWith('web-notes'))
      const vid = mds.filter(f => f.startsWith('video-notes'))
      file = web.includes('web-notes.md') ? 'web-notes.md'
        : web[0] || (vid.includes('video-notes.md') ? 'video-notes.md' : vid[0])
    } catch { /* no notes dir */ }
    if (!file) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'no web-notes for this lesson' }))
      return
    }
    let markdown = ''
    try { markdown = readFileSync(join(dir, file), 'utf8') }
    catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: err.message }))
      return
    }
    // Mirror it into authoritative state + broadcast, so a refresh restores it
    // and any other open tab follows along — same effect as show_notes.
    lastNotes = { lesson, markdown, ts: Date.now() }
    saveState()
    broadcast({ type: 'notes', lesson, markdown, ts: Date.now() })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ lesson, markdown }))
    return
  }

  // GET /api/lessons — course catalog for the welcome screen
  if (req.method === 'GET' && url.pathname === '/api/lessons') {
    let chapters = []
    try { chapters = listLessons() }
    catch (err) { console.error('[study-web] listLessons failed:', err.message) }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ chapters }))
    return
  }

  // GET /api/video?lesson=<folder>[&chapter=<folder>] — locate the lesson's .mp4
  // and return a /video/... URL the <video> element streams from. 404 for lessons
  // with no video (chapters 03-06) → the frontend just shows no player.
  if (req.method === 'GET' && url.pathname === '/api/video') {
    const lesson = url.searchParams.get('lesson') || ''
    const wantCh = url.searchParams.get('chapter') || ''
    if (!lesson || /[\\/]|\.\./.test(lesson) || (wantCh && /[\\/]|\.\./.test(wantCh))) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'bad lesson/chapter' }))
      return
    }
    const found = findVideo(lesson, wantCh)
    if (!found) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'no video for this lesson' }))
      return
    }
    const src = '/video/' + encodeURIComponent(found.chapter) + '/' +
      encodeURIComponent(lesson) + '/' + encodeURIComponent(found.file)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ chapter: found.chapter, lesson, src }))
    return
  }

  // GET /video/<chapter>/<lesson>/<file> — stream a course .mp4 from disk with
  // HTTP Range support (206) so the scrubber works. 127.0.0.1-only, but we still
  // hard-guard traversal: exactly three single-name segments, video extension.
  if (req.method === 'GET' && url.pathname.startsWith('/video/')) {
    const parsed = parseVideoPath(url.pathname)
    if (!parsed.ok) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad video path')
      return
    }
    const { chapter: segCh, lesson: segLs, file: segFile } = parsed
    const filePath = join(LESSONS_ROOT, segCh, segLs, segFile)
    let size
    try { size = statSync(filePath).size }
    catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('video not found'); return }
    const type = /\.webm$/i.test(segFile) ? 'video/webm'
      : /\.mov$/i.test(segFile) ? 'video/quicktime' : 'video/mp4'
    // pipe a (possibly partial) read; a mid-stream I/O error must NOT become an
    // uncaughtException — this process is also the MCP channel + WS hub.
    const sendStream = opts => {
      const stream = createReadStream(filePath, opts)
      stream.on('error', err => {
        console.error('[study-web] video stream error:', err.message)
        res.destroy(err)
      })
      stream.pipe(res)
    }
    const rangeHdr = req.headers.range
    if (rangeHdr) {
      const r = parseRange(rangeHdr, size)
      if (!r.satisfiable) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end()
        return
      }
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${r.start}-${r.end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': r.end - r.start + 1,
      })
      sendStream({ start: r.start, end: r.end })
    } else {
      res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' })
      sendStream({})
    }
    return
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = readFileSync(INDEX_HTML, 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        .end('study-web: public/index.html missing — ' + err.message)
    }
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
})

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
wss.on('connection', ws => {
  clients.add(ws)
  // Replay authoritative state so a refreshed/reconnected page rebuilds its
  // notes panel + chat log (and catches up on anything sent while it was away).
  try { ws.send(JSON.stringify({ type: 'snapshot', notes: lastNotes, history })) } catch { /* socket already gone */ }
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
  ws.on('message', raw => {
    try {
      const m = JSON.parse(String(raw))
      if (m.type === 'ask') {
        // deeper-mode cards send {mode,term,question} with no `text` — build the
        // prompt from term/question; plain chat sends {text}. Don't gate on text.
        let content = typeof m.text === 'string' ? m.text.trim() : ''
        // Record the user's displayed bubble (m.text is the bubble label for
        // both plain chat and deeper cards) so it survives a refresh.
        if (content) pushHistory({ from: 'user', text: content, ts: Date.now() })
        if (m.mode === 'deeper' && m.term) {
          const q = (m.question || '').trim()
          content = `[在課程脈絡中深入解釋術語「${m.term}」]${q ? ' ' + q : ''}`
        }
        if (content) deliver(content)
      }
    } catch { /* ignore malformed frames */ }
  })
})

// listen on 127.0.0.1, fall forward on EADDRINUSE so a stale process can't
// take the whole MCP server down.
function listen(port, attemptsLeft = 10) {
  httpServer.once('error', err => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.error(`[study-web] port ${port} in use, trying ${port + 1}`)
      listen(port + 1, attemptsLeft - 1)
    } else {
      console.error('[study-web] HTTP listen error:', err)
      process.exit(1)
    }
  })
  httpServer.listen(port, '127.0.0.1', () => {
    console.error(`[study-web] UI ready: http://127.0.0.1:${port}`)
  })
}
listen(DEFAULT_PORT)

// ---- clean shutdown on stdin EOF (Claude Code closed the MCP connection) ----
let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.error('[study-web] shutting down')
  saveState(true)
  setTimeout(() => process.exit(0), 2000).unref()
  try { for (const ws of clients) ws.close() } catch { /* best effort */ }
  wss.close(() => {})
  httpServer.close(() => process.exit(0))
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
