import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildFinancialReportQuery, calculateFinancialBucketTotals, calculateFinancialReport, calculateSpendingByAccountTotals } from '../../src/finance/reporting.ts';
import { buildTransactionPagePredicate } from '../../src/db/local/queryBuilders.ts';

function setupReportDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE Account (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, currency TEXT NOT NULL,
      balanceMinor INTEGER NOT NULL, archivedAt TEXT
    );
    CREATE TABLE "Transaction" (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, date TEXT NOT NULL, amountMinor INTEGER NOT NULL,
      type TEXT NOT NULL, categoryId TEXT NOT NULL, note TEXT, accountId TEXT, toAccountId TEXT, reversalOfId TEXT,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX Transaction_owner_date_id_idx ON "Transaction"(ownerId, date DESC, id DESC);
    INSERT INTO Account VALUES ('pkr', 'user-1', 'PKR', 9000000, NULL);
    INSERT INTO Account VALUES ('pkr-archived', 'user-1', 'PKR', 25000, '2026-04-01T00:00:00.000Z');
    INSERT INTO Account VALUES ('usd', 'user-1', 'USD', 500000, NULL);
    INSERT INTO Account VALUES ('other-user', 'user-2', 'PKR', 100000, NULL);
  `);
  const insert = database.prepare(`INSERT INTO "Transaction" (id, ownerId, date, amountMinor, type, categoryId, accountId, toAccountId, reversalOfId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const date = '2026-05-15T12:00:00.000Z';
  for (let index = 0; index < 2500; index += 1) {
    insert.run(`expense-${String(index).padStart(4, '0')}`, 'user-1', date, index === 0 ? 500 : 100, 'Expense', 'Food', 'pkr', null, null);
  }
  insert.run('income', 'user-1', date, 5000, 'Income', 'Salary', 'pkr', null, null);
  insert.run('refund', 'user-1', date, 250, 'Refund', 'Expense refund', 'pkr', null, 'expense-0000');
  insert.run('refund-partial', 'user-1', date, 50, 'Refund', 'Expense refund', 'pkr', null, 'expense-0000');
  insert.run('correction-original', 'user-1', date, 600, 'Expense', 'Housing', 'pkr', null, null);
  insert.run('correction-reversal', 'user-1', date, 600, 'Reversal', 'Correction reversal', 'pkr', null, 'correction-original');
  insert.run('correction-replacement', 'user-1', date, 400, 'Expense', 'Transport', 'pkr', null, null);
  insert.run('refund-reversal', 'user-1', date, 250, 'Reversal', 'Correction reversal', 'pkr', null, 'refund');
  insert.run('own-transfer', 'user-1', date, 9000, 'Transfer', 'Transfer', 'pkr', 'pkr-archived', null);
  insert.run('transfer-reversal', 'user-1', date, 9000, 'Reversal', 'Correction reversal', 'pkr', 'pkr-archived', 'own-transfer');
  insert.run('archived-expense', 'user-1', date, 75, 'Expense', 'Food', 'pkr-archived', null, null);
  insert.run('usd-expense', 'user-1', date, 8000, 'Expense', 'Food', 'usd', null, null);
  insert.run('another-profile', 'user-2', date, 100000, 'Expense', 'Food', 'other-user', null, null);
  insert.run('before-period', 'user-1', '2026-04-30T23:59:59.999Z', 99000, 'Expense', 'Food', 'pkr', null, null);
  insert.run('after-period', 'user-1', '2026-06-01T00:00:00.000Z', 88000, 'Expense', 'Food', 'pkr', null, null);
  return database;
}

test('complete indexed report totals ignore pagination, retain archived history, and separate currencies', () => {
  const database = setupReportDatabase();
  const built = buildFinancialReportQuery('user-1', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
  const rows = database.prepare(built.sql).all(...built.params).map((row) => ({ ...row }));
  assert.equal(rows.length, 2511, 'period query includes all records for this profile, including USD and archived-account history');
  const plan = database.prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...built.params).map((row) => row.detail).join('\n');
  assert.match(plan, /Transaction_owner_date_id_idx/);
  assert.equal(rows[0].date, rows[1].date);
  assert.equal(rows[0].id, 'archived-expense', 'stable report order uses date then ID for tied timestamps');

  const range = { startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z' };
  const full = calculateFinancialReport(rows, 'PKR', range);
  assert.equal(full.incomeMinor, 5000);
  assert.equal(full.expenseMinor, 250825);
  assert.equal(full.netMinor, -245825);
  assert.equal(full.expenseCount, 2502, 'frequency counts positive net expense records after partial refunds and full reversals');
  assert.deepEqual(full.incomeSourceTotals, [{ source: 'Salary', amountMinor: 5000 }]);
  assert.deepEqual(full.excludedCurrencies, ['USD']);
  assert.deepEqual(full.categoryTotals, [
    { category: 'Food', amountMinor: 250425 },
    { category: 'Transport', amountMinor: 400 },
  ]);
  assert.equal(full.largestExpenses[0].amountMinor, 450, 'partial refund reduces the original expense and correction reversal removes its original');

  for (const pageSize of [1, 17, 50, 100, 257]) {
    const pages = [];
    for (let offset = 0; offset < rows.length; offset += pageSize) pages.push(rows.slice(offset, offset + pageSize));
    assert.deepEqual(calculateFinancialReport(pages.flat(), 'PKR', range), full, `page size ${pageSize}`);
  }
  assert.deepEqual(calculateFinancialReport([...rows].reverse(), 'PKR', range), full, 'row ordering does not change totals');

  const expectedIds = database.prepare('SELECT id FROM "Transaction" WHERE ownerId = ? ORDER BY date DESC, id DESC')
    .all('user-1').map((row) => row.id);
  for (const pageSize of [1, 17, 50, 100]) {
    const ids = [];
    let cursor;
    while (true) {
      const page = buildTransactionPagePredicate({ ownerId: 'user-1', cursor, take: pageSize });
      const pageSql = `SELECT t.id, t.date FROM "Transaction" t WHERE ${page.whereSql} ORDER BY ${page.orderSql}${page.limitSql}`;
      const pageRows = database.prepare(pageSql).all(...page.params).map((row) => ({ ...row }));
      if (!pageRows.length) break;
      ids.push(...pageRows.map((row) => row.id));
      const last = pageRows.at(-1);
      cursor = { date: last.date, id: last.id };
    }
    assert.deepEqual(ids, expectedIds, `keyset pages of ${pageSize} retain tied timestamps exactly once`);
  }
  database.close();
});

test('report query is profile scoped, period bounded, and refuses inconsistent linked records', () => {
  const database = setupReportDatabase();
  const query = buildFinancialReportQuery('user-1', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
  const rows = database.prepare(query.sql).all(...query.params).map((row) => ({ ...row }));
  assert.equal(rows.some((row) => row.id === 'another-profile'), false);
  assert.equal(rows.some((row) => row.id === 'before-period' || row.id === 'after-period'), false);
  const corrupt = rows.map((row) => row.id === 'refund' ? { ...row, linkedOriginalType: 'Income' } : row);
  assert.throws(() => calculateFinancialReport(corrupt, 'PKR', {
    startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z',
  }), /does not refer to a recorded expense/);
  assert.throws(() => buildFinancialReportQuery('', '2026-05-01', '2026-06-01'), /profile/);
  database.close();
});

test('borrowing and principal repayments affect cash but not income or expenses; interest remains expense',()=>{
  const database=setupReportDatabase();
  const built=buildFinancialReportQuery('user-1','2026-05-01T00:00:00.000Z','2026-06-01T00:00:00.000Z');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,date,amountMinor,type,categoryId,accountId) VALUES(?,?,?,?,?,?,?)').run('borrow','user-1','2026-05-15T12:00:00.000Z',50000,'Income','debt_borrowing','pkr');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,date,amountMinor,type,categoryId,accountId) VALUES(?,?,?,?,?,?,?)').run('principal','user-1','2026-05-15T12:00:00.000Z',10000,'Expense','debt_principal_repayment','pkr');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,date,amountMinor,type,categoryId,accountId) VALUES(?,?,?,?,?,?,?)').run('interest','user-1','2026-05-15T12:00:00.000Z',500,'Expense','debt_interest','pkr');
  const rows=database.prepare(built.sql).all(...built.params).map((row)=>({...row}));
  const report=calculateFinancialReport(rows,'PKR',{startDate:'2026-05-01T00:00:00.000Z',endDate:'2026-06-01T00:00:00.000Z'});
  assert.equal(report.incomeMinor,5000);
  assert.equal(report.expenseMinor,250825+500);
  assert.equal(report.categoryTotals.find((item)=>item.category==='debt_interest')?.amountMinor,500);
  assert.equal(report.categoryTotals.some((item)=>item.category==='debt_principal_repayment'),false);
  database.close();
});

test('chart buckets aggregate complete large record sets with signed refunds and stable ordering', () => {
  const range = { startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z' };
  const rows = [];
  for (let index = 0; index < 1000; index += 1) {
    rows.push({ id: `e-${index}`, ownerId: 'u', date: '2026-05-15T12:00:00.000Z', amountMinor: 100, type: 'Expense', category: 'food', note: '', accountId: 'a', toAccountId: null, accountCurrency: 'PKR', destinationCurrency: null, reversalOfId: null, linkedOriginalAccountId: null, linkedOriginalToAccountId: null, linkedOriginalType: null, linkedCategory: null, linkedCurrency: null, linkedDestinationCurrency: null, linkedRootType: null, linkedRootId: null, linkedRootCurrency: null });
  }
  rows.push({ ...rows[0], id: 'refund', amountMinor: 25, type: 'Refund', category: 'expense_refund', reversalOfId: 'e-0', linkedOriginalType: 'Expense', linkedCategory: 'food', linkedCurrency: 'PKR' });
  rows.push({ ...rows[0], id: 'income', amountMinor: 500, type: 'Income', category: 'salary' });
  rows.push({ ...rows[0], id: 'transfer', amountMinor: 900, type: 'Transfer', category: 'internal_transfer', toAccountId: 'b', destinationCurrency: 'PKR' });
  rows.push({ ...rows[0], id: 'usd', amountMinor: 100_000, accountCurrency: 'USD' });
  const buckets = [{ id: 'may', group: 'month', startDate: range.startDate, endDate: range.endDate }];
  const totals = calculateFinancialBucketTotals(rows, 'PKR', buckets);
  assert.deepEqual(totals.may, { incomeMinor: 500, expenseMinor: 99_975 });
  assert.deepEqual(calculateFinancialBucketTotals([...rows].reverse(), 'PKR', buckets), totals);
  for (const pageSize of [1, 23, 100, 257]) {
    const pages = [];
    for (let offset = 0; offset < rows.length; offset += pageSize) pages.push(rows.slice(offset, offset + pageSize));
    // A chart consumes the complete set; summing page-level bucket results is equivalent.
    const paged = pages.reduce((sum, page) => {
      const result = calculateFinancialBucketTotals(page, 'PKR', buckets).may;
      return { incomeMinor: sum.incomeMinor + result.incomeMinor, expenseMinor: sum.expenseMinor + result.expenseMinor };
    }, { incomeMinor: 0, expenseMinor: 0 });
    assert.deepEqual(paged, totals.may);
  }
});

test('spending-by-account totals reconcile after refunds and reversals while excluding transfers', () => {
  const base = { ownerId: 'u', date: '2026-05-15T12:00:00.000Z', category: 'food', note: '', toAccountId: null, accountCurrency: 'PKR', destinationCurrency: null, reversalOfId: null, linkedOriginalAccountId: null, linkedOriginalToAccountId: null, linkedOriginalType: null, linkedCategory: null, linkedCurrency: null, linkedDestinationCurrency: null, linkedRootType: null, linkedRootId: null, linkedRootCurrency: null };
  const rows = [
    { ...base, id: 'expense-a', amountMinor: 1000, type: 'Expense', accountId: 'a' },
    { ...base, id: 'expense-b', amountMinor: 500, type: 'Expense', accountId: 'b' },
    { ...base, id: 'refund-a', amountMinor: 200, type: 'Refund', accountId: 'a', reversalOfId: 'expense-a', linkedOriginalAccountId: 'a', linkedOriginalType: 'Expense', linkedCategory: 'food', linkedCurrency: 'PKR' },
    { ...base, id: 'reverse-b', amountMinor: 100, type: 'Reversal', accountId: 'b', reversalOfId: 'expense-b', linkedOriginalAccountId: 'b', linkedOriginalType: 'Expense', linkedCategory: 'food', linkedCurrency: 'PKR' },
    { ...base, id: 'refund-b-from-a', amountMinor: 50, type: 'Refund', accountId: 'a', reversalOfId: 'expense-b', linkedOriginalAccountId: 'b', linkedOriginalType: 'Expense', linkedCategory: 'food', linkedCurrency: 'PKR' },
    { ...base, id: 'undo-refund-b', amountMinor: 50, type: 'Reversal', accountId: 'a', reversalOfId: 'refund-b-from-a', linkedOriginalAccountId: 'a', linkedOriginalType: 'Refund', linkedCategory: 'food', linkedCurrency: 'PKR', linkedRootType: 'Expense', linkedRootId: 'expense-b', linkedRootAccountId: 'b', linkedRootCurrency: 'PKR' },
    { ...base, id: 'transfer', amountMinor: 9999, type: 'Transfer', accountId: 'a', toAccountId: 'b', destinationCurrency: 'PKR' },
  ];
  const range = { startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z' };
  const byAccount = calculateSpendingByAccountTotals(rows, 'PKR', range);
  assert.deepEqual(byAccount, [{ accountId: 'a', amountMinor: 800 }, { accountId: 'b', amountMinor: 400 }]);
  const report = calculateFinancialReport(rows, 'PKR', range);
  assert.equal(byAccount.reduce((sum, item) => sum + item.amountMinor, 0), report.expenseMinor);
});

test('a refund in a later reporting period remains a signed adjustment instead of a fake positive category', () => {
  const database = setupReportDatabase();
  database.prepare('INSERT INTO "Transaction"(id,ownerId,date,amountMinor,type,categoryId,accountId) VALUES(?,?,?,?,?,?,?)')
    .run('prior-month-expense', 'user-1', '2026-04-15T12:00:00.000Z', 200, 'Expense', 'food', 'pkr');
  database.prepare('INSERT INTO "Transaction"(id,ownerId,date,amountMinor,type,categoryId,accountId,reversalOfId) VALUES(?,?,?,?,?,?,?,?)')
    .run('current-month-refund', 'user-1', '2026-05-15T12:00:00.000Z', 200, 'Refund', 'expense_refund', 'pkr', 'prior-month-expense');
  const built = buildFinancialReportQuery('user-1', '2026-05-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
  const rows = database.prepare(built.sql).all(...built.params).map((row) => ({ ...row }));
  const report = calculateFinancialReport(rows, 'PKR', { startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-06-01T00:00:00.000Z' });
  assert.equal(report.expenseMinor, 250_625);
  assert.equal(report.categoryTotals.find((category) => category.category === 'food')?.amountMinor, -200);
  database.close();
});
