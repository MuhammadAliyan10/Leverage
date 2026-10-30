# Leverage API (cloud sync and AI gateway)

This is the existing Node backend used by the Expo app. Its Hono AI routes run in the same API instance as cloud sync; there is no separate gateway service or per-user server. It is not imported by the Expo bundle. Neon credentials and the AI encryption key are used only by this server and the Prisma CLI.

## Local setup

1. Copy `.env.example` to `.env` and set a pooled runtime PostgreSQL URL, a direct/unpooled migration URL, an HTTPS API URL, trusted origins, and a random `BETTER_AUTH_SECRET`.
2. Install dependencies with `npm ci` from this directory.
3. Generate the client with `npm run prisma:generate`.
4. Apply migrations only to a reviewed, disposable development database with `npm run prisma:migrate:deploy`.
5. Start the API with `npm run dev`.

## Container artifact

The backend can be packaged without exposing a database credential in the image:

```sh
docker build -t leverage-api:local .
```

The image runs as the unprivileged `node` user and starts the compiled server with `npm run start:production`'s equivalent (`node dist/src/index.js`). Supply `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ALLOWED_ORIGINS`, and optionally `PORT` through the hosting provider's runtime secret/configuration store. To enable AI on the same API instance, also configure Neon Auth base/JWKS URLs and `AI_CREDENTIAL_ENCRYPTION_KEY` (32 random bytes, 64 hex characters) in that secret store. `DATABASE_URL` must be the pooled runtime PostgreSQL URL with TLS enabled in production. Do not pass credentials as Docker build arguments or bake them into the image. The image health check uses `/health/ready`.

Schema changes are a separate release operation: review the SQL under `prisma/migrations`, then run `npm run prisma:migrate:deploy` from a controlled migration job with `DATABASE_URL_UNPOOLED` pointing to the intended database. Do not run that command as part of container startup, and do not apply migrations to the user's production database without an explicit release approval.

The container recipe is source-checked but has not been built or deployed in this task. It does not resolve the application-level cloud-sync, import, recovery, or Android-native verification gaps listed below.

Never put either database URL in an Expo `EXPO_PUBLIC_*` variable. Do not run migrations against a real database until the initial schema has been compared to that database and the migration reviewed.

## Implemented server surface

- Better Auth email/password registration and sign-in at `/api/auth/*`; sessions live in PostgreSQL, use a 30-day sliding expiry, and are revoked by the auth library on logout.
- Authenticated account list/create/update/archive and transaction list/post endpoints under `/api/v1/finance`.
- Income, expense, and same-currency transfer posting with server-derived ownership, integer minor units, idempotency receipts, transactional writes, append-only transaction rows, and per-user change-log entries.
- Authenticated `/api/v1/sync/identity` and durable change-feed pagination at `/api/v1/sync/changes`.
- Per-user cursor revisions are incremented on the user row inside the same PostgreSQL transaction as each financial change. That row lock serializes publication through commit, so a later committed cursor cannot hide an earlier transaction that commits afterward.
- Change-feed requests are user-scoped and deterministic; clients persist the returned cursor only in the same local SQLite transaction that applies the entire page.
- Shared project collaboration is implemented by owner/member-scoped Neon Data API RPC functions in the `20261030000100_shared_projects` migration. The client queues offline project mutations and sends them with stable idempotency keys; database functions enforce membership and roles, invitations, event revisions, financial operations, and member-removal constraints. This project path is separate from the generic `/api/v1/sync/changes` feed.
- The AI gateway stores provider credentials encrypted server-side, requires authenticated Neon identity and explicit forwarding consent, applies per-user quotas, and forwards only to the supported provider integration. The AI routes run in this same Hono process.
- Health endpoints at `/health/live` and `/health/ready`.

## Deliberate release boundary

The Expo app keeps its existing device-local profile and app lock. Cloud authentication is separate, uses Better Auth's Expo integration with a SecureStore key namespace per local profile, and a local profile can be linked only through the explicit Settings flow when that profile contains no financial records. There is no automatic email matching, record import, or upload of pre-existing data.

The generic client outbox supports account create/update/archive and income/expense/transfer posting. Supported local provisional writes and their outbox rows are committed atomically. The app checks the authenticated cloud user before sync, posts with stable idempotency keys, and applies authenticated change pages with the cursor in one SQLite transaction. A rejected outbox mutation stays in local history and is marked for attention. Shared projects synchronize through the separate Neon RPC path described above.

This is not a complete cloud copy of every local financial feature. Budgets, savings, emergency funds, obligations, debt, assets, investments, refunds/corrections, and historical import are not included in the generic account/transaction change feed; local write guards prevent unsupported operations from silently mixing into linked cloud profiles. Shared projects have their own cloud RPC implementation, but the local PGlite suite does not prove a deployed Neon branch, invitation flow across real users/devices, or Android native behavior. Do not describe those release checks as complete until they have been exercised against disposable real services and devices.

The migration and integration tests use disposable in-memory PGlite. No Neon database was contacted or changed. PGlite checks do not replace a PostgreSQL deployment migration review, Android native testing, or a production backup/recovery test.
