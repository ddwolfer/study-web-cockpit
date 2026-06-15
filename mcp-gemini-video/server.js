/**
 * Gemini Video MCP Server
 * Delegates VIDEO understanding to Google Gemini (frames + audio) so a Claude Code
 * session — which cannot watch video — can ask questions about a lesson recording.
 *
 * Lives inside a generated learning project, registered as a SECOND MCP server
 * alongside the knowledge-graph engine. This server is ONLY about video.
 *
 * 3 tools:
 *   gemini_prepare_video  — upload the lesson's video via the Gemini Files API, poll
 *                           until ACTIVE, cache the file handle in memory.
 *   gemini_ask_video      — ask a scoped question about the lesson (optional start/end window).
 *   gemini_digest_lesson  — produce a full structured markdown digest of the lesson.
 *
 * Uses the '@google/genai' unified GenAI JS SDK. The client is LAZY-INITIALIZED so that
 * importing/booting this file never crashes when GEMINI_API_KEY is unset — only a tool
 * CALL errors with a clear message.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// projectRoot = the generated learning project (this server lives in <projectRoot>/mcp-gemini-video)
const projectRoot = path.join(__dirname, '..');

/**
 * Load this folder's .env (zero-dependency). The .env is the authoritative source
 * for GEMINI_API_KEY: it OVERRIDES any value inherited from the launching process.
 * This matters because the MCP host may spawn us with a stale/invalid GEMINI_API_KEY
 * baked in at host-launch time (e.g. .mcp.json's "${GEMINI_API_KEY}" expansion); a
 * fresh key dropped in .env then fixes us without restarting the host. .env is gitignored.
 */
function loadDotenv() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return; // no .env → rely on the process environment
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) process.env[key] = val; // .env wins
  }
}
loadDotenv();

const ASK_MODEL = process.env.GEMINI_ASK_MODEL || 'gemini-2.5-flash';
const DIGEST_MODEL = process.env.GEMINI_DIGEST_MODEL || 'gemini-2.5-pro';

const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.webm'];
const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
};

// Google keeps uploaded files ~48h. Re-upload when within this margin of expiry.
const FILE_TTL_MS = 48 * 60 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60 * 60 * 1000; // 1h safety margin

// In-memory cache of prepared videos, keyed by lesson name.
// value: { uri, mimeType, name, expiresAtMs }
const videoCache = new Map();

// Same, for uploaded slide PDFs.
const pdfCache = new Map();

// ─── Lazy GenAI client ───────────────────────────────────────────────────────
let _client = null;
function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Set GEMINI_API_KEY (export GEMINI_API_KEY=... or add it to this folder\'s .env) ' +
      'before using the gemini-video tools.'
    );
  }
  if (!_client) {
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function lessonsDir() {
  return process.env.LESSONS_DIR || path.join(projectRoot, 'lessons');
}

/** Find the first video file inside <lessonsDir>/<lesson>/. */
function resolveVideoFile(lesson) {
  const dir = path.join(lessonsDir(), lesson);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Lesson folder not found: ${dir}`);
  }
  const entries = fs.readdirSync(dir);
  const match = entries.find((f) => VIDEO_EXTS.includes(path.extname(f).toLowerCase()));
  if (!match) {
    throw new Error(
      `No video file (${VIDEO_EXTS.join(', ')}) found in ${dir}`
    );
  }
  return path.join(dir, match);
}

function isCacheFresh(entry) {
  return Boolean(entry) && entry.expiresAtMs - Date.now() > EXPIRY_MARGIN_MS;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upload a lesson file to the Gemini Files API by reading it into a Blob and uploading
 * the Blob — NOT the file path. Two reasons, both Windows + non-ASCII specific:
 *
 *  1) ByteString header crash. Given a string path, the SDK derives the basename and
 *     sends it in the `X-Goog-Upload-File-Name` HTTP header, which must be Latin-1.
 *     Our lesson files have Chinese names, so this throws
 *     "Cannot convert argument to a ByteString". A Blob has no name, so the SDK omits
 *     that header entirely.
 *
 *  2) Native upload crash. On Node 24 + Windows the SDK's path-based streaming upload
 *     (uploadFileFromPath) crashes intermittently with STATUS_STACK_BUFFER_OVERRUN
 *     (exit 0xC0000409) on multi-hundred-KB files. The Blob path (uploadBlob) is a
 *     different, stable code path.
 *
 * Trade-off: the whole file is buffered in memory (~2x its size transiently). Fine for
 * slide PDFs (a few MB); for large videos this costs RAM, but the streaming path is not
 * a usable alternative here because it crashes.
 */
async function uploadLessonFile(ai, filePath, mimeType) {
  const buf = await fs.promises.readFile(filePath);
  const blob = new Blob([buf], { type: mimeType });
  return ai.files.upload({ file: blob, config: { mimeType } });
}

/**
 * Ensure the lesson's video is uploaded and ACTIVE on Gemini's side; cache the handle.
 * Returns the cache entry { uri, mimeType, name, expiresAtMs }.
 */
async function ensurePrepared(lesson) {
  const cached = videoCache.get(lesson);
  if (isCacheFresh(cached)) return cached;

  const ai = getClient();
  const filePath = resolveVideoFile(lesson);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] || 'video/mp4';

  let uploaded = await uploadLessonFile(ai, filePath, mimeType);

  // Poll until the file leaves PROCESSING.
  const startedAt = Date.now();
  const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
  while (uploaded.state === 'PROCESSING') {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for Gemini to process video for lesson "${lesson}".`);
    }
    await sleep(3000);
    uploaded = await ai.files.get({ name: uploaded.name });
  }

  if (uploaded.state !== 'ACTIVE') {
    throw new Error(
      `Gemini failed to process video for lesson "${lesson}" (state=${uploaded.state}).`
    );
  }

  const entry = {
    uri: uploaded.uri,
    mimeType: uploaded.mimeType || mimeType,
    name: uploaded.name,
    expiresAtMs: Date.now() + FILE_TTL_MS,
  };
  videoCache.set(lesson, entry);
  return entry;
}

/** Build the createPartFromUri-style file part the SDK expects. */
function filePart(entry) {
  return { fileData: { fileUri: entry.uri, mimeType: entry.mimeType } };
}

/** Pull the plain text out of a generateContent response across SDK shapes. */
function responseText(res) {
  if (!res) return '';
  if (typeof res.text === 'string') return res.text;
  if (typeof res.text === 'function') return res.text();
  const parts = res?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((p) => p.text || '').join('');
  }
  return '';
}

/** List the lesson's slide PDFs (light theme only — skip *_dark.pdf), sorted by name. */
function listLessonPdfs(lesson) {
  const dir = path.join(lessonsDir(), lesson);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Lesson folder not found: ${dir}`);
  }
  return fs.readdirSync(dir)
    .filter((f) => path.extname(f).toLowerCase() === '.pdf')
    .filter((f) => !/_dark\.pdf$/i.test(f))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Find a lesson's slide PDF. If `file` is given, match it by exact name or by
 * filename stem (case-insensitive, with/without the .pdf extension); otherwise
 * return the first PDF in the folder. Throws (listing what IS available) when
 * the requested file can't be found.
 */
function resolvePdfFile(lesson, file) {
  const dir = path.join(lessonsDir(), lesson);
  const pdfs = listLessonPdfs(lesson);
  if (pdfs.length === 0) throw new Error(`No .pdf found in ${dir}`);
  if (!file) return path.join(dir, pdfs[0]);
  const want = file.toLowerCase().replace(/\.pdf$/i, '').trim();
  const match = pdfs.find((f) => f.toLowerCase().replace(/\.pdf$/i, '') === want);
  if (!match) {
    throw new Error(
      `PDF "${file}" not found in lesson "${lesson}". Available PDFs: ${pdfs.join(' | ')}`
    );
  }
  return path.join(dir, match);
}

/**
 * Ensure the lesson's slide PDF is uploaded and ACTIVE on Gemini; cache the handle.
 * PDFs are small, so this usually returns ACTIVE almost immediately.
 */
async function ensurePdf(lesson, file) {
  const filePath = resolvePdfFile(lesson, file);

  const cached = pdfCache.get(filePath);
  if (isCacheFresh(cached)) return cached;

  const ai = getClient();

  let uploaded = await uploadLessonFile(ai, filePath, 'application/pdf');

  const startedAt = Date.now();
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  while (uploaded.state === 'PROCESSING') {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for Gemini to process the PDF for lesson "${lesson}".`);
    }
    await sleep(2000);
    uploaded = await ai.files.get({ name: uploaded.name });
  }
  if (uploaded.state !== 'ACTIVE') {
    throw new Error(`Gemini failed to process the PDF for lesson "${lesson}" (state=${uploaded.state}).`);
  }

  const entry = {
    uri: uploaded.uri,
    mimeType: uploaded.mimeType || 'application/pdf',
    name: uploaded.name,
    expiresAtMs: Date.now() + FILE_TTL_MS,
  };
  pdfCache.set(filePath, entry);
  return entry;
}

// ─── Server ──────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'kg-study-gemini-video',
  version: '1.0.0',
  description: 'Gemini Video — delegate lesson video understanding (frames + audio) to Google Gemini',
});

// ─── gemini_prepare_video ───
server.tool(
  'gemini_prepare_video',
  'Resolve the lesson\'s video file, upload it to the Gemini Files API, wait until it is ACTIVE, and cache the handle. Files live ~48h on Google\'s side; cached uploads are reused.',
  {
    lesson: z.string().describe('Lesson name = subfolder under <projectRoot>/lessons/ (or LESSONS_DIR)'),
  },
  async ({ lesson }) => {
    try {
      const cached = videoCache.get(lesson);
      if (isCacheFresh(cached)) {
        return {
          content: [{
            type: 'text',
            text: `Lesson "${lesson}" already prepared (cached, ACTIVE). uri=${cached.uri}`,
          }],
        };
      }
      const entry = await ensurePrepared(lesson);
      return {
        content: [{
          type: 'text',
          text: `Prepared lesson "${lesson}": uploaded and ACTIVE on Gemini. uri=${entry.uri} (cached ~48h).`,
        }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `ERROR: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ─── gemini_ask_video ───
server.tool(
  'gemini_ask_video',
  'Ask Gemini a question about the lesson video. Optionally scope to a [start,end] timestamp window (mm:ss). Prepares the lesson automatically if not cached.',
  {
    lesson: z.string().describe('Lesson name = subfolder under <projectRoot>/lessons/'),
    question: z.string().describe('What you want to know about the video'),
    start: z.string().optional().describe('Optional window start, e.g. "01:30"'),
    end: z.string().optional().describe('Optional window end, e.g. "04:15"'),
  },
  async ({ lesson, question, start, end }) => {
    try {
      const ai = getClient();
      const entry = await ensurePrepared(lesson);

      const scope = (start && end)
        ? `Focus ONLY on the segment from ${start} to ${end}. `
        : '';
      const prompt =
        `${scope}${question}. ` +
        'Describe any diagrams/architecture drawn on screen, and cite timestamps like [mm:ss].';

      const res = await ai.models.generateContent({
        model: ASK_MODEL,
        contents: [
          { role: 'user', parts: [filePart(entry), { text: prompt }] },
        ],
      });

      const text = responseText(res) || '(no text returned by model)';
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `ERROR: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ─── gemini_digest_lesson ───
server.tool(
  'gemini_digest_lesson',
  'Produce a full structured markdown digest of the lesson video: transcript-level summary, every diagram/architecture drawn, the architecture evolution over time, and key timestamps. Prepares the lesson automatically if not cached.',
  {
    lesson: z.string().describe('Lesson name = subfolder under <projectRoot>/lessons/'),
  },
  async ({ lesson }) => {
    try {
      const ai = getClient();
      const entry = await ensurePrepared(lesson);

      const prompt = [
        'Produce a FULL structured digest of this lesson video as Markdown.',
        'Include the following sections, in order:',
        '',
        '## Summary',
        'A transcript-level summary of what is taught, in narrative order.',
        '',
        '## Diagrams & Architecture',
        'Describe EVERY diagram / architecture / drawing shown on screen. For each one, ',
        'describe the components, their relationships, and what it represents.',
        '',
        '## Architecture Evolution',
        'How the architecture/diagrams change and build up over the course of the video.',
        '',
        '## Key Timestamps',
        'A bulleted list of the most important moments, each cited like [mm:ss].',
        '',
        'Cite timestamps like [mm:ss] throughout wherever relevant.',
      ].join('\n');

      const res = await ai.models.generateContent({
        model: DIGEST_MODEL,
        contents: [
          { role: 'user', parts: [filePart(entry), { text: prompt }] },
        ],
      });

      const text = responseText(res) || '(no markdown returned by model)';
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `ERROR: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ─── gemini_ask_pdf ───
server.tool(
  'gemini_ask_pdf',
  'Ask Gemini about the lesson\'s slide PDF. Slides are visual + bilingual; Gemini reads the text (including Chinese) and any diagrams. Uploads/caches the PDF on first use. If the lesson folder has multiple PDFs and `file` is omitted, returns the list of available PDFs instead of answering.',
  {
    lesson: z.string().describe('Lesson name = subfolder under <projectRoot>/lessons/ (or LESSONS_DIR)'),
    question: z.string().describe('What you want to know from the slides'),
    file: z.string().optional().describe('Which PDF in the lesson folder to read (name or stem, e.g. "REST" or "REST.pdf"). Required only when the folder has more than one PDF.'),
  },
  async ({ lesson, question, file }) => {
    try {
      const pdfs = listLessonPdfs(lesson);
      if (pdfs.length > 1 && !file) {
        return { content: [{ type: 'text', text:
          `Lesson "${lesson}" has ${pdfs.length} PDFs. Re-call with the "file" parameter set to one of:\n` +
          pdfs.map((f) => `- ${f}`).join('\n') }] };
      }
      const ai = getClient();
      const entry = await ensurePdf(lesson, file);
      const prompt =
        `Based on these lecture slides, answer: ${question}. ` +
        'Quote the exact slide text where relevant and PRESERVE the original language (including Chinese) — do not translate or paraphrase quotes. Note any diagrams.';
      const res = await ai.models.generateContent({
        model: ASK_MODEL,
        contents: [{ role: 'user', parts: [filePart(entry), { text: prompt }] }],
      });
      const text = responseText(res) || '(no text returned by model)';
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true };
    }
  }
);

// ─── gemini_digest_pdf ───
server.tool(
  'gemini_digest_pdf',
  'Full slide-by-slide digest of the lesson\'s slide PDF: verbatim slide text (preserving Chinese) + diagram descriptions. Use for quote-grade capture of a PDF-only lesson. Uploads/caches on first use. If the lesson folder has multiple PDFs and `file` is omitted, returns the list of available PDFs instead of digesting.',
  {
    lesson: z.string().describe('Lesson name = subfolder under <projectRoot>/lessons/'),
    file: z.string().optional().describe('Which PDF in the lesson folder to digest (name or stem, e.g. "B+ Tree" or "B+ Tree.pdf"). Required only when the folder has more than one PDF.'),
  },
  async ({ lesson, file }) => {
    try {
      const pdfs = listLessonPdfs(lesson);
      if (pdfs.length > 1 && !file) {
        return { content: [{ type: 'text', text:
          `Lesson "${lesson}" has ${pdfs.length} PDFs. Re-call with the "file" parameter set to one of:\n` +
          pdfs.map((f) => `- ${f}`).join('\n') }] };
      }
      const ai = getClient();
      const entry = await ensurePdf(lesson, file);
      const prompt = [
        'Go through these lecture slides IN ORDER and produce Markdown, one section per slide:',
        '',
        '## Slide N',
        '- **Verbatim text**: the exact text on the slide, preserving the original language',
        '  (including Chinese). Do NOT translate or paraphrase — reproduce it faithfully.',
        '- **Diagram**: if the slide has a diagram / architecture, describe its components and relationships.',
        '',
        'This will be used as quote-grade source material, so faithfulness matters more than brevity.',
      ].join('\n');
      const res = await ai.models.generateContent({
        model: DIGEST_MODEL,
        contents: [{ role: 'user', parts: [filePart(entry), { text: prompt }] }],
      });
      const text = responseText(res) || '(no markdown returned by model)';
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true };
    }
  }
);

// Graceful shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[gemini-video] MCP server started');
console.error(`[gemini-video] lessons dir: ${lessonsDir()}`);
console.error(`[gemini-video] ask model: ${ASK_MODEL} | digest model: ${DIGEST_MODEL}`);
if (!process.env.GEMINI_API_KEY) {
  console.error('[gemini-video] WARNING: GEMINI_API_KEY is not set — tool calls will error until it is.');
}
