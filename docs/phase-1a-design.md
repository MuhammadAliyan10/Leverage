# Phase 1A: Local Foundation, Security, and Sync Design

Date: 2026-10-18

## Baseline and migration contract

The app is local-first today. Expo SQLite is the app's financial store; the Prisma/PostgreSQL schema is not used by the Expo runtime, and there is no authenticated sync API. The app has two pre-versioned local database shapes to support: the released Prisma-shaped `Account` and `Transaction` tables, and an intermediate local shape with ownership and some minor-unit/provenance columns. Both have `PRAGMA user_version = 0`. New databases and upgraded databases use version 1, created in `src/db/local/migrations.ts`.

Version 1 runs table creation, additive column changes, data backfills, validation, indexes, integrity checking, and `user_version` assignment in one SQLite transaction. Existing account and transaction row counts are checked before and after. Legacy REAL monetary values are converted to integer minor units; unsafe amounts abort and roll back the schema and data changes. Existing labels are retained while recognized classifications are mapped to canonical IDs. Existing sync flags are reset because this client cannot verify an acknowledgement from a server. Future database versions are rejected before mutation. The tests exercise released-schema and intermediate-schema fixtures, fresh creation, re-entry, invalid-value rollback, and future-version rejection.

No user device database was opened or upgraded during this work; the tests use in-memory SQLite fixtures. The migration path is verified for those represented schemas, not every possible hand-edited or partially corrupted local file. Never use `reset-project` or delete `finance.db` as a migration strategy. A production migration should first make a verified backup and should keep the original file until the upgraded database passes integrity and record-level checks.

## Money and domain rules

New account and transaction writes validate in `src/finance/domain.ts` and again at the persistence boundary. Amounts are positive safe integer minor units. The current supported currencies explicitly use two decimal places. A transfer requires two distinct accounts owned by the same local profile and currently requires matching currencies. An income or expense must use a supported classification of the matching transaction type. Gifts and remittances require a named source. A remittance records original amount/currency, provider rate, reference, and an exactly matching PKR conversion. Tax status is separate user-entered metadata; the app does not infer tax treatment or calculate tax from a category. Pakistan tax year is derived using the Asia/Karachi calendar.

Stable transaction IDs act as idempotency keys. Repeating the same ID with identical normalized details returns the existing record; reusing it with different details is rejected. Transaction writes execute account ownership checks, duplicate checks, and insertion in the same write transaction. The UI generates an ID before submission and waits for durable local persistence before reporting completion or navigating away.

This version still stores one row per transaction and derives cash-account views from those rows. It is not the balanced double-entry ledger required for future debt, asset, investment, and formal statement features. The existing ledger primitives are not connected to transaction persistence. Do not use the current model to claim a complete balance sheet, tax calculation, or business accounting result.

## SQLCipher and local data protection design

Expo SDK 57's `expo-sqlite` supports SQLCipher for native iOS, Android, and macOS builds when the config plugin sets `useSQLCipher: true`; Expo Go does not include that native implementation. It requires a prebuild/custom development build and native-device verification. The SQLCipher key must be applied with `PRAGMA key` immediately after opening the database and before other database operations. Configuration alone does not encrypt an existing plaintext database. See the [Expo SDK 57 SQLite documentation](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/) and [SQLCipher API documentation](https://www.zetetic.net/sqlcipher/sqlcipher-api/).

Recommended rollout:

1. Ship the SQLCipher native build with a migration-capable implementation that can open both the old plaintext database and a new encrypted temporary database. Do not replace or delete the old file.
2. Generate a cryptographically random per-install database key. Never embed it in source, app config, JavaScript bundle, or logs. Store a wrapped key in platform-protected storage and make key acquisition an explicit prerequisite to opening the encrypted database.
3. With SQLCipher enabled in a disposable native build, first verify whether Expo SQLite's generic SQL execution methods expose SQLCipher's `sqlcipher_export()` function. Zetetic documents the SQL sequence as attaching a new encrypted DB and calling `SELECT sqlcipher_export('encrypted')`; Expo SQLite exposes generic SQL execution, but SDK docs do not demonstrate this migration path. If the call works through the shipped Expo binding, keep the conversion in one audited transaction and test it. If the function is unavailable, use a small audited native bridge. Do not copy the plaintext file and call it encrypted.
4. Export into a new temporary encrypted file, then verify SQLCipher can reopen it, run `PRAGMA integrity_check`, compare record counts and IDs, and reconcile all account and transaction values. Flush and atomically promote the verified file using native filesystem operations.
5. Keep the original plaintext database in a protected rollback location until the new app has reopened the encrypted file and the owner has completed recovery verification. Then offer encrypted export/backup and securely retire the plaintext copy according to the recovery policy.

### Isolated SQLCipher proof-of-concept runbook

Run this in a disposable SDK 57 app or isolated worktree, never against `finance.db`:

1. Configure only the POC app with the `expo-sqlite` plugin and `useSQLCipher: true`, then run `npx expo prebuild` and build a custom native development client. Do not add this plugin to the production app until conversion and recovery work.
2. Generate a random key at runtime using a cryptographic random-byte API, store only the POC key in SecureStore, and pass it to SQLCipher immediately after opening the disposable DB. Do not print or commit the key.
3. Check that SQLCipher is present, create a synthetic account/transaction fixture, close the handle, restart the app, reopen with the same key, and compare the fixture rows and integer balances. Reopen with a different random key and verify the first read fails; show only a generic error.
4. From a disposable plaintext fixture, open the plaintext database without a key, attach a separate temporary encrypted target using a fresh random key, call `sqlcipher_export()` through Expo SQLite SQL execution, detach, and close both handles. Reopen the target with SQLCipher and compare `user_version`, row counts, IDs, integer balances, and `PRAGMA integrity_check` with the source.
5. Inject failures before export, during export, during validation, and before activation. Confirm the source remains untouched, the target is not activated, temporary files are handled in app-private storage, and the app reports recovery rather than an empty database. Android development-build and real process-restart checks are required for this phase; iOS verification is a separate release gate.

The SQLCipher build and all steps above remain unexecuted because dependencies could not be installed and Xcode is unavailable. The runbook is a prepared test plan, not encryption or recovery evidence.

SecureStore is suitable for small key material, not financial records. A random database key should be stored in platform keychain/keystore protected storage without tying the only copy directly to a biometric-bound item: biometric enrollment changes can invalidate authentication-protected SecureStore values, Android uninstall removes SecureStore data, and iOS keychain persistence across uninstall is not guaranteed. Therefore, a recoverable encrypted backup must use a separate recovery secret or an authenticated recovery service; losing the device-protected key must not silently destroy access to the only copy. See [Expo SDK 57 SecureStore documentation](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/).

App lock and database encryption are separate controls. The current UI lock fails closed when `getEnrolledLevelAsync()` returns `NONE` and calls native authentication with `disableDeviceFallback: false`. SDK 57 describes device-passcode fallback after failed attempts and an iOS-specific fallback label; actual behavior depends on platform and device and is not physically verified. A device with no compatible enrolled authentication currently has no in-app recovery path and remains locked. The UI lock is only an app-level gate: it does not encrypt the database or clear sensitive rows already in memory. Before production, define an app PIN fallback with a memory-hard password KDF (or a carefully parameterized platform-supported PBKDF2 implementation), rate limiting/backoff, and a wrapped database key. Do not use plain SHA-256, a PIN as the SQLCipher key, or an unthrottled PIN hash. On lock, clear sensitive query caches and in-memory keys. On logout/account switch, close the database and make profile switching explicit. Test biometric changes, passcode fallback, device loss, reinstall, key loss, restore, and interrupted conversion on real iOS and Android builds.

## Authentication and ownership boundary

The current profile and password are local-only. The password is still stored as an unsalted SHA-256 digest; this is not acceptable production password storage and is not fixed by the UI's 10-character minimum. There is no server identity, remote authorization, session revocation, or account recovery. Local owner IDs are application-level filtering, not a security boundary. Do not connect the mobile app directly to Neon or bundle database credentials.

For cloud identity, use a trusted API that verifies an established identity provider/passkey flow, issues revocable scoped sessions, authorizes every resource by user ID, and validates every financial operation independently. If the product retains passwords, hash them server-side with Argon2id and a unique salt, with rate-limited login/recovery. Offline local unlock is a device authorization decision, separate from cloud identity. A user must explicitly select and unlock a provisioned local profile; a failed migration or missing key must surface as an error and must never be presented as an empty account.

Credentials shared in chat should be rotated manually before using that database with real financial records. The credential value is intentionally not repeated here. Keep only server-side secrets in ignored environment files, verify they are absent from Git history and deployment bundles, and never place them in an Expo public environment variable.

## Offline synchronization design (not implemented)

The local SQLite database remains authoritative for immediate offline use. Add an `OutboxOperation` table in a later migration, and insert each domain mutation plus its outbox operation in the same SQLite transaction. Each operation should include a UUID operation ID, local owner ID, entity ID, operation type, schema/payload version, canonical payload hash, base revision, local sequence, state, attempt count, next retry time, and created/updated timestamps. Use a unique operation ID and stable entity IDs across retries and devices.

Suggested states: `pending` → `in_flight` → `acknowledged`; transient network/server failures return to `pending` with exponential backoff plus jitter; validation failures become `needs_attention`; revision mismatches become `conflict`. `in_flight` work must return to retryable state after restart. The client marks an operation acknowledged only after validating a server response containing the same operation ID, owner scope, committed revision, and durable result. A request being sent is not an acknowledgement. Expose local save and cloud backup as separate user-facing states.

The API must enforce authentication, owner scoping, payload version, account ownership, money/currency rules, and idempotency independently of the client. Store server idempotency keys uniquely per owner and operation, and return the original committed result for duplicate requests. Pull changes incrementally from a per-user server cursor; do not accept a cursor supplied for a different owner. Initial hydration should stage and validate a snapshot before making it visible locally.

Never use last-write-wins for posted financial transactions, balances, or corrections. Treat posted financial events as immutable; corrections are explicit reversals or versioned adjustments with an audit link. On concurrent edits to descriptive metadata, merge only fields with a documented merge rule; conflicting classification, account, amount, currency, date, deletion, or correction requires user resolution. Categories, budgets, and profile settings can use separate entity-specific revision policies. Acknowledged local operations may be compacted only after the server cursor confirms their result is included in a recoverable snapshot. Sync must not be shown as complete before durable server acknowledgement.

The current implementation has no outbox, sync transport, server API, cursor, conflict flow, encrypted backup, or background sync. Legacy `synced` values are reset to pending/unverified (`0`) during version 1 migration. Do not add a UI state that claims cloud backup until the protocol exists and has tests for retries, duplicate requests, interruption, owner isolation, and conflict resolution.

## Platform and release verification still required

- Install dependencies and run the real SDK 57 Expo typecheck/lint and native builds. Current workspace dependencies are absent, so the project-wide checks could not use actual installed Expo/React Native type declarations.
- Build custom iOS and Android development clients with SQLCipher, then verify encryption, migration, key lifecycle, passcode fallback, lock behavior, recovery, and interruption on physical devices.
- Replace local SHA-256 authentication before production.
- Implement encrypted backup/restore and user-visible migration recovery before enabling SQLCipher for existing user files.
- Add production server identity, authorization, outbox API, and sync tests before any cloud-backed state is shown.
- Verify Pakistan tax rules against the applicable official FBR sources before adding tax conclusions or calculations. Current tax labels are recordkeeping only.

## Encrypted backup and restore design (not implemented)

Use a binary container with a fixed magic prefix and a bounded, versioned header followed by an authenticated encrypted payload. Header fields should include format version, database schema version, cipher and KDF identifiers, salt, nonce, and KDF work parameters. The payload should be a SQLite backup/export with no plaintext financial metadata in the header. Use an AEAD cipher such as AES-256-GCM or XChaCha20-Poly1305 with header bytes authenticated as associated data. Enforce size and KDF-parameter limits before allocating memory; reject unknown versions and algorithms.

The backup key should be derived from a high-entropy user-held recovery secret with Argon2id through an audited native implementation, or wrapped under a random key protected by an authenticated server/KMS recovery flow. Expo Crypto's digest API is not a password KDF or authenticated-encryption API. Do not use an ordinary login password, the device-only SQLCipher key, or a hardcoded application secret as the backup key. A recovery secret should be shown once, verified by a confirmation step, and accompanied by a clear warning that HouseLog cannot recover a lost secret without a configured recovery service.

Export must first create a consistent SQLite snapshot, validate it, encrypt it into a temporary file, flush and verify the produced envelope, then share only the encrypted file using platform file-sharing APIs. Do not export raw SQLite to a shared folder. Avoid plaintext temporary files; if native APIs require one for conversion, store it in app-private storage, tightly limit its lifetime, and delete it in a `finally` path. Treat deletion as best-effort, not guaranteed secure erasure on flash storage.

Restore must parse a bounded header, reject unsupported parameters, authenticate/decrypt fully into an app-private staging file, and then validate SQLite integrity, schema version, record counts, owner/profile structure, foreign-key checks where present, and financial invariants. Reject truncated, tampered, wrong-key, or incompatible backups without changing the active database. Migrate the staged database to the current version, run the same validation again, then require explicit user confirmation before atomically activating it. Do not silently merge a backup with existing data: create a new profile or require a separately designed, reviewed merge policy. Keep the current database and a rollback copy until the restored database has reopened successfully. Test partial writes, bad tags, wrong secrets, interrupted restores, duplicate IDs, old backup versions, and disk exhaustion before calling recovery reliable.

Device-only key storage is convenient and protects a lost file on that device, but cannot guarantee recovery after uninstall, device loss, or SecureStore key invalidation. A user-held recovery secret enables cross-device recovery without trusting HouseLog with a decryption key, at the cost of permanent data loss if the user loses it. A cloud-managed wrapping key can support account recovery, but requires a trusted identity service, strict authorization, key rotation, audit, and a documented provider trust model. The current local-only identity model cannot provide remote account recovery.

## Phase 1A.1 verification record

- `npm ci --no-audit --no-fund` was attempted with Node 24.12.0 and npm 11.13.0. The sandbox could not resolve `registry.npmjs.org` (`ENOTFOUND`); npm then exited with `Exit handler never called!` and could not write its default log. A retry with a cache under `/private/tmp` failed with the same registry DNS errors. An elevated retry stalled and was stopped. The lockfile was not changed; the incomplete generated `node_modules` tree was removed after the attempts.
- The partial tree contained Expo 57.0.9, React Native 0.86.2, and TypeScript 6.0.3, but was missing dependencies including `expo-sqlite` and `expo-image`, and did not contain the npm executable-link directory. `expo install --check` therefore reported that `expo-image` was declared but not installed and that offline version validation was unreliable.
- Direct `tsc --noEmit -p tsconfig.json` using the partially extracted TypeScript found a real integration issue: the extracted account-balance result type omitted `name` and `type`. That was fixed by preserving those account fields in `src/finance/balances.ts`. Remaining diagnostics were caused by incomplete installed packages, including missing Expo modules and CSS declarations. A strict targeted check of the pure financial, balance, migration, and queue modules passes.
- The official Expo ESLint guide says `npx expo lint` sets up ESLint dependencies and creates `eslint.config.js`; this repository has neither ESLint dependencies nor a config, and the install required for that setup cannot reach the registry. The committed `lint` script is therefore not verified in this environment. `typecheck` now has a direct package script.
- The test suite runs under Node's built-in SQLite implementation. Tests verify the migration fixtures and transaction/queue behavior; no existing user database was read, copied, or modified. Foreign-key constraints are not currently defined in the local schema, so `PRAGMA foreign_key_check` has no application relationships to validate yet.
- No Expo Go, simulator, native build, or physical device was used. SQLCipher was not enabled in the production app config and no SQLCipher database was created. Expo SDK 57 documents that SQLCipher requires `useSQLCipher: true`, `npx expo prebuild`, and is unsupported in Expo Go; native encryption, wrong-key rejection, persistence, key lifecycle, plaintext conversion, and rollback are therefore **not verified**. See the [SDK 57 SQLCipher instructions](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/#sqlcipher).
- The Expo CLI diagnostics command reached local version metadata but reported “Networking has been disabled” and “Dependency validation is unreliable in offline-mode.” No `expo-doctor` package is installed, and no native build could be completed.
- Authentication remains a local unsalted SHA-256 password check; this is a production blocker. SecureStore stores a local profile ID, not a revocable identity-provider session. Query cache is now cleared on sign-in, signup, and logout to prevent a previous profile's cached financial records from surviving a profile transition. App lock prompts native device authentication and keeps a cold-start lock; attempts are not rate-limited by HouseLog, and lifecycle/device behavior remains unverified.
- UI regression verification was limited to source review. Sign-in/signup now surface storage/session errors; financial screens and device lock were not launched because required dependencies are missing. Expo SQLite web support itself is alpha and requires Metro WASM support plus cross-origin isolation headers, which the current Metro config and hosting config do not provide.

### Migration fixture comparison

| Fixture | Before | After migration | Result |
| --- | --- | --- | --- |
| Released schema | 1 account, 2 transactions; opening balance 1,250.75; transaction amounts total 25,000 | 1 account, 2 transactions; opening balance 125,075 minor units; transaction amounts total 2,500,000 minor units | Counts and monetary values preserved exactly at two decimal places |
| Released family gift | Display category `Family gift / support` | Same display label; canonical classification `family_gift` | Display label preserved; classification becomes machine-readable |
| Released banking fee | Display category `Banking expense` | Same display label; canonical classification `bank_fee` | Display label preserved; classification becomes machine-readable |
| Intermediate schema | 1 owned account at 100.50; 1 owned transaction at 125.25 | Same owners and record counts; 10,050 and 12,525 minor units | Existing ownership and money preserved |
| Invalid legacy amount | Out-of-range transaction amount | Migration rejects and rolls back DDL, backfills, and version update | No converted database is committed |
| Newer version | `user_version = 99` | Same version and records | Rejected without mutation |

These are deterministic SQLite fixture results, not an audit of an actual user's database. The fixture checks include close/reopen validation and `PRAGMA integrity_check = 'ok'`. The current schema has no declared foreign keys, so foreign-key checks are not applicable yet.

## Phase 1A.2 environment recovery and native verification record

The scope of this verification was limited to Phase 1A.2. No accounting migration, cloud API, sync implementation, or product feature was started. The shared working tree contained uncommitted Phase 1A/1A.1 work at the start; it was preserved. `package-lock.json` was preserved. No production database connection was made and no real financial database file was read, changed, or removed. The previously shared database credentials were not read from the environment, printed, or reused.

### Environment and dependency access

| Check | Result | Classification |
| --- | --- | --- |
| Node/npm | Node `v24.12.0`, npm `11.13.0` | VERIFIED |
| npm registry setting | `https://registry.npmjs.org/` | VERIFIED |
| Proxy configuration | `npm config get proxy` returned `null`; only `NO_PROXY` is present among proxy variables | VERIFIED |
| DNS | Node DNS lookup for `registry.npmjs.org` returned `ENOTFOUND` | BLOCKED BY ENVIRONMENT |
| HTTPS | `curl` to the official registry failed to resolve its host (`curl: (6) Could not resolve host`, HTTP status `000`) | BLOCKED BY ENVIRONMENT |
| Reproducible dependency install | `npm ci --no-audit --no-fund` was attempted; it failed with the same registry DNS error. A retry using a temporary npm cache also failed. A prior elevated retry stalled and was stopped. No further retries were made. | BLOCKED BY ENVIRONMENT |
| Lockfile | No lockfile changes | VERIFIED |
| Expo config resolution | SDK config resolves as SDK `57.0.0`, with iOS, Android, and web platform declarations | VERIFIED |
| Android tooling | `adb`, `sdkmanager`, and `gradle` are not on PATH | BLOCKED BY ENVIRONMENT |
| iOS tooling | `xcodebuild -version` reports the active developer directory is Command Line Tools, not full Xcode | BLOCKED BY ENVIRONMENT |
| CocoaPods | `pod --version` fails because its Git subprocess resolves to incompatible `/usr/local/bin/git` (`Bad CPU type in executable`) | BLOCKED BY ENVIRONMENT |
| EAS CLI | `eas-cli/18.12.2` is installed. No EAS build was configured or triggered; there is no verified project/account or signing/device setup, and no credentials or paid build were created. | IMPLEMENTED BUT UNVERIFIED |

The available evidence identifies DNS/network resolution as the immediate npm blocker. The configured registry is the official registry and npm has no proxy configured. This environment cannot distinguish a machine-wide DNS problem from a sandbox/network policy that blocks DNS; it does not establish a package-registry outage. Do not change registries to work around this.

### Quality gates

| Command/check | Result | Classification |
| --- | --- | --- |
| `npm test` | 20 tests passed, 0 failed, under Node `v24.12.0` using Node's built-in SQLite | VERIFIED (Node SQLite only) |
| Strict targeted TypeScript check | Pure finance, balance, migration, and queue modules pass with strict settings | VERIFIED (targeted files only) |
| `npm run typecheck` | Cannot complete: dependencies are absent, so `expo/tsconfig.base` and Expo/React Native declarations cannot be resolved | BLOCKED BY ENVIRONMENT |
| `npx expo install --check` | Previously attempted against an incomplete install; it reported missing `expo-image` and unreliable offline version validation | BLOCKED BY ENVIRONMENT |
| `npx expo-doctor` | Cannot run reproducibly without installed dependencies/Expo tooling; registry resolution remains unavailable | BLOCKED BY ENVIRONMENT |
| `npm run lint` | Failed: because local dependencies are absent, the script fell through to the globally installed legacy Expo CLI, which does not recognize `expo lint`; it also could not write its user state file (`EPERM`). There is no `eslint.config.js` or ESLint dependency set. The SDK 57 `npx expo lint` setup was not run because package installation cannot resolve the registry. | FAILED (environment/tool resolution); SDK 57 lint setup BLOCKED BY ENVIRONMENT |
| `package-lock.json` integrity | Preserved; no dependency changes were made to mask connectivity failure | VERIFIED |

The `npm test` result is meaningful for the pure domain rules and test fixtures but does not prove that Expo SQLite or native SQLite behaves identically. The test output includes Node's experimental SQLite warning and Node's typeless-module performance warning; neither was suppressed.

### Native SQLite, SQLCipher, app lock, and recovery

The root app config remains unchanged for SQLite encryption: SQLCipher is not enabled in the production app. This avoids opening an existing plaintext database with an untested encryption setting. SDK 57 documentation confirms the `expo-sqlite` config plugin option `useSQLCipher: true`, and says native rebuilds are required; its documented SQLCipher instructions do not constitute runtime proof. The test runbook above remains the executable procedure once a disposable native build is available.

| Proof item | Result | Classification |
| --- | --- | --- |
| Android/iOS Expo SQLite integration tests | No native test harness or native test execution in this phase; Android SDK/ADB and full Xcode are unavailable, and dependencies are not installed | NOT IMPLEMENTED / BLOCKED BY ENVIRONMENT |
| SQLCipher native compile and encrypted database | Not built or created | BLOCKED BY ENVIRONMENT |
| Wrong-key rejection, restart persistence, secure-key retrieval, missing-key behavior | Not exercised on a native SQLCipher binding | NOT IMPLEMENTED |
| `sqlcipher_export()` support in Expo SQLite's actual binding | Not probed; upstream SQLCipher documentation alone is insufficient evidence | NOT IMPLEMENTED |
| Plaintext conversion, interrupted migration, WAL/journal handling | Design/runbook only; no disposable native conversion executed | IMPLEMENTED BUT UNVERIFIED |
| Native biometric/passcode lifecycle and profile-switch isolation | Source changes were not run on a device; actual platform fallback and lock transitions remain unverified | BLOCKED BY ENVIRONMENT |
| Encrypted backup/restore, user recovery key, clean-device restore | Design only; no backup or restore implementation/test | NOT IMPLEMENTED |

At Phase 1A.2, the SQLCipher runbook was a test plan without an executable proof-of-concept application. There was no encryption evidence. Do not migrate actual user records or enable SQLCipher until an isolated POC passes on Android and a verified recovery route exists; iOS verification is required before an iOS release.

## Phase 1A.3 implementation and verification record

Date: 2026-10-20. This phase added an independent `poc/sqlcipher` Expo SDK 57 app with a disposable Android package ID, synthetic SQLite rows, and SQLCipher enabled only in its own app config. Its probe checks native cipher presence, file header, correct/wrong/missing key behavior, foreign keys, rollback, separate connections, integer amounts, and a disposable plaintext export through the actual `sqlcipher_export()` binding. The destination is validated without activation and the source is preserved. **The probe has not been installed, compiled, or run on Android**; its source is an executable harness awaiting network access and Android SDK/ADB. Its simulated interruption currently occurs before export, not during an in-progress export or file promotion. It does not prove production migration safety.

The new `src/security/keyMaterial.ts` is a platform-independent profile key manager. It requires 32 random bytes, stores each profile key under a separate name through an injected secure-store port, serializes concurrent calls within one manager instance, validates loaded key material, and refuses to replace a missing key when the corresponding database exists. The production database client has not been wired to this manager because the existing `finance.db` is plaintext and there is no validated conversion or recovery route. The POC uses Expo Crypto random bytes and SecureStore separately, also without touching `finance.db`.

The new `src/security/backupEnvelope.ts` defines a bounded version-1 encrypted backup envelope. It uses a 256-bit user-held recovery key, authenticates the public format header as AES-GCM additional data, keeps profile ID and schema version inside the ciphertext, validates format/size/profile/version before returning bytes, and rejects wrong keys and corruption. `src/security/expoBackupCipher.ts` is an Expo SDK 57 AES-GCM adapter. The root app does not yet export or restore backup files and the adapter has not run in a native build. A 64-character random hex recovery key is supported; a human password is not accepted as a recovery key because no audited password KDF is available in the installed runtime. The key must be shown and confirmed through a future recovery UI before real data is encrypted.

### Exact checks and evidence

| Check | Outcome | Classification |
| --- | --- | --- |
| `npm ping --fetch-retries=0 --fetch-timeout=5000` | `ENOTFOUND registry.npmjs.org`; local `scutil --dns` reports no DNS configuration available | BLOCKED |
| Registry HTTPS and Node DNS lookup | `curl: (6) Could not resolve host`; Node lookup `ENOTFOUND` | BLOCKED |
| Offline npm cache | Expo SQLite has registry metadata but no cached tarball; Expo Crypto and FileSystem have some cached tarballs. Cache is insufficient to establish a complete reproducible `npm ci`. | BLOCKED |
| `npm test` | 24 passed, 0 failed. The four new tests cover recovery envelope authentication, profile/key isolation, corrupt and wrong-key rejection, and a synthetic Node SQLite restore into a clean directory. | VERIFIED for Node only |
| Targeted strict TypeScript check | `src/security/keyMaterial.ts` and `src/security/backupEnvelope.ts` pass with `--strict`; the Expo adapter and POC cannot be typechecked against absent installed Expo types. | PARTIALLY VERIFIED |
| `git diff --check` | No whitespace errors | VERIFIED |
| Android native build/device | No `adb`, `sdkmanager`, or `gradle` on PATH; dependencies are absent. No Android build ran. | BLOCKED |
| iOS native build/device | Not required in Phase 1A.3; remains a separate iOS release gate. | NOT IMPLEMENTED |
| Expo install/doctor/lint/project typecheck | Local dependencies are absent, registry DNS is unavailable, and the global Expo CLI is legacy. No pass result is claimed. | BLOCKED |

The existing unsalted SHA-256 local password verifier remains in `src/db/local/client.ts`. Expo Crypto SDK 57 supplies digests and AES-GCM but does not document a password KDF; no vetted native Argon2id/PBKDF2 dependency can be installed or verified while npm is unreachable. New password hashing and migration of existing verifiers are **NOT IMPLEMENTED**. Replacing the verifier without a compatible migration would lock out existing profiles. Local authentication and biometric fallback still require physical Android verification. Query caches are already cleared on profile transitions in the preserved Phase 1A.1 work, but real profile isolation is not device-tested.

The Node restore test decrypts a synthetic SQLite file into a new directory and verifies integrity, foreign keys, schema version, row IDs, and integer total. This is not an atomic device restore implementation. The production app has no backup UI, file export, staging/promote/rollback path, or tested recovery from lost SecureStore material. Do not enable encryption of existing records until these are implemented and verified on Android. The uncommitted Phase 1A/1A.1 files and `package-lock.json` were preserved. No real financial database or production Neon endpoint was accessed.

Next operator step: restore DNS/network access on the development machine, run root `npm ci` and the full quality gates, then install Android SDK/ADB and run the isolated POC from `poc/sqlcipher/README.md`. After native SQLCipher behavior is confirmed, add an audited password KDF dependency with a backward-compatible verifier migration and implement file-level encrypted backup/atomic restore against disposable Android data. The root app must continue to use its current database path until a recoverable migration is proven.

### Operator handoff and next verification sequence

On a network-enabled development Mac with the project checked out and the same `package-lock.json`, run `npm ci --no-audit --no-fund`, `npm run typecheck`, `npm test`, and `npx expo install --check`; then configure the SDK 57 ESLint setup and run `npx expo lint`, followed by `npx expo-doctor`. Resolve the local toolchain separately: install a compatible Android SDK/ADB and Gradle, install full Xcode and its matching command line tools, and make CocoaPods use the arm64-compatible Git binary. Then create a disposable SDK 57 native harness with synthetic data and SQLCipher enabled only in that harness. Use an Android development build first, then iOS, without uploading signing credentials or triggering paid/production builds unless separately authorized. Test binding support for `sqlcipher_export()` rather than assuming it. Only after device restart, wrong-key, migration interruption, data reconciliation, backup, and clean-install restore checks pass should an encrypted database migration be planned for real user data.
