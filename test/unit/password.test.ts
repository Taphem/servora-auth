import { describe, expect, it } from 'vitest';
import { hashPassword, isValidPasswordShape, verifyAgainstDummyHash, verifyPassword } from '../../src/security/password.js';

describe('password', () => {
  it('accepts passwords >= 10 chars and rejects shorter ones', () => {
    expect(isValidPasswordShape('short')).toBe(false);
    expect(isValidPasswordShape('exactly10c')).toBe(true);
    expect(isValidPasswordShape('a'.repeat(300))).toBe(false);
  });

  it('does not require composition rules (no uppercase/symbol requirement)', () => {
    expect(isValidPasswordShape('alllowercaseletters')).toBe(true);
  });

  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).not.toContain('correct-horse-battery-staple');
    await expect(verifyPassword(hash, 'correct-horse-battery-staple')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const hashA = await hashPassword('same-password-123');
    const hashB = await hashPassword('same-password-123');
    expect(hashA).not.toBe(hashB);
  });

  it('runs the dummy verify without throwing (timing-equalization path)', async () => {
    await expect(verifyAgainstDummyHash()).resolves.toBeUndefined();
  });
});
