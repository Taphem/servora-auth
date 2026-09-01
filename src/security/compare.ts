import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Raw timingSafeEqual throws on
 * length mismatch (itself a timing/branching leak for variable-length
 * secrets), so both inputs are hashed to a fixed 32-byte digest first.
 */
export function secureCompare(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
