import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initSchema } from '../../lib/db.js';
import { mergeDatabases, parseMergeArgs } from './merge.js';

let counter = 0;
function tmpDir() {
  const dir = join(tmpdir(), `kg-merge-${process.pid}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Build a real KG database at `path` with the given rows.
function makeKgDb(path, { nodes = [], edges = [], episodes = [], steps = [], vecs = [] } = {}) {
  const db = new Database(path);
  sqliteVec.load(db);
  initSchema(db);
  const now = '2026-01-01T00:00:00.000Z';
  const insNode = db.prepare(
    `INSERT INTO nodes (id, type, trust, name, content, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const n of nodes) {
    insNode.run(n.id, n.type ?? 'rule', n.trust ?? 'principle', n.name ?? n.id,
      n.content ?? 'content', n.metadata ?? null, n.created_at ?? now, n.updated_at ?? now);
  }
  const insEdge = db.prepare(
    `INSERT INTO edges (id, source_id, target_id, relation_type, reasoning, weight, created_at) VALUES (?,?,?,?,?,?,?)`
  );
  for (const e of edges) {
    insEdge.run(e.id, e.source_id, e.target_id, e.relation_type ?? 'causes',
      e.reasoning ?? null, e.weight ?? 1.0, e.created_at ?? now);
  }
  const insEp = db.prepare(
    `INSERT INTO episodes (id, type, context, summary, outcome, session_id, created_at) VALUES (?,?,?,?,?,?,?)`
  );
  for (const ep of episodes) {
    insEp.run(ep.id, ep.type ?? 'lesson', ep.context ?? null, ep.summary ?? 's',
      ep.outcome ?? null, ep.session_id ?? null, ep.created_at ?? now);
  }
  const insStep = db.prepare(
    `INSERT INTO episode_steps (id, episode_id, step_order, element, action, decision, reason, result) VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const s of steps) {
    insStep.run(s.id, s.episode_id, s.step_order ?? 0, s.element ?? null,
      s.action ?? 'a', s.decision ?? null, s.reason ?? null, s.result ?? null);
  }
  const insVec = db.prepare(`INSERT INTO vec_nodes (node_id, embedding) VALUES (?, ?)`);
  for (const v of vecs) insVec.run(v.node_id, v.embedding);
  db.close();
}

function openKg(path) {
  const db = new Database(path);
  sqliteVec.load(db);
  return db;
}

test('merge: copies nodes from one source into an empty target', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'a.db');
    const dst = join(dir, 'team.db');
    makeKgDb(src, { nodes: [
      { id: 'n1', name: 'CAP', content: 'cap theorem' },
      { id: 'n2', name: 'Sharding', content: 'shard routing' },
    ] });
    makeKgDb(dst, {});

    const report = mergeDatabases({ into: dst, from: [src] });

    const db = openKg(dst);
    const count = db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c;
    db.close();

    assert.equal(count, 2, 'both source nodes copied');
    assert.equal(report.totals.nodes, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: copies edges', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'a.db');
    const dst = join(dir, 'team.db');
    makeKgDb(src, {
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      edges: [{ id: 'e1', source_id: 'n1', target_id: 'n2', relation_type: 'causes', reasoning: 'because' }],
    });
    makeKgDb(dst, {});

    const report = mergeDatabases({ into: dst, from: [src] });

    const db = openKg(dst);
    const row = db.prepare('SELECT * FROM edges').get();
    const count = db.prepare('SELECT COUNT(*) AS c FROM edges').get().c;
    db.close();

    assert.equal(count, 1);
    assert.equal(row.relation_type, 'causes');
    assert.equal(row.reasoning, 'because');
    assert.equal(report.totals.edges, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: copies episodes and their steps', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'a.db');
    const dst = join(dir, 'team.db');
    makeKgDb(src, {
      episodes: [{ id: 'ep1', type: 'lesson', summary: 'designed QR generator' }],
      steps: [
        { id: 's1', episode_id: 'ep1', step_order: 0, action: 'pick id scheme' },
        { id: 's2', episode_id: 'ep1', step_order: 1, action: 'add CDN' },
      ],
    });
    makeKgDb(dst, {});

    const report = mergeDatabases({ into: dst, from: [src] });

    const db = openKg(dst);
    const eps = db.prepare('SELECT COUNT(*) AS c FROM episodes').get().c;
    const steps = db.prepare('SELECT COUNT(*) AS c FROM episode_steps').get().c;
    db.close();

    assert.equal(eps, 1);
    assert.equal(steps, 2);
    assert.equal(report.totals.episodes, 1);
    assert.equal(report.totals.episode_steps, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: copies vec_nodes embeddings (vector search works after merge)', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'a.db');
    const dst = join(dir, 'team.db');
    const vec = new Float32Array(1024).fill(0);
    vec[0] = 1; // distinctive unit vector
    makeKgDb(src, {
      nodes: [{ id: 'n1', name: 'CAP', content: 'cap' }],
      vecs: [{ node_id: 'n1', embedding: vec }],
    });
    makeKgDb(dst, {});

    const report = mergeDatabases({ into: dst, from: [src] });

    const db = openKg(dst);
    const count = db.prepare('SELECT COUNT(*) AS c FROM vec_nodes').get().c;
    const hit = db.prepare(
      `SELECT node_id, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 1`
    ).get(vec);
    db.close();

    assert.equal(count, 1);
    assert.equal(report.totals.vec_nodes, 1);
    assert.equal(hit.node_id, 'n1', 'copied embedding is searchable');
    assert.ok(hit.distance < 1e-3, 'exact vector matches with ~0 distance');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: rebuilds fts_nodes so keyword search finds copied nodes', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'a.db');
    const dst = join(dir, 'team.db');
    // Fixture intentionally does NOT populate source fts — merge must rebuild it.
    makeKgDb(src, { nodes: [{ id: 'n1', name: 'Consistent Hashing', content: 'ring of virtual nodes' }] });
    makeKgDb(dst, {});

    mergeDatabases({ into: dst, from: [src] });

    const db = openKg(dst);
    const hit = db.prepare(`SELECT node_id FROM fts_nodes WHERE fts_nodes MATCH ? LIMIT 1`).get('hashing');
    db.close();

    assert.equal(hit?.node_id, 'n1', 'copied node is keyword-searchable via rebuilt FTS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: --tag-domain stamps each node with metadata.domain = source basename', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'system-design.db');
    const dst = join(dir, 'team.db');
    makeKgDb(src, { nodes: [
      { id: 'n1', name: 'CAP' },
      { id: 'n2', name: 'Sharding', metadata: JSON.stringify({ lesson: 'L10' }) },
    ] });
    makeKgDb(dst, {});

    mergeDatabases({ into: dst, from: [src], tagDomain: true });

    const db = openKg(dst);
    const rows = db.prepare('SELECT id, metadata FROM nodes ORDER BY id').all();
    db.close();

    const m1 = JSON.parse(rows[0].metadata);
    const m2 = JSON.parse(rows[1].metadata);
    assert.equal(m1.domain, 'system-design');
    assert.equal(m2.domain, 'system-design');
    assert.equal(m2.lesson, 'L10', 'preserves existing metadata keys');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: UUID dedup — existing node id is skipped, not overwritten', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'a.db');
    const dst = join(dir, 'team.db');
    makeKgDb(dst, { nodes: [{ id: 'n1', name: 'ORIGINAL' }] });
    makeKgDb(src, { nodes: [
      { id: 'n1', name: 'DUPLICATE' },
      { id: 'n2', name: 'NEW' },
    ] });

    const report = mergeDatabases({ into: dst, from: [src] });

    const db = openKg(dst);
    const count = db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c;
    const n1 = db.prepare(`SELECT name FROM nodes WHERE id = 'n1'`).get();
    db.close();

    assert.equal(count, 2, 'n1 (existing) + n2 (new)');
    assert.equal(n1.name, 'ORIGINAL', 'existing node not overwritten');
    assert.equal(report.sources[0].nodes, 1, 'only n2 counted as copied');
    assert.ok(report.sources[0].skipped >= 1, 'duplicate n1 counted as skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: combines multiple sources and sums totals', () => {
  const dir = tmpDir();
  try {
    const a = join(dir, 'a.db');
    const b = join(dir, 'b.db');
    const dst = join(dir, 'team.db');
    makeKgDb(a, { nodes: [{ id: 'a1' }, { id: 'a2' }] });
    makeKgDb(b, { nodes: [{ id: 'b1' }] });
    makeKgDb(dst, {});

    const report = mergeDatabases({ into: dst, from: [a, b] });

    const db = openKg(dst);
    const count = db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c;
    db.close();

    assert.equal(count, 3);
    assert.equal(report.totals.nodes, 3);
    assert.equal(report.sources.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge: refuses a source with an uncheckpointed WAL sidecar (live server)', () => {
  const dir = tmpDir();
  try {
    const src = join(dir, 'a.db');
    const dst = join(dir, 'team.db');
    makeKgDb(src, { nodes: [{ id: 'n1' }] });
    makeKgDb(dst, {});
    writeFileSync(src + '-wal', 'pending-frames'); // simulate a running/uncheckpointed server

    assert.throws(
      () => mergeDatabases({ into: dst, from: [src] }),
      /wal|checkpoint|server/i,
      'should refuse and tell the user to stop the server'
    );

    // and it must not have partially written into the target
    const db = openKg(dst);
    const count = db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c;
    db.close();
    assert.equal(count, 0, 'no partial merge on refusal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseMergeArgs: --into, repeated --from, --tag-domain', () => {
  const o = parseMergeArgs(['--into', 'team.db', '--from', 'a.db', '--from', 'b.db', '--tag-domain']);
  assert.equal(o.into, 'team.db');
  assert.deepEqual(o.from, ['a.db', 'b.db']);
  assert.equal(o.tagDomain, true);
  assert.equal(o.help, false);
});

test('parseMergeArgs: defaults — no tag-domain, empty from', () => {
  const o = parseMergeArgs(['--into', 'team.db']);
  assert.equal(o.tagDomain, false);
  assert.deepEqual(o.from, []);
});

test('parseMergeArgs: -h / --help sets help', () => {
  assert.equal(parseMergeArgs(['-h']).help, true);
  assert.equal(parseMergeArgs(['--help']).help, true);
});

test('parseMergeArgs: flag missing its value throws', () => {
  assert.throws(() => parseMergeArgs(['--into']), /requires a value/i);
  assert.throws(() => parseMergeArgs(['--from']), /requires a value/i);
});

test('parseMergeArgs: unknown flag throws', () => {
  assert.throws(() => parseMergeArgs(['--bogus']), /unknown flag/i);
});
