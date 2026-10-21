# Android Phase 2C Verification

The `development` and `preview` EAS profiles set `HOUSELOG_ANDROID_VARIANT=disposable`. The dynamic app config changes the Android package to `com.houselog.verification`, which gives Android a separate application data sandbox and a separate `finance.db` from the normal package `com.anonymous.HouseLog`. The default app config retains the normal package ID.

Both profiles produce internal APKs. `development` includes the Expo development client; `preview` is a standalone internal APK. Neither build has been started. Build only after an explicit request because EAS cloud builds may use account build resources.

```sh
eas build --profile development --platform android
eas build --profile preview --platform android
```

## Device checklist

Use the verification package and synthetic profile only. Confirm the app configuration shows `com.houselog.verification` before installation. Never install the verification binary over the production package.

- Fresh install creates an empty local profile; upgrade a disposable v4 database to v5 and verify existing rows survive.
- Borrow PKR 100,000: cash rises and liability rises equally; net worth does not rise from borrowing.
- Lend PKR 20,000: cash falls and receivable rises equally.
- Record principal payments, interest payments, early repayment and final settlement; compare cash, remaining principal, liability/receivable and interest expense.
- Create fixed and declining plans with explicit rate terms. Check leap-year and month-end due dates; verify the plans do not write transactions.
- Pay a bill partially, correct it with a replacement amount and a different same-currency account, then verify the original, reversal and replacement remain visible and the paid total is recalculated.
- Correct a debt opening event and a repayment; retry each correction and confirm the duplicate is rejected.
- Force a replacement failure and confirm the reversal, obligation correction, replacement and balance changes all roll back.
- Try simultaneous repayments whose combined principal exceeds the amount owed; only a valid serialized set may commit.
- Skip/cancel a reminded unpaid bill and confirm the scheduled notification is removed. Confirm paid bills cannot be cancelled without a separate correction.
- Restart the app and verify histories, schedule projections, statuses and totals persist. Check profile and currency boundaries.
- Separately verify native SQLite transaction serialization, notification permission/delivery/cancellation, native PBKDF2 password upgrade, SQLCipher proof/recovery, and fresh install/migration behavior.

Node tests exercise disposable `node:sqlite` databases only; they do not certify Expo's native SQLite implementation or Android notifications, authentication, encryption, or recovery.
