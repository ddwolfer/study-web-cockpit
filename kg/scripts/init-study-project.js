#!/usr/bin/env node
/**
 * Scaffold a system-design (or any) STUDY project wired to this engine:
 * copies templates/study, writes a dual-server .mcp.json (knowledge-graph +
 * gemini-video) with absolute paths, and binds KG hooks to the project's own db.
 *
 *   node scripts/init-study-project.js --target ../my-study-project
 *   node scripts/init-study-project.js --target ../my-study --db system-design.db
 *
 * Idempotent — re-run any time. The KG db lives INSIDE the target project and is
 * referenced by an absolute --db path (the engine resolves relative paths against
 * itself, which is why an absolute path is required).
 */

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parseStudyArgs, initStudyProject } from './lib/study-init.js';

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: node scripts/init-study-project.js --target <dir> [--db <name>]

Flags:
  --target <dir>   Where to create the study project (required)
  --db <name>      KG db filename inside the project (default: system-design.db)
  --help, -h       This message

Creates a learning project with two MCP servers (the knowledge-graph engine +
a gemini-video server), the study-coach CLAUDE.md persona, a Whisper transcribe
fallback, and a lessons/ folder. Re-running is idempotent.
`;

function main() {
  let opts;
  try {
    opts = parseStudyArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`Error: ${e.message}\n`);
    process.stdout.write(USAGE);
    process.exit(2);
  }

  if (opts.help || !opts.target) {
    process.stdout.write(USAGE);
    process.exit(opts.help ? 0 : 1);
  }

  const templatesStudyDir = join(ENGINE, 'templates', 'study');
  const hookTemplatePath = join(ENGINE, 'templates', 'claude', 'settings.json');
  if (!existsSync(templatesStudyDir)) {
    console.error(`Missing ${templatesStudyDir} — run this from the Multi-knowledgeGraph engine repo.`);
    process.exit(1);
  }

  // Record what engine version we vendored (best-effort git SHA).
  let sha = 'unknown';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: ENGINE, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { /* not a git repo / git missing — leave 'unknown' */ }
  const engineMeta = {
    source: ENGINE.split('\\').join('/'),
    sha,
    copiedAt: new Date().toISOString(),
  };

  let report;
  try {
    report = initStudyProject({
      target: opts.target,
      engineDir: ENGINE,
      dbName: opts.db,
      templatesStudyDir,
      hookTemplatePath,
      engineMeta,
    });
  } catch (e) {
    console.error(`Scaffold failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`\n✓ Study project scaffolded at: ${report.target}`);
  console.log(`  Engine vendored:   ${report.kgDir}  (source ${engineMeta.sha})`);
  console.log(`  KG db (absolute):  ${report.dbPath}`);
  console.log(`  MCP servers:       ${report.servers.join(', ')}\n`);
  console.log('Next steps (PowerShell):');
  console.log(`  1. cd "${report.target}"`);
  console.log('  2. cd kg; npm install; cd ..                     # vendored engine deps');
  console.log('  3. cd mcp-gemini-video; npm install; cd ..       # Gemini video server deps');
  console.log('  4. setx GEMINI_API_KEY "your_key"                # then open a NEW terminal');
  console.log('  5. (optional) pip install faster-whisper         # offline transcript fallback');
  console.log('  6. Put each lesson under lessons\\<NN-slug>\\ (slides.pdf + the video)');
  console.log('  7. claude                                        # start the study session');
  console.log('\nThe engine is COPIED into kg/ — this project is self-contained (no central dependency).');
  console.log('First KG run downloads the ~560MB Qwen3 embedding model once (machine-wide cache).');
  console.log('Re-running this generator is safe (idempotent); it re-vendors kg/.');
}

main();
