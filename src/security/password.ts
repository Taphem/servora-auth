import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * OWASP-recommended minimums for Argon2id (memory in KiB, iterations, parallelism).
 * See: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/** A constant, never-matched hash used to equalize response timing when no user exists. */
let dummyHashPromise: Promise<string> | undefined;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

export function isValidPasswordShape(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

/**
 * Runs a real Argon2id verify against a fixed dummy hash so that a login
 * attempt against a non-existent user takes roughly as long as one against
 * a real user — reduces (does not eliminate) user-enumeration via timing.
 */
export async function verifyAgainstDummyHash(): Promise<void> {
  dummyHashPromise ??= hash('servora-dummy-password-for-timing-equalization', ARGON2_OPTIONS);
  const dummy = await dummyHashPromise;
  await verify(dummy, 'this-will-never-match');
}
