/**
 * Unit tests for lib/video-http.js
 *
 * Run with:
 *   node --test study-web/lib/
 * or from study-web/:
 *   node --test lib/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRange, parseVideoPath, VIDEO_RE } from './video-http.js'

// ---------------------------------------------------------------------------
// parseRange
// ---------------------------------------------------------------------------

test('parseRange: normal range within bounds', () => {
  // size=10000, request bytes=0-1023
  const r = parseRange('bytes=0-1023', 10000)
  assert.equal(r.satisfiable, true)
  assert.equal(r.start, 0)
  assert.equal(r.end, 1023)
})

test('parseRange: open-ended "bytes=500-" returns to EOF', () => {
  const r = parseRange('bytes=500-', 10000)
  assert.equal(r.satisfiable, true)
  assert.equal(r.start, 500)
  assert.equal(r.end, 9999)        // clamped to size-1
})

test('parseRange: suffix range "bytes=-500" returns last 500 bytes', () => {
  const r = parseRange('bytes=-500', 10000)
  assert.equal(r.satisfiable, true)
  assert.equal(r.start, 9500)
  assert.equal(r.end, 9999)
})

test('parseRange: suffix range larger than file returns from byte 0', () => {
  // bytes=-50000 on a 10000-byte file → start = max(0, 10000-50000) = 0
  const r = parseRange('bytes=-50000', 10000)
  assert.equal(r.satisfiable, true)
  assert.equal(r.start, 0)
  assert.equal(r.end, 9999)
})

test('parseRange: start >= size → unsatisfiable (416)', () => {
  const r = parseRange('bytes=10000-10999', 10000)
  assert.equal(r.satisfiable, false)
})

test('parseRange: start > end → unsatisfiable', () => {
  const r = parseRange('bytes=500-100', 10000)
  assert.equal(r.satisfiable, false)
})

test('parseRange: end clamped when it exceeds size-1', () => {
  // bytes=9500-99999 on size=10000 → end clamped to 9999
  const r = parseRange('bytes=9500-99999', 10000)
  assert.equal(r.satisfiable, true)
  assert.equal(r.start, 9500)
  assert.equal(r.end, 9999)
})

test('parseRange: no Range header (undefined) → returns full range', () => {
  // When rangeHeader is undefined, the regex does not match → m is null →
  // start=0, end=size-1. Still satisfiable.
  const r = parseRange(undefined, 10000)
  assert.equal(r.satisfiable, true)
  assert.equal(r.start, 0)
  assert.equal(r.end, 9999)
})

test('parseRange: size=1 exact hit byte 0', () => {
  const r = parseRange('bytes=0-0', 1)
  assert.equal(r.satisfiable, true)
  assert.equal(r.start, 0)
  assert.equal(r.end, 0)
})

test('parseRange: start=0 equals size=0 → unsatisfiable', () => {
  // A 0-byte file can never satisfy any range
  const r = parseRange('bytes=0-', 0)
  assert.equal(r.satisfiable, false)
})

// ---------------------------------------------------------------------------
// parseVideoPath
// ---------------------------------------------------------------------------

test('parseVideoPath: valid 3-segment .mp4 path', () => {
  const r = parseVideoPath('/video/ch07/my-lesson/lecture.mp4')
  assert.equal(r.ok, true)
  assert.equal(r.chapter, 'ch07')
  assert.equal(r.lesson, 'my-lesson')
  assert.equal(r.file, 'lecture.mp4')
})

test('parseVideoPath: valid .webm path', () => {
  const r = parseVideoPath('/video/ch07/lesson-name/video.webm')
  assert.equal(r.ok, true)
  assert.equal(r.file, 'video.webm')
})

test('parseVideoPath: valid .mov path', () => {
  const r = parseVideoPath('/video/ch07/lesson-name/video.mov')
  assert.equal(r.ok, true)
  assert.equal(r.file, 'video.mov')
})

test('parseVideoPath: .. in chapter segment → rejected', () => {
  const r = parseVideoPath('/video/../etc/passwd/video.mp4')
  assert.equal(r.ok, false)
})

test('parseVideoPath: .. in lesson segment → rejected', () => {
  const r = parseVideoPath('/video/ch07/../../../video.mp4')
  assert.equal(r.ok, false)
})

test('parseVideoPath: only 2 decoded segments → rejected', () => {
  const r = parseVideoPath('/video/ch07/video.mp4')
  assert.equal(r.ok, false)
})

test('parseVideoPath: 4 segments → rejected', () => {
  const r = parseVideoPath('/video/a/b/c/d.mp4')
  assert.equal(r.ok, false)
})

test('parseVideoPath: non-video extension (.txt) → rejected', () => {
  const r = parseVideoPath('/video/ch07/lesson/notes.txt')
  assert.equal(r.ok, false)
})

test('parseVideoPath: non-video extension (.pdf) → rejected', () => {
  const r = parseVideoPath('/video/ch07/lesson/slides.pdf')
  assert.equal(r.ok, false)
})

test('parseVideoPath: encoded slash %2F stays one segment → still 3 segments, ok', () => {
  // %2F decodes to '/' but as a character inside a segment, not a separator
  // — the segment itself would contain '/' and so fail the /[\\/]/ guard.
  // This verifies that encoded-slash does NOT split into extra segments.
  const pathname = '/video/ch07/lesson/file%2Fname.mp4'
  const r = parseVideoPath(pathname)
  // The decoded file segment is "file/name.mp4" → contains '/' → rejected
  assert.equal(r.ok, false)
})

test('parseVideoPath: percent-encoded characters in chapter/lesson decoded correctly', () => {
  // spaces encoded → should decode and be accepted (no '..' or separators)
  const r = parseVideoPath('/video/ch07/my%20lesson/lecture.mp4')
  assert.equal(r.ok, true)
  assert.equal(r.lesson, 'my lesson')
})

test('parseVideoPath: empty segment → rejected', () => {
  // trailing slash creates an empty segment
  const r = parseVideoPath('/video/ch07/lesson//video.mp4')
  assert.equal(r.ok, false)
})

test('parseVideoPath: does not start with /video/ → rejected', () => {
  const r = parseVideoPath('/other/ch07/lesson/video.mp4')
  assert.equal(r.ok, false)
})

// ---------------------------------------------------------------------------
// VIDEO_RE export
// ---------------------------------------------------------------------------

test('VIDEO_RE matches expected extensions', () => {
  assert.ok(VIDEO_RE.test('file.mp4'))
  assert.ok(VIDEO_RE.test('file.MP4'))
  assert.ok(VIDEO_RE.test('file.m4v'))
  assert.ok(VIDEO_RE.test('file.webm'))
  assert.ok(VIDEO_RE.test('file.mov'))
})

test('VIDEO_RE rejects non-video extensions', () => {
  assert.ok(!VIDEO_RE.test('file.pdf'))
  assert.ok(!VIDEO_RE.test('file.txt'))
  assert.ok(!VIDEO_RE.test('file.mp3'))
  assert.ok(!VIDEO_RE.test('file'))
})
