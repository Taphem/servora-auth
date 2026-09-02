import pino from 'pino';
import type { Env } from '../config/env.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-servora-internal-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.sessionToken',
  '*.otp',
  '*.otpCode',
  '*.internalServiceKey',
  '*.credential',
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>) {
  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    transport:
      env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
