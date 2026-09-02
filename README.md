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
| `POST /register` | — | Body: `{ email, password, phone? }` — **`phone` is optional**. Creates the account, auto-creates a session, and requests email verification |
| `POST /login` | — | Generic `INVALID_CREDENTIALS` for both unknown email and wrong password |
| `POST /logout` | session cookie (optional) | Always `204`, idempotent |
| `GET /session` | — | `200 { authenticated: false }` when no/invalid session, never `401` |
| `POST /email/verify` | — | Body: `{ token }`. Single-use |
| `POST /email/resend` | — | Body: `{ email }`. Identical generic response whether or not the account exists |
| `POST /phone/otp/request` | session cookie | Body: `{}` — **no `phone` field**; the destination number is always the account's own stored phone (`400 PHONE_NOT_SET` if none) |
| `POST /phone/otp/verify` | session cookie | Body: `{ otp }` — no `phone` field; derived from the pending challenge |
| `GET /google/start` | — | Authorization-code redirect flow. 302 to Google, or `503 GOOGLE_OAUTH_NOT_CONFIGURED` |
| `GET /google/callback` | — | Authorization-code redirect flow. 302 redirect to `OAUTH_POST_LOGIN_REDIRECT_URL` on success |
| `POST /google` | — | Body: `{ credential }` (Google ID token). "Continue with Google" for a frontend that obtains the credential directly (Identity Services button/One Tap) — see "Google authentication" |
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

- **`users`** — `id`, `email` (unique, `citext`), `phone` (unique, **nullable — optional at
  registration**; Postgres treats multiple `NULL`s as distinct, so any number of accounts can have
  no phone at all, no schema change was needed to support this), `password_hash` (nullable —
  Google-only accounts have none), `role`, `status`, `email_verified_at`, `phone_verified_at`,
  timestamps. A non-null `phone` is stored as soon as it's supplied (registration or the phone OTP
  flow) but is not implied to be *verified* — only `phone_verified_at` means that; see
  "Authentication flows".
- **`oauth_identities`** — links a `user_id` to `(provider, provider_subject_id)`, unique per
  provider+subject.
- **`sessions`** — `session_token_hash` (SHA-256 of the raw cookie value, unique), `expires_at`,
  `revoked_at`, `rotated_from` (reserved for future incremental rotation — currently only
  populated conceptually via "revoke all + re-login" after a password reset), `user_agent`, `ip`.
- **`email_verification_tokens`**, **`password_reset_tokens`** — `token_hash` (SHA-256, unique),
  `expires_at`, `consumed_at` (single-use).
- **`otp_challenges`** — `otp_hash` (SHA-256), `phone`, `attempt_count`/`max_attempts`,
  `expires_at`, `consumed_at`. **Present in the schema but no longer written to by the
  application** — phone OTP challenges moved to Redis (see "Phone OTP flow" and "Redis usage"
  below). The table was deliberately kept rather than dropped, so it remains part of the schema
  history untouched; nothing reads or writes it today.

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

**Phone number is optional, by product decision.** An account is fully usable — register, login,
session, email verification — with only email + password; nothing in this service invents,
defaults, or later demands a phone number. `POST /register` accepts an optional `phone` field
(`{ email, password, phone? }`); when supplied it's validated (E.164) and stored on the account
immediately, but **never marked verified by registration itself** — `phone_verified_at` is only
ever set by a completed OTP verification (`markPhoneVerified`), never as a side effect of
registering, verifying email, or Google-authenticating. When omitted, `phone` is `NULL` — not an
empty string, not a placeholder. A user without a phone can request one be added only through the
existing phone OTP flow once authenticated (there is no separate "add phone" endpoint — see "Phone
OTP flow"); a future Profile/Account Settings feature is expected to be the primary way users add
one after the fact, which is out of scope here.

**Login** does not require prior verification to succeed, and does not require a phone number to
exist on the account at all — it establishes a session and honestly reports
`emailVerified`/`phoneVerified` (`false` when no phone is set, exactly as when one is set but
unverified — indistinguishable from the login/session response alone) so the frontend/gateway can
gate access to protected functionality. This is a deliberate reading of the approved design:
verification itself (`/email/resend`, `/phone/otp/request`) needs an identified account to act on,
so login has to remain reachable pre-verification, or a user could never complete verification at
all. "Not fully ready" is enforced by what the *rest of the platform* does with
`emailVerified`/`phoneVerified`, not by blocking authentication outright, and never by requiring a
phone number.

**Account enumeration:** `/login` returns identical `401 INVALID_CREDENTIALS` for "no such
account" and "wrong password" (verified by `test/integration/registerLogin.test.ts`), and both
`/email/resend` and `/password/reset/request` return byte-identical generic responses regardless
of whether the account exists.

## Google authentication

Two backend entry points exist, both ending at the same shared identity-resolution and
session-creation logic (`resolveOrCreateUserForGoogleIdentity`, `src/auth/googleIdentityService.ts`)
— neither is a "signup-only" flow, and which one a given frontend uses doesn't change the account
behavior described below.

**`POST /api/v1/auth/google`** — for a frontend that obtains a Google ID token *directly* (Google
Identity Services "Sign in with Google" button / One Tap), without any page redirect. Body:
`{ credential: "<Google ID token>" }`. The token is verified server-side with `google-auth-library`
(`src/oauth/googleIdTokenVerifier.ts`) — real signature verification against Google's published
keys, plus issuer, audience (`aud` must equal `GOOGLE_CLIENT_ID`), and expiration checks, never a
mock. On success it calls the same `resolveOrCreateUserForGoogleIdentity` used below and creates a
normal session. This is the endpoint a "Continue with Google" button should call.

**`GET /google/start` + `GET /google/callback`** — the pre-existing authorization-code redirect
flow, unchanged and still available for a redirect-based integration. `/start` builds a Google
authorization URL with PKCE (`code_challenge`/`S256`), `state`, and `nonce` via `openid-client`'s
real discovery against `https://accounts.google.com`, persists `{codeVerifier, nonce}` in Redis
keyed by `state` (single-use, 10-minute TTL), and redirects the browser. `/callback` consumes the
stored state (rejects replay), exchanges the code, and verifies the ID token against Google's own
discovery document.

**The button is mode-less, by design.** Neither endpoint accepts (or needs) a `mode`/`signup`/
`login` field — "authenticate me with this Google identity" is the entire contract, whether the
identity already has a Servora account or not:

1. If `(google, sub)` is already linked → authenticate that existing user. No new account, no new
   `oauth_identities` row, no "already registered" error — this is true regardless of whether the
   caller conceptually arrived from a Login or Signup page, since the endpoint has no way to know
   or care which.
2. Else, if Google reports `email_verified: true` and an existing password account has that exact
   email → **safely auto-link** (justified because Google's `email_verified` claim is
   cryptographically backed, not browser-supplied) and mark the account's email verified if it
   wasn't already — "don't ask users to verify an email Google already authenticated." Then
   authenticate that account immediately. No duplicate account is ever created for a matching
   email, and a manual `POST /register` with that same email is completely unaffected by this —
   see "Authentication flows" for why those two paths stay independent.
3. Else → create a brand-new Google-only account (`password_hash: null`, `phone: null`,
   `email_verified_at: now()`, `phone_verified_at: null`) and authenticate it immediately — Google
   never supplies a phone number, and none is invented; phone stays entirely optional here exactly
   as for password registration (see "Authentication flows"). No OTP is sent.
4. If Google reports `email_verified: false` for an identity with no existing link, linking/account
   creation is refused outright (`401 GOOGLE_OAUTH_FAILED`) rather than trusting an unverified
   email — an already-linked identity's subsequent logins don't re-check this.

`GOOGLE_CLIENT_ID` is the single source of truth for both flows — the authorization-code flow
additionally needs `GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` (`env.googleOAuthConfigured`,
gates `/start` + `/callback`), while the ID-token endpoint needs only the client ID
(`env.googleIdTokenVerificationConfigured`, gates `POST /google`) since there's no code exchange
or redirect involved — no second/duplicate client ID variable was introduced. Either gate missing
returns `503 GOOGLE_OAUTH_NOT_CONFIGURED` rather than behaving unpredictably. **No fake Google
login exists anywhere in this codebase** — without real Google credentials, the feature is simply
unavailable in an honestly-reported way, not stubbed. Google ID tokens, access tokens, and
credentials are never logged (`src/observability/logger.ts` redaction) and Google access/refresh
tokens are never persisted — the authorization-code flow discards them once the ID token's claims
are extracted, and the ID-token endpoint never receives one in the first place.

## Email verification flow

`POST /register` (and `POST /email/resend`) generate a 32-byte random token, store only its
SHA-256 hash with a TTL (`EMAIL_VERIFICATION_TOKEN_TTL_SECONDS`, default 1h), and publish an
`EmailVerificationRequested` event carrying the raw token. `POST /email/verify` hashes the
submitted token, looks up an unconsumed/unexpired match, marks it consumed, and sets
`email_verified_at`. Resend is cooldown-gated per account (Redis, default 60s) and returns the
same generic response whether or not the account exists or is already verified.

## Phone OTP flow

Requires an authenticated session (deliberate — see "Authentication flows"). The OTP challenge
itself lives entirely in Redis, not Postgres (`src/redis/otpChallenge.ts`) — per
`servora-docs/02-architecture/database-architecture.md` ("Redis is for cache/rate
limits/temporary state/idempotency/counters/locks where justified"), a short-lived, inherently
TTL-bound challenge is exactly that kind of temporary state, so Redis's own `EX` TTL provides
expiry for free instead of a separate expired-row cleanup job.

`POST /phone/otp/request` takes **`{}` — no `phone` field**. The phone number an OTP is sent to is
always the authenticated user's own stored `users.phone`, read server-side; the request body is
validated with a `.strict()` zod schema that *rejects* a body containing an unexpected `phone` key
outright (`400 VALIDATION_FAILED`) rather than silently ignoring it. This is deliberate, not
incidental: a session must never be usable to redirect an OTP to a phone number the caller doesn't
own, and there is no server-side trust placed in anything the client sends here. If the account has
no phone number at all, the request fails with `400 PHONE_NOT_SET` — the backend never invents one
and never silently succeeds. Once a phone is confirmed present, the route generates a
cryptographically random numeric OTP (`crypto.randomInt`, default 6 digits) and `SET`s a single
Redis key (`otp:phone:challenge:<userId>`, see "Redis usage") holding its SHA-256 hash, the phone
number, and `attempts: 0`/`maxAttempts`, with an `EX` of `OTP_TTL_SECONDS`. Requesting a new OTP
simply overwrites this key — the old code stops working immediately, and only ever the latest
challenge per user exists. A `PhoneOtpRequested` event is published carrying the raw OTP (see
"Notification integration boundary").

`POST /phone/otp/verify` submits only `{ otp }` — the phone number being verified is read back
from the stored challenge, never re-trusted from the client. Verification runs as a single atomic
Redis Lua script (`VERIFY_OTP_SCRIPT` in `src/redis/otpChallenge.ts`): it checks the attempt
counter, compares the submitted OTP's hash, and then either deletes the key (success — single-use)
or increments the attempt counter (wrong guess), all as one indivisible operation. This is what
makes concurrent verification race-safe: Redis executes Lua scripts single-threaded, so two
simultaneous requests submitting the same correct OTP are fully serialized — the first to reach
Redis deletes the key and succeeds, the second observes it already gone and gets
`400 OTP_NOT_REQUESTED`, never a second success (covered by
`test/integration/phoneOtp.test.ts`'s concurrency test). Once attempts are exhausted the script
deletes the challenge outright and returns `429 OTP_ATTEMPTS_EXCEEDED` — even the correct OTP
stops working at that point, requiring a fresh `/request`.

**Phone uniqueness:** `users.phone` is written as soon as a phone is supplied — at registration, or
by a completed OTP verification — under the same `users_phone_unique` database constraint either
way, so two accounts can never simultaneously hold the same non-null phone value, verified or not
(Postgres treats multiple `NULL`s as distinct, so this never affects accounts with no phone). A
duplicate at registration is rejected with `409 PHONE_ALREADY_REGISTERED` before the account is
even created. Both `phoneOtpRequest.ts`'s `findUserByPhone` ownership check and
`phoneOtpVerify.ts`'s `users_phone_unique` violation catch are consequently unreachable through any
flow available today — kept as defense-in-depth in case that registration-time guarantee is ever
relaxed by a future change, not because either is currently load-bearing.

The OTP comparison inside the script uses ordinary (not constant-time) equality on two SHA-256 hex
digests, not the raw OTP — deliberately: hash-to-hash timing cannot leak information about the
preimage due to the avalanche effect, unlike comparing a raw secret's characters directly. The
actual brute-force defense for a 6-digit OTP is the atomic attempt counter and the surrounding
resend cooldown/rate limits (unchanged from before this redesign), not comparison timing.

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
  `token`, `sessionToken`, `otp`, `otpCode`, `internalServiceKey`, `credential` from every log
  line. `NotificationPublisher` implementations only ever log event *type* and *request ID*, never
  the event body (which may contain a raw token/OTP).
- **Google identity trust:** neither Google endpoint ever trusts a browser-supplied email, name,
  subject, or profile field as authoritative — the only trusted identity is what comes back from a
  successful cryptographic verification (`completeGoogleLogin` for the redirect flow,
  `verifyGoogleIdToken` for the ID-token endpoint), and a client-supplied `userId` is never
  accepted anywhere in this service; the session's own user is always the one the server just
  resolved.
- **Error responses:** never expose stack traces, SQL, provider secrets, or internal topology
  (verified by `test/integration/healthAndMisc.test.ts`).
- **Headers:** `@fastify/helmet` with CSP disabled (this service only ever serves JSON, matching
  the gateway's own reasoning).

## Redis usage

Non-authoritative for everything *except* the phone OTP challenge itself, per ADR-003 and
`database-architecture.md` ("temporary state ... where justified"):

| Key pattern | Purpose | TTL |
|---|---|---|
| `ratelimit:<endpoint>:<ip\|email\|user>:<value>` | Fixed-window rate-limit counters (`src/redis/rateLimiter.ts`) | per-endpoint window |
| `cooldown:<endpoint>:<userId>` | Resend cooldowns (`src/redis/cooldown.ts`) | per-endpoint cooldown |
| `oauth:google:state:<state>` | Google OAuth PKCE/nonce state, single-use (`src/oauth/googleOAuthState.ts`) | 10 min |
| `otp:phone:challenge:<userId>` | Phone OTP challenge — hash, phone, attempts (`src/redis/otpChallenge.ts`) | `OTP_TTL_SECONDS` |

A flushed Redis instance degrades rate limiting/cooldowns to "temporarily permissive" and — unlike
before this redesign — would also silently invalidate any in-flight (unverified) phone OTP
challenge, requiring the user to request a new one; it never breaks authentication, session
validity, or already-completed email/phone verification state (all of which live only in
Postgres). This is a deliberate, scoped exception to "Redis is never authoritative for core
business data": a still-pending, minutes-lived OTP challenge is not durable state anyone depends
on surviving a Redis outage — losing one only costs the user a re-request.

`scripts/reset-auth-data.ts` (see "Development data reset" below) only ever deletes keys under
these exact four prefixes, scanned and named explicitly (`SCAN` + `UNLINK`) — never `FLUSHDB`/
`FLUSHALL` — so anything outside them is structurally impossible for it to touch.

**Bloom filter:** not implemented. `servora-docs/02-architecture/database-architecture.md`
describes it as an optional future accelerator for email/phone existence checks, explicitly
conditioned on a measurable reason and a clean invalidation strategy — neither exists at this
scale, so it was left out rather than added speculatively.

## Development data reset

`scripts/reset-auth-data.ts` (`npm run reset-auth-data`) deletes **all rows** from every
auth-owned Postgres table and **all keys** under the four Redis prefixes listed above — schema,
migrations, indexes, and constraints are never touched. This is a deliberate full reset for a
development database, not a test-data-detection tool: every account in this service's database
was created during development, so there is nothing to selectively preserve.

```bash
npm run reset-auth-data                                            # dry run (default) — reports counts, deletes nothing
npm run reset-auth-data -- --execute --confirm=DELETE-ALL-AUTH-DATA  # actually delete
```

Safety properties, all enforced in `scripts/resetAuthDataCore.ts` (exercised directly by
`test/integration/resetAuthData.test.ts`, including against real concurrent/production-guard
scenarios):

- **Dry run by default.** `--execute` alone does nothing destructive.
- **Explicit confirmation required.** `--execute` without `--confirm=DELETE-ALL-AUTH-DATA` (exact
  string) refuses and explains why.
- **Production-refusing.** Refuses to run destructively when `NODE_ENV=production` unless
  `ALLOW_PRODUCTION_DESTRUCTIVE_RESET=I-UNDERSTAND-THIS-DELETES-PRODUCTION-DATA` (exact value) is
  also set — a second, independent, deliberately unwieldy override from the `--confirm` flag.
- **Transactional in Postgres.** All table deletes run inside one `BEGIN`/`COMMIT`; any failure
  rolls back everything.
- **FK-safe, schema-aware.** Deletes children before `users` in a fixed order; checks
  `information_schema.tables` first so it degrades gracefully if a table is ever added or removed
  later, rather than assuming the table list.
- **Redis: named prefixes only, never FLUSHDB/FLUSHALL.** Every key deleted is first enumerated by
  `SCAN` against one of the four known prefixes, then removed by `UNLINK` (non-blocking) — a key
  outside those prefixes cannot be deleted by this script even if this Redis instance ever holds
  unrelated data.
- **Verifies its own result.** After executing, re-counts every table and re-scans every Redis
  prefix and reports whether zero remain — this is not just assumed from the delete call's row
  count.
- **No public HTTP endpoint.** This is a local/CI-invoked script only, never routed.

Sequences are inspected (`information_schema.sequences`) and reported but not touched — this
schema uses only UUID primary keys (`gen_random_uuid()`), so none exist; a future serial/identity
column would show up here rather than being silently ignored.

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
- No "add/change phone number" endpoint for an already-registered account — a phone can only be
  set at registration today. A future Profile/Account Settings feature is expected to add one;
  deliberately not built here (see "Authentication flows").
