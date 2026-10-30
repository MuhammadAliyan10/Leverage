# AI configuration foundation

## Scope

AI is optional, read-only and disabled by default. Phase 1 provides configuration, explicit consent, a selected-model connection test, and the existing guarded financial-data selectors. It does not add an analyst, agent, background job, embedding, vector store, or financial write path.

## Identity and gateway

The app calls the existing Hono service at `EXPO_PUBLIC_AI_GATEWAY_URL`, falling back to the already-required `EXPO_PUBLIC_MIZAN_API_URL` when the dedicated override is absent. The AI routes run in that same backend instance; they do not require a separate gateway service or per-user server. The AI route is separate from Hono's existing BetterAuth routes and requires a Neon Auth Data API JWT. The service verifies its signature against Neon Auth's configured JWKS, validates issuer and expiry (and audience when configured), and derives the data owner solely from `sub`. AI settings, encrypted credentials, and monthly request counts are keyed by that verified subject. The request API accepts only fixed settings, credential, deletion, and OpenAI connection-test operations; it cannot proxy arbitrary URLs.

Set `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL` to the exact values Neon returns for the same branch used by the app. Configure `NEON_AUTH_AUDIENCE` only if that token contract specifies an audience. Apply `20261030000200_ai_gateway` and `20261030000300_ai_credential_vault` to the backend database before enabling the route. Set `AI_CREDENTIAL_ENCRYPTION_KEY` to 32 random bytes encoded as 64 hexadecimal characters in the backend secret manager; never put it in Expo config, the database, source control, or build variables. The AI route returns 503 when Neon trust or encryption configuration is absent. The existing BetterAuth authentication and finance route middleware are unchanged.

## BYOK credential lifecycle

The API key is stored once per Neon-authenticated account in the existing backend database as an AES-256-GCM authenticated ciphertext envelope. The random nonce and authentication tag are stored with the ciphertext; the 32-byte encryption key stays only in backend runtime secrets. The authenticated owner ID is associated data, so ciphertext cannot be moved between accounts. The app can only see a `hasCredential` boolean; API responses never return the key or ciphertext. No raw key is saved in SecureStore, SQLite, Expo config, or logs. Builds from earlier versions delete any legacy device-side key when the AI settings load. Rotating the single configured encryption key currently requires users to re-enter their provider key; a key-ring re-encryption migration is not implemented.

The user must accept the credential storage/forwarding disclosure before the backend accepts the key. The app submits it once over HTTPS to the authenticated Hono API, which encrypts before writing it. When the user tests the connection, the backend decrypts it in memory and forwards it to the fixed OpenAI Responses endpoint. The key is not stored in process state beyond the request path and is never placed in a URL or returned in a response. Removing the key or revoking forwarding consent deletes the encrypted value. OpenAI receives only the synthetic test prompt during this phase; `store: false` is set. Because the existing backend can decrypt the key, it remains a trusted security boundary; database encryption alone does not protect against compromise of that backend or its runtime secret.

## Connection test and controls

The connection test sends a fixed synthetic prompt, the selected allow-listed model, at most 8 output tokens, no tools, no background mode, and a 12-second provider timeout. The key is never decrypted merely by opening settings or changing permissions. A successful test marks the selected model as connected but leaves AI off. Enabling requires a fresh successful test, accepted data and credential-forwarding consents, a cloud credential, and aggregated-insights permission. Disabling cancels local AI work and immediately stores disabled state locally before syncing remotely. Revoking forwarding consent also deletes the encrypted cloud key. Revoking a data permission likewise updates the active device first.

The gateway limits request bodies to 16 KiB, accepts only fixed routes and schemas, caps output, applies an atomic per-user UTC-month request counter (30, 60, or 120), and maps provider failures to safe messages. This counter currently covers the connection-test endpoint; this phase contains no financial analysis executor to count. OpenAI billing is separate and users should also configure their provider spending limit.

The existing selectors remain local and read-only. Every selector checks the active profile, enabled state, validation freshness, data consent, credential-forwarding consent, and requested scope. No AI request executor has been added in this phase.

## Current verification status

Automated route, JWT, request-shaping, encryption, isolation and failure tests run locally. A real provider test and native end-to-end validation require a reachable Hono API (the existing API deployment, not a second gateway service), the matching branch's Neon Auth base/JWKS values, both migrations, a configured backend encryption secret, an Expo build pointed at that API, a disposable Neon-authenticated user, and a fresh authorized OpenAI API key. The API key previously pasted in chat is considered exposed and must be revoked; it was not used. Do not apply migrations to production without the repository's required release approval.
