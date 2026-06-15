/**
 * Generator core for `init-study-project.js` — scaffolds a learning/study
 * project that wires the Multi-knowledgeGraph engine + a Gemini video MCP server.
 *
 * Two MCP servers end up in the project's .mcp.json:
 *   - knowledge-graph: the shared engine, pointed at the project's OWN db via an
 *     ABSOLUTE --db path (the engine resolves a relative --db against itself).
 *   - gemini-video: the per-project Gemini video server (key via env passthrough).
 * KG hooks are bound to the same project db by appending its absolute path as the
 * positional arg the hooks read (KG_DB_PATH env > argv[2] > default).
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { substitute, hasPlaceholders } from './placeholders.js';
import { ensureMcpServer, mergeClaudeHooks } from './json-merge.js';

function toPosix(p) { return p.split('\\').join('/'); }

/**
 * Parse argv (without node/script) for init-study-project.js.
 *   --target <dir>   where to create the study project (required)
 *   --db <name>      KG db filename inside the project (default system-design.db)
 *   --help, -h       usage
 */
export function parseStudyArgs(argv) {
  const opts = { target: null, db: 'system-design.db', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`Flag ${a} requires a value`);
      return argv[++i];
    };
    switch (a) {
      case '--target': opts.target = need(); break;
      case '--db':     opts.db = need(); break;
      case '--help':
      case '-h':       opts.help = true; break;
      default:         throw new Error(`Unknown flag: ${a}`);
    }
  }
  return opts;
}

/**
 * Build the two MCP server entries for a study project's .mcp.json.
 * Paths are resolved to ABSOLUTE posix form — critical because the engine's
 * main.js resolves a relative --db against the ENGINE repo, not the project.
 */
export function buildStudyServers({ engineDir, projectDir, dbName = 'system-design.db' } = {}) {
  const engine = toPosix(resolve(engineDir));
  const project = toPosix(resolve(projectDir));

  return {
    servers: {
      'knowledge-graph': {
        command: 'node',
        args: [`${engine}/main.js`, '--db', `${project}/${dbName}`],
      },
      'gemini-video': {
        command: 'node',
        args: [`${project}/mcp-gemini-video/server.js`],
        env: { GEMINI_API_KEY: '${GEMINI_API_KEY}' },
      },
    },
  };
}

/**
 * Build the .claude/settings.json hooks object for a study project: take the
 * engine's hook template, fill {{KG_ROOT}}, and bind the project db by appending
 * its absolute path as the positional arg every command-type KG hook reads.
 * The type=agent Stop hook (no command) is left untouched.
 */
export function buildStudyHooks({ engineDir, dbPath, hookTemplatePath }) {
  const enginePosix = toPosix(resolve(engineDir));
  let tmpl = readFileSync(hookTemplatePath, 'utf8');
  tmpl = substitute(tmpl, { KG_ROOT: enginePosix });
  if (hasPlaceholders(tmpl)) {
    throw new Error(`Unresolved placeholders in ${hookTemplatePath}`);
  }
  const hooks = JSON.parse(tmpl).hooks;

  for (const event of Object.keys(hooks)) {
    for (const group of hooks[event]) {
      for (const h of group.hooks || []) {
        if (h.type === 'command' && typeof h.command === 'string' && h.command.includes('/hooks/')) {
          h.command = `${h.command} "${dbPath}"`;
        }
      }
    }
  }
  return hooks;
}

// Dirs never copied when vendoring the engine into a project's kg/.
const VENDOR_EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'plans', 'templates']);

/**
 * Vendor the engine CORE into `kgDir` (a copy, not a git clone) so the study
 * project is self-contained: main.js, lib/, tools/, hooks/, scripts/, package*.
 * Excludes .git / node_modules / plans / templates and the engine's own
 * knowledge.db(-wal/-shm). Writes a .engine-source stamp recording provenance.
 */
export function vendorEngine({ sourceEngineDir, kgDir, meta = {} }) {
  const src = resolve(sourceEngineDir);
  const dest = resolve(kgDir);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const b = basename(s);
      if (VENDOR_EXCLUDE_DIRS.has(b)) return false;
      if (/^knowledge\.db($|-)/.test(b)) return false; // engine's own dev db + wal/shm
      return true;
    },
  });
  writeFileSync(join(dest, '.engine-source'), JSON.stringify(meta, null, 2) + '\n');
  return { kgDir: dest };
}

/**
 * Scaffold a study project at `target`:
 *   - copy the templates/study tree (minus node_modules/.git/__pycache__),
 *   - VENDOR the engine core into <target>/kg (self-contained, no central dep),
 *   - write a dual-server .mcp.json pointing at the vendored kg/ (absolute paths),
 *   - merge KG hooks into .claude/settings.json bound to the project db.
 * Idempotent: re-running re-vendors, replaces the server entries, de-dupes hooks.
 */
export function initStudyProject({ target, engineDir, dbName = 'system-design.db', templatesStudyDir, hookTemplatePath, engineMeta = {} }) {
  const projectDir = resolve(target);
  const dbPath = toPosix(join(projectDir, dbName));

  // 1. copy template tree
  mkdirSync(projectDir, { recursive: true });
  cpSync(templatesStudyDir, projectDir, {
    recursive: true,
    filter: (src) => {
      const b = basename(src);
      return b !== 'node_modules' && b !== '.git' && b !== '__pycache__';
    },
  });

  // 2. vendor the engine into <project>/kg
  const kgDir = join(projectDir, 'kg');
  vendorEngine({ sourceEngineDir: engineDir, kgDir, meta: engineMeta });

  // 3. dual-server .mcp.json — KG server points at the VENDORED engine
  const mcpFile = join(projectDir, '.mcp.json');
  const { servers } = buildStudyServers({ engineDir: kgDir, projectDir, dbName });
  for (const [name, config] of Object.entries(servers)) {
    ensureMcpServer(mcpFile, name, config);
  }

  // 4. .claude/settings.json hooks — point at vendored kg/, bound to the project db
  const settingsFile = join(projectDir, '.claude', 'settings.json');
  mkdirSync(dirname(settingsFile), { recursive: true });
  const hooks = buildStudyHooks({ engineDir: kgDir, dbPath, hookTemplatePath });
  mergeClaudeHooks(settingsFile, hooks);

  return {
    target: projectDir,
    kgDir: toPosix(resolve(kgDir)),
    dbPath,
    servers: Object.keys(servers),
  };
}
