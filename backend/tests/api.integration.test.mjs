import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pg = await PGlite.create({ extensions: { pgcrypto } });
await pg.exec(`CREATE ROLE anonymous; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA neon_auth;
  CREATE FUNCTION auth.user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.neon_user_id',true),'') $$;
  CREATE TABLE neon_auth."user" (id text PRIMARY KEY,email text,name text);`);
const migrationRoot = resolve(project, 'prisma/migrations');
const migrationDirectories = (await readdir(migrationRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
for (const directory of migrationDirectories) {
  await pg.exec(await readFile(resolve(migrationRoot, directory, 'migration.sql'), 'utf8'));
}
const probe = createServer();
await new Promise((done) => probe.listen(0, '127.0.0.1', done));
const address = probe.address();
if (!address || typeof address === 'string') throw new Error('Could not allocate isolated Postgres test port.');
await new Promise((done, fail) => probe.close((error) => error ? fail(error) : done()));
const pgServer = new PGLiteSocketServer({ db: pg, port: address.port, host: '127.0.0.1' });
await pgServer.start();

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = `postgresql://test:test@127.0.0.1:${address.port}/postgres?sslmode=disable`;
process.env.BETTER_AUTH_SECRET = 'test-only-secret-never-used-outside-the-isolated-test-suite';
process.env.BETTER_AUTH_URL = 'http://localhost:3001';
process.env.ALLOWED_ORIGINS = 'http://localhost:3001';

const [{ app }, { prisma }] = await Promise.all([import('../src/app.ts'), import('../src/db.ts')]);
const { createPrismaAISettingsStore } = await import('../src/aiGatewayStore.ts');
const { encryptAICredential } = await import('../src/aiCredentialVault.ts');
const { createAIGateway } = await import('../src/aiGateway.ts');

async function signUp(email, name, origin = 'http://localhost:3001') {
  const response = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email, name, password: 'Test-password-strong-2026!' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  assert.ok(cookies.includes('better-auth.session_token='), `expected session cookie, got ${cookies}`);
  return { cookies, user: body.user };
}

async function api(path, { cookies, ...options } = {}) {
  return app.request(path, {
    ...options,
    headers: { origin: 'http://localhost:3001', ...(cookies ? { cookie: cookies } : {}), ...options?.headers },
  });
}

test('cloud API uses persistent identity, derives ownership from sessions, and deduplicates financial posts', async () => {
  const first = await signUp('Aliyan@example.com', 'Aliyan');
  const second = await signUp('second@example.com', 'Second');
  assert.equal(first.user.email, 'aliyan@example.com');

  const unauthorized = await api('/api/v1/finance/accounts');
  assert.equal(unauthorized.status, 401);

  const accountRequest = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'account-create-aliyan-01' },
    body: JSON.stringify({ id: '15f6ee5a-2c4a-4c5d-b6ce-c46269a171e2', name: 'Main bank', type: 'bank', currency: 'PKR', openingBalanceMinor: '0' }),
  };
  const accountResponse = await api('/api/v1/finance/accounts', { cookies: first.cookies, ...accountRequest });
  assert.equal(accountResponse.status, 201);
  const account = (await accountResponse.json()).data;
  assert.equal(account.id, '15f6ee5a-2c4a-4c5d-b6ce-c46269a171e2');

  const updateRequest = { method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': 'account-update-aliyan-01' },
    body: JSON.stringify({ expectedRevision: 1, name: 'Main current account' }) };
  const updated = await api(`/api/v1/finance/accounts/${account.id}`, { cookies: first.cookies, ...updateRequest });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.revision, 2);
  const staleUpdate = await api(`/api/v1/finance/accounts/${account.id}`, { cookies: first.cookies, method: 'PATCH',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'account-update-stale-01' },
    body: JSON.stringify({ expectedRevision: 1, name: 'Stale name' }) });
  assert.equal(staleUpdate.status, 409);

  const usdAccountResponse = await api('/api/v1/finance/accounts', { cookies: first.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'account-create-usd-01' },
    body: JSON.stringify({ name: 'Dollar cash', type: 'cash', currency: 'USD' }) });
  assert.equal(usdAccountResponse.status, 201);
  const usdAccount = (await usdAccountResponse.json()).data;

  const transaction = {
    id: 'd3c9e1e0-1548-4eac-b4e8-8be3d9e7c90b',
    type: 'expense', amountMinor: '25000', currency: 'PKR', classificationId: 'food', categoryLabel: 'Food',
    accountId: account.id, occurredAt: '2026-10-24T08:30:00.000Z', taxStatus: 'unreviewed', paymentMethod: 'Card',
  };
  const post = () => api('/api/v1/finance/transactions', { cookies: first.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'expense-001-aliyan' }, body: JSON.stringify(transaction) });
  const accepted = await post();
  assert.equal(accepted.status, 201);
  const acceptedRecord = (await accepted.json()).data;
  assert.equal(acceptedRecord.id, transaction.id);
  assert.equal(acceptedRecord.paymentMethod, 'Card');
  const repeated = await post();
  assert.equal(repeated.status, 201);
  assert.equal((await repeated.json()).data.id, acceptedRecord.id);

  const mixedCurrencyTransfer = await api('/api/v1/finance/transactions', { cookies: first.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'mixed-currency-transfer' },
    body: JSON.stringify({ ...transaction, type: 'transfer', classificationId: 'internal_transfer', toAccountId: usdAccount.id, occurredAt: '2026-10-24T08:32:00.000Z' }) });
  assert.equal(mixedCurrencyTransfer.status, 409);

  const reusedKey = await api('/api/v1/finance/transactions', { cookies: first.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'expense-001-aliyan' },
    body: JSON.stringify({ ...transaction, amountMinor: '26000' }) });
  assert.equal(reusedKey.status, 409);

  const refund = {
    id: '5b9364e7-4236-4c28-835a-1773bd6e3d06', type: 'refund', amountMinor: '5000', currency: 'PKR',
    classificationId: 'expense_refund', categoryLabel: 'Expense refund', accountId: account.id,
    refundOfId: transaction.id, occurredAt: '2026-10-24T08:33:00.000Z', taxStatus: 'unreviewed',
  };
  const postRefund = () => api('/api/v1/finance/transactions', { cookies: first.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'refund-expense-001' }, body: JSON.stringify(refund) });
  const refunded = await postRefund();
  assert.equal(refunded.status, 201, JSON.stringify(await refunded.clone().json()));
  assert.equal((await refunded.json()).data.refundOfId, transaction.id);
  assert.equal((await postRefund()).status, 201);
  const excessRefund = await api('/api/v1/finance/transactions', { cookies: first.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'refund-expense-excess' },
    body: JSON.stringify({ ...refund, id: '1e67c871-a826-4d83-b1be-0f7148242f4d', amountMinor: '20001' }) });
  assert.equal(excessRefund.status, 409);
  assert.equal((await excessRefund.json()).error.code, 'REFUND_EXCEEDS_EXPENSE');

  const crossUser = await api('/api/v1/finance/transactions', { cookies: second.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'cross-user-transaction' },
    body: JSON.stringify({ ...transaction, occurredAt: '2026-10-24T08:31:00.000Z' }) });
  assert.equal(crossUser.status, 409);

  const history = await api('/api/v1/finance/transactions', { cookies: first.cookies });
  const result = await history.json();
  assert.equal(result.data.length, 2);
  assert.deepEqual(new Set(result.data.map((row) => row.id)), new Set([acceptedRecord.id, refund.id]));
  const firstChanges = await api('/api/v1/sync/changes?after=0&limit=2', { cookies: first.cookies });
  const changePage = await firstChanges.json();
  assert.equal(firstChanges.status, 200);
  assert.equal(changePage.data.length, 2);
  assert.equal(changePage.hasMore, true);
  assert.equal(changePage.nextCursor, '2');
  assert.deepEqual(changePage.data.map((row) => row.sequence), ['1', '2']);
  const otherUserChanges = await api('/api/v1/sync/changes?after=0', { cookies: second.cookies });
  assert.deepEqual((await otherUserChanges.json()).data, []);
  const archived = await api(`/api/v1/finance/accounts/${account.id}/archive`, { cookies: first.cookies, method: 'POST',
    headers: { 'idempotency-key': 'archive-main-account-01' } });
  assert.equal(archived.status, 200);
  assert.ok((await archived.json()).data.archivedAt);
  const secondChanges = await api('/api/v1/sync/changes?after=2&limit=2', { cookies: first.cookies });
  const secondPage = await secondChanges.json();
  assert.deepEqual(secondPage.data.map((row) => row.sequence), ['3', '4']);
  assert.equal(secondPage.nextCursor,'4');
  assert.equal(secondPage.hasMore,true);
  const finalChanges = await api('/api/v1/sync/changes?after=4&limit=2', { cookies: first.cookies });
  const finalPage = await finalChanges.json();
  assert.deepEqual(finalPage.data.map((row) => row.sequence), ['5','6']);
  assert.equal(finalPage.nextCursor,'6');
  assert.equal(finalPage.hasMore,false);
  assert.equal(await prisma.mutationReceipt.count({ where: { userId: first.user.id } }), 6);
  assert.equal(await prisma.changeLog.count({ where: { userId: first.user.id } }), 6);
});

test('AI settings, monthly usage limits, and request leases persist per Neon subject', async () => {
  const store = createPrismaAISettingsStore(prisma);
  const settings = {
    model: 'gpt-6-luna', enabled: false,
    permissions: { aggregatedFinancialInsights: true, detailedFinancialRecords: false, projectsIntelligence: false },
    consentAcceptedAt: new Date().toISOString(), credentialForwardingConsentAcceptedAt: new Date().toISOString(),
    connectionStatus: 'connected', lastValidatedAt: new Date().toISOString(), monthlyRequestLimit: 30,
  };
  await store.saveSettings('neon-subject-ai-test', settings);
  assert.deepEqual(await store.getSettings('neon-subject-ai-test'), settings);
  assert.equal(await store.getSettings('different-neon-subject'), null);
  assert.equal(await store.consumeMonthlyRequest('neon-subject-ai-test', '2026-10', 1), true);
  assert.equal(await store.consumeMonthlyRequest('neon-subject-ai-test', '2026-10', 1), false);
  assert.equal(await store.getMonthlyRequestCount('neon-subject-ai-test', '2026-10'), 1);
  const lease = await store.tryAcquireConnectionTest('neon-subject-ai-test');
  assert.ok(lease);
  assert.equal(await store.tryAcquireConnectionTest('neon-subject-ai-test'), null);
  await store.releaseConnectionTest('neon-subject-ai-test', lease);
  assert.ok(await store.tryAcquireConnectionTest('neon-subject-ai-test'));
  const rawCredential = `sk-proj-${'x'.repeat(40)}`;
  const encryptedCredential = encryptAICredential('neon-subject-ai-test', rawCredential, 'ab'.repeat(32));
  await store.saveCredential('neon-subject-ai-test', encryptedCredential);
  assert.equal(await store.hasCredential('neon-subject-ai-test'), true);
  assert.equal(await store.getCredential('neon-subject-ai-test'), encryptedCredential);
  const storedCredential = await prisma.aiUserSetting.findUnique({ where: { userId: 'neon-subject-ai-test' }, select: { credentialCiphertext: true } });
  assert.notEqual(storedCredential.credentialCiphertext, rawCredential);
  assert.equal(JSON.stringify(storedCredential).includes(rawCredential), false);
  await store.deleteCredential('neon-subject-ai-test');
  assert.equal(await store.hasCredential('neon-subject-ai-test'), false);
});

test('AI credential workflow encrypts in the database and tests the provider through the authenticated gateway', async () => {
  const userId = 'neon-subject-ai-vault-integration';
  const rawCredential = `sk-proj-${'z'.repeat(40)}`;
  let providerAuthorization;
  const store = createPrismaAISettingsStore(prisma);
  const gateway = createAIGateway({
    store,
    verifyNeonToken: async (token) => token === 'valid-neon-token-1234567890' ? userId : Promise.reject(new Error('invalid token')),
    credentialEncryptionKey: 'cd'.repeat(32),
    providerFetch: async (_url, init) => {
      providerAuthorization = new Headers(init.headers).get('Authorization');
      return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] });
    },
    now: () => new Date('2026-10-30T12:00:00.000Z'),
  });
  const headers = { Authorization: 'Bearer valid-neon-token-1234567890', 'Content-Type': 'application/json' };
  const settingsInput = { model: 'gpt-6-luna', enabled: false,
    permissions: { aggregatedFinancialInsights: true, detailedFinancialRecords: false, projectsIntelligence: false },
    dataConsentAccepted: true, credentialForwardingConsentAccepted: true, monthlyRequestLimit: 30 };

  assert.equal((await gateway.request('/settings')).status, 401);
  await gateway.request('/settings', { method: 'PUT', headers, body: JSON.stringify(settingsInput) });
  const saved = await gateway.request('/credential', { method: 'PUT', headers, body: JSON.stringify({ apiKey: rawCredential }) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).data.hasCredential, true);
  const row = await prisma.aiUserSetting.findUnique({ where: { userId }, select: { credentialCiphertext: true } });
  assert.ok(row.credentialCiphertext);
  assert.notEqual(row.credentialCiphertext, rawCredential);

  const tested = await gateway.request('/connection-test', { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-6-luna' }) });
  const testResult = await tested.json();
  assert.equal(tested.status, 200);
  assert.equal(providerAuthorization, `Bearer ${rawCredential}`);
  assert.equal(JSON.stringify(testResult).includes(rawCredential), false);
  assert.equal(testResult.data.connectionStatus, 'connected');

  const enabled = await gateway.request('/settings', { method: 'PUT', headers, body: JSON.stringify({ ...settingsInput, enabled: true }) });
  assert.equal((await enabled.json()).data.enabled, true);
  const removed = await gateway.request('/credential', { method: 'DELETE', headers });
  assert.equal((await removed.json()).data.hasCredential, false);
  assert.equal(await store.getCredential(userId), null);
});

test('cloud corrections append an exact reversal then one replacement without mutating posted history', async () => {
  await prisma.rateLimit.deleteMany();
  const owner = await signUp('correction-owner@example.com', 'Correction Owner');
  const accountId = 'ddc6f665-a1fc-40df-99d2-c3c07b4078d1';
  const accountResponse = await api('/api/v1/finance/accounts', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'correction-account-create-01' },
    body: JSON.stringify({ id: accountId, name: 'Correction account', type: 'bank', currency: 'PKR', openingBalanceMinor: '100000' }) });
  assert.equal(accountResponse.status, 201);

  const originalId = '8bb5b7a3-b359-4716-8229-c1be7260782a';
  const original = { id: originalId, type: 'expense', amountMinor: '25000', currency: 'PKR', classificationId: 'food', categoryLabel: 'Food',
    accountId, occurredAt: '2026-10-24T08:00:00.000Z', note: 'Original entry', taxStatus: 'unreviewed' };
  const posted = await api('/api/v1/finance/transactions', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'correction-original-expense-01' }, body: JSON.stringify(original) });
  assert.equal(posted.status, 201);

  const replacementId = 'ad84db08-cd57-45bf-9e8a-80074a3e2e48';
  const reversalId = `correction:${replacementId}:reversal`;
  const replacement = { id: replacementId, type: 'expense', amountMinor: '30000', currency: 'PKR', classificationId: 'housing', categoryLabel: 'Housing',
    accountId, occurredAt: '2026-10-24T08:05:00.000Z', note: 'Corrected entry', taxStatus: 'unreviewed', correctionOfId: originalId };
  const premature = await api('/api/v1/finance/transactions', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'correction-before-reversal' }, body: JSON.stringify(replacement) });
  assert.equal(premature.status, 409);
  assert.equal((await premature.json()).error.code, 'CORRECTION_REVERSAL_REQUIRED');

  const reversal = { id: reversalId, type: 'reversal', amountMinor: original.amountMinor, currency: original.currency,
    classificationId: 'correction_reversal', categoryLabel: 'Correction reversal', accountId, occurredAt: '2026-10-24T08:04:00.000Z',
    note: `Correction reversal for ${originalId}`, reversalOfId: originalId };
  const postReversal = () => api('/api/v1/finance/transactions', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'correction-reversal-mutation-01' }, body: JSON.stringify(reversal) });
  const reversed = await postReversal();
  assert.equal(reversed.status, 201, JSON.stringify(await reversed.clone().json()));
  assert.equal((await reversed.json()).data.reversalOfId, originalId);
  assert.equal((await postReversal()).status, 201);

  const postReplacement = () => api('/api/v1/finance/transactions', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'correction-replacement-mutation-01' }, body: JSON.stringify(replacement) });
  const corrected = await postReplacement();
  assert.equal(corrected.status, 201, JSON.stringify(await corrected.clone().json()));
  assert.equal((await corrected.json()).data.correctionOfId, originalId);
  assert.equal((await postReplacement()).status, 201);

  const transactions = await prisma.financeTransaction.findMany({ where: { userId: owner.user.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(transactions.length, 3);
  assert.equal(transactions[0].amountMinor, 25000n);
  assert.equal(transactions[1].type, 'reversal');
  assert.equal(transactions[1].amountMinor, 25000n);
  assert.equal(transactions[2].amountMinor, 30000n);
  assert.equal(transactions[0].note, 'Original entry', 'posted original remains unchanged');
  assert.deepEqual((await prisma.changeLog.findMany({ where: { userId: owner.user.id, entityType: 'transaction' } })).map((row) => row.revision), [1,1,1]);
  await assert.rejects(() => pg.query(`INSERT INTO "FinanceTransaction"
    (id,"userId","amountMinor",currency,type,"classificationId","categoryLabel","accountId","occurredAt","refundOfId")
    VALUES($1,$2,100,$3,'refund','expense_refund','Expense refund',$4,NOW(),$5)`,
    ['forbidden-refund-after-correction',owner.user.id,'PKR',accountId,originalId]), /corrected expense/);
});

test('database constraints enforce immutable posted history and valid transfer shape', async () => {
  const original = await pg.query('SELECT id, "userId" FROM "FinanceTransaction" LIMIT 1');
  const row = original.rows[0];
  assert.ok(row);
  await assert.rejects(() => pg.query('UPDATE "FinanceTransaction" SET "amountMinor" = 1 WHERE id = $1 AND "userId" = $2', [row.id, row.userId]), /append-only/);
  await assert.rejects(() => pg.query('DELETE FROM "FinanceTransaction" WHERE id = $1 AND "userId" = $2', [row.id, row.userId]), /append-only/);
  const expense = await pg.query('SELECT t.id,t."userId",t."accountId",t.currency FROM "FinanceTransaction" t WHERE t.type = $1 LIMIT 1', ['expense']);
  const originalExpense = expense.rows[0];
  assert.ok(originalExpense);
  const activeAccountId = '4d90cd1b-c2a3-4fd3-a72b-32d9137cbd8a';
  await pg.query('INSERT INTO "FinanceAccount"(id,"userId",name,type,currency,"openingBalanceMinor","updatedAt") VALUES($1,$2,$3,$4,$5,0,NOW())',
    [activeAccountId,originalExpense.userId,'Active refund account','bank',originalExpense.currency]);
  await assert.rejects(() => pg.query(`INSERT INTO "FinanceTransaction"
    (id,"userId","amountMinor",currency,type,"classificationId","categoryLabel","accountId","occurredAt","refundOfId")
    VALUES($1,$2,25001,$3,'refund','expense_refund','Expense refund',$4,NOW(),$5)`,
    ['15d9c9e1-3270-44b4-a392-d2a4da5c41b2',originalExpense.userId,originalExpense.currency,activeAccountId,originalExpense.id]), /refund exceeds/);
});

test('budget revisions retain history and report category spending net of partial refunds', async () => {
  const owner = await signUp('budget-owner@example.com', 'Budget Owner');
  const other = await signUp('budget-other@example.com', 'Other Owner');
  const accountResponse = await api('/api/v1/finance/accounts', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'budget-account-create-01' },
    body: JSON.stringify({ name: 'Budget account', type: 'bank', currency: 'PKR' }) });
  assert.equal(accountResponse.status, 201);
  const accountId = (await accountResponse.json()).data.id;
  const expenseResponse = await api('/api/v1/finance/transactions', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'budget-expense-create-01' },
    body: JSON.stringify({ type: 'expense', amountMinor: '10000', currency: 'PKR', classificationId: 'food', categoryLabel: 'Food',
      accountId, occurredAt: '2026-10-12T09:00:00.000Z' }) });
  assert.equal(expenseResponse.status, 201);
  const expenseId = (await expenseResponse.json()).data.id;
  const refundResponse = await api('/api/v1/finance/transactions', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'budget-refund-create-01' },
    body: JSON.stringify({ type: 'refund', amountMinor: '2500', currency: 'PKR', classificationId: 'expense_refund', categoryLabel: 'Refund',
      accountId, refundOfId: expenseId, occurredAt: '2026-10-13T09:00:00.000Z' }) });
  assert.equal(refundResponse.status, 201);

  const budgetInput = { categoryId: 'food', amountMinor: '20000', currency: 'PKR', periodStart: '2026-10-01', periodEnd: '2026-11-01', rolloverPolicy: 'reset' };
  const create = () => api('/api/v1/finance/budgets', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'budget-food-create-01' }, body: JSON.stringify(budgetInput) });
  const created = await create();
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
  const budget = (await created.json()).data;
  assert.equal(budget.revision, 1);
  assert.equal(budget.amountMinor, '20000');
  assert.equal((await create()).status, 201);
  const reusedKey = await api('/api/v1/finance/budgets', { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'budget-food-create-01' },
    body: JSON.stringify({ ...budgetInput, amountMinor: '30000' }) });
  assert.equal(reusedKey.status, 409);

  const list = await api('/api/v1/finance/budgets', { cookies: owner.cookies });
  assert.equal(list.status, 200);
  const current = (await list.json()).data;
  assert.equal(current.length, 1);
  assert.equal(current[0].spentMinor, '7500');
  assert.equal((await (await api('/api/v1/finance/budgets', { cookies: other.cookies })).json()).data.length, 0);

  const revisionInput = { ...budgetInput, amountMinor: '30000', expectedRevision: 1 };
  const revised = await api(`/api/v1/finance/budgets/${budget.id}/revisions`, { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'budget-food-revision-01' }, body: JSON.stringify(revisionInput) });
  assert.equal(revised.status, 201, JSON.stringify(await revised.clone().json()));
  const next = (await revised.json()).data;
  assert.equal(next.revision, 2);
  assert.equal(next.supersedesId, budget.id);
  const afterRevision = (await (await api('/api/v1/finance/budgets', { cookies: owner.cookies })).json()).data;
  assert.equal(afterRevision.length, 1);
  assert.equal(afterRevision[0].id, next.id);
  assert.equal(afterRevision[0].spentMinor, '7500');
  const stale = await api(`/api/v1/finance/budgets/${budget.id}/revisions`, { cookies: owner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'budget-food-revision-stale' }, body: JSON.stringify(revisionInput) });
  assert.equal(stale.status, 404);
  const archive = () => api(`/api/v1/finance/budgets/${next.id}/archive`, { cookies: owner.cookies, method: 'POST',
    headers: { 'idempotency-key': 'budget-food-archive-01' } });
  const archived = await archive();
  assert.equal(archived.status, 200);
  assert.ok((await archived.json()).data.archivedAt);
  assert.equal((await archive()).status, 200);
  assert.equal((await (await api('/api/v1/finance/budgets', { cookies: owner.cookies })).json()).data.length, 0);
  await assert.rejects(() => pg.query('UPDATE "Budget" SET "amountMinor"=1 WHERE id=$1 AND "userId"=$2', [next.id,owner.user.id]), /budget revisions are immutable/);
  await assert.rejects(() => pg.query('DELETE FROM "Budget" WHERE id=$1 AND "userId"=$2', [next.id,owner.user.id]), /append-only/);
  const changes = (await (await api('/api/v1/sync/changes?after=0&limit=100', { cookies: owner.cookies })).json()).data;
  const budgetChanges = changes.filter((change) => change.entityType === 'budget');
  assert.deepEqual(budgetChanges.map((change) => change.revision), [1,2,3]);
  assert.deepEqual(budgetChanges.map((change) => change.entityId), [budget.id,next.id,next.id]);
});

test('Better Auth restores a cookie session and revokes it on logout', async () => {
  await signUp('session@example.test', 'Session Test','houselog://');
  const login = await api('/api/auth/sign-in/email', {
    method: 'POST', headers: { origin:'houselog://','content-type': 'application/json' },
    body: JSON.stringify({ email: 'session@example.test', password: 'Test-password-strong-2026!' }),
  });
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  assert.ok(cookies.includes('better-auth.session_token='));
  const restored = await api('/api/auth/get-session', { cookies,headers:{origin:'houselog://'} });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).user.email, 'session@example.test');
  assert.equal((await api('/api/v1/sync/identity', { cookies,headers:{origin:'houselog://'} })).status, 200);
  const logout = await api('/api/auth/sign-out', { cookies, method: 'POST',headers:{origin:'houselog://'} });
  assert.equal(logout.status, 200);
  assert.equal((await api('/api/v1/sync/identity', { cookies,headers:{origin:'houselog://'} })).status, 401);
});

test.after(async () => {
  await prisma.$disconnect();
  await pgServer.stop();
  await pg.close();
});

test('savings and emergency-fund mutations preserve reservations, cash links, idempotency, and change history', async () => {
  await prisma.rateLimit.deleteMany();
  const accountOwner = await signUp('savings-owner@example.com', 'Savings Owner');
  const otherOwner = await signUp('other-savings@example.com', 'Other Owner');
  const createAccount = async (id, name, openingBalanceMinor) => {
    const response = await api('/api/v1/finance/accounts', { cookies: accountOwner.cookies, method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `account-${id}-create` },
      body: JSON.stringify({ id, name, type: 'bank', currency: 'PKR', openingBalanceMinor }) });
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    return response.json();
  };
  const operatingId = 'b19a2c86-35cb-4d63-bf15-a92c14fa2b44';
  const savingsId = 'ebbe8f32-8e2c-4ab6-a066-3f985f23c8b1';
  await createAccount(operatingId, 'Operating', '200000');
  await createAccount(savingsId, 'Reserve', '0');

  const goalId = 'd8eb0468-4537-4cd7-862e-74cf1a4cf09b';
  const goalPayload = { id: goalId, name: 'Emergency cushion', targetMinor: '80000', currency: 'PKR', targetDate: '2027-01-01' };
  const createGoal = () => api('/api/v1/finance/savings/goals', { cookies: accountOwner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'saving-goal-create-0001' }, body: JSON.stringify(goalPayload) });
  const createdGoal = await createGoal();
  assert.equal(createdGoal.status, 201, JSON.stringify(await createdGoal.clone().json()));
  assert.equal((await createGoal()).status, 201);

  const allocation = { id: '4f26f71e-59ca-4bc5-a861-68b40adf778e', eventType: 'allocate', amountMinor: '50000', currency: 'PKR', accountId: operatingId, eventDate: '2026-10-24T09:00:00.000Z', note: 'Earmark only' };
  const allocate = () => api(`/api/v1/finance/savings/goals/${goalId}/events`, { cookies: accountOwner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'saving-event-allocate-0001' }, body: JSON.stringify(allocation) });
  const allocated = await allocate();
  assert.equal(allocated.status, 201, JSON.stringify(await allocated.clone().json()));
  assert.equal((await allocate()).status, 201);
  assert.equal(await prisma.financeTransaction.count({ where: { userId: accountOwner.user.id } }), 0, 'an earmark is not cash movement');

  const excess = await api(`/api/v1/finance/savings/goals/${goalId}/events`, { cookies: accountOwner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'saving-event-excess-0001' },
    body: JSON.stringify({ ...allocation, id: 'd09c571e-d33b-4d17-bcc3-da631f31e747', amountMinor: '200001' }) });
  assert.equal(excess.status, 409);
  assert.equal((await excess.json()).error.code, 'INSUFFICIENT_UNRESERVED_FUNDS');

  const transferEvent = { id: 'e7d6867a-81e6-42ab-9669-ae1e8d54b15c', eventType: 'transfer_in', amountMinor: '30000', currency: 'PKR', sourceAccountId: operatingId, destinationAccountId: savingsId, eventDate: '2026-10-24T10:00:00.000Z', note: 'Move reserved savings' };
  const transferResponse = await api(`/api/v1/finance/savings/goals/${goalId}/events`, { cookies: accountOwner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'saving-event-transfer-0001' }, body: JSON.stringify(transferEvent) });
  assert.equal(transferResponse.status, 201, JSON.stringify(await transferResponse.clone().json()));
  const transferRecord = (await transferResponse.json()).data;
  assert.equal(transferRecord.transactionId, `fund-transfer:${transferEvent.id}`);
  assert.equal(await prisma.financeTransaction.count({ where: { userId: accountOwner.user.id, type: 'transfer' } }), 1);

  const config = { currency: 'PKR', coverageMonths: 3, essentialMonthlyMinor: '25000' };
  const configResponse = await api('/api/v1/finance/emergency-fund/config', { cookies: accountOwner.cookies, method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'emergency-config-save-0001' }, body: JSON.stringify(config) });
  assert.equal(configResponse.status, 200, JSON.stringify(await configResponse.clone().json()));
  const emergency = { id: 'f084c399-6c52-4f60-97d1-308eb5d1316c', eventType: 'allocate', amountMinor: '100000', currency: 'PKR', accountId: operatingId, eventDate: '2026-10-24T11:00:00.000Z', note: 'Emergency reserve' };
  const emergencyResponse = await api('/api/v1/finance/emergency-fund/events', { cookies: accountOwner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'emergency-event-allocate-0001' }, body: JSON.stringify(emergency) });
  assert.equal(emergencyResponse.status, 201, JSON.stringify(await emergencyResponse.clone().json()));
  assert.equal((await api('/api/v1/finance/emergency-fund/config', { cookies: accountOwner.cookies })).status, 200);
  const crossProfile = await api(`/api/v1/finance/savings/goals/${goalId}/events`, { cookies: otherOwner.cookies, method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'cross-profile-savings-0001' }, body: JSON.stringify(allocation) });
  assert.equal(crossProfile.status, 404);
  assert.equal(await prisma.savingsGoalEvent.count({ where: { userId: accountOwner.user.id } }), 2);
  assert.equal(await prisma.emergencyFundEvent.count({ where: { userId: accountOwner.user.id } }), 1);
  assert.equal(await prisma.changeLog.count({ where: { userId: accountOwner.user.id, entityType: { in: ['savings_goal','savings_goal_event','emergency_config','emergency_event','transaction'] } } }), 6);
});

test('recurring schedules and occurrences are profile-scoped, idempotent, linked, and change-fed', async () => {
  const owner = await signUp('schedule-owner@example.com', 'Schedule Owner');
  const stranger = await signUp('schedule-stranger@example.com', 'Schedule Stranger');
  const accountId = '5c0bb9f1-7780-4857-aad2-52f16a3c6d1c';
  const accountResponse = await api('/api/v1/finance/accounts', { cookies: owner.cookies, method:'POST',
    headers:{ 'content-type':'application/json','idempotency-key':'schedule-account-create-001' },
    body:JSON.stringify({ id:accountId,name:'Schedule account',type:'bank',currency:'PKR',openingBalanceMinor:'10000' }) });
  assert.equal(accountResponse.status,201);

  const schedule = { id:'recurring-food-001',scheduleType:'expense',name:'Weekly groceries',amountMinor:'500',currency:'PKR',classificationId:'food',accountId,
    frequency:'weekly',startDate:'2026-10-24',endDate:null,nextDueDate:'2026-10-24',status:'active',createdAt:'2026-10-24T00:00:00.000Z',updatedAt:'2026-10-24T00:00:00.000Z' };
  const createSchedule = () => api('/api/v1/finance/recurring-schedules', { cookies:owner.cookies,method:'POST',
    headers:{ 'content-type':'application/json','idempotency-key':'recurring-schedule-create-001' },body:JSON.stringify(schedule) });
  const created = await createSchedule();
  assert.equal(created.status,201,JSON.stringify(await created.clone().json()));
  const createdData = (await created.json()).data;
  assert.equal(createdData.amountMinor,'500');
  assert.equal(createdData.revision,1);
  assert.equal((await createSchedule()).status,201);

  const stolen = await api('/api/v1/finance/recurring-schedules', { cookies:stranger.cookies,method:'POST',
    headers:{ 'content-type':'application/json','idempotency-key':'recurring-schedule-cross-001' },body:JSON.stringify({...schedule,id:'another-profile-schedule'}) });
  assert.equal(stolen.status,409);

  const transactionId = '77031035-4e8e-4e87-91f1-1d46a61e6c60';
  const transaction = await api('/api/v1/finance/transactions', { cookies:owner.cookies,method:'POST',
    headers:{ 'content-type':'application/json','idempotency-key':'schedule-expense-transaction-001' },
    body:JSON.stringify({ id:transactionId,type:'expense',amountMinor:'500',currency:'PKR',classificationId:'food',categoryLabel:'Food',accountId,
      occurredAt:'2026-10-24T10:00:00.000Z',taxStatus:'unreviewed' }) });
  assert.equal(transaction.status,201,JSON.stringify(await transaction.clone().json()));

  const occurrenceId = 'recurring-food-001:2026-10-24';
  const occurrenceResponse = await api('/api/v1/finance/recurring-schedules/recurring-food-001/occurrences', { cookies:owner.cookies,method:'POST',
    headers:{ 'content-type':'application/json','idempotency-key':'schedule-occurrence-create-001' },
    body:JSON.stringify({ id:occurrenceId,occurrenceDate:'2026-10-24',status:'pending',createdAt:'2026-10-24T00:00:00.000Z' }) });
  assert.equal(occurrenceResponse.status,201,JSON.stringify(await occurrenceResponse.clone().json()));
  assert.equal((await occurrenceResponse.json()).data.status,'pending');

  const resolved = await api(`/api/v1/finance/recurring-schedules/recurring-food-001/occurrences/${encodeURIComponent(occurrenceId)}`, { cookies:owner.cookies,method:'PUT',
    headers:{ 'content-type':'application/json','idempotency-key':'schedule-occurrence-resolve-001' },
    body:JSON.stringify({ status:'posted',transactionId,resolvedAt:'2026-10-24T10:00:00.000Z',expectedRevision:1 }) });
  assert.equal(resolved.status,200,JSON.stringify(await resolved.clone().json()));
  assert.equal((await resolved.json()).data.revision,2);

  const mismatched = await api(`/api/v1/finance/recurring-schedules/recurring-food-001/occurrences/${encodeURIComponent(occurrenceId)}`, { cookies:owner.cookies,method:'PUT',
    headers:{ 'content-type':'application/json','idempotency-key':'schedule-occurrence-replay-001' },
    body:JSON.stringify({ status:'skipped',transactionId:null,resolvedAt:'2026-10-24T10:00:00.000Z',expectedRevision:1 }) });
  assert.equal(mismatched.status,409);
  assert.equal(await prisma.recurringSchedule.count({ where:{ userId:owner.user.id } }),1);
  assert.equal(await prisma.scheduleOccurrence.count({ where:{ userId:owner.user.id,status:'posted',transactionId } }),1);
  assert.equal(await prisma.changeLog.count({ where:{ userId:owner.user.id,entityType:{ in:['recurring_schedule','schedule_occurrence'] } } }),3);
});
