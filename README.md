# Leverage

Leverage is a local-first personal finance app for tracking day-to-day money and understanding a household’s wider financial position. It is built with Expo SDK 57, React Native, TypeScript, SQLite, and an optional Neon-backed cloud service.

> This repository is private. The MIT license is included for the project owner’s future open-source use; review the license and third-party asset licenses before making the repository public.

## What the app includes

- **Dashboard:** liquid funds, cash available to spend, recent activity, upcoming commitments, and spending trends.
- **Transactions:** income, expenses, transfers, search, filters, and transaction history.
- **Accounts:** multiple cash, bank, and wallet balances with account activity.
- **Budgets and savings:** monthly category budgets, savings goals, and emergency-fund tracking.
- **Recurring, bills, and debt:** scheduled items, obligations, and repayment plans.
- **Assets and net worth:** physical assets, investments, liabilities, and account-based position summaries.
- **Projects:** trip and group budgets, member contributions, pooled funds, expense splits, settlements, and project reports. Shared project collaboration requires the configured cloud services.
- **Optional AI:** the existing Hono API can provide consent-gated AI features. Provider credentials are stored encrypted by that server; the app does not bundle provider API keys.
- **Security and recovery:** local profile protection, biometric unlock where supported, encrypted backups, and recovery flows.

Financial amounts are stored as integer minor units. Currency totals remain separate; the app does not silently convert currencies. See [the financial model](docs/financial-model.md) for ledger and reporting rules.

## Data and service model

The app stores local profile and financial records in on-device SQLite. Core local workflows do not require a continuously running developer server. Cloud sign-in, supported account/transaction sync, and AI gateway features require the configured Neon services and the existing Hono API to be reachable. Shared project collaboration uses authenticated Neon Data API functions and the project database migrations. These are optional app integrations, not services started by `expo start`.

The backend is in [`backend/`](backend/README.md). It is part of this repository and is the existing API for authentication and supported cloud operations; AI routes run in the same API process. Do not put database URLs, auth secrets, or AI encryption keys in Expo `EXPO_PUBLIC_*` variables. Public endpoint origins are configuration; secret credentials belong in the server’s secret manager.

Cloud scope and release limitations are documented in [backend/README.md](backend/README.md). A passing local test suite does not prove a production deployment, native release, database migration, or recovery procedure.

## Requirements

- Node.js **22.13 or newer** (Expo SDK 57’s minimum supported Node version).
- npm, using the committed lockfile.
- For native development builds: Android Studio/Android SDK for Android, or Xcode for iOS on macOS.
- Expo account and EAS CLI access for hosted EAS builds.

This app includes custom native functionality and uses `expo-dev-client`; **Expo Go is not the supported runtime**. Use an installed development build or a built app.

## Install and run locally

```sh
npm ci
npx expo start
```

Open the project in an installed development build. To compile and install a native development build locally:

```sh
npm run android
# or, on macOS with Xcode installed
npm run ios
```

Copy `.env.example` to `.env` only when local cloud/API configuration is needed. The example includes public endpoint configuration and placeholders; it contains no database password, auth secret, or AI provider key. Local-only `.env` files are ignored by Git.

## Backend setup

The backend is optional for local-only use. Cloud authentication, cloud features, invitations, and AI require a deployed/configured API and database. For isolated local backend development:

```sh
cd backend
cp .env.example .env
npm ci
npm run prisma:generate
npm run dev
```

Fill `.env` with disposable development services and secrets before starting it. Apply migrations only to a reviewed disposable development database:

```sh
npm run prisma:migrate:deploy
```

Production migrations require a separate review and release operation. See [backend/README.md](backend/README.md) and [AI setup notes](docs/ai-foundation.md) for server configuration, security boundaries, and current cloud limitations.

## Verify source

```sh
npm run typecheck
npm run lint
npm test
npm run verify:source
```

`verify:source` runs the source checks, backend checks, and an Android JavaScript bundle export. It does **not** compile or launch a native Android/iOS app, contact a production Neon database, deploy the backend, or verify an EAS release. Use disposable accounts and data for integration checks.

## Build and release

EAS profiles are defined in [`eas.json`](eas.json):

| Profile | Output | Intended use |
| --- | --- | --- |
| `development` | Android APK, development client | Native development; uses a separate disposable Android app identity. |
| `preview` | Android APK | Internal preview; uses a separate disposable Android app identity. |
| `production-apk` | Android APK | Internal distribution under the normal Leverage app identity. |
| `production` | Android App Bundle | Store distribution under the normal Leverage app identity. |

Before a production build, configure the required HTTPS API and Neon endpoint values in the EAS **production** environment. Server secrets must stay in the server’s secret manager; they must not be embedded in an app build. EAS manages the app version/build number according to `appVersionSource` and profile settings.

Typical manual release commands (no GitHub Actions are configured):

```sh
eas build --profile production-apk --platform android
# or for a store upload package
eas build --profile production --platform android
```

Review the build identity, app version, signing credentials, configuration, and device behavior before sharing an APK or submitting a store bundle. Create a Git tag and GitHub Release only after the build has been reviewed; attach the generated package to the release rather than committing APK/AAB files to the repository.

## Repository hygiene

- Keep `.env` files, signing keys, certificates, local databases, build output, and device-specific editor/MCP settings out of Git.
- Commit `.env.example` files with placeholders only.
- Keep `package-lock.json` and `backend/package-lock.json` in sync with their package manifests.
- Do not commit generated APK, AAB, IPA, or native build directories.
- GitHub Actions are intentionally not used in this repository.

## License

Leverage source code is licensed under the MIT License. See [LICENSE](LICENSE). Third-party packages, fonts, and assets may have separate terms; their notices remain with the corresponding dependency or asset.
