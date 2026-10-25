import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildAccountActivitySummaryQuery, buildAccountBalanceQuery, buildFilteredTransactionPredicate, buildHistoricalAccountBalanceQuery, buildRecentAccountPreferenceQuery, buildTransactionListQuery } from '../../src/db/local/queryBuilders.ts';
import { calculateAccountBalances } from '../../src/finance/balances.ts';

test('account balance aggregation matches ledger rules without returning transaction history', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE Account (id TEXT PRIMARY KEY, ownerId TEXT, name TEXT, type TEXT, balanceMinor INTEGER, currency TEXT, createdAt TEXT, archivedAt TEXT, synced INTEGER);
      CREATE TABLE "Transaction" (id TEXT PRIMARY KEY, ownerId TEXT, amountMinor INTEGER, type TEXT, accountId TEXT, toAccountId TEXT, reversalOfId TEXT, date TEXT);
      CREATE INDEX Transaction_owner_date_id_idx ON "Transaction"(ownerId,date DESC,id DESC);
      INSERT INTO Account VALUES ('cash','u1','Cash','cash',10000,'PKR','2026-01-01',NULL,0),
        ('bank','u1','Bank','bank',5000,'PKR','2026-01-02',NULL,0),
        ('old','u1','Archived','bank',7000,'PKR','2025-01-01','2026-01-01',0),
        ('other','u2','Other','bank',9000,'PKR','2026-01-01',NULL,0);
      INSERT INTO "Transaction" VALUES
        ('income','u1',2000,'Income','cash',NULL,NULL,'2026-01-03'),
        ('expense','u1',500,'Expense','cash',NULL,NULL,'2026-01-04'),
        ('transfer','u1',1000,'Transfer','cash','bank',NULL,'2026-01-05'),
        ('refund','u1',200,'Refund','cash',NULL,'expense','2026-01-06'),
        ('prior-expense','u1',300,'Expense','bank',NULL,NULL,'2026-01-07'),
        ('reversal','u1',300,'Reversal','bank',NULL,'prior-expense','2026-01-08'),
        ('replacement','u1',350,'Expense','cash',NULL,NULL,'2026-01-08'),
        ('old-transfer','u1',100,'Transfer','old','bank',NULL,'2025-12-31'),
        ('foreign-income','u2',600,'Income','other',NULL,NULL,'2026-01-03');`);
    const query = buildAccountBalanceQuery('u1');
    const aggregated = database.prepare(query.sql).all(...query.params).map((row) => ({ ...row }));
    const fullLedger = database.prepare('SELECT * FROM Account WHERE ownerId=?').all('u1').map((row) => ({ ...row }));
    const transactions = database.prepare('SELECT * FROM "Transaction" WHERE ownerId=? ORDER BY date,id').all('u1').map((row) => ({ ...row }));
    const expected = calculateAccountBalances(fullLedger, transactions).filter((account) => account.id !== 'old');
    assert.deepEqual(aggregated.map((row) => [row.id, row.currentBalanceMinor]), expected.map((account) => [account.id, account.balanceMinor]));
    assert.deepEqual(query.params, ['u1']);
    assert.ok(query.sql.includes('SUM(events.delta)'));
    assert.ok(!query.sql.includes('SELECT * FROM "Transaction"'));
  } finally { database.close(); }
});

test('account activity summary covers full history and classifies transfers, refunds, reversals, and profile scope', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE Account (id TEXT PRIMARY KEY,ownerId TEXT,name TEXT,type TEXT,balanceMinor INTEGER,currency TEXT,createdAt TEXT,archivedAt TEXT,synced INTEGER);
      CREATE TABLE "Transaction" (id TEXT PRIMARY KEY,ownerId TEXT,amountMinor INTEGER,type TEXT,accountId TEXT,toAccountId TEXT,reversalOfId TEXT,date TEXT);
      CREATE INDEX Transaction_owner_account_idx ON "Transaction"(ownerId,accountId,date DESC,id DESC);
      CREATE INDEX Transaction_owner_destination_idx ON "Transaction"(ownerId,toAccountId,date DESC,id DESC);
      INSERT INTO Account VALUES ('cash','u1','Cash','cash',10000,'PKR','2026-01-01',NULL,0),('bank','u1','Bank','bank',5000,'PKR','2026-01-01','2026-02-01',0),('other','u2','Other','cash',5000,'PKR','2026-01-01',NULL,0);
      INSERT INTO "Transaction" VALUES
        ('income','u1',2000,'Income','cash',NULL,NULL,'2026-01-02'),
        ('expense','u1',500,'Expense','cash',NULL,NULL,'2026-01-03'),
        ('transfer','u1',1000,'Transfer','cash','bank',NULL,'2026-01-04'),
        ('refund','u1',200,'Refund','cash',NULL,'expense','2026-01-05'),
        ('bank-expense','u1',300,'Expense','bank',NULL,NULL,'2026-01-06'),
        ('expense-reversal','u1',300,'Reversal','bank',NULL,'bank-expense','2026-01-07'),
        ('income-reversal','u1',100,'Reversal','cash',NULL,'income','2026-01-08'),
        ('transfer-reversal','u1',1000,'Reversal','cash','bank','transfer','2026-01-09'),
        ('foreign-income','u2',999999,'Income','other',NULL,NULL,'2026-01-10');`);
    // Older records beyond any normal history-page boundary must be included in the aggregate.
    database.exec('BEGIN');
    const insert = database.prepare('INSERT INTO "Transaction" VALUES(?,?,?,?,?,?,?,?)');
    for (let index = 0; index < 1200; index += 1) insert.run(`old-${index}`, 'u1', 1, 'Income', 'cash', null, null, `2025-01-${String(index % 28 + 1).padStart(2, '0')}`);
    database.exec('COMMIT');

    const cashQuery = buildAccountActivitySummaryQuery('u1', 'cash');
    const cash = database.prepare(cashQuery.sql).get(...cashQuery.params);
    assert.deepEqual({ opening: cash.openingBalanceMinor, current: cash.currentBalanceMinor, in: cash.inflowMinor, out: cash.outflowMinor, count: cash.transactionCount }, {
      opening: 10000, current: 12800, in: 4400, out: 1600, count: 1206,
    });
    const bank = database.prepare(buildAccountActivitySummaryQuery('u1', 'bank').sql).get(...buildAccountActivitySummaryQuery('u1', 'bank').params);
    assert.deepEqual({ current: bank.currentBalanceMinor, in: bank.inflowMinor, out: bank.outflowMinor, count: bank.transactionCount }, { current: 5000, in: 1300, out: 1300, count: 4 });
    assert.equal(database.prepare(buildAccountActivitySummaryQuery('u1', 'other').sql).get(...buildAccountActivitySummaryQuery('u1', 'other').params), undefined);
    assert.throws(() => buildAccountActivitySummaryQuery('', 'cash'), /profile and account/);
  } finally { database.close(); }
});

test('historical indexed account snapshots match full ledger replay across refunds, reversals and transfers', () => {
  const database=new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE Account (id TEXT PRIMARY KEY,ownerId TEXT,name TEXT,type TEXT,balanceMinor INTEGER,currency TEXT,createdAt TEXT,archivedAt TEXT,synced INTEGER);
      CREATE TABLE "Transaction" (id TEXT PRIMARY KEY,ownerId TEXT,amountMinor INTEGER,type TEXT,accountId TEXT,toAccountId TEXT,reversalOfId TEXT,date TEXT);
      CREATE INDEX Transaction_owner_date_id_idx ON "Transaction"(ownerId,date DESC,id DESC);
      INSERT INTO Account VALUES ('cash','u1','Cash','cash',10000,'PKR','2026-01-01',NULL,0),('bank','u1','Bank','bank',5000,'PKR','2026-01-05','2026-02-01',0),('other','u2','Other','cash',7000,'PKR','2026-01-01',NULL,0);
      INSERT INTO "Transaction" VALUES
        ('income','u1',5000,'Income','cash',NULL,NULL,'2026-01-10'),
        ('expense','u1',2000,'Expense','cash',NULL,NULL,'2026-01-11'),
        ('transfer','u1',1000,'Transfer','cash','bank',NULL,'2026-01-12'),
        ('refund','u1',500,'Refund','cash',NULL,'expense','2026-01-13'),
        ('transfer-reversal','u1',1000,'Reversal','cash','bank','transfer','2026-02-02'),
        ('future','u1',3000,'Income','cash',NULL,NULL,'2026-03-01'),
        ('foreign','u2',9000,'Income','other',NULL,NULL,'2026-01-10');`);
    const accounts=database.prepare('SELECT id,ownerId,name,type,balanceMinor,currency,createdAt,archivedAt FROM Account WHERE ownerId=?').all('u1').map((row)=>({...row}));
    const transactions=database.prepare('SELECT * FROM "Transaction" WHERE ownerId=? ORDER BY date,id').all('u1').map((row)=>({...row}));
    for(const cutoff of ['2026-01-12','2026-01-14','2026-02-03','2026-03-02']){
      const query=buildHistoricalAccountBalanceQuery('u1',cutoff);
      const actual=database.prepare(query.sql).all(...query.params).map((row)=>({...row}));
      const eligibleAccounts=accounts.filter((account)=>account.createdAt<=cutoff);
      const eligibleTransactions=transactions.filter((transaction)=>transaction.date<=cutoff);
      const expected=calculateAccountBalances(eligibleAccounts,eligibleTransactions);
      assert.deepEqual(actual.map(({id,balanceMinor})=>({id,balanceMinor})),expected.map(({id,balanceMinor})=>({id,balanceMinor})));
    }
  } finally { database.close(); }
});

test('12 historical snapshots stay in SQLite for 1,000, 10,000 and 50,000 ledger rows', () => {
  for(const count of [1_000,10_000,50_000]){
    const database=new DatabaseSync(':memory:');
    try {
      database.exec(`CREATE TABLE Account (id TEXT PRIMARY KEY,ownerId TEXT,name TEXT,type TEXT,balanceMinor INTEGER,currency TEXT,createdAt TEXT,archivedAt TEXT,synced INTEGER);
        CREATE TABLE "Transaction" (id TEXT PRIMARY KEY,ownerId TEXT,amountMinor INTEGER,type TEXT,accountId TEXT,toAccountId TEXT,reversalOfId TEXT,date TEXT);
        CREATE INDEX Transaction_owner_date_id_idx ON "Transaction"(ownerId,date DESC,id DESC);
        INSERT INTO Account VALUES ('cash','u1','Cash','cash',1000000,'PKR','2026-01-01T00:00:00.000Z',NULL,0);`);
      database.exec('BEGIN');
      const insert=database.prepare('INSERT INTO "Transaction" VALUES(?,?,?,?,?,?,?,?)');
      for(let index=0;index<count;index+=1){
        const month=index%12;const day=Math.floor(index/12)%28+1;const date=`2026-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}T12:00:00.000Z`;
        insert.run(`tx-${index}`,'u1',1,'Expense','cash',null,null,date);
      }
      database.exec('COMMIT');
      const eligible=[];
      for(let index=0;index<count;index+=1){const month=index%12;const day=Math.floor(index/12)%28+1;eligible.push(`2026-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}T12:00:00.000Z`);}
      const snapshotStart=performance.now();
      for(let month=1;month<=12;month+=1){
        const cutoff=new Date(Date.UTC(2026,month,0,23,59,59,999)).toISOString();
        const query=buildHistoricalAccountBalanceQuery('u1',cutoff);
        const result=database.prepare(query.sql).get(...query.params);
        const txCount=eligible.filter((date)=>date<=cutoff).length;
        assert.equal(result.balanceMinor,1_000_000-txCount);
      }
      console.log(`Synthetic historical cash snapshots: ${count} ledger rows, 12 SQL snapshots in ${(performance.now()-snapshotStart).toFixed(2)} ms (Node SQLite).`);
    } finally { database.close(); }
  }
});

test('dashboard balance aggregation remains equivalent through 50,000 synthetic ledger rows', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE Account (id TEXT PRIMARY KEY, ownerId TEXT, name TEXT, type TEXT, balanceMinor INTEGER, currency TEXT, createdAt TEXT, archivedAt TEXT, synced INTEGER);
      CREATE TABLE "Transaction" (id TEXT, ownerId TEXT, amountMinor INTEGER, type TEXT, accountId TEXT, toAccountId TEXT, reversalOfId TEXT, date TEXT);
      CREATE INDEX Transaction_owner_date_id_idx ON "Transaction"(ownerId,date DESC,id DESC);
      INSERT INTO Account VALUES ('cash','u1','Cash','cash',10000,'PKR','2026-01-01',NULL,0),
        ('bank','u1','Bank','bank',5000,'PKR','2026-01-02',NULL,0),
        ('other','u2','Other','bank',9000,'PKR','2026-01-01',NULL,0);`);
    const insert = database.prepare('INSERT INTO "Transaction" VALUES(?,?,?,?,?,?,NULL,?)');
    const counts = [1_000, 10_000, 50_000];
    const timings = [];
    let sequence = 0;
    for (const targetCount of counts) {
      const startInsert = performance.now();
      while (sequence < targetCount) {
        const type = sequence % 3 === 0 ? 'Income' : sequence % 3 === 1 ? 'Expense' : 'Transfer';
        insert.run(`row-${String(sequence).padStart(6, '0')}`, 'u1', 100, type,
          type === 'Income' ? 'cash' : 'bank', type === 'Transfer' ? 'cash' : null,
          `2026-01-${String((sequence % 28) + 1).padStart(2, '0')}T12:00:00.000Z`);
        sequence += 1;
      }
      const insertMs = performance.now() - startInsert;
      const query = buildAccountBalanceQuery('u1', true);
      const aggregateStart = performance.now();
      const aggregated = database.prepare(query.sql).all(...query.params).map((row) => ({ ...row }));
      const aggregateMs = performance.now() - aggregateStart;
      const rows = database.prepare('SELECT * FROM "Transaction" WHERE ownerId=? ORDER BY date ASC,id ASC').all('u1').map((row) => ({ ...row }));
      const referenceStart = performance.now();
      const expected = calculateAccountBalances(database.prepare('SELECT * FROM Account WHERE ownerId=?').all('u1').map((row) => ({ ...row })), rows);
      const referenceMs = performance.now() - referenceStart;
      assert.deepEqual(aggregated.map((row) => [row.id, row.currentBalanceMinor]), expected.map((account) => [account.id, account.balanceMinor]));
      assert.equal(aggregated.length, 2, 'the SQL result contains accounts, not ledger history');
      timings.push({ rows: targetCount, insertMs: Math.round(insertMs), aggregateMs: Math.round(aggregateMs), referenceMs: Math.round(referenceMs) });
    }
    console.info('Synthetic dashboard balance timing (ms):', JSON.stringify(timings));
  } finally { database.close(); }
});

test('the correction lookup index is selected by SQLite query planning', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE "Transaction" (id TEXT, ownerId TEXT, correctionOfId TEXT); CREATE INDEX Transaction_owner_correction_idx ON "Transaction"(ownerId,correctionOfId);');
    const plan = database.prepare('EXPLAIN QUERY PLAN SELECT id FROM "Transaction" WHERE ownerId=? AND correctionOfId=? LIMIT 1').all('u1', 'original');
    assert.ok(plan.some((row) => String(row.detail).includes('Transaction_owner_correction_idx')));
  } finally { database.close(); }
});

test('recent account preference is profile-scoped, active-only, deterministic, and reads one row', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE Account (id TEXT, ownerId TEXT, archivedAt TEXT);
      CREATE TABLE "Transaction" (id TEXT, ownerId TEXT, type TEXT, accountId TEXT, date TEXT);
      CREATE INDEX Transaction_owner_date_id_idx ON "Transaction"(ownerId,date DESC,id DESC);
      INSERT INTO Account VALUES ('a','u1',NULL),('b','u1','2026-10-23'),('c','u2',NULL);
      INSERT INTO "Transaction" VALUES ('1','u1','Expense','a','2026-10-22T10:00:00.000Z'),
        ('2','u1','Expense','b','2026-10-23T10:00:00.000Z'),
        ('3','u1','Income','c','2026-10-24T10:00:00.000Z'),
        ('4','u2','Expense','c','2026-10-25T10:00:00.000Z');`);
    const query = buildRecentAccountPreferenceQuery('u1', 'Expense');
    const row = database.prepare(query.sql).get(...query.params);
    assert.equal(row.accountId, 'a');
    assert.deepEqual(query.params, ['u1', 'Expense']);
    assert.match(query.sql, /LIMIT 1/);
    assert.match(query.sql, /archivedAt IS NULL/);
    assert.throws(() => buildRecentAccountPreferenceQuery('', 'Expense'), /profile/);
  } finally { database.close(); }
});

test('complete-history transaction filters compose safely and preserve deterministic cursor pagination', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE "Transaction" (id TEXT, ownerId TEXT, date TEXT, type TEXT, accountId TEXT, toAccountId TEXT, categoryId TEXT, classificationId TEXT, note TEXT, sourceName TEXT, reversalOfId TEXT, correctionOfId TEXT);
      CREATE TABLE Account (id TEXT, ownerId TEXT, name TEXT, currency TEXT);
      CREATE TABLE Bill (id TEXT, ownerId TEXT, name TEXT);
      CREATE TABLE Debt (id TEXT, ownerId TEXT, counterparty TEXT);
      CREATE TABLE Asset (id TEXT, ownerId TEXT, name TEXT);
      CREATE TABLE InvestmentHolding (id TEXT, ownerId TEXT, name TEXT);
      INSERT INTO Account VALUES ('bank','u1','Primary Bank','PKR'),('wallet','u1','Cash Wallet','PKR'),('other','u2','Other User Bank','PKR');
      INSERT INTO "Transaction" VALUES ('a','u1','2026-10-23T10:00:00.000Z','Expense','bank',NULL,'food','food','Lunch 100%','',NULL,NULL),
        ('b','u1','2026-10-23T10:00:00.000Z','Income','wallet',NULL,'salary','salary','Salary','Employer',NULL,NULL),
        ('c','u2','2026-10-23T10:00:00.000Z','Expense','other',NULL,'food','food','Lunch','',NULL,NULL);`);
    const query = buildFilteredTransactionPredicate({
      ownerId: 'u1', take: 10,
      filters: { search: '100%', types: ['Expense'], startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-11-01T00:00:00.000Z', accountId: 'bank', categoryId: 'food', currency: 'PKR' },
    });
    const rows = database.prepare(`SELECT t.id FROM "Transaction" t LEFT JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId
      LEFT JOIN Account destination ON destination.id=t.toAccountId AND destination.ownerId=t.ownerId
      LEFT JOIN "Transaction" linked ON linked.id=COALESCE(t.reversalOfId,t.correctionOfId) AND linked.ownerId=t.ownerId
      LEFT JOIN "Transaction" linkedRoot ON linkedRoot.id=linked.reversalOfId AND linkedRoot.ownerId=linked.ownerId
      LEFT JOIN Bill bill ON 1=0 LEFT JOIN Debt debt ON 1=0 LEFT JOIN Asset asset ON 1=0 LEFT JOIN InvestmentHolding holding ON 1=0
      WHERE ${query.whereSql} ORDER BY ${query.orderSql}${query.limitSql}`).all(...query.params);
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ id: 'a' }]);
    assert.ok(!query.whereSql.includes('u1'), 'profile value remains a bound parameter');
    assert.ok(query.whereSql.includes('t.ownerId = ?'));
    assert.ok(query.orderSql.includes('t.date DESC, t.id DESC'));
  } finally { database.close(); }
});

test('transaction search escapes LIKE metacharacters and never interpolates search input', () => {
  const query = buildFilteredTransactionPredicate({ ownerId: 'profile', filters: { search: "%' OR 1=1 --_" }, take: 10 });
  assert.ok(query.whereSql.includes('LIKE ?'));
  assert.equal(query.params[0], 'profile');
  assert.equal(query.params[1], "%\\%' or 1=1 --\\_%");
  assert.ok(!query.whereSql.includes("OR 1=1"));
});

test('filtered keyset pages cover thousands of tied timestamps exactly once and remain profile scoped', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE "Transaction" (id TEXT, ownerId TEXT, date TEXT, type TEXT, accountId TEXT, toAccountId TEXT, categoryId TEXT, classificationId TEXT, note TEXT, sourceName TEXT, reversalOfId TEXT, correctionOfId TEXT);
      CREATE TABLE Account (id TEXT, ownerId TEXT, name TEXT, currency TEXT);
      CREATE TABLE Bill (id TEXT, ownerId TEXT, name TEXT); CREATE TABLE Debt (id TEXT, ownerId TEXT, counterparty TEXT);
      CREATE TABLE Asset (id TEXT, ownerId TEXT, name TEXT); CREATE TABLE InvestmentHolding (id TEXT, ownerId TEXT, name TEXT);
      INSERT INTO Account VALUES ('bank','u1','Bank','PKR');
      CREATE INDEX Transaction_owner_date_id_idx ON "Transaction"(ownerId,date DESC,id DESC);`);
    const insert = database.prepare('INSERT INTO "Transaction" VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    for (let index = 0; index < 1200; index += 1) {
      insert.run(`row-${String(index).padStart(4, '0')}`, 'u1', '2026-10-23T10:00:00.000Z', 'Expense', 'bank', null, 'food', 'food', `item ${index}`, '', null, null);
    }
    insert.run('foreign', 'u2', '2026-10-23T10:00:00.000Z', 'Expense', 'bank', null, 'food', 'food', 'item', '', null, null);
    const collected = [];
    let cursor;
    while (true) {
      const page = buildFilteredTransactionPredicate({ ownerId: 'u1', take: 37, cursor });
      const rows = database.prepare(`SELECT t.id,t.date FROM "Transaction" t LEFT JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId
        LEFT JOIN Account destination ON destination.id=t.toAccountId AND destination.ownerId=t.ownerId
        LEFT JOIN "Transaction" linked ON linked.id=COALESCE(t.reversalOfId,t.correctionOfId) AND linked.ownerId=t.ownerId
        LEFT JOIN Bill bill ON 1=0 LEFT JOIN Debt debt ON 1=0 LEFT JOIN Asset asset ON 1=0 LEFT JOIN InvestmentHolding holding ON 1=0
        WHERE ${page.whereSql} ORDER BY ${page.orderSql}${page.limitSql}`).all(...page.params).map((row) => ({ ...row }));
      if (!rows.length) break;
      collected.push(...rows.map((row) => row.id));
      const last = rows.at(-1);
      cursor = { date: last.date, id: last.id };
    }
    assert.equal(collected.length, 1200);
    assert.equal(new Set(collected).size, 1200);
    assert.equal(collected.includes('foreign'), false);
  } finally { database.close(); }
});

test('the production transaction-list SQL reads linked originals, account labels, refund totals, and specialized names', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE "Transaction" (id TEXT, ownerId TEXT, amountMinor INTEGER, type TEXT, categoryId TEXT, classificationId TEXT, accountId TEXT, toAccountId TEXT, date TEXT, note TEXT, sourceName TEXT, paymentMethod TEXT, sourceAmountMinor INTEGER, sourceCurrency TEXT, exchangeRate TEXT, referenceNumber TEXT, taxStatus TEXT, taxYear INTEGER, synced INTEGER, reversalOfId TEXT, correctionOfId TEXT);
      CREATE TABLE Account (id TEXT, ownerId TEXT, name TEXT, currency TEXT);
      CREATE TABLE BillPayment (ownerId TEXT, transactionId TEXT, billId TEXT); CREATE TABLE Bill (id TEXT, ownerId TEXT, name TEXT);
      CREATE TABLE DebtEvent (ownerId TEXT, transactionId TEXT, debtId TEXT); CREATE TABLE Debt (id TEXT, ownerId TEXT, counterparty TEXT);
      CREATE TABLE AssetActivity (ownerId TEXT, transactionId TEXT, assetId TEXT); CREATE TABLE Asset (id TEXT, ownerId TEXT, name TEXT);
      CREATE TABLE InvestmentEvent (ownerId TEXT, transactionId TEXT, holdingId TEXT); CREATE TABLE InvestmentHolding (id TEXT, ownerId TEXT, name TEXT);
      INSERT INTO Account VALUES ('bank','u1','Primary Bank','PKR');
      INSERT INTO "Transaction" VALUES ('expense','u1',1000,'Expense','Food','food','bank',NULL,'2026-10-23T10:00:00.000Z','Lunch',NULL,NULL,NULL,NULL,NULL,NULL,'unreviewed',NULL,0,NULL,NULL),
        ('refund','u1',200,'Refund','Expense refund','expense_refund','bank',NULL,'2026-10-24T10:00:00.000Z','Returned item',NULL,NULL,NULL,NULL,NULL,NULL,'unreviewed',NULL,0,'expense',NULL),
        ('foreign','u2',500,'Expense','Food','food','bank',NULL,'2026-10-24T10:00:00.000Z','Other profile',NULL,NULL,NULL,NULL,NULL,NULL,'unreviewed',NULL,0,NULL,NULL);
      INSERT INTO Bill VALUES ('bill-1','u1','Phone bill'); INSERT INTO BillPayment VALUES ('u1','bill-expense','bill-1');
      INSERT INTO "Transaction" VALUES ('bill-expense','u1',300,'Expense','Bills','bills','bank',NULL,'2026-10-22T10:00:00.000Z','Payment',NULL,NULL,NULL,NULL,NULL,NULL,'unreviewed',NULL,0,NULL,NULL);`);
    const query = buildTransactionListQuery({ ownerId: 'u1', limit: 10 });
    const rows = database.prepare(query.sql).all(...query.params).map((row) => ({ ...row }));
    const expense = rows.find((row) => row.id === 'expense');
    const refund = rows.find((row) => row.id === 'refund');
    const bill = rows.find((row) => row.id === 'bill-expense');
    assert.equal(rows.length, 3);
    assert.equal(expense.accountName, 'Primary Bank');
    assert.equal(expense.refundedMinor, 200);
    assert.equal(refund.linkedOriginalId, 'expense');
    assert.equal(refund.linkedOriginalType, 'Expense');
    assert.equal(refund.linkedOriginalCategory, 'Food');
    assert.equal(bill.specializedContext, 'Bill · Phone bill');
  } finally { database.close(); }
});
