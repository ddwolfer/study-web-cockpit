# kg-study-gemini-video

A standalone Node MCP server that lets a Claude Code study session **delegate video
understanding to Google Gemini**.

Claude cannot watch video. Gemini can read video frames *and* audio. This server uploads a
lesson's recording to the Gemini Files API once, then exposes tools that ask Gemini about
it — so your Claude Code session can "see" the lesson, follow the diagrams drawn on screen,
and get timestamped answers.

It lives inside a generated learning project and runs as a **second MCP server alongside
the knowledge-graph engine**. It is concerned with video only — it knows nothing about the
knowledge graph.

## Tools

- **`gemini_prepare_video(lesson)`** — find the lesson's video file
  (`<projectRoot>/lessons/<lesson>/*.mp4|.mov|.mkv|.webm`), upload it to the Gemini Files
  API, poll until it is `ACTIVE`, and cache the handle in memory. Uploaded files live ~48h
  on Google's side, so subsequent calls reuse the cached upload until it nears expiry.
- **`gemini_ask_video(lesson, question, start?, end?)`** — ask a scoped question. If
  `start`/`end` (e.g. `01:30` / `04:15`) are given, the answer is constrained to that
  timestamp window. Prepares the lesson automatically if it isn't cached. Answers describe
  on-screen diagrams/architecture and cite timestamps like `[mm:ss]`.
- **`gemini_digest_lesson(lesson)`** — produce a full structured Markdown digest:
  transcript-level summary, every diagram/architecture drawn, how the architecture evolves
  over time, and key timestamps. Prepares the lesson automatically if needed.

## Lesson layout

```
<projectRoot>/
├─ mcp-gemini-video/      ← this server
└─ lessons/
   ├─ 01-intro/
   │  └─ recording.mp4
   └─ 02-architecture/
      └─ class.mov
```

The `lesson` argument is the subfolder name (e.g. `01-intro`). The first video file found
in that folder is used. Override the lessons location with `LESSONS_DIR`.

## Install

This is a **separate npm package** from the knowledge-graph engine. Install its
dependencies here:

```bash
npm install
```

(from this `mcp-gemini-video/` directory).

## Environment

Copy `.env.example` and set your key, or provide these via your shell / the learning
project's `.mcp.json` env block:

| Variable               | Required | Default              | Purpose                                  |
| ---------------------- | -------- | -------------------- | ---------------------------------------- |
| `GEMINI_API_KEY`       | yes      | —                    | Google AI Studio API key                 |
| `GEMINI_ASK_MODEL`     | no       | `gemini-2.5-flash`   | model for `gemini_ask_video`             |
| `GEMINI_DIGEST_MODEL`  | no       | `gemini-2.5-pro`     | model for `gemini_digest_lesson`         |
| `LESSONS_DIR`          | no       | `<projectRoot>/lessons` | override lessons location             |

Get a key at <https://aistudio.google.com/apikey>.

The server boots without a key (so the MCP host doesn't crash); the key is only required
when a tool is actually called. If it is missing, the tool returns a clear
`Set GEMINI_API_KEY ...` error.

## Run

```bash
npm start   # node server.js — speaks MCP over stdio
```

## Registration

This server is **auto-registered in the learning project's `.mcp.json`** by the
Multi-knowledgeGraph generator, as a second MCP server next to the knowledge-graph engine.
You normally don't launch it by hand — your MCP host (Claude Code) starts it over stdio.
You only need to run `npm install` here and provide `GEMINI_API_KEY`.
