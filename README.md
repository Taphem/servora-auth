# Servora Auth

Standalone identity and authentication service for [Servora](https://servora.hemandu.com), an
AI-powered local service marketplace. This is the only Servora service that owns credentials,
sessions, and identity verification.

## Repository independence

`servora-auth` is a completely standalone, independently deployable repository. It does not share
source code with, import from, or depend on any other Servora repository at build or run time —
including `servora-web`, `servora-api-gateway`, `servora-users`, `servora-business-service`,
`servora-service-catalog`, `servora-booking`, `servora-payment`, `servora-notification`,
`servora-search`, `servora-ai`, or `servora-workers`. Where this service needs to reach another
service (currently just an outbound call toward `servora-notification`), it does so over plain
HTTP against a configurable base URL. Everything here can be built, linted, tested, and run with
only this repository checked out (Postgres and Redis aside — see "Local development").

## Responsibility

Per `servora-docs/02-architecture/service-boundaries.md` ("Auth: Identity, credentials, sessions,
verification"), this service owns:

- Registration, login, logout
- Password hashing and verification (Argon2id)
- Email verification and phone OTP verification
- Google OAuth / OpenID Connect
- Session issuance, validation, rotation-on-password-reset, and revocation
- Password reset / account recovery
- A single coarse platform-level role per account (`CUSTOMER`, `BUSINESS_OWNER`,
  `BUSINESS_STAFF`, `ADMIN`, `SUPER_ADMIN`, `SUPPORT`) for RBAC

It explicitly does **not** own: user profiles/addresses, business/staff domain data, service
catalog/pricing, bookings, payments, invoices, refunds, reviews, search, recommendations, AI, maps,
or notification delivery (email/SMS/push are sent by `servora-notification`, not this service).
Fine-grained, resource-scoped permissions (e.g. which business a `BUSINESS_STAFF` account can act
on) are owned by the Business service, not here.

## Technology

Node.js 24 (TypeScript, ESM) + [Fastify](https://fastify.dev). Dependencies were chosen
deliberately:

| Package | Why |
|---|---|
| `fastify`, `@fastify/cookie`, `@fastify/helmet` | HTTP framework, session cookie handling, secure headers |
| `pg` | PostgreSQL driver. No ORM — six tables with plain constraints/indexes don't justify one; see `migrations/0001_init.sql` and the hand-written query modules in `src/db/queries/` |
| `ioredis` | Redis client for rate limits, cooldowns, and OAuth state — never authoritative |
| `@node-rs/argon2` | Argon2id password hashing via prebuilt native bindings (no node-gyp/build-toolchain requirement, unlike the `argon2` package) |
| `openid-client` | Genuine Google OAuth/OpenID Connect — real discovery, PKCE, state, nonce, and ID-token verification, not a mock |
| `zod` | Environment and request-body validation |
| `pino` | Structured, redacted logging |
| `tsx`, `typescript`, `eslint`, `vitest` | Dev tooling only |

## Project structure

```text
src/
├── app/            # buildApp.ts (wires plugins + routes), context.ts (DI container)
├── auth/           # session cookie helpers, session service, Google identity linking
├── config/         # env validation (zod), rate-limit constants
├── db/             # pg Pool, query modules (one per table), row→domain mappers
├── errors/         # AppError + stable error codes
├── health/         # /health, /ready
├── notifications/  # NotificationPublisher interface + Http/Null/InMemory implementations
├── oauth/          # Google OIDC client wrapper + Redis-backed OAuth state
├── observability/  # pino logger with secret redaction
├── plugins/        # request-id, error handler, security headers, cookies, internal-auth guard
├── redis/          # client, rate limiter, cooldown helper
├── routes/         # v1/auth/* (public) and internal/v1/* (service-to-service)
├── schemas/        # zod request-body schemas
├── security/        # password hashing, token/OTP generation & hashing, constant-time compare
└── server.ts        # process entrypoint, graceful shutdown
migrations/           # numbered .sql files, applied by scripts/migrate.ts
test/
├── unit/             # pure-function tests, no infrastructure required
└── integration/      # real Postgres + Redis, full HTTP flows via Fastify inject()
```

## Local development

Requires Node.js 24 (see `.nvmrc`) and a local Postgres + Redis (via `docker-compose.yml`, or your
own instances).

```bash
docker compose up -d          # starts local Postgres + Redis
cp .env.example .env          # edit as needed; never commit this file
npm ci
npm run migrate               # applies migrations/*.sql
npm run dev                   # tsx watch, local dev on :4001
```

No other Servora repository needs to be running: `NOTIFICATION_SERVICE_URL` and the three
`GOOGLE_*` variables can all be left unset, and the service degrades honestly (verification
challenges are still created and persisted; Google routes return a clear `503
GOOGLE_OAUTH_NOT_CONFIGURED` instead of failing unsafely or faking a login). Automated tests never
require real Google credentials — Google's OIDC client is exercised only for its "not configured"
degrade path in integration tests; the OAuth callback logic (state/PKCE handling, identity
linking, new-vs-existing-user resolution) is unit-testable in isolation from the network call.

```bash
npm run dev          # tsx watch
npm run build        # tsc -> dist/
npm run start          # run the compiled build (node dist/server.js)
npm run lint            # eslint
npm run typecheck        # tsc --noEmit
npm test                  # vitest run (unit always; integration skips if TEST_DATABASE_URL/TEST_REDIS_URL unset)
npm run migrate            # apply migrations/*.sql
```

### Running the test suite

Unit tests (`test/unit/`) never touch a network or database. Integration tests
(`test/integration/`) exercise real HTTP flows against a real Postgres + Redis and are skipped
automatically — not silently faked — when `TEST_DATABASE_URL`/`TEST_REDIS_URL` aren't set:

```bash
export TEST_DATABASE_URL=postgresql://auth:auth@localhost:5432/servora_auth_test
export TEST_REDIS_URL=redis://localhost:6379
npm test
```

Test files run serially (`fileParallelism: false` in `vitest.config.ts`) because integration tests
share one external Postgres/Redis instance and truncate all auth tables between tests — running
files in parallel would let one file's reset clobber another file's in-flight assertions.

## API versioning

Public API is served under `/api/v1/`, per `servora-docs/09-api/versioning.md`. Internal
(service-to-service only) routes are served under `/internal/v1/` and are never proxied under
`/api/v1` by design — see "Internal session verification" below.

## Public API — `/api/v1/auth/*`

| Method & path | Auth required | Notes |
|---|---|---|
| `POST /register` | — | Creates the account, auto-creates a session, and requests email verification |
| `POST /login` | — | Generic `INVALID_CREDENTIALS` for both unknown email and wrong password |
| `POST /logout` | session cookie (optional) | Always `204`, idempotent |
| `GET /session` | — | `200 { authenticated: false }` when no/invalid session, never `401` |
| `POST /email/verify` | — | Body: `{ token }`. Single-use |
| `POST /email/resend` | — | Body: `{ email }`. Identical generic response whether or not the account exists |
| `POST /phone/otp/request` | session cookie | Body: `{ phone }` |
| `POST /phone/otp/verify` | session cookie | Body: `{ otp }` |
| `GET /google/start` | — | 302 redirect to Google, or `503 GOOGLE_OAUTH_NOT_CONFIGURED` |
| `GET /google/callback` | — | 302 redirect to `OAUTH_POST_LOGIN_REDIRECT_URL` on success |
| `POST /password/reset/request` | — | Body: `{ email }`. Identical generic response either way |
| `POST /password/reset/confirm` | — | Body: `{ token, newPassword }`. Revokes all existing sessions |

All error responses use the documented envelope
(`servora-docs/09-api/error-handling.md`):

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "Invalid email or password.", "requestId": "..." } }
```

## Internal session verification — WORKING CONTRACT (PROPOSED)

`servora-docs` does not define an internal session-verification contract. The API Gateway
(`servora-api-gateway/src/clients/authClient.ts`) already contains a **provisional** client for
`POST /internal/v1/sessions/verify`, and its own code/README mark it explicitly unconfirmed. Per
the approved design for this repository, this service implements that contract as-is (same path,
request/response shape) so the two services interoperate today, **plus** service-to-service
authentication the gateway's current code does not yet send:

**Request**
```
POST /internal/v1/sessions/verify
x-servora-internal-key: <INTERNAL_SERVICE_KEY>
Content-Type: application/json

{ "sessionToken": "<raw session cookie value>" }
```

**Response** (`200` in both cases — matches the gateway's existing client, which treats any
non-200 as "no identity" regardless of body)
```jsonc
// valid
{ "valid": true, "userId": "...", "role": "CUSTOMER", "sessionId": "..." }
// invalid/expired/revoked/unknown
{ "valid": false }
```

Missing or incorrect `x-servora-internal-key` is a `401 INTERNAL_AUTH_FAILED` (not a `200
{valid:false}` — that's a distinct failure mode from "the caller's session token was bad").

**What's genuinely new here, not just a restatement of the gateway's provisional shape:**

1. **Service-to-service authentication.** `servora-docs/03-authentication/authorization.md`
   states "internal services must not blindly trust every internal caller," but the gateway's
   `AuthClient.verifySession()` currently sends an unauthenticated POST. This service requires
   `x-servora-internal-key` to match `INTERNAL_SERVICE_KEY` (constant-time comparison — see
   `src/security/compare.ts`) on every call. **The gateway does not send this header yet** — that
   repository was explicitly not modified as part of this work. Until the gateway is updated to
   send it, every gateway→auth internal call will receive `401 INTERNAL_AUTH_FAILED`, which the
   gateway's existing code already handles safely (it logs a warning and proceeds with no identity
   attached, per its own fail-open design — see `servora-api-gateway/src/plugins/auth.ts`). This
   is a **known follow-up**, not a bug in either repository: whoever next touches the gateway
   needs to add `x-servora-internal-key: <the shared INTERNAL_SERVICE_KEY value>` to
   `AuthClient`'s request headers.
2. **Coarse role ownership.** Returning `role` here means this service is the owner of a single
   platform-level role per account. This was flagged as an assumption in the Phase 1 documentation
   review and is now baked into `users.role` — fine-grained/business-scoped permissions are
   explicitly out of scope here (see "Responsibility" above).

This is documented here, in this repository, as instructed — `servora-docs` was not modified.

## Notification integration boundary — CONFIRMED contract

`servora-notification` is deployed and its internal HTTP contract is documented in that
repository (`servora-notification/docs/api.md`, `docs/integration.md`). This service's outbound
side (`src/notifications/`) was updated to match it exactly — it is no longer a proposal:

- `NotificationPublisher` — the interface every call site depends on (`publish(event)`),
  unchanged by this update.
- `NotificationEvent` (`src/notifications/events.ts`) — three internal TypeScript-only shapes
  (`EmailVerificationRequested`, `PhoneOtpRequested`, `PasswordResetRequested`); `type` and
  `requestId` are never sent in the outbound body — see `notificationRequest.ts`.
- `toNotificationHttpRequest` (`src/notifications/notificationRequest.ts`) — pure mapping from an
  internal event to the exact `{ path, body }` servora-notification documents for each of its
  three resource-oriented endpoints:

  | Auth-side trigger | Call into servora-notification | Body |
  |---|---|---|
  | `POST /register`, `POST /email/resend` | `POST /internal/v1/notifications/email-verification` | `{ userId, email, verificationToken }` |
  | `POST /password/reset/request` | `POST /internal/v1/notifications/password-reset` | `{ userId, email, resetToken }` |
  | `POST /phone/otp/request` | `POST /internal/v1/notifications/phone-otp` | `{ userId, phone, otp, expiresInSeconds }` |

- `HttpNotificationPublisher` — sends `x-servora-internal-key: <INTERNAL_SERVICE_KEY>` (the same
  shared secret used on the internal session-verify endpoint) and `x-request-id: <requestId>` on
  every call, to `${NOTIFICATION_SERVICE_URL}<path>`. Success is `202 { accepted: true }`. A
  non-2xx response, an unreachable service, or a malformed/unexpected response body is logged as a
  warning (HTTP status, servora-notification's own error `code` when present, event type, request
  ID) and **swallowed, never thrown** — the token/OTP is already durably persisted in Postgres
  before this call happens, so a delivery failure never blocks or fails the calling auth flow; the
  user can always retry via `/email/resend` or a fresh `/phone/otp/request`. Never logged, under
  any outcome: `INTERNAL_SERVICE_KEY`, the raw token/OTP, or the request/response body.
- `NullNotificationPublisher` — used when `NOTIFICATION_SERVICE_URL` is unset. The verification/
  reset challenge is still created and persisted in Postgres; it just isn't delivered anywhere. A
  warning is logged (event type + request ID only, never the payload). This mirrors the API
  Gateway's own `DOWNSTREAM_NOT_CONFIGURED` honesty pattern.
- `InMemoryNotificationPublisher` — test double; used throughout `test/integration/` to assert on
  exactly what would have been sent, without a network call.

**History:** this was previously a PROPOSED, unconfirmed contract — a single generic
`POST {baseUrl}/internal/v1/events` endpoint with a `type`-discriminated envelope, no internal-auth
header, and `expiresAt` ISO timestamps. `servora-notification` was built independently to its own
specified contract (three resource-oriented endpoints, `x-servora-internal-key` required,
`expiresInSeconds` for the OTP flow — a deliberate, more security-conscious choice on that
repository's part, documented in its `docs/integration.md` "Known contract mismatch" section as of
before this update). This service has now been updated to match that contract exactly, rather than
the other way around — `servora-notification` was not modified as part of this work.

## Database schema

PostgreSQL is authoritative (`servora-docs/02-architecture/database-architecture.md`, ADR-002). No
ORM — see `migrations/0001_init.sql` for the full DDL. Six tables, all Auth-owned:

- **`users`** — `id`, `email` (unique, `citext`), `phone` (unique, nullable — only set once
  verified), `password_hash` (nullable — Google-only accounts have none), `role`, `status`,
  `email_verified_at`, `phone_verified_at`, timestamps.
- **`oauth_identities`** — links a `user_id` to `(provider, provider_subject_id)`, unique per
  provider+subject.
- **`sessions`** — `session_token_hash` (SHA-256 of the raw cookie value, unique), `expires_at`,
  `revoked_at`, `rotated_from` (reserved for future incremental rotation — currently only
  populated conceptually via "revoke all + re-login" after a password reset), `user_agent`, `ip`.
- **`email_verification_tokens`**, **`password_reset_tokens`** — `token_hash` (SHA-256, unique),
  `expires_at`, `consumed_at` (single-use).
- **`otp_challenges`** — `otp_hash` (SHA-256), `phone`, `attempt_count`/`max_attempts`,
  `expires_at`, `consumed_at`.

Never persisted in plaintext, anywhere: passwords, session tokens, verification tokens, OTPs,
reset tokens — only their SHA-256 (tokens/OTPs) or Argon2id (passwords) form. See "Security" for
why tokens use a fast hash and passwords use a slow one.

**Known gap:** no retention/purge job for expired or consumed tokens, OTP challenges, or revoked
sessions — `servora-docs` doesn't specify a retention period, and none was implemented here. Rows
accumulate indefinitely; a scheduled cleanup (cron/worker) is a reasonable follow-up.

## Session / cookie architecture

Opaque, server-side sessions — **not JWTs** — per the approved design. `POST /register`,
`POST /login`, and a successful `GET /google/callback` each generate a random 32-byte token
(`crypto.randomBytes`, base64url-encoded), store only its SHA-256 hash in `sessions`, and set it
as the value of an HttpOnly cookie. `GET /session` and the internal verify endpoint both resolve a
raw cookie value back to its session by hashing and looking up.

Cookie attributes (`src/auth/sessionCookie.ts`) are fully environment-driven:
`SESSION_COOKIE_NAME` (default `servora_session`, must match the gateway's
`SESSION_COOKIE_NAME`), `SESSION_COOKIE_DOMAIN`, `SESSION_COOKIE_PATH`, `SESSION_COOKIE_SECURE`
(defaults to `true` in production; boot refuses `false` in production), `SESSION_COOKIE_SAME_SITE`
(default `lax`), `SESSION_TTL_SECONDS`.

**Session security after password reset:** `POST /password/reset/confirm` revokes every existing
session for the account (not just rotates the current one) and does not auto-issue a new session —
the user must log in again with the new password. This is deliberate: a credential compromise
shouldn't survive a password change just because an attacker's session was still valid.

**CSRF:** state-changing routes rely on `SameSite=Lax` (blocks the cookie being attached to
cross-site POSTs in modern browsers) rather than a separate CSRF token scheme — appropriate for a
JSON API reached only through the API Gateway, not a form-posting HTML site. `authentication.md`
and `session-management.md` call for "CSRF protection where applicable"; this is the applied
choice, not an oversight, but a synchronizer-token scheme would be a reasonable hardening step if
a same-site embedding scenario is ever introduced.

## Authentication flows

**Registration → email verification → phone OTP → account ready.** Registration only collects
email + password; phone is supplied later, at `POST /phone/otp/request` — this unifies the
password and Google registration paths (Google never supplies a phone number) instead of forcing
phone collection at signup. `email_verified_at`/`phone_verified_at` are never set automatically;
`markEmailVerified`/`markPhoneVerified` only run after their respective token/OTP is actually
validated.

**Login** does not require prior verification to succeed — it establishes a session and honestly
reports `emailVerified`/`phoneVerified` in the response so the frontend/gateway can gate access to
protected functionality. This is a deliberate reading of the approved design: verification itself
(`/email/resend`, `/phone/otp/request`) needs an identified account to act on, so login has to
remain reachable pre-verification, or a user could never complete verification at all. "Not fully
ready" is enforced by what the *rest of the platform* does with `emailVerified`/`phoneVerified`,
not by blocking authentication outright.

**Account enumeration:** `/login` returns identical `401 INVALID_CREDENTIALS` for "no such
account" and "wrong password" (verified by `test/integration/registerLogin.test.ts`), and both
`/email/resend` and `/password/reset/request` return byte-identical generic responses regardless
of whether the account exists.

## Google OAuth flow

`GET /google/start` → builds a Google authorization URL with PKCE (`code_challenge`/`S256`),
`state`, and `nonce`, all via `openid-client`'s real discovery against
`https://accounts.google.com`; persists `{codeVerifier, nonce}` in Redis keyed by `state`
(single-use, 10-minute TTL) → redirects the browser.

`GET /google/callback` → consumes the stored state (rejects replay), exchanges the code, and
verifies the ID token against Google's own discovery document — this is genuine OpenID Connect,
never a mock. `resolveOrCreateUserForGoogleIdentity` (`src/auth/googleIdentityService.ts`) then:

1. If `(google, sub)` is already linked → log in as that user.
2. Else, if Google reports `email_verified: true` and an existing password account has that exact
   email → **auto-link** (safe because Google's `email_verified` claim is trustworthy) and mark
   the account's email verified if it wasn't already — "don't ask users to verify an email Google
   already authenticated."
3. Else → create a brand-new Google-only account (`password_hash: null`,
   `email_verified_at: now()`, **`phone_verified_at: null`**). Per the approved design, a
   Google-created account still must complete phone verification separately before being
   considered fully ready — this function never touches `phone_verified_at`.
4. If Google reports `email_verified: false`, linking/account-creation is refused outright
   (`401 GOOGLE_OAUTH_FAILED`) rather than trusting an unverified email.

`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` are all-or-nothing
(`env.googleOAuthConfigured`); if any is missing, both routes return `503
GOOGLE_OAUTH_NOT_CONFIGURED` rather than behaving unpredictably. **No fake Google login exists
anywhere in this codebase** — without real Google credentials, the feature is simply unavailable
in an honestly-reported way, not stubbed.

## Email verification flow

`POST /register` (and `POST /email/resend`) generate a 32-byte random token, store only its
SHA-256 hash with a TTL (`EMAIL_VERIFICATION_TOKEN_TTL_SECONDS`, default 1h), and publish an
`EmailVerificationRequested` event carrying the raw token. `POST /email/verify` hashes the
submitted token, looks up an unconsumed/unexpired match, marks it consumed, and sets
`email_verified_at`. Resend is cooldown-gated per account (Redis, default 60s) and returns the
same generic response whether or not the account exists or is already verified.

## Phone OTP flow

Requires an authenticated session (deliberate — see "Authentication flows"). `POST
/phone/otp/request` accepts `{ phone }`, generates a cryptographically random numeric OTP
(`crypto.randomInt`, default 6 digits), stores only its SHA-256 hash with `max_attempts` (default
5) and a short TTL (default 5 min), and publishes a `PhoneOtpRequested` event. `POST
/phone/otp/verify` compares via constant-time comparison of the hashes
(`src/security/compare.ts`), increments `attempt_count` on mismatch, and once attempts are
exhausted returns `429 OTP_ATTEMPTS_EXCEEDED` (not `400`) requiring a fresh `/request`. On success,
`phone` is only written to `users.phone` at this point — never reserved earlier — so a phone
number can't be squatted by starting-but-never-completing verification; a `23505` unique-violation
race against another account claiming the same number is caught and mapped to `409
PHONE_ALREADY_REGISTERED`.

## Internal service authentication

`src/plugins/internalAuth.ts` — `x-servora-internal-key` must match `INTERNAL_SERVICE_KEY`
exactly (SHA-256 both sides, then `crypto.timingSafeEqual`, avoiding both a length-mismatch throw
and a timing side-channel). Missing or wrong key → `401 INTERNAL_AUTH_FAILED`. Enforced only on
`/internal/v1/sessions/verify`, which is never mounted under `/api/v1`. `INTERNAL_SERVICE_KEY`
must be ≥ 32 characters in production (boot-time check in `src/config/env.ts`) — this value must
never reach a browser, frontend build, or public log line.

## Security

- **Passwords:** Argon2id (`@node-rs/argon2`), OWASP-recommended minimum cost parameters (19 MiB
  memory, 2 iterations, parallelism 1). Minimum 10 characters, no composition rules. A login
  attempt against a non-existent account (or a Google-only account with no password) runs a real
  Argon2id verify against a fixed dummy hash, so response timing doesn't distinguish "no such
  account" from "wrong password" (see `src/security/password.ts`).
- **Tokens/OTPs:** high-entropy random values hashed with SHA-256 (fast hash is correct here —
  these aren't low-entropy user-chosen secrets, so a slow KDF would be pure cost with no security
  benefit). Single-use, expiring, never logged (see redaction below), never stored in plaintext.
- **Rate limiting:** Redis-backed fixed-window counters (`src/redis/rateLimiter.ts`) on
  registration, login, email resend, OTP request/verify, and password reset — by IP and by
  identity, per `servora-docs/08-security/rate-limiting.md`. Not a correctness-critical boundary:
  an occasional missed `EXPIRE` self-heals on the next window (see code comment).
- **Logging:** `pino` redaction (`src/observability/logger.ts`) strips `authorization`, `cookie`,
  `set-cookie`, `x-servora-internal-key` headers, and any field named `password`, `newPassword`,
  `token`, `sessionToken`, `otp`, `otpCode`, `internalServiceKey` from every log line.
  `NotificationPublisher` implementations only ever log event *type* and *request ID*, never the
  event body (which may contain a raw token/OTP).
- **Error responses:** never expose stack traces, SQL, provider secrets, or internal topology
  (verified by `test/integration/healthAndMisc.test.ts`).
- **Headers:** `@fastify/helmet` with CSP disabled (this service only ever serves JSON, matching
  the gateway's own reasoning).

## Redis usage

Non-authoritative only, per ADR-003 and `database-architecture.md`: rate-limit counters
(`src/redis/rateLimiter.ts`), resend/OTP cooldowns (`src/redis/cooldown.ts`), and short-lived
Google OAuth state (`src/oauth/googleOAuthState.ts`, 10-minute TTL, single-use). No correctness
invariant depends solely on Redis — a flushed Redis instance degrades rate limiting/cooldowns to
"temporarily permissive," never breaks authentication, session validity, or verification state
(all of which live only in Postgres).

**Bloom filter:** not implemented. `servora-docs/02-architecture/database-architecture.md`
describes it as an optional future accelerator for email/phone existence checks, explicitly
conditioned on a measurable reason and a clean invalidation strategy — neither exists at this
scale, so it was left out rather than added speculatively.

## Environment variables

See `.env.example` for the complete, commented list. Required with no default: `DATABASE_URL`,
`REDIS_URL`, `INTERNAL_SERVICE_KEY`. Everything Google/Notification-related is optional and
degrades honestly when unset (see above). Boot-time validation (`src/config/env.ts`, zod) refuses
to start in production with `SESSION_COOKIE_SECURE=false` or an `INTERNAL_SERVICE_KEY` under 32
characters — mirroring the gateway's own "refuse to boot with insufficiently explicit
configuration" pattern for CORS.

## Observability

Structured JSON logging (`pino`), a request ID on every request (`x-request-id`: reused if
well-formed and client-supplied, generated otherwise — via `genReqId`, so it's present from the
very first log line, not just after a hook runs), `GET /health` (always `200` while the process is
alive) and `GET /ready` (`200` only after the startup DB check succeeds, `503` during
startup/shutdown). Metrics/tracing (Prometheus/OpenTelemetry, per
`servora-docs/07-devops/observability.md`) are not wired up yet — no metrics library is installed,
since none was justified by a concrete need at this milestone; the health/readiness/logging
foundation is in place for it to be added without restructuring anything.

## Deployment

`Dockerfile` — four-stage build (deps → build → prod-deps → runtime), non-root `node` user, no
dev dependencies or build cache in the final image, `HEALTHCHECK` against `/health`. Database
migrations are deliberately **not** run from inside the runtime image — they're a separate step
(`npm run migrate`, which needs `tsx`, a dev dependency) run against CI or a deploy pipeline with
the full repository checked out, before the new image is promoted. `.github/workflows/ci.yml`:
install → lint → typecheck → migrate (against a Postgres/Redis service container) → test → build,
plus a separate job building the Docker image. It does not deploy anywhere.

## Not implemented / explicitly out of scope here

- No metrics/tracing wiring (see "Observability").
- No scheduled cleanup of expired tokens/OTPs/revoked sessions (see "Database schema").
- The API Gateway does not yet send `x-servora-internal-key` — that repository was not modified as
  part of this work (see "Internal session verification").
- No CSRF token scheme beyond `SameSite=Lax` — see "Session / cookie architecture."
