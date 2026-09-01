import { describe, expect, it } from 'vitest';
import { generateOtp, hashOtp } from '../../src/security/otp.js';

describe('otp', () => {
  it('generates numeric OTPs of the requested length, zero-padded', () => {
    for (let i = 0; i < 50; i++) {
      const otp = generateOtp(6);
      expect(otp).toMatch(/^\d{6}$/);
    }
  });

  it('supports configurable length', () => {
    expect(generateOtp(4)).toMatch(/^\d{4}$/);
  });

  it('hashes match for equal OTPs and differ for different OTPs', () => {
    expect(hashOtp('123456')).toBe(hashOtp('123456'));
    expect(hashOtp('123456')).not.toBe(hashOtp('654321'));
  });
});
