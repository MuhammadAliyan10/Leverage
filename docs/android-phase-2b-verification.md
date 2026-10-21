# Android Phase 2B verification

This extends `android-phase-2a-verification.md` for a disposable development installation. The configured `development` EAS profile produces an internal Android APK with the development client enabled. This checklist does not start a cloud build. Use a synthetic profile and database only; never copy, inspect, or migrate a user's `finance.db`.

## Schema and storage

1. Fresh install: check `PRAGMA user_version = 4`, foreign keys enabled, and `PRAGMA integrity_check = 'ok'`.
2. Migrate synthetic v1, v2, and v3 databases to v4. Compare financial record IDs and minor-unit values before and after. Force an error during v4 and verify both DDL and data roll back.
3. Reopen after creation and posting. Verify schedules, pending/posted/skipped occurrences, bills, payment history, debts, and debt events persist.
4. Run two due-occurrence catch-ups concurrently and after restart. Each schedule/date pair must exist once. A due schedule must remain pending until explicit user approval.

## Recurrence and bills

1. Exercise daily, weekly, monthly and yearly schedules, including a January 31 schedule, February month-end, leap day, and an end date.
2. Leave the app closed across multiple dates; on next open, verify each missed occurrence appears once and none is posted automatically.
3. Pause, resume, edit and cancel a schedule. Verify edits affect future occurrences only and existing transactions remain unchanged.
4. Create one-time and recurring bills. Verify creating bills and generating due obligations does not create ledger transactions or reduce account balances.
5. Pay a bill in partial amounts, repeat a request, attempt to exceed the obligation, and retry after an injected failure. Verify payment history, transaction links, and outstanding amount.
6. Schedule and cancel a local reminder. Deny notification permission, reopen the app, and verify the bill remains available with an in-app due state. Notifications are reminders only; they never post payments.

## Debt and financial integrity

1. Borrow principal and verify cash increases while earned income remains unchanged and outstanding liability increases.
2. Lend principal and verify cash decreases while ordinary expenses remain unchanged and receivable balance increases.
3. Repay borrowed principal and collect lent principal partially and fully. Verify cash, outstanding principal, and settlement status.
4. Record interest separately. Verify interest is an expense while principal is excluded from expense totals.
5. Attempt cross-profile, cross-currency, archived-account, excess-principal, duplicate-request and duplicate-transaction writes. Verify rejection without partial history.
6. Inject failures after the transaction insert and before obligation history insert. Verify transaction, payment/event, and status updates all roll back together.

## Notifications and native SQLite

1. On a physical Android device, verify OS notification permission and local date trigger at 9:00 AM on the due date. Confirm tapping the notification opens Recurring, Bills & Debt.
2. Verify that paying a bill cancels its saved local reminder.
3. Verify concurrent posting uses Expo SQLite's exclusive transaction connection, then terminate and restart the app to confirm persistence.

Record device/API level, APK identifier, synthetic profile IDs, expected and observed minor-unit values, notification permission state, and restart/rollback outcomes. Do not include passwords, tokens, production connection strings, or production records in evidence.
