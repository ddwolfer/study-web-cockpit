/**
 * Substitute {{KEY}} placeholders in a string. KEY is uppercase + digits + underscore.
 *
 * substitute(str, vars)     — replace known keys; leave unknown placeholders intact
 * hasPlaceholders(str)      — boolean: any {{...}} remaining?
 * findPlaceholders(str)     — list of unique keys still present
 */

const PATTERN = '\\{\\{([A-Z][A-Z0-9_]*)\\}\\}';

export function substitute(str, vars) {
  return str.replace(new RegExp(PATTERN, 'g'), (m, key) => {
    return vars[key] !== undefined ? String(vars[key]) : m;
  });
}

export function hasPlaceholders(str) {
  return new RegExp(PATTERN).test(str);
}

export function findPlaceholders(str) {
  const out = new Set();
  for (const m of str.matchAll(new RegExp(PATTERN, 'g'))) {
    out.add(m[1]);
  }
  return [...out];
}
