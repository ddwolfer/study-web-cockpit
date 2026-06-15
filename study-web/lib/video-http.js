/**
 * video-http.js — pure, side-effect-free helpers extracted from server.js.
 *
 * Exported so that unit tests can import them without starting the HTTP /
 * MCP server, and so server.js can stay thin.
 */

/** Video-file extension whitelist (same regex as server.js). */
export const VIDEO_RE = /\.(mp4|m4v|webm|mov)$/i

/**
 * parseRange(rangeHeader, size)
 *
 * Parse an HTTP Range header and compute the byte range to serve.
 *
 * Supports:
 *   "bytes=<start>-<end>"   — normal range
 *   "bytes=<start>-"        — open-ended (to EOF)
 *   "bytes=-<N>"            — suffix range (last N bytes)
 *
 * Returns { satisfiable: false } when:
 *   - start or end is NaN
 *   - start > end
 *   - start >= size   (nothing to serve)
 *
 * Otherwise returns { satisfiable: true, start, end } with end clamped to
 * size - 1 (matching the server's `if (end >= size) end = size - 1` guard).
 *
 * @param {string|undefined} rangeHeader  value of req.headers.range
 * @param {number}           size         total file size in bytes
 * @returns {{ satisfiable: boolean, start?: number, end?: number }}
 */
export function parseRange(rangeHeader, size) {
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader ?? '')
  let start, end

  if (m && m[1] === '' && m[2] !== '') {
    // suffix range "bytes=-N" → last N bytes
    start = Math.max(0, size - parseInt(m[2], 10))
    end = size - 1
  } else {
    start = m && m[1] ? parseInt(m[1], 10) : 0
    end   = m && m[2] ? parseInt(m[2], 10) : size - 1
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    return { satisfiable: false }
  }

  // Clamp end to the last valid byte
  if (end >= size) end = size - 1

  return { satisfiable: true, start, end }
}

/**
 * parseVideoPath(pathname)
 *
 * Validate and decode a /video/<chapter>/<lesson>/<file> URL pathname.
 *
 * Rules (mirrors the /video route guard in server.js):
 *   1. pathname must start with "/video/"
 *   2. The remainder is split on "/" → exactly 3 segments after decodeURIComponent.
 *   3. Each segment must be non-empty and must not contain ".." or path
 *      separators (\\ or /).
 *   4. The third segment (file) must match VIDEO_RE.
 *
 * Returns { ok: true, chapter, lesson, file } on success,
 *         { ok: false } on any violation.
 *
 * @param {string} pathname  e.g. "/video/ch07/my-lesson/lecture.mp4"
 * @returns {{ ok: boolean, chapter?: string, lesson?: string, file?: string }}
 */
export function parseVideoPath(pathname) {
  if (!pathname.startsWith('/video/')) return { ok: false }

  let segs
  try {
    segs = pathname.slice('/video/'.length).split('/').map(decodeURIComponent)
  } catch {
    return { ok: false }
  }

  if (
    segs.length !== 3 ||
    segs.some(s => !s || s.includes('..') || /[\\/]/.test(s)) ||
    !VIDEO_RE.test(segs[2])
  ) {
    return { ok: false }
  }

  const [chapter, lesson, file] = segs
  return { ok: true, chapter, lesson, file }
}
