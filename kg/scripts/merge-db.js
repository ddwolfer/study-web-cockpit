#!/usr/bin/env node
/**
 * Merge one or more knowledge-graph databases into a target ("hire" domain
 * masters into a project's working brain).
 *
 *   node scripts/merge-db.js --into team.db --from system-design.db --from music.db --tag-domain
 *
 * - Copies nodes, edges, episodes, episode_steps and vec_nodes embeddings.
 * - Rebuilds the FTS index from the merged node set.
 * - UUID-level dedup: ids already present in the target are skipped (idempotent).
 * - --tag-domain stamps each copied node's metadata.domain with the source
 *   filename (a namespace you can later filter / prune by).
 *
 * SAFETY: refuses any --from that has a non-empty -wal/-shm sidecar (its MCP
 * server is likely still running). Stop the server / checkpoint first.
 *
 * All databases must have been built by THIS engine (same Qwen3 1024-dim
 * embedding model) for vector search to remain meaningful after merge.
 */

import { parseMergeArgs, mergeDatabases } from './lib/merge.js';

const USAGE = `Usage: node scripts/merge-db.js --into <target.db> --from <source.db> [--from ...] [--tag-domain]

Flags:
  --into <file>    Target DB to merge into (created if it doesn't exist)
  --from <file>    Source DB to merge from (repeat for multiple sources)
  --tag-domain     Stamp each copied node's metadata.domain = source filename
  --help, -h       This message

Example:
  node scripts/merge-db.js --into team.db --from system-design.db --from music.db --tag-domain

Notes:
  - UUID dedup makes re-running safe (existing ids are skipped, not overwritten).
  - Stop each source's MCP server before merging (WAL safety).
`;

function main() {
  let opts;
  try {
    opts = parseMergeArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`Error: ${e.message}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }

  if (opts.help || !opts.into || opts.from.length === 0) {
    process.stdout.write(USAGE);
    process.exit(opts.help ? 0 : 1);
  }

  let report;
  try {
    report = mergeDatabases(opts);
  } catch (e) {
    console.error(`Merge failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`Merged into: ${opts.into}${opts.tagDomain ? '  (domain-tagged)' : ''}\n`);
  for (const s of report.sources) {
    console.log(
      `  ${s.from}\n` +
      `    nodes:${s.nodes}  edges:${s.edges}  episodes:${s.episodes}  ` +
      `steps:${s.episode_steps}  vectors:${s.vec_nodes}  skipped:${s.skipped}`
    );
  }
  const t = report.totals;
  console.log(
    `\nTotals — nodes:${t.nodes}  edges:${t.edges}  episodes:${t.episodes}  ` +
    `steps:${t.episode_steps}  vectors:${t.vec_nodes}  skipped:${t.skipped}`
  );
}

main();
