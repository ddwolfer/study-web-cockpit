/**
 * Parse CLI args for setup-project.js.
 *
 * Supports:
 *   --db <single|preset|custom>     DB setup mode
 *   --custom-dbs <a,b,c>            comma-separated DB names (when --db=custom)
 *   --platforms <a,b,c>             which platforms to wire (claude,codex,gemini)
 *   --kg-dir <path>                 KG repo location relative to project root
 *   --project-root <path>           project root (default: auto-detect)
 *   --no-briefing                   skip persona-file briefing injection
 *   --interactive                   prompt for missing values (CLI mode)
 *   --reset-git                     move .git to backup and `git init` fresh
 *   --help, -h                      print usage
 */

export const KNOWN_FLAGS = new Set([
  '--db', '--custom-dbs', '--platforms', '--kg-dir', '--project-root',
  '--no-briefing', '--interactive', '--reset-git', '--help', '-h',
]);

export function parseArgs(argv) {
  const opts = {
    db: null,
    customDbs: [],
    platforms: null,
    kgDir: null,
    projectRoot: null,
    briefing: true,
    interactive: false,
    resetGit: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`Flag ${a} requires a value`);
      return argv[++i];
    };
    switch (a) {
      case '--db':           opts.db = need(); break;
      case '--custom-dbs':   opts.customDbs = splitList(need()); break;
      case '--platforms':    opts.platforms = splitList(need()); break;
      case '--kg-dir':       opts.kgDir = need(); break;
      case '--project-root': opts.projectRoot = need(); break;
      case '--no-briefing':  opts.briefing = false; break;
      case '--interactive':  opts.interactive = true; break;
      case '--reset-git':    opts.resetGit = true; break;
      case '--help':
      case '-h':             opts.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
        throw new Error(`Unexpected positional: ${a}`);
    }
  }
  return opts;
}

function splitList(s) {
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

export function usage() {
  return `Usage: node scripts/setup-project.js [flags]

Wires Multi-knowledgeGraph into a project's .mcp.json / .claude / .codex / .gemini configs.

Flags:
  --db <single|preset|custom>   DB setup (default: single)
  --custom-dbs <a,b,c>          DB names when --db=custom (e.g. "main,research,scratch")
  --platforms <a,b,c>           Comma-separated: claude,codex,gemini (default: claude)
  --kg-dir <path>               KG location relative to project root (default: auto-detect, fallback ./kg)
  --project-root <path>         Project root (default: parent of KG repo)
  --no-briefing                 Skip injecting briefing blocks into CLAUDE.md/AGENTS.md/GEMINI.md
  --interactive                 Prompt for missing values (defaults to non-interactive)
  --reset-git                   Backup .git and re-initialize (rare; advanced)
  --help, -h                    This message

Re-running is idempotent: same flags produce same output. Existing entries in
config files are preserved; only knowledge-graph entries are merged/replaced.
`;
}
