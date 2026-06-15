# Third-Party Notices

This project vendors the **Multi-knowledgeGraph** engine under [`kg/`](./kg).

- **Multi-knowledgeGraph** — a local knowledge-graph engine (long-term memory,
  spaced-repetition retrievability scoring, semantic + full-text search).
  - Source: <https://github.com/ddwolfer/Multi-knowledgeGraph>
  - License: MIT © 2026 ChenLiangChong (see [`kg/LICENSE`](./kg/LICENSE))

The `kg/` tree is included so the project runs offline on clone. It is the
upstream engine **except** local-only artifacts (the populated database,
`node_modules/`, and the engine-source pointer) which are intentionally not
redistributed.

Local modifications made by this project on top of the upstream engine:

- **`kg/hooks/`** — Claude Code hook wiring authored for this app:
  session-start spaced review, auto-recall, search-enforcer, post-compact, and
  the `web-reply-guard` Stop hook.
- **`kg/lib/db.js`** — patched so a relative `--db` argument resolves against
  `process.cwd()` (the project root) instead of the engine's `__dirname`. The
  upstream behavior turned `--db kg/x.db` into `kg/kg/x.db` and broke
  `better-sqlite3` on Windows. See the header note in that file.

All other dependencies are standard npm packages declared in the project's
`package.json` files and are **not** redistributed here — run `npm install`.
