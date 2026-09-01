import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';

type CookieEnv = Pick<
  Env,
  'SESSION_COOKIE_NAME' | 'SESSION_COOKIE_DOMAIN' | 'SESSION_COOKIE_PATH' | 'SESSION_COOKIE_SAME_SITE' | 'sessionCookieSecure' | 'SESSION_TTL_SECONDS'
>;

export function setSessionCookie(reply: FastifyReply, env: CookieEnv, rawToken: string): void {
  reply.setCookie(env.SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: env.sessionCookieSecure,
    sameSite: env.SESSION_COOKIE_SAME_SITE,
    domain: env.SESSION_COOKIE_DOMAIN,
    path: env.SESSION_COOKIE_PATH,
    maxAge: env.SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply, env: CookieEnv): void {
  reply.clearCookie(env.SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: env.sessionCookieSecure,
    sameSite: env.SESSION_COOKIE_SAME_SITE,
    domain: env.SESSION_COOKIE_DOMAIN,
    path: env.SESSION_COOKIE_PATH,
  });
}

export function readSessionCookie(request: FastifyRequest, env: Pick<Env, 'SESSION_COOKIE_NAME'>): string | undefined {
  return request.cookies[env.SESSION_COOKIE_NAME];
}
