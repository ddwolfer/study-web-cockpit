# Setup Guide — study-web-cockpit

A browser-based study cockpit powered by Claude Code, a knowledge-graph MCP
server, and an optional Gemini video/PDF ingestion server. Works on Windows and
macOS after cloning.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** (20 LTS recommended) | <https://nodejs.org> |
| **Claude Code** | `npm install -g @anthropic-ai/claude-code` |
| **Google Gemini API key** | Optional — only needed for the `gemini-video` MCP server (reading slides/videos). Get one at <https://aistudio.google.com/apikey>. Without it the server still boots but every tool call returns a clear error. |
| **Python + faster-whisper** | Optional — only needed if you want to run the local `scripts/transcribe.py` helper that generates timestamped transcripts from audio/video files. |

---

## 1. Clone and install

```bash
git clone https://github.com/ddwolfer/study-web-cockpit
cd study-web-cockpit
```

Install each sub-package **separately** (native modules must be compiled on the
current machine — copying `node_modules` from another OS or CPU architecture
will not work):

```bash
cd kg               && npm install && cd ..
cd mcp-gemini-video && npm install && cd ..
cd study-web        && npm install && cd ..
```

> **First-run note:** when the knowledge-graph server starts for the first time
> it automatically downloads the Qwen3-Embedding-0.6B ONNX model (~560 MB).
> This is a one-time download cached inside `kg/node_modules`.

---

## 2. Configure Gemini (optional)

```bash
cp mcp-gemini-video/.env.example mcp-gemini-video/.env
```

Open `mcp-gemini-video/.env` and set your key:

```
GEMINI_API_KEY=<your-key-here>
```

Alternatively, export the variable in your shell before launching:

```bash
# bash / zsh
export GEMINI_API_KEY=<your-key-here>

# PowerShell
$env:GEMINI_API_KEY = "<your-key-here>"
```

The `.mcp.json` at the repo root forwards `GEMINI_API_KEY` from the environment
into the server automatically, so either approach works.

---

## 3. Trust the MCP servers (Claude Code permission prompts)

The first time you launch, Claude Code will ask whether to trust each server in
`.mcp.json`. You can pre-approve them to avoid stalls inside the browser
cockpit:

```bash
cp .claude/settings.local.json.example .claude/settings.local.json
```

This pre-allows all three servers (`knowledge-graph`, `gemini-video`,
`study-web`) and a small set of write permissions for the `notes/` folder. Edit
the file to tighten or widen permissions as you see fit.

---

## 4. (Optional) Check for portable paths

All paths in `.mcp.json` and `.claude/settings.json` should be **relative to
the repo root** (e.g. `kg/main.js`, not `C:\Users\…\kg\main.js`). If you
originally set up on a different machine and those files contain hard-coded
drive letters or absolute paths, fix them to relative paths before pushing — the
`--dangerously-load-development-channels` launcher always `cd`s to the repo root
first, so relative paths resolve correctly on any machine.

---

## 5. Verify everything

```bash
node scripts/check-setup.mjs
```

The script checks:

- Node.js version (>=18 required)
- `node_modules` present in each sub-package
- Native modules (`better-sqlite3`, `sqlite-vec`) loadable on this machine
- Gemini API key set
- `kg/demo.db` present (warns if missing — see step 6)
- `demo-lessons/` present (warns if missing)
- Launcher script present and executable (macOS: checks `chmod +x`)
- All three servers listed in `enabledMcpjsonServers`
- No hard-coded drive letters in `.mcp.json` / `.claude/settings.json`

Exit code 0 means no blockers (warnings are fine); exit code 1 means at least
one `❌` item needs fixing. Re-run after each fix until you see the "All checks
passed" line.

---

## 6. (Optional) Build the demo knowledge graph

The repo ships without a pre-built database (it would grow with personal notes).
To seed an empty demo graph:

```bash
cd kg
npm install          # already done in step 1 if you followed in order
# seed the demo data
node main.js --db demo.db
# (then, in another terminal or via Claude Code, run the seed commands
#  described in kg/README.md, or point Claude Code at the kg-init skill)
```

The resulting file is `kg/demo.db`. Once it exists, `check-setup.mjs` will
report it as present.

> See `kg/README.md` (English) or `kg/README.zh-TW.md` (Traditional Chinese)
> for the full API, trust rules, and `merge-db.js` usage.

---

## 7. Add demo lessons

The `demo-lessons/` folder (mapped to `LESSONS_DIR` in `.mcp.json`) is
gitignored because lesson materials are large and may be copyright-restricted.
Create the folder and drop in your own lesson subfolders — each subfolder should
contain a `.pdf` slide deck and/or a `.mp4` video file. The `gemini-video` MCP
server auto-discovers them by folder name.

```
demo-lessons/
  01. My First Lesson/
    slides.pdf
    lecture.mp4        ← optional
```

Pass the subfolder path (relative to `demo-lessons/`) to Gemini tools:

```
gemini_digest_pdf(lesson="01. My First Lesson")
```

---

## 8. Launch

### Windows

Double-click `study-coach.cmd`, or run it from a terminal:

```bat
study-coach.cmd
```

### macOS / Linux

Make executable once:

```bash
chmod +x study-coach.command
```

Then launch:

```bash
./study-coach.command
# or double-click in Finder
```

Both launchers start Claude Code with:

```
claude --resume "system_design_study" --dangerously-load-development-channels server:study-web
```

The `--dangerously-load-development-channels` flag is required during the
Claude Code channels research preview so that the `study-web` server can push
browser messages into the session. Without it, the browser cockpit receives no
replies.

After it starts, open the URL printed in the terminal (default
`http://127.0.0.1:7654`) and click a demo lesson card to begin.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `better-sqlite3` / `sqlite-vec` fails to load | Reinstall on this machine: `cd kg && rm -rf node_modules && npm install` |
| Browser cockpit shows no replies | Make sure you launched via `study-coach.cmd` / `study-coach.command`, not plain `claude` — the flag is required |
| Gemini tools all return "key not set" | Check `mcp-gemini-video/.env` or that `GEMINI_API_KEY` is exported in your shell before launching |
| `kg/demo.db` "directory does not exist" | Ensure `kg/` folder exists and you are running commands from the repo root — paths are resolved relative to `process.cwd()` |
| Settings file has `D:\...` absolute paths | Edit `.mcp.json` and `.claude/settings.json` to use relative paths (e.g. `kg/main.js`); see step 4 above |
