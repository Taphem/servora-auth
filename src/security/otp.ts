import { randomInt } from 'node:crypto';
import { hashToken } from './tokens.js';

/** Cryptographically secure numeric OTP, zero-padded to the configured length. */
export function generateOtp(length: number): string {
  const max = 10 ** length;
  const value = randomInt(0, max);
  return value.toString().padStart(length, '0');
}

export function hashOtp(rawOtp: string): string {
  return hashToken(rawOtp);
}
