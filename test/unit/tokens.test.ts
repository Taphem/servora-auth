import { describe, expect, it } from 'vitest';
import { generateSecureToken, hashToken } from '../../src/security/tokens.js';

describe('tokens', () => {
  it('generates unique, high-entropy tokens', () => {
    const a = generateSecureToken(32);
    const b = generateSecureToken(32);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(30);
  });

  it('hashes deterministically so a stored hash can be matched later', () => {
    const token = generateSecureToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('produces different hashes for different tokens', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });

  it('never stores the raw token value inside the hash', () => {
    const token = 'raw-secret-value';
    expect(hashToken(token)).not.toContain(token);
  });
});
