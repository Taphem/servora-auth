import { describe, expect, it } from 'vitest';
import { secureCompare } from '../../src/security/compare.js';

describe('secureCompare', () => {
  it('returns true for identical strings', () => {
    expect(secureCompare('secret-value', 'secret-value')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(secureCompare('secret-value', 'different-value')).toBe(false);
  });

  it('does not throw on mismatched lengths', () => {
    expect(() => secureCompare('short', 'a-much-longer-string-value')).not.toThrow();
    expect(secureCompare('short', 'a-much-longer-string-value')).toBe(false);
  });

  it('treats empty strings correctly', () => {
    expect(secureCompare('', '')).toBe(true);
    expect(secureCompare('', 'nonempty')).toBe(false);
  });
});
