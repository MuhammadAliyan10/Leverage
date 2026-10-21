# Android Phase 2A verification

This checklist is for a disposable development installation and synthetic profile. Do not open, copy, or migrate a user's `finance.db` during the probe. The EAS `development` profile currently requests an internal Android APK with the development client enabled. No cloud build is started by this checklist.

## Build and install

1. Confirm an Android emulator/device is disposable, record its OS/API level, and remove any prior HouseLog app data.
2. Build locally only when the Android SDK is installed, or request authorization before starting a billable EAS cloud build. Do not upload production signing credentials for this verification.
3. Install the development APK and launch it online and offline. Check startup, onboarding, and first local database creation.
4. Close and reopen the app after each persistence section below. Confirm profile and records remain local and correct.

## Schema and isolation

1. On a fresh app database, verify `PRAGMA user_version = 3`, `PRAGMA foreign_keys = 1`, and `PRAGMA integrity_check = 'ok'` using a disposable debug-only inspection path.
2. Upgrade a copy of a synthetic version-2 database to version 3. Compare every account and transaction ID, amount, owner, and date before/after. Run migration twice and verify no duplicate rows.
3. Force a migration failure in the synthetic copy. Verify the old schema version and all prior rows remain unchanged.
4. Create two synthetic profiles. Verify neither can read or mutate the other's budgets, savings events, accounts, or transactions. Verify a cross-profile account reference is rejected by SQLite.

## Financial flows

1. Create two PKR accounts and one USD account. Verify opening balances and currency labels.
2. Post income, expense, and same-currency transfer. Confirm balances and dashboard/report totals. Confirm transfers are neither income nor expense.
3. Post a partial refund, then a correction/reversal. Confirm history remains append-only and balances/report totals recalculate correctly.
4. Create budgets for food and housing. Add more than 100 eligible expenses, including identical timestamps, a refund, a correction, and an expense on an archived account. Verify budget totals match the complete report and do not change when transaction-list pagination changes.
5. Verify a budget edit creates a revision, archive hides it from active budgets while preserving history, and unused deletion succeeds only when there is no history/activity.
6. Carry unused funds into the next calendar month; repeat the same rollover request ID and verify no duplicate budget rows. Verify reset policy separately.
7. Create a savings goal. Record a planned contribution and confirm no balance/progress credit; earmark available money and confirm progress without a ledger balance change; transfer between accounts and confirm the transaction is recorded as a transfer.
8. Attempt a second earmark beyond unreserved account funds. Verify the operation fails without adding a ledger or event row. Release an earmark and withdraw a transfer back to a spending account.
9. Configure a 3-month emergency target, earmark funds, then attempt to earmark the same account balance for another goal. Verify duplicate reservation is rejected. Repeat using a 6-month target and a second currency/account.
10. Repeat an idempotent request after app restart. Reuse its ID with changed amount, event, account, date, or note and verify it is rejected.

## Transaction and recovery behavior

1. With the Expo SQLite transaction connection, force an error after a transaction insert and verify the transaction, account changes, and associated savings event all roll back.
2. Trigger concurrent write requests from two screens. Verify `withExclusiveTransactionAsync()` keeps each account/event update atomic and the write queue remains usable after a rejected operation.
3. Switch profiles, lock/unlock the app, and restart. Verify the session is scoped to the selected profile and data remains consistent.
4. Test backup/recovery only in a dedicated disposable SQLCipher probe app/database. Verify wrong-key, corrupted-file, and wrong-profile restores fail closed. Production SQLCipher and restore flows remain disabled until this native evidence is reviewed.

## Evidence to record

Record device/API version, build identifier, schema version, test account IDs, expected/observed integer minor-unit balances and report totals, restart results, rollback result, and any native logs. Remove the disposable app and test files after retaining the review evidence; never include credentials or production records in logs.
