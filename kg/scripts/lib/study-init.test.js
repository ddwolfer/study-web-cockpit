import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  buildStudyServers, buildStudyHooks, vendorEngine, initStudyProject, parseStudyArgs,
} from './study-init.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_TEMPLATE = join(REPO, 'templates', 'claude', 'settings.json');
const toPosix = (p) => p.split('\\').join('/');

let counter = 0;
function tmpDir() {
  const dir = join(tmpdir(), `kg-study-${process.pid}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A minimal fake engine on disk, including junk that vendoring must exclude.
function makeSrcEngine(root) {
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'plans', 'p'), { recursive: true });
  mkdirSync(join(root, 'templates', 'study'), { recursive: true });
  writeFileSync(join(root, 'main.js'), '// main');
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'lib', 'db.js'), '// db');
  writeFileSync(join(root, 'hooks', 'session-start.js'), '// hook');
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'x');
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
  writeFileSync(join(root, 'knowledge.db'), 'sqlite');
  writeFileSync(join(root, 'knowledge.db-wal'), 'wal');
  writeFileSync(join(root, 'plans', 'p', 'plan.md'), 'p');
  writeFileSync(join(root, 'templates', 'study', 'CLAUDE.md'), 't');
}

test('buildStudyServers: two servers with absolute posix paths + gemini env', () => {
  const { servers } = buildStudyServers({
    engineDir: 'D:\\AI\\proj\\kg',
    projectDir: 'D:\\AI\\proj',
    dbName: 'system-design.db',
  });

  const kg = servers['knowledge-graph'];
  assert.equal(kg.command, 'node');
  assert.deepEqual(kg.args, [
    'D:/AI/proj/kg/main.js',
    '--db',
    'D:/AI/proj/system-design.db',
  ]);

  const gv = servers['gemini-video'];
  assert.equal(gv.command, 'node');
  assert.equal(gv.args[0], 'D:/AI/proj/mcp-gemini-video/server.js');
  assert.equal(gv.env.GEMINI_API_KEY, '${GEMINI_API_KEY}');
});

test('buildStudyHooks: substitutes KG_ROOT and binds the project db as a positional arg', () => {
  const dbPath = 'D:/AI/proj/system-design.db';
  const hooks = buildStudyHooks({ engineDir: 'D:/AI/proj/kg', dbPath, hookTemplatePath: HOOK_TEMPLATE });

  const sessionCmd = hooks.SessionStart[0].hooks[0].command;
  assert.ok(sessionCmd.includes('/kg/hooks/session-start.js'), 'KG_ROOT -> vendored kg/');
  assert.ok(!sessionCmd.includes('{{KG_ROOT}}'), 'no leftover placeholder');
  assert.ok(sessionCmd.includes(dbPath), 'project db bound to the hook command');

  const stop = hooks.Stop[0].hooks[0];
  assert.equal(stop.type, 'agent');
  assert.equal(stop.command, undefined);
});

test('vendorEngine: copies engine core into kg/, excludes junk, stamps .engine-source', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'engine');
    makeSrcEngine(src);
    const kgDir = join(dir, 'proj', 'kg');

    vendorEngine({ sourceEngineDir: src, kgDir, meta: { source: src, sha: 'abc123', copiedAt: '2026-01-01' } });

    assert.ok(existsSync(join(kgDir, 'main.js')), 'main.js copied');
    assert.ok(existsSync(join(kgDir, 'lib', 'db.js')), 'lib copied');
    assert.ok(existsSync(join(kgDir, 'hooks', 'session-start.js')), 'hooks copied');
    assert.ok(existsSync(join(kgDir, 'package.json')), 'package.json copied');

    assert.ok(!existsSync(join(kgDir, 'node_modules')), 'node_modules excluded');
    assert.ok(!existsSync(join(kgDir, '.git')), '.git excluded');
    assert.ok(!existsSync(join(kgDir, 'knowledge.db')), 'engine dev db excluded');
    assert.ok(!existsSync(join(kgDir, 'knowledge.db-wal')), 'engine dev wal excluded');
    assert.ok(!existsSync(join(kgDir, 'plans')), 'plans excluded');
    assert.ok(!existsSync(join(kgDir, 'templates')), 'templates excluded');

    const meta = JSON.parse(readFileSync(join(kgDir, '.engine-source'), 'utf8'));
    assert.equal(meta.sha, 'abc123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initStudyProject: vendors engine into kg/, dual-server .mcp.json -> kg/, db at root, idempotent', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'engine');
    makeSrcEngine(src);
    const templates = join(dir, 'tpl');
    mkdirSync(join(templates, 'mcp-gemini-video'), { recursive: true });
    writeFileSync(join(templates, 'CLAUDE.md'), '# study coach');
    writeFileSync(join(templates, 'mcp-gemini-video', 'server.js'), '// gemini server');
    const target = join(dir, 'proj');

    const report = initStudyProject({
      target,
      engineDir: src,
      dbName: 'system-design.db',
      templatesStudyDir: templates,
      hookTemplatePath: HOOK_TEMPLATE,
      engineMeta: { source: src, sha: 'deadbeef', copiedAt: '2026-01-01' },
    });

    // engine vendored under the project
    assert.ok(existsSync(join(target, 'kg', 'main.js')), 'engine vendored into kg/');
    assert.ok(existsSync(join(target, 'kg', '.engine-source')), 'version stamp written');
    assert.ok(!existsSync(join(target, 'kg', 'node_modules')), 'no node_modules vendored');

    // template files copied
    assert.ok(existsSync(join(target, 'CLAUDE.md')));
    assert.ok(existsSync(join(target, 'mcp-gemini-video', 'server.js')));

    // .mcp.json: kg server points at the VENDORED engine, db at project root (absolute)
    const mcp = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'));
    const kgArgs = mcp.mcpServers['knowledge-graph'].args;
    assert.equal(kgArgs[0], toPosix(resolve(target, 'kg', 'main.js')));
    assert.equal(kgArgs[kgArgs.length - 1], toPosix(resolve(target, 'system-design.db')));
    assert.ok(mcp.mcpServers['gemini-video'], 'gemini server present');

    // hooks point at the vendored kg/ and carry the project db
    const settings = JSON.parse(readFileSync(join(target, '.claude', 'settings.json'), 'utf8'));
    const cmd = settings.hooks.SessionStart[0].hooks[0].command;
    assert.ok(cmd.includes('/kg/hooks/session-start.js'));
    assert.ok(cmd.includes('system-design.db'));

    assert.equal(report.dbPath, toPosix(resolve(target, 'system-design.db')));
    assert.equal(report.kgDir, toPosix(resolve(target, 'kg')));

    // idempotent
    initStudyProject({
      target, engineDir: src, dbName: 'system-design.db',
      templatesStudyDir: templates, hookTemplatePath: HOOK_TEMPLATE,
      engineMeta: { source: src, sha: 'deadbeef', copiedAt: '2026-01-01' },
    });
    const mcp2 = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'));
    assert.equal(Object.keys(mcp2.mcpServers).length, 2, 're-run keeps exactly 2 servers');
    const settings2 = JSON.parse(readFileSync(join(target, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings2.hooks.SessionStart.length, 2, 're-run keeps SessionStart entries stable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initStudyProject: skips node_modules and __pycache__ in the TEMPLATE copy', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'engine');
    makeSrcEngine(src);
    const templates = join(dir, 'tpl');
    mkdirSync(join(templates, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(templates, 'scripts', '__pycache__'), { recursive: true });
    writeFileSync(join(templates, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(templates, 'scripts', '__pycache__', 'foo.pyc'), 'x');
    writeFileSync(join(templates, 'keep.txt'), 'k');
    const target = join(dir, 'proj');

    initStudyProject({
      target, engineDir: src, templatesStudyDir: templates, hookTemplatePath: HOOK_TEMPLATE,
    });

    assert.ok(existsSync(join(target, 'keep.txt')), 'normal template file copied');
    assert.ok(!existsSync(join(target, 'node_modules')), 'template node_modules skipped');
    assert.ok(!existsSync(join(target, 'scripts', '__pycache__')), 'template __pycache__ skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseStudyArgs: --target + --db, with default db name', () => {
  const o = parseStudyArgs(['--target', 'D:\\AI\\study', '--db', 'sd.db']);
  assert.equal(o.target, 'D:\\AI\\study');
  assert.equal(o.db, 'sd.db');
  assert.equal(o.help, false);

  const d = parseStudyArgs(['--target', 'X']);
  assert.equal(d.db, 'system-design.db', 'default db name');
});

test('parseStudyArgs: -h / --help and error cases', () => {
  assert.equal(parseStudyArgs(['-h']).help, true);
  assert.equal(parseStudyArgs(['--help']).help, true);
  assert.throws(() => parseStudyArgs(['--target']), /requires a value/i);
  assert.throws(() => parseStudyArgs(['--nope']), /unknown flag/i);
});
