# Disposable Android SQLCipher probe

This is an independent Expo SDK 57 app with package ID `dev.houselog.sqlcipherlab`. Its only database files begin with `houselog-lab-`. It never imports HouseLog's production database client or opens `finance.db`.

On a network-enabled development machine with Android SDK/ADB and an Android device or emulator:

1. Run `npm install` in this directory to create its separate lockfile. Review and retain that lockfile before repeated builds.
2. Run `npx expo prebuild --platform android`, then `npx expo run:android`.
3. Tap **Run disposable SQLCipher probe**. Run it a second time after force-stopping and reopening the app to verify process-restart persistence.
4. Capture only pass/fail labels. Do not capture SecureStore values, database keys, or raw synthetic rows in logs.

The isolated `eas.json` contains an Android development APK profile for a later cloud build if local Android tooling remains unavailable. Running EAS Build requires the operator's Expo account, project setup, signing decision, and network access; this task did not start such a build or upload credentials.

The probe verifies SQLCipher presence, encrypted header, correct and wrong keys, missing-key refusal, integer records, foreign keys, rollback, separate native connections, and a disposable plaintext-to-encrypted export. `sqlcipher_export()` is treated as a runtime capability check. An export failure leaves the plaintext source in place. The test destination is never activated as an application database.

This source has not been compiled or run in the current environment. The production HouseLog app must remain unencrypted until this probe and a separate verified recovery path pass on Android. iOS verification remains a separate release gate.
