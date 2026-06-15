/**
 * Idempotent markdown block insertion using
 *   <!-- <NAME>:START --> ... <!-- <NAME>:END -->
 * markers. Re-running with the same name updates the block in place.
 *
 * ensureBlock(content, name, body)  — insert or replace the named block
 * removeBlock(content, name)        — strip the block entirely (if present)
 * hasBlock(content, name)           — boolean
 */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeRe(name) {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  return new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}`);
}

export function hasBlock(content, name) {
  return makeRe(name).test(content);
}

export function ensureBlock(content, name, body) {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  const block = `${start}\n${body}\n${end}`;
  const re = makeRe(name);

  if (re.test(content)) {
    return content.replace(re, block);
  }
  // Append. Leave a blank line between prior content and the block.
  const sep = content.length === 0
    ? ''
    : content.endsWith('\n\n') ? ''
    : content.endsWith('\n') ? '\n'
    : '\n\n';
  return content + sep + block + '\n';
}

export function removeBlock(content, name) {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  // Consume one trailing newline + optional preceding blank-line buffer.
  const re = new RegExp(`\\n?\\n?${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}\\n?`, 'g');
  return content.replace(re, '');
}
