import type { RedisClient } from './client.js';

/**
 * Phone OTP challenges live entirely in Redis, not Postgres — per
 * servora-docs/02-architecture/database-architecture.md ("Redis is for
 * cache/rate limits/temporary state/idempotency/counters/locks where
 * justified"), a short-lived (minutes), inherently TTL-bound challenge is
 * exactly that kind of temporary state. Redis's own TTL provides expiry
 * for free; requesting a new OTP simply overwrites the previous challenge
 * key, so only the latest challenge per user ever exists — no separate
 * cleanup of old/expired rows is needed (unlike the Postgres-backed design
 * this replaced).
 *
 * Verification (VERIFY_OTP_SCRIPT below) runs as a single atomic Lua
 * script so that "check attempts, compare, then consume-or-increment" is
 * one indivisible Redis operation — required so two concurrent requests
 * submitting the same correct OTP cannot both succeed (Redis executes Lua
 * scripts single-threaded; a concurrent EVAL for the same key is fully
 * serialized after the first, so it observes the key already deleted).
 *
 * The OTP comparison itself happens inside the script comparing two
 * SHA-256 hex digests (never the raw OTP) via ordinary string equality,
 * not a constant-time comparison. This is intentional, not an oversight:
 * hash-to-hash equality timing cannot leak information about the
 * preimage (the raw OTP) — a hash's avalanche property means a
 * partially-matching hash carries no signal about how "close" a guessed
 * OTP is, unlike comparing a raw secret's characters directly. The real
 * brute-force defense for a 6-digit OTP is the attempt counter and
 * resend cooldown enforced by this same script and the surrounding
 * rate limits, not comparison timing.
 */

export interface OtpChallengeData {
  otpHash: string;
  phone: string;
  maxAttempts: number;
}

export type VerifyOtpResult =
  | { status: 'success'; phone: string }
  | { status: 'invalid'; attemptsRemaining: number }
  | { status: 'not_found' }
  | { status: 'attempts_exceeded' };

export function otpChallengeKey(userId: string): string {
  return `otp:phone:challenge:${userId}`;
}

/**
 * The verify request only submits { otp } (no phone — see schemas/auth.ts),
 * so the phone number being verified is remembered inside the challenge
 * itself and returned on success, rather than trusted from the client
 * again.
 */
export async function storeOtpChallenge(
  redis: RedisClient,
  userId: string,
  data: OtpChallengeData,
  ttlSeconds: number,
): Promise<void> {
  const payload = JSON.stringify({ otpHash: data.otpHash, phone: data.phone, attempts: 0, maxAttempts: data.maxAttempts });
  await redis.set(otpChallengeKey(userId), payload, 'EX', ttlSeconds);
}

const VERIFY_OTP_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {-1, 0}
end

local data = cjson.decode(raw)

if data.otpHash == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {1, 0, data.phone}
end

data.attempts = data.attempts + 1

if data.attempts >= data.maxAttempts then
  redis.call('DEL', KEYS[1])
  return {-2, 0}
end

local ttl = redis.call('TTL', KEYS[1])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], cjson.encode(data), 'EX', ttl)
else
  redis.call('SET', KEYS[1], cjson.encode(data))
end

return {0, data.maxAttempts - data.attempts}
`;

export async function verifyOtpChallenge(redis: RedisClient, userId: string, submittedOtpHash: string): Promise<VerifyOtpResult> {
  const result = (await redis.eval(VERIFY_OTP_SCRIPT, 1, otpChallengeKey(userId), submittedOtpHash)) as [number, number, string?];
  const [status, attemptsRemaining, phone] = result;

  switch (status) {
    case 1:
      return { status: 'success', phone: phone! };
    case 0:
      return { status: 'invalid', attemptsRemaining };
    case -1:
      return { status: 'not_found' };
    case -2:
      return { status: 'attempts_exceeded' };
    default:
      throw new Error(`Unexpected verifyOtpChallenge result status: ${String(status)}`);
  }
}
