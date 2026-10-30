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
- Health endpoints at `/health/live` and `/health/ready`.

## Deliberate release boundary

The Expo app keeps its existing device-local profile and app lock. Cloud authentication is separate, uses Better Auth's Expo integration with a SecureStore key namespace per local profile, and a local profile can be linked only through the explicit Settings flow when that profile contains no financial records. There is no automatic email matching, record import, or upload of pre-existing data.

The client outbox supports account create/update/archive and basic income/expense/transfer posting. Supported local provisional writes and their outbox rows are committed atomically. The app checks the authenticated cloud user before sync, posts with stable idempotency keys, and applies authenticated change pages with the cursor in one SQLite transaction. A rejected outbox mutation stays in local history and is marked for attention.

This is not the complete cloud/offline product and is not production-ready. Budgets, savings, emergency funds, obligations, debt, assets, investments, refunds/corrections, and historical import are intentionally excluded from cloud sync. SQLite guards block unsupported module writes in linked cloud profiles to prevent reports from mixing unsynced records with cloud-backed data. Do not deploy this as the production financial backend or claim verified cross-device synchronization until disposable real PostgreSQL and Android native tests pass.

The migration and integration tests use disposable in-memory PGlite. No Neon database was contacted or changed. PGlite checks do not replace a PostgreSQL deployment migration review, Android native testing, or a production backup/recovery test.
