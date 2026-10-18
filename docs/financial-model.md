# HouseLog financial model

## Product goal

HouseLog helps a person record money without needing accounting knowledge, then explains what those records mean for day-to-day cash, spending, debt, and wealth. The entry flow should use familiar language. Accounting terms should have short explanations and optional detail.

## Source of truth

For the first personal-finance version, store each real-world event as a categorized transaction and derive cash-account balances from opening balances plus those transactions. This keeps entry understandable without presenting bookkeeping jargon. Transfers are one event with a from-account and a to-account; they change balances but never count as income or expense. Before adding business accounting, extend this model with balanced double-entry journal postings and migrate opening balances.

Money is stored as integer minor units (paisa for PKR). Amount entry accepts at most two decimal places. Currency calculations use integer/BigInt arithmetic; floating point is used only to format chart/display values. For a foreign remittance, preserve the original amount, currency, provider exchange rate, reference number, and converted PKR amount.

## Concepts and user language

| Accounting concept | Plain-language label | Examples |
| --- | --- | --- |
| Asset | Money and things you own | Cash, bank account, savings, investments, money owed to you |
| Liability | Money you owe | Credit card, personal loan, mortgage, unpaid bill |
| Income | Money you earned | Salary, freelance work, interest received |
| Expense | Money you used up | Groceries, rent, transport, fees, interest paid |
| Transfer | Money moved between your accounts | Cash to bank, current account to savings |
| Net worth | What you own minus what you owe | Assets − liabilities |

Borrowing is not income: receiving a loan increases cash and debt by the same amount. Paying a credit card is not a second expense: the card purchase records the expense, and the payment reduces cash and the card liability. Transfers between a person’s own accounts do not count as income or expense.

Use these starting classifications in the personal transaction form:

| Example | Transaction classification | Report treatment |
| --- | --- | --- |
| Rs 20,000 from mother | Family gift / support | Money in; not automatically earnings or tax-exempt |
| Rs 20,000 from brother sent from abroad | Family remittance | Money in; retain original amount, currency, rate, and reference |
| Rs 25,000 internship salary | Employment income | Money in |
| Rs 5,000 debit-card fee | Banking expense | Money out |
| Rs 15,000 hostel rent | Housing expense | Money out |
| Rs 10,000 between own accounts | Internal transfer | Changes account balances; excluded from money in/out |
| Rs 500 bank profit | Bank profit / deposit income | Money in; tax status reviewed separately |

“Money in” is a cash movement summary. It is not the same as earned income, taxable income, or business profit.

## Ledger examples

- Salary paid into a bank account: debit bank; credit salary income.
- Groceries paid with cash: debit groceries expense; credit cash.
- Credit-card purchase: debit the expense category; credit the card liability.
- Payment from bank to credit card: debit card liability; credit bank.
- Transfer from checking to savings: debit savings; credit checking.
- Money lent to a friend: debit receivable (an asset); credit cash. Repayment reverses the receivable and increases cash.
- Loan payment with interest: debit loan liability for principal and interest expense for interest; credit cash for the total payment.

## Reports and their rules

- **Daily money view:** show money in, money out, and the net change for the selected local calendar day. Account transfers are visible but excluded from total income and expense.
- **Income and spending:** sum income and expense postings over an inclusive date range. Show category totals and the difference (surplus or deficit).
- **Cash flow:** sum changes in cash-like accounts and classify them as operating, investing, or financing. Exclude transfers between a person’s own cash-like accounts from the combined flow.
- **Balance sheet:** show asset and liability balances as of a date, plus net worth. For a balanced ledger, assets equal liabilities plus equity; net worth is assets minus liabilities.
- **Liquidity:** show available cash and near-cash separately from investments and property. Do not label all assets as spendable money.
- **Budgets:** compare expense postings in a category and period with that period’s limit. Transfers, card payments, and loan principal are not spending; card purchases and interest are.

Every report must state its period or “as of” date, currency, and whether it includes pending/unposted items. Rounding happens only for display, never during aggregation.

## Data flow

1. A guided form captures an income, purchase, or transfer in plain language and records source/payer and tax review status separately.
2. Validation converts the entered decimal string directly to integer minor units and rejects invalid precision or unsafe values.
3. The local database saves the transaction. Transfers validate two distinct owned accounts with the same currency.
4. Queries derive account balances from opening balances and events, and reports sum only Income and Expense rows. Transfers are excluded.
5. Explanations connect the entry to its report effects, for example: “This increased your bank balance by PKR 5,000 and recorded PKR 5,000 of employment income.”

For offline use, the local database can be the write-ahead store. Sync must use stable IDs and idempotency, preserve pending entries on failure, and only mark an entry synced after the server confirms it. The Neon credential belongs only in a trusted backend; it must never be included in an Expo client build.

## Current implementation status

### What works now

- Expo Router provides authentication, onboarding, dashboard, add transaction, transaction history, Insights, settings, and a budget screen.
- The app stores accounts and categorized income/expense/transfer rows in local SQLite. Reads and writes are scoped by the local profile ID.
- Transaction entry parses PKR amounts into integer paisa and rejects excess precision or unsafe values. Existing floating-point SQLite values are migrated to a new integer column.
- Income entry distinguishes salary, freelance, gross business receipts, family gifts, foreign family remittances, investment returns, rent, and other income. Gift records require the sender name/relationship; tax status is a separate user-entered review field.
- Internal transfers store source and destination accounts, affect derived balances, and stay out of income/expense totals.
- Foreign family remittances preserve source amount/currency, entered provider rate, reference number, and converted PKR value.
- Dashboard and Insights totals use saved local rows; the dashboard's net is explicitly limited to recorded income minus expenses.
- `src/finance/ledger.ts` contains exact minor-unit parsing, FX conversion, and double-entry primitives for later business-accounting work. The double-entry primitives are not wired to the personal-finance SQLite model.
- The financial model terms and required accounting behavior are described above.

### What is still a prototype or missing

- SQLite stores one row per transaction. Cash-account balances are derived from opening balances plus recorded income, expenses, and same-currency transfers. Assets beyond cash accounts, liabilities, debts, repayments, full cash flow, balance sheet, and net worth are not yet implemented.
- Account setup remains basic. Debt, repayments, assets beyond cash accounts, and receipt attachments need dedicated flows. Receipt selection and persistence are not implemented; the Expo document-picker package is not in the current app dependencies.
- Categories are hardcoded. Budgets are not persisted. Transaction edit/delete, account management, export, and local wipe controls are placeholders.
- Authentication is local-only and uses an unsalted SHA-256 password hash. It is not suitable for production identity or password storage.
- The SQLite database is not encrypted by this code. Local profile scoping is an application convention, not a security boundary; production authorization and tenant isolation must be enforced by a trusted backend.
- There is no API/backend in this repository. The Neon URL is for Prisma CLI configuration only; the Expo app never connects directly to Neon. Sync does not send data or mark rows synced.
- Credentials must remain in ignored environment files for trusted server-side tooling and must never be bundled into the Expo app. Because the database password was shared in chat, rotate it before using the database with real financial records.

Before business accounting features are built, add a versioned SQLite journal schema, event-to-posting services, balanced opening entries, and journal-based statements. For this personal-finance phase, next add receipt attachment storage, assets/liabilities and debt repayment flows, account editing, and then a trusted authenticated sync API.

## Income sources and tax separation

Keep an event's accounting treatment, source label, payer, and tax treatment as separate fields. A family gift is a documented non-salary receipt; a salary is employment income; business sales are gross revenue, while business profit is derived after matching business costs; investment returns and rent are their own sources. A loan is a liability increase, and an owner's capital contribution is equity, so neither should inflate earned income. Each receipt should capture its payer and payment method when useful, with the tax status initially marked unknown until reviewed for the relevant tax year.

Pakistan's normal income-tax year runs from 1 July through 30 June. The FBR-published Income Tax Ordinance text inspected (amended through 20 February 2026) describes gifts under section 39, an exclusion for gifts from a defined relative, and traceability rules in subsection (3) for certain loans, advances, share deposits, and gifts. The Finance Act 2026 and current FBR guidance must be checked against that dated Ordinance before any exemption logic ships. The app should record donor identity, relationship, payment channel, available source proof, and tax-year reference. It must not decide that every family gift is exempt or calculate a final tax result from the label alone.

As of 18 October 2026, FBR lists a Tax Year 2027 withholding-tax rate card updated for Finance Act 2026. Tax-year tables belong in versioned data/configuration with their source and effective date, not hard-coded in screen components. Tax calculations need a separate review for the taxpayer's residency, income head, salary benefits, withholding credits, deductions, and other applicable facts.

Reference sources: [FBR Income Tax Ordinance (amended 20 February 2026)](https://download1.fbr.gov.pk/Docs/2026226162211364IncomeTaxOrdinance2001-Amended-20.02.2026.pdf), [FBR Tax Year 2027 withholding-tax rate card](https://www.fbr.gov.pk/withholding-taxes-rate-card/174298/174301), and [FBR Finance Act 2026](https://fbr.gov.pk/Budget2026-27/FinanceAct.html).

## Repository flow map

| Area | Responsibility | Current data flow |
| --- | --- | --- |
| `app/` | Expo Router screens and navigation | Form state → hooks → local database |
| `src/context/AuthContext.tsx` | Local profile session | SecureStore session ID ↔ local SQLite `User` |
| `src/db/local/client.ts` | Local persistence and schema upgrades | Expo SQLite tables `User`, `Account`, `Transaction` |
| `hooks/queries/` | User-scoped reads | TanStack Query → local SQLite → screen summaries |
| `hooks/mutations/` | User actions | Validation/form → local SQLite → invalidate query cache |
| `src/finance/ledger.ts` | Exact-money and ledger domain primitives | Dated journal entries → validated reports (not connected yet) |
| `prisma/` | Future PostgreSQL schema/migrations | Prisma CLI uses direct `DATABASE_URL_UNPOOLED` |
| `utils/syncEngine.ts` | Sync placeholder | Reports unavailable and leaves local rows pending |
