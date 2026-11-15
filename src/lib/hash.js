/**
 * Hashing helpers. Everything is SHA-256, hex encoded.
 *
 * canonicalJson() gives the same string for the same data regardless of key
 * order, so a hash taken at sign-off can be recomputed later and compared.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with object keys sorted at every level. Arrays keep their order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}
