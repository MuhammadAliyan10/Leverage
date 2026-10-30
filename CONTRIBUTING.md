# Contributing to Leverage

Thank you for helping improve Leverage. Contributions should preserve financial correctness, user privacy, and the app’s local-first behavior.

## Before you start

- Read the [codebase guide](docs/codebase-guide.md), [financial model](docs/financial-model.md), and [environment/security guide](docs/environment-and-security.md) relevant to your change.
- Check existing issues and pull requests to avoid duplicate work. For a major feature or architectural change, open an issue first to discuss its scope.
- Never use real personal financial data in tests, screenshots, issue reports, or sample databases. Use synthetic profiles and amounts.
- Do not commit `.env` files, access tokens, database URLs with credentials, signing keys, database files, or backups.

## Development setup

1. Install Node.js 22.13 or newer.
2. Install dependencies with `npm ci`.
3. Copy `.env.example` to `.env` only if you need local cloud/API integration, then fill it with your own disposable development endpoints.
4. Run `npx expo start` and use an installed development build. Expo Go is not supported because the app uses native SQLCipher.

Backend development is optional for local-only app work. See [backend/README.md](backend/README.md) before starting services or applying database migrations. Use a disposable development database; never run a migration against the production database as part of a contribution.

## Change guidelines

- Keep financial arithmetic in `src/finance/` and amounts in integer minor units. Do not use floating-point values as persisted money.
- Preserve immutable financial history. Corrections/refunds should append or link corrective records according to the domain rules instead of rewriting posted history.
- Make writes atomic and idempotent where retries are possible. Add/adjust migration and regression coverage when changing data shapes or invariants.
- Keep every account, project, and cloud mutation scoped to its owner/member and enforce authorization in the authoritative store or database function.
- Avoid broadening AI data access or provider forwarding without explicit user consent and updated security tests/docs.
- Keep UI and navigation changes consistent with shared components and keyboard-safe form patterns.
- Update docs when changing routes, data models, environment variables, cloud scope, security behavior, or release steps.

## Verification

Run the relevant checks before opening a pull request:

```sh
npm run typecheck
npm run lint
npm test
npm run verify:source
```

For backend-only changes:

```sh
cd backend
npm run typecheck
npm test
```

`npm run verify:source` includes an Android JavaScript bundle export but does not compile a native binary or test a deployed database. State clearly which checks you ran and what remains unverified. Do not report simulator, EAS, Neon, or native-device checks as passing unless you actually ran them.

## Pull requests

- Explain the user impact and the reason for the change.
- List the relevant tests and platform/runtime checks with their actual results.
- Include screenshots for UI changes only after redacting names, emails, transactions, balances, and other identifying data.
- Call out data migrations, environment changes, permission changes, or release steps.
- Keep the diff focused and avoid generated build outputs.

By submitting a contribution, you agree that it may be distributed under the project’s [MIT License](LICENSE).
