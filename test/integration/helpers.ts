import type { LightMyRequestResponse } from 'fastify';

export function getCookieValue(response: LightMyRequestResponse, name: string): string | undefined {
  return response.cookies.find((cookie) => cookie.name === name)?.value;
}

export function isInfraAvailable(): boolean {
  return Boolean(process.env['TEST_DATABASE_URL'] && process.env['TEST_REDIS_URL']);
}
