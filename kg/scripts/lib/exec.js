/**
 * spawnSync wrapper with logging. Throws on non-zero exit.
 */

import { spawnSync } from 'node:child_process';

export function run(cmd, args, label, opts = {}) {
  const display = label || [cmd, ...args].join(' ');
  console.log(`→ ${display}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (r.error) throw new Error(`${display}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${display} failed (exit ${r.status})`);
  }
  return r;
}

/** Like run, but returns captured stdout instead of inheriting. */
export function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const stderr = (r.stderr || '').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})${stderr ? ': ' + stderr : ''}`);
  }
  return (r.stdout || '').trim();
}
