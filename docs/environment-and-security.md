# Environment and security

This guide separates **public client configuration** from **server credentials**. Variable names may be documented here, but secret values must never be committed, copied into screenshots, or embedded in the Expo app.

## Expo app variables

The root `.env.example` contains reserved placeholder values. Copy it to a local `.env` and configure your own values for local development. Root `.env*` files are ignored except the example templates.

| Variable | Purpose | Secret? |
| --- | --- | --- |
| `EXPO_PUBLIC_NEON_AUTH_URL` | Neon Auth endpoint used by the app. | No. It is client-visible configuration. |
| `EXPO_PUBLIC_NEON_DATA_API_URL` | Neon Data API endpoint used by authenticated cloud/project requests. | No. Authorization must be enforced by the database and authenticated functions. |
| `EXPO_PUBLIC_MIZAN_API_URL` | HTTPS origin for the existing Hono API (cloud finance sync and AI gateway). | No. It is a service origin, not an API credential. |
| `EXPO_PUBLIC_AI_GATEWAY_URL` | Optional AI-specific Hono origin; otherwise the app reuses `EXPO_PUBLIC_MIZAN_API_URL`. | No. It is a service origin. |

**Every `EXPO_PUBLIC_*` value is compiled into client JavaScript and can be recovered from a built app. Never put passwords, database URLs with credentials, bearer tokens, Neon API keys, encryption keys, or provider API keys in an `EXPO_PUBLIC_*` variable.** Public endpoints are protected by authentication, authorization, rate limits, and server/database rules; hiding their URLs is not a security boundary.

## EAS build configuration

`eas.json` names the EAS environments for the development, preview, and production profiles. It deliberately contains no Neon endpoints. Configure the app’s public endpoint values in the matching EAS environment (`development`, `preview`, or `production`) using the Expo project’s environment-variable settings. Use separate development/preview services when possible; do not point contributor builds at a production database.

The disposable development/preview Android identity is selected by `HOUSELOG_ANDROID_VARIANT=disposable`. This is a build selector, not a credential. Production APK and app-bundle profiles use the Leverage application identity.

`app.config.ts` validates required Neon endpoints for production builds. Set `EXPO_PUBLIC_MIZAN_API_URL` to a real HTTPS API origin for cloud and gateway calls. A build’s public URLs are still visible after compilation; EAS environment storage prevents source commits from defaulting forks to your live services, but it cannot make client URLs secret.

## Backend variables

`backend/.env.example` documents server configuration with placeholders. Create a local `backend/.env` for disposable development only; it is ignored by Git. In deployments, set these values in the backend host’s secret/configuration manager.

| Variable | Required use |
| --- | --- |
| `DATABASE_URL` | Pooled PostgreSQL runtime connection with TLS in production. Server only. |
| `DATABASE_URL_UNPOOLED` | Direct PostgreSQL URL for reviewed Prisma migration jobs only. Never expose to the app. |
| `BETTER_AUTH_SECRET` | Random server-only authentication secret (at least 32 characters). |
| `BETTER_AUTH_URL` | Canonical HTTPS origin of the deployed Hono API. |
| `ALLOWED_ORIGINS` | Comma-separated trusted app origins for backend CORS. CORS is not a substitute for auth. |
| `PORT` | Optional listener port; defaults to `3001`. |
| `NEON_AUTH_BASE_URL` | Neon Auth issuer/base URL used to verify app JWTs for AI gateway requests. |
| `NEON_AUTH_JWKS_URL` | Provider-issued JWKS URL used to verify JWT signatures. |
| `NEON_AUTH_AUDIENCE` | Optional audience when the provider-issued token contract has an `aud` claim. |
| `AI_CREDENTIAL_ENCRYPTION_KEY` | Server-only 32-byte AES-GCM key encoded as 64 hex characters. Needed only to enable the AI gateway. |

The AI provider key is supplied by the user through the app’s settings flow, then stored encrypted in the backend database. It is decrypted only by the gateway when an authorized request is forwarded. The database encryption key and provider credential must not be committed or passed as build args.

## Local data and privacy

- The mobile app’s financial store uses SQLCipher through `expo-sqlite`; its random key is kept in device SecureStore. Keep database files, WAL/SHM files, encrypted backups, and recovery keys out of Git and bug reports.
- Local profile authentication and cloud account authentication are distinct. Cloud linking does not mean all device data is uploaded.
- Database migrations use authenticated ownership checks, row-level security, and constrained RPC grants. Do not disable RLS or grant anonymous table access to make a screen work.
- Shared project RPCs authorize active membership and roles in database functions. Test owner/member/non-member boundaries with disposable accounts before production migration.
- Financial screenshots can expose account names, transaction descriptions, email addresses, and balances. Only publish synthetic/redacted screenshots; the unredacted local captures are ignored by `.gitignore`.

## Repository audit and release checklist

Before making the repository public:

1. Keep the actual `.env`, `backend/.env`, `.env.*` overrides, signing credentials, database files, dumps, and backups untracked. `git ls-files` should show only `.env.example` templates.
2. Search both the working tree and all Git history for credentials, not just `.env` filenames. If a real secret was ever committed, revoke/rotate it immediately and remove it from history before publication; deleting the latest file is not enough.
3. Confirm live Neon migrations, anonymous grants, RLS policies, and function permissions match the reviewed source. Try anonymous access and cross-user reads/writes on a disposable branch.
4. Confirm EAS development/preview projects cannot write to production services; review the EAS environment values for each profile.
5. Keep backend credentials in its deployment secret manager. Keep app endpoint origins public and protect the endpoints with auth and authorization.
6. Confirm no personal transaction or profile data remains in screenshots, test fixtures, example backups, or release notes.
7. Review the MIT license and third-party asset/font terms before the public visibility change.

### Current Git-history note

The current working files and EAS profiles use placeholders/external environment configuration. Earlier pushed commits included the actual Neon Auth and Data API **endpoint URLs** in build/example files. Those URLs are not database passwords or privileged Neon API keys, but they are still present in repository history. A normal cleanup commit does not remove historical blobs. If the goal is to remove those old endpoint strings from every publicly visible commit, rewrite repository history and coordinate a force-push before changing visibility. No real `.env` file is tracked in the current tree, and the repository history check found no long OpenAI project-key-shaped value; rotate any credential shared outside Git independently.
