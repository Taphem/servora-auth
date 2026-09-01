import type { ErrorCode } from './errorCodes.js';

export interface AppErrorOptions {
  statusCode: number;
  code: ErrorCode;
  message: string;
  cause?: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = options.statusCode;
    this.code = options.code;
  }
}
