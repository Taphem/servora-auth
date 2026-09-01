import { vi } from 'vitest';
import type { Logger } from '../../src/observability/logger.js';

export interface FakeLogger {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

/** Minimal logger double — captures calls without pino's formatting so tests can assert on exact args. */
export function createFakeLogger(): FakeLogger & Logger {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  return logger as unknown as FakeLogger & Logger;
}
