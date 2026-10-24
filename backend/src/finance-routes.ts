import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Prisma } from './generated/prisma/client.js';
import { prisma } from './db.js';

type Variables = { userId: string };
const allowedIncome = new Set(['salary','freelance','business_revenue','family_gift','foreign_remittance','investment_return','rental_income','other_income']);
const allowedExpense = new Set(['food','transport','bills','shopping','health','bank_fee','housing','other_expense']);
export const accountInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  type: z.enum(['cash', 'bank', 'wallet', 'savings']),
  currency: z.enum(['PKR','USD','GBP','EUR','AED','SAR']),
  openingBalanceMinor: z.string().regex(/^-?\d{1,16}$/).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) && BigInt(value) >= -BigInt(Number.MAX_SAFE_INTEGER)).default('0'),
});

export const transactionInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9:_-]{1,120}$/).optional(),
  type: z.enum(['income', 'expense', 'transfer', 'refund', 'reversal']),
  amountMinor: z.string().regex(/^[1-9]\d{0,15}$/).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
  currency: z.enum(['PKR','USD','GBP','EUR','AED','SAR']),
  classificationId: z.string().trim().min(1).max(80),
  categoryLabel: z.string().trim().min(1).max(120),
  accountId: z.string().uuid().optional(),
  toAccountId: z.string().uuid().optional(),
  occurredAt: z.string().datetime({ offset: true }),
  note: z.string().max(2000).nullable().optional(),
  paymentMethod: z.enum(['Bank transfer','Digital payment','Cash','Cheque','Card','Other']).nullable().optional(),
  sourceName: z.string().max(200).nullable().optional(),
  sourceAmountMinor: z.string().regex(/^[1-9]\d{0,15}$/).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)).nullable().optional(),
  sourceCurrency: z.enum(['USD','GBP','EUR','AED','SAR']).nullable().optional(),
  exchangeRate: z.string().max(80).nullable().optional(),
  referenceNumber: z.string().max(120).nullable().optional(),
  taxStatus: z.enum(['unreviewed', 'taxable', 'non_taxable']).default('unreviewed'),
  taxYear: z.number().int().min(2000).max(2200).nullable().optional(),
  refundOfId: z.string().uuid().nullable().optional(),
  reversalOfId: z.string().regex(/^[A-Za-z0-9:_-]{1,120}$/).nullable().optional(),
  correctionOfId: z.string().uuid().nullable().optional(),
}).superRefine((payload, context) => {
  const allowedRefund = new Set(['expense_refund']);
  if (payload.type === 'income' && !allowedIncome.has(payload.classificationId)) context.addIssue({ code:'custom',path:['classificationId'],message:'Income classification is unsupported.' });
  if (payload.type === 'expense' && !allowedExpense.has(payload.classificationId)) context.addIssue({ code:'custom',path:['classificationId'],message:'Expense classification is unsupported.' });
  if (payload.type === 'refund' && (!allowedRefund.has(payload.classificationId) || !payload.refundOfId)) context.addIssue({ code:'custom',path:['refundOfId'],message:'A refund must reference an expense and use the refund classification.' });
  if (payload.type !== 'refund' && payload.refundOfId != null) context.addIssue({ code:'custom',path:['refundOfId'],message:'Only refunds may reference a refunded transaction.' });
  if (payload.type === 'reversal' && (payload.classificationId !== 'correction_reversal' || !payload.reversalOfId || payload.correctionOfId != null)) context.addIssue({ code:'custom',path:['reversalOfId'],message:'A reversal must reference its original transaction.' });
  if (payload.type !== 'reversal' && payload.reversalOfId != null) context.addIssue({ code:'custom',path:['reversalOfId'],message:'Only reversals may reference a reversed transaction.' });
  if (payload.correctionOfId != null && !['income','expense','transfer'].includes(payload.type)) context.addIssue({ code:'custom',path:['correctionOfId'],message:'Only a replacement transaction can reference a correction original.' });
  if (payload.type === 'transfer' && payload.classificationId !== 'internal_transfer') context.addIssue({ code:'custom',path:['classificationId'],message:'Transfer classification must be internal_transfer.' });
  if (payload.sourceAmountMinor != null || payload.sourceCurrency != null || payload.exchangeRate != null) {
    if (payload.sourceAmountMinor == null || payload.sourceCurrency == null || payload.exchangeRate == null) {
      context.addIssue({ code:'custom',path:['sourceAmountMinor'],message:'Foreign amount, currency, and rate must be supplied together.' });
      return;
    }
    if (payload.currency !== 'PKR' || payload.type !== 'income' || payload.classificationId !== 'foreign_remittance') {
      context.addIssue({ code:'custom',path:['classificationId'],message:'Foreign provenance is supported only for PKR family remittance income.' });
      return;
    }
    const rateMatch = /^(\d+)(?:\.(\d{1,8}))?$/.exec(payload.exchangeRate);
    if (!rateMatch) { context.addIssue({ code:'custom',path:['exchangeRate'],message:'Exchange rate must have up to eight decimal places.' }); return; }
    const scale=100_000_000n;
    const rate=BigInt(rateMatch[1]??'0')*scale+BigInt((rateMatch[2]??'').padEnd(8,'0')||'0');
    if(rate<=0n) { context.addIssue({ code:'custom',path:['exchangeRate'],message:'Exchange rate must be positive.' }); return; }
    const converted=(BigInt(payload.sourceAmountMinor)*rate+scale/2n)/scale;
    if(converted!==BigInt(payload.amountMinor)) context.addIssue({ code:'custom',path:['amountMinor'],message:'Converted PKR amount does not match the supplied rate.' });
  }
});
const accountUpdateInput = z.object({
  expectedRevision: z.number().int().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  type: z.enum(['cash', 'bank', 'wallet', 'savings']).optional(),
}).refine((value) => value.name !== undefined || value.type !== undefined);
const budgetFields = z.object({
  id: z.string().uuid().optional(),
  categoryId: z.string().trim().min(1).max(80),
  amountMinor: z.string().regex(/^[1-9]\d{0,15}$/).refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
  currency: z.enum(['PKR','USD','GBP','EUR','AED','SAR']),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rolloverPolicy: z.enum(['reset','carry_unused']),
});
const budgetPeriodIsValid = (value: z.infer<typeof budgetFields>) => {
  const start = Date.parse(`${value.periodStart}T00:00:00.000Z`);
  const end = Date.parse(`${value.periodEnd}T00:00:00.000Z`);
  return Number.isFinite(start) && Number.isFinite(end) && start < end &&
    new Date(start).toISOString().slice(0,10) === value.periodStart && new Date(end).toISOString().slice(0,10) === value.periodEnd;
};
const budgetInput = budgetFields.refine((value) => allowedExpense.has(value.categoryId), { message: 'Budget category must be a supported expense classification.' })
  .refine(budgetPeriodIsValid, { message: 'Budget period must be a valid, non-empty calendar date range.' });
const reviseBudgetInput = budgetFields.omit({ id: true }).extend({ expectedRevision: z.number().int().min(1) })
  .refine((value) => allowedExpense.has(value.categoryId), { message: 'Budget category must be a supported expense classification.' })
  .refine(budgetPeriodIsValid, { message: 'Budget period must be a valid, non-empty calendar date range.' });

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item)) as Prisma.InputJsonValue;
}

function serializeBudget(budget: {
  id: string; categoryId: string; amountMinor: bigint; currency: string; periodStart: Date; periodEnd: Date;
  rolloverPolicy: string; revision: number; changeRevision: number; supersedesId: string | null; createdAt: Date;
}) {
  return { ...budget, amountMinor: budget.amountMinor.toString(), periodStart: budget.periodStart.toISOString().slice(0,10),
    periodEnd: budget.periodEnd.toISOString().slice(0,10), createdAt: budget.createdAt.toISOString() };
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function publishChange(tx: Prisma.TransactionClient, change: {
  userId: string; entityType: string; entityId: string; revision: number; payload: unknown;
}): Promise<void> {
  // Updating the user's revision row serializes this user's change publication until
  // commit, so a committed cursor cannot be hidden behind a later commit.
  const user = await tx.user.update({
    where: { id: change.userId },
    data: { syncRevision: { increment: 1n } },
    select: { syncRevision: true },
  });
  await tx.changeLog.create({ data: {
    ...change, cursor: user.syncRevision, payload: asJson(change.payload),
  } });
}

function readIdempotencyKey(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9._:-]{8,160}$/.test(value) ? value : null;
}

async function replayMutationAfterRace(userId: string, key: string, hash: string): Promise<unknown | null> {
  const winner = await prisma.mutationReceipt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
  if (!winner) return null;
  if (winner.requestHash !== hash) throw new MutationConflict('IDEMPOTENCY_KEY_REUSED');
  return winner.response;
}

export const financeRoutes = new Hono<{ Variables: Variables }>();

financeRoutes.get('/budgets', async (c) => {
  const userId = c.get('userId');
  const rows = await prisma.budget.findMany({ where: { userId, archivedAt: null, supersededAt: null },
    orderBy: [{ periodStart: 'desc' }, { categoryId: 'asc' }, { id: 'asc' }] });
  const data = await Promise.all(rows.map(async (budget) => {
    const periodEnd = new Date(budget.periodEnd);
    const actual = await prisma.$queryRaw<Array<{ amountMinor: bigint | null }>>`
      SELECT COALESCE(SUM(CASE WHEN t."type" = 'expense' THEN t."amountMinor" ELSE -t."amountMinor" END), 0)::bigint AS "amountMinor"
      FROM "FinanceTransaction" t
      LEFT JOIN "FinanceTransaction" original ON original."id" = t."refundOfId" AND original."userId" = t."userId"
      WHERE t."userId" = ${userId}
        AND t."currency" = ${budget.currency}
        AND t."occurredAt" >= ${budget.periodStart}
        AND t."occurredAt" < ${periodEnd}
        AND ((t."type" = 'expense' AND t."classificationId" = ${budget.categoryId})
          OR (t."type" = 'refund' AND original."classificationId" = ${budget.categoryId}))
    `;
    return { ...budget, amountMinor: budget.amountMinor.toString(), spentMinor: (actual[0]?.amountMinor ?? 0n).toString() };
  }));
  return c.json({ data });
});

financeRoutes.post('/budgets', async (c) => {
  const key = readIdempotencyKey(c.req.header('Idempotency-Key'));
  if (!key) return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Provide an Idempotency-Key header.' } }, 400);
  const parsed = budgetInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_BUDGET', message: 'Budget details are invalid.' } }, 400);
  const userId = c.get('userId');
  const payload = parsed.data;
  const hash = requestHash(payload);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.mutationReceipt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
      if (existing) {
        if (existing.requestHash !== hash) throw new MutationConflict('IDEMPOTENCY_KEY_REUSED');
        return existing.response;
      }
      const budget = await tx.budget.create({ data: {
        id: payload.id ?? randomUUID(), userId, categoryId: payload.categoryId, amountMinor: BigInt(payload.amountMinor),
        currency: payload.currency, periodStart: new Date(`${payload.periodStart}T00:00:00.000Z`),
        periodEnd: new Date(`${payload.periodEnd}T00:00:00.000Z`), rolloverPolicy: payload.rolloverPolicy,
      } });
      const response = serializeBudget(budget);
      await tx.mutationReceipt.create({ data: { userId, idempotencyKey: key, mutationType: 'budget.create', requestHash: hash, response: asJson(response) } });
      await publishChange(tx, { userId, entityType: 'budget', entityId: budget.id, revision: budget.revision, payload: response });
      return response;
    }, { isolationLevel: 'Serializable' });
    return c.json({ data: result, syncStatus: 'confirmed' }, 201);
  } catch (error) {
    if (error instanceof MutationConflict) return c.json({ error: { code: error.code, message: 'This idempotency key was already used for different data.' } }, 409);
    if (isUniqueViolation(error)) {
      const replay = await replayMutationAfterRace(userId, key, hash);
      if (replay !== null) return c.json({ data: replay, syncStatus: 'confirmed' }, 200);
      return c.json({ error: { code: 'BUDGET_ALREADY_EXISTS', message: 'An active budget already exists for this category and period.' } }, 409);
    }
    throw error;
  }
});

financeRoutes.post('/budgets/:id/revisions', async (c) => {
  const key = readIdempotencyKey(c.req.header('Idempotency-Key'));
  if (!key) return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Provide an Idempotency-Key header.' } }, 400);
  const parsed = reviseBudgetInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_BUDGET', message: 'Budget revision details are invalid.' } }, 400);
  const userId = c.get('userId');
  const payload = { budgetId: c.req.param('id'), ...parsed.data };
  const hash = requestHash(payload);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.mutationReceipt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
      if (existing) {
        if (existing.requestHash !== hash) throw new MutationConflict('IDEMPOTENCY_KEY_REUSED');
        return existing.response;
      }
      await tx.$queryRaw`SELECT "id" FROM "Budget" WHERE "id" = ${payload.budgetId}::uuid AND "userId" = ${userId} FOR UPDATE`;
      const current = await tx.budget.findFirst({ where: { id: payload.budgetId, userId, archivedAt: null, supersededAt: null } });
      if (!current) throw new MutationConflict('BUDGET_UNAVAILABLE');
      if (current.revision !== payload.expectedRevision) throw new MutationConflict('REVISION_CONFLICT');
      if (current.categoryId !== payload.categoryId || current.currency !== payload.currency || current.periodStart.toISOString().slice(0,10) !== payload.periodStart) {
        throw new MutationConflict('BUDGET_IDENTITY_IMMUTABLE');
      }
      const at = new Date();
      await tx.budget.update({ where: { id_userId: { id: current.id, userId } }, data: { supersededAt: at } });
      const next = await tx.budget.create({ data: {
        id: randomUUID(), userId, categoryId: payload.categoryId, amountMinor: BigInt(payload.amountMinor), currency: payload.currency,
        periodStart: current.periodStart, periodEnd: new Date(`${payload.periodEnd}T00:00:00.000Z`), rolloverPolicy: payload.rolloverPolicy,
        revision: current.revision + 1, changeRevision: current.changeRevision + 1, supersedesId: current.id,
      } });
      const response = serializeBudget(next);
      await tx.mutationReceipt.create({ data: { userId, idempotencyKey: key, mutationType: 'budget.revise', requestHash: hash, response: asJson(response) } });
      await publishChange(tx, { userId, entityType: 'budget', entityId: next.id, revision: next.changeRevision, payload: response });
      return response;
    }, { isolationLevel: 'Serializable' });
    return c.json({ data: result, syncStatus: 'confirmed' }, 201);
  } catch (error) {
    if (error instanceof MutationConflict) {
      const status = error.code === 'BUDGET_UNAVAILABLE' ? 404 : 409;
      return c.json({ error: { code: error.code, message: error.code === 'REVISION_CONFLICT' ? 'The budget changed elsewhere. Refresh and review it.' : 'The budget revision is no longer valid.' } }, status);
    }
    if (isUniqueViolation(error)) return c.json({ error: { code: 'BUDGET_REVISION_RACE', message: 'A concurrent budget revision was posted. Refresh before retrying.' } }, 409);
    throw error;
  }
});

financeRoutes.post('/budgets/:id/archive', async (c) => {
  const key = readIdempotencyKey(c.req.header('Idempotency-Key'));
  if (!key) return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Provide an Idempotency-Key header.' } }, 400);
  const userId = c.get('userId');
  const request = { budgetId: c.req.param('id'), action: 'archive' };
  const hash = requestHash(request);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.mutationReceipt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
      if (existing) {
        if (existing.requestHash !== hash) throw new MutationConflict('IDEMPOTENCY_KEY_REUSED');
        return existing.response;
      }
      await tx.$queryRaw`SELECT "id" FROM "Budget" WHERE "id" = ${request.budgetId}::uuid AND "userId" = ${userId} FOR UPDATE`;
      const budget = await tx.budget.findFirst({ where: { id: request.budgetId, userId, supersededAt: null, archivedAt: null } });
      if (!budget) throw new MutationConflict('BUDGET_UNAVAILABLE');
      const archivedAt = new Date();
      const updated = await tx.budget.update({ where: { id_userId: { id: budget.id, userId } }, data: { archivedAt, changeRevision: { increment: 1 } } });
      const response = { id: updated.id, archivedAt: archivedAt.toISOString(), revision: updated.changeRevision };
      await tx.mutationReceipt.create({ data: { userId, idempotencyKey: key, mutationType: 'budget.archive', requestHash: hash, response: asJson(response) } });
      await publishChange(tx, { userId, entityType: 'budget', entityId: updated.id, revision: updated.changeRevision, payload: response });
      return response;
    }, { isolationLevel: 'Serializable' });
    return c.json({ data: result, syncStatus: 'confirmed' });
  } catch (error) {
    if (error instanceof MutationConflict) return c.json({ error: { code: error.code, message: 'The budget is missing or is no longer current.' } }, 404);
    if (isUniqueViolation(error)) return c.json({ error: { code: 'MUTATION_RACE', message: 'Retry with the same idempotency key.' } }, 409);
    throw error;
  }
});

financeRoutes.get('/accounts', async (c) => {
  const accounts = await prisma.financeAccount.findMany({
    where: { userId: c.get('userId') },
    orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return c.json({ data: accounts.map((account) => ({
    ...account,
    openingBalanceMinor: account.openingBalanceMinor.toString(),
  })) });
});

financeRoutes.post('/accounts', async (c) => {
  const key = readIdempotencyKey(c.req.header('Idempotency-Key'));
  if (!key) return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Provide an Idempotency-Key header.' } }, 400);
  const parsed = accountInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_ACCOUNT', message: 'Account details are invalid.' } }, 400);
  const userId = c.get('userId');
  const payload = parsed.data;
  const hash = requestHash(payload);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.mutationReceipt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
      if (existing) {
        if (existing.requestHash !== hash) throw new MutationConflict('IDEMPOTENCY_KEY_REUSED');
        return existing.response;
      }
      const account = await tx.financeAccount.create({ data: {
        id: payload.id ?? randomUUID(), userId, name: payload.name, type: payload.type,
        currency: payload.currency, openingBalanceMinor: BigInt(payload.openingBalanceMinor),
      } });
      const response = { id: account.id, name: account.name, type: account.type, currency: account.currency,
        openingBalanceMinor: account.openingBalanceMinor.toString(), archivedAt: null, createdAt: account.createdAt.toISOString(), revision: 1 };
      await tx.mutationReceipt.create({ data: {
        userId, idempotencyKey: key, mutationType: 'account.create', requestHash: hash, response: asJson(response),
      } });
      await publishChange(tx, { userId, entityType: 'account', entityId: account.id, revision: 1, payload: response });
      return response;
    }, { isolationLevel: 'Serializable' });
    return c.json({ data: result, syncStatus: 'confirmed' }, 201);
  } catch (error) {
    if (error instanceof MutationConflict) return c.json({ error: { code: error.code, message: 'This idempotency key was already used for different data.' } }, 409);
    if (isUniqueViolation(error)) {
      try {
        const replay = await replayMutationAfterRace(userId, key, hash);
        if (replay !== null) return c.json({ data: replay, syncStatus: 'confirmed' }, 200);
      } catch (raceError) {
        if (raceError instanceof MutationConflict) return c.json({ error: { code: raceError.code, message: 'This idempotency key was already used for different data.' } }, 409);
        throw raceError;
      }
      return c.json({ error: { code: 'MUTATION_RACE', message: 'Retry this operation with the same idempotency key.' } }, 409);
    }
    throw error;
  }
});

financeRoutes.patch('/accounts/:id', async (c) => {
  const key = readIdempotencyKey(c.req.header('Idempotency-Key'));
  if (!key) return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Provide an Idempotency-Key header.' } }, 400);
  const parsed = accountUpdateInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_ACCOUNT_UPDATE', message: 'Account changes are invalid.' } }, 400);
  const userId = c.get('userId');
  const request = { accountId: c.req.param('id'), ...parsed.data };
  const hash = requestHash(request);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.mutationReceipt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
      if (existing) {
        if (existing.requestHash !== hash) throw new MutationConflict('IDEMPOTENCY_KEY_REUSED');
        return existing.response;
      }
      const account = await tx.financeAccount.findFirst({ where: { id: request.accountId, userId, archivedAt: null } });
      if (!account) throw new MutationConflict('ACCOUNT_UNAVAILABLE');
      if (account.revision !== request.expectedRevision) throw new MutationConflict('REVISION_CONFLICT');
      const updated = await tx.financeAccount.update({
        where: { id_userId: { id: account.id, userId } },
        data: { ...(request.name !== undefined ? { name: request.name } : {}), ...(request.type !== undefined ? { type: request.type } : {}), revision: { increment: 1 } },
      });
      const response = { id: updated.id, name: updated.name, type: updated.type, currency: updated.currency,
        openingBalanceMinor: updated.openingBalanceMinor.toString(), archivedAt: null,
        createdAt: updated.createdAt.toISOString(), revision: updated.revision };
      await tx.mutationReceipt.create({ data: { userId, idempotencyKey: key, mutationType: 'account.update', requestHash: hash, response: asJson(response) } });
      await publishChange(tx, { userId, entityType: 'account', entityId: updated.id, revision: updated.revision, payload: response });
      return response;
    }, { isolationLevel: 'Serializable' });
    return c.json({ data: result, syncStatus: 'confirmed' });
  } catch (error) {
    if (error instanceof MutationConflict) return c.json({ error: { code: error.code, message: error.code === 'REVISION_CONFLICT' ? 'The account changed elsewhere. Refresh and review it.' : 'The account was not found or is archived.' } }, error.code === 'REVISION_CONFLICT' ? 409 : 404);
    if (isUniqueViolation(error)) {
      const replay = await replayMutationAfterRace(userId, key, hash);
      if (replay !== null) return c.json({ data: replay, syncStatus: 'confirmed' }, 200);
      return c.json({ error: { code: 'MUTATION_RACE', message: 'Retry with the same idempotency key.' } }, 409);
    }
    throw error;
  }
});

financeRoutes.post('/accounts/:id/archive', async (c) => {
  const key = readIdempotencyKey(c.req.header('Idempotency-Key'));
  if (!key) return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Provide an Idempotency-Key header.' } }, 400);
  const userId = c.get('userId');
  const request = { accountId: c.req.param('id'), action: 'archive' };
  const hash = requestHash(request);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.mutationReceipt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
      if (existing) {
        if (existing.requestHash !== hash) throw new MutationConflict('IDEMPOTENCY_KEY_REUSED');
        return existing.response;
      }
      const account = await tx.financeAccount.findFirst({ where: { id: request.accountId, userId, archivedAt: null } });
      if (!account) throw new MutationConflict('ACCOUNT_UNAVAILABLE');
      const archivedAt = new Date();
      const updated = await tx.financeAccount.update({ where: { id_userId: { id: account.id, userId } }, data: { archivedAt, revision: { increment: 1 } } });
      const response = { id: updated.id, archivedAt: archivedAt.toISOString(), revision: updated.revision };
      await tx.mutationReceipt.create({ data: { userId, idempotencyKey: key, mutationType: 'account.archive', requestHash: hash, response: asJson(response) } });
      await publishChange(tx, { userId, entityType: 'account', entityId: updated.id, revision: updated.revision, payload: response });
      return response;
    }, { isolationLevel: 'Serializable' });
    return c.json({ data: result, syncStatus: 'confirmed' });
  } catch (error) {
    if (error instanceof MutationConflict) return c.json({ error: { code: error.code, message: 'The account was not found or is already archived.' } }, 404);
    if (isUniqueViolation(error)) return c.json({ error: { code: 'MUTATION_RACE', message: 'Retry with the same idempotency key.' } }, 409);
    throw error;
  }
});

financeRoutes.get('/transactions', async (c) => {
  const requestedLimit = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const cursor = c.req.query('cursor');
  if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor)) {
    return c.json({ error: { code: 'INVALID_CURSOR', message: 'The page cursor is invalid. Refresh the history list.' } }, 400);
  }
  const userId = c.get('userId');
  const rows = await prisma.financeTransaction.findMany({
    where: { userId }, take: limit + 1, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    ...(cursor ? { cursor: { id_userId: { id: cursor, userId } }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit).map((row) => ({ ...row, amountMinor: row.amountMinor.toString(), sourceAmountMinor: row.sourceAmountMinor?.toString() ?? null }));
  return c.json({ data, nextCursor: hasMore ? data.at(-1)?.id ?? null : null });
});

financeRoutes.post('/transactions', async (c) => {
  const key = readIdempotencyKey(c.req.header('Idempotency-Key'));
  if (!key) return c.json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Provide an Idempotency-Key header.' } }, 400);
  const parsed = transactionInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: { code: 'INVALID_TRANSACTION', message: 'Transaction details are invalid.' } }, 400);
  const payload = parsed.data;
  const accountId = payload.accountId;
  const toAccountId = payload.toAccountId;
  if (((payload.type === 'transfer' || (payload.type === 'reversal' && toAccountId !== undefined)) && (!accountId || !toAccountId || accountId === toAccountId)) ||
      (payload.type !== 'transfer' && payload.type !== 'reversal' && (!accountId || toAccountId)) ||
      (payload.type === 'reversal' && !accountId)) {
    return c.json({ error: { code: 'INVALID_ACCOUNT_PAIR', message: 'Choose the correct account or distinct transfer accounts.' } }, 400);
  }
  if (Boolean(payload.sourceAmountMinor) !== Boolean(payload.sourceCurrency) || Boolean(payload.sourceCurrency) !== Boolean(payload.exchangeRate)) {
    return c.json({ error: { code: 'INCOMPLETE_REMITTANCE', message: 'Original amount, currency, and exchange rate must be provided together.' } }, 400);
  }
  const userId = c.get('userId');
  const hash = requestHash(payload);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.mutationReceipt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
      if (existing) {
        if (existing.requestHash !== hash) throw new MutationConflict('IDEMPOTENCY_KEY_REUSED');
        return existing.response;
      }
      const ids = [...new Set([accountId, toAccountId].filter((id): id is string => Boolean(id)))];
      const accounts = await tx.financeAccount.findMany({ where: { id: { in: ids }, userId, archivedAt: null } });
      if (accounts.length !== ids.length || accounts.some((account) => account.currency !== payload.currency)) throw new MutationConflict('ACCOUNT_UNAVAILABLE');
      if (payload.type === 'refund') {
        const original = await tx.financeTransaction.findFirst({ where: { id: payload.refundOfId ?? '', userId } });
        if (!original || original.type !== 'expense' || original.currency !== payload.currency) throw new MutationConflict('REFUND_ORIGINAL_UNAVAILABLE');
        const reversal = await tx.financeTransaction.findFirst({ where: { userId, type: 'reversal', reversalOfId: original.id } });
        if (reversal) throw new MutationConflict('REFUND_ORIGINAL_CORRECTED');
        const alreadyRefunded = await tx.financeTransaction.aggregate({
          where: { userId, type: 'refund', refundOfId: original.id }, _sum: { amountMinor: true },
        });
        const remaining = original.amountMinor - (alreadyRefunded._sum.amountMinor ?? 0n);
        if (BigInt(payload.amountMinor) > remaining) throw new MutationConflict('REFUND_EXCEEDS_EXPENSE');
      }
      if (payload.type === 'reversal') {
        const original = await tx.financeTransaction.findFirst({ where: { id: payload.reversalOfId ?? '', userId } });
        if (!original || !['income','expense','transfer'].includes(original.type) || original.amountMinor !== BigInt(payload.amountMinor) ||
          original.currency !== payload.currency || original.accountId !== accountId || original.toAccountId !== (toAccountId ?? null)) throw new MutationConflict('REVERSAL_ORIGINAL_UNAVAILABLE');
        const prior = await tx.financeTransaction.findFirst({ where: { userId, type: 'reversal', reversalOfId: original.id } });
        const refunds = await tx.financeTransaction.count({ where: { userId, type: 'refund', refundOfId: original.id } });
        if (prior || refunds) throw new MutationConflict('TRANSACTION_ALREADY_ADJUSTED');
      }
      if (payload.correctionOfId) {
        const original = await tx.financeTransaction.findFirst({ where: { id: payload.correctionOfId, userId } });
        if (!original || !['income','expense','transfer'].includes(original.type)) throw new MutationConflict('CORRECTION_ORIGINAL_UNAVAILABLE');
        const reversal = await tx.financeTransaction.findFirst({ where: { userId, type: 'reversal', reversalOfId: original.id } });
        if (!reversal) throw new MutationConflict('CORRECTION_REVERSAL_REQUIRED');
        const replacement = await tx.financeTransaction.findFirst({ where: { userId, correctionOfId: original.id } });
        if (replacement) throw new MutationConflict('TRANSACTION_ALREADY_CORRECTED');
      }
      const transaction = await tx.financeTransaction.create({ data: {
        id: payload.id ?? randomUUID(), userId, amountMinor: BigInt(payload.amountMinor), currency: payload.currency,
        type: payload.type, classificationId: payload.classificationId, categoryLabel: payload.categoryLabel,
        accountId: accountId ?? null, toAccountId: toAccountId ?? null, occurredAt: new Date(payload.occurredAt),
        note: payload.note ?? null, paymentMethod: payload.paymentMethod ?? null, sourceName: payload.sourceName ?? null,
        sourceAmountMinor: payload.sourceAmountMinor ? BigInt(payload.sourceAmountMinor) : null,
        sourceCurrency: payload.sourceCurrency ?? null, exchangeRate: payload.exchangeRate ?? null,
        referenceNumber: payload.referenceNumber ?? null, taxStatus: payload.taxStatus, taxYear: payload.taxYear ?? null,
        refundOfId: payload.refundOfId ?? null,
        reversalOfId: payload.reversalOfId ?? null,
        correctionOfId: payload.correctionOfId ?? null,
      } });
      const response = { ...transaction, amountMinor: transaction.amountMinor.toString(),
        sourceAmountMinor: transaction.sourceAmountMinor?.toString() ?? null, occurredAt: transaction.occurredAt.toISOString(), createdAt: transaction.createdAt.toISOString() };
      await tx.mutationReceipt.create({ data: {
        userId, idempotencyKey: key, mutationType: `transaction.${payload.type}`, requestHash: hash,
        transactionId: transaction.id, response: asJson(response),
      } });
      await publishChange(tx, { userId, entityType: 'transaction', entityId: transaction.id, revision: 1, payload: response });
      return response;
    }, { isolationLevel: 'Serializable' });
    return c.json({ data: result, syncStatus: 'confirmed' }, 201);
  } catch (error) {
    if (error instanceof MutationConflict) {
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') return c.json({ error: { code: error.code, message: 'This idempotency key was already used for different data.' } }, 409);
      const message = error.code === 'REFUND_EXCEEDS_EXPENSE' ? 'The refund exceeds the expense amount still available for refund.'
        : error.code.startsWith('REFUND_') ? 'The original expense cannot receive this refund.'
        : error.code.startsWith('REVERSAL_') ? 'The original transaction cannot be reversed.'
        : error.code.startsWith('CORRECTION_') || error.code.startsWith('TRANSACTION_') ? 'The transaction correction conflicts with its posted history.'
        : 'The account is missing, archived, or has a different currency.';
      return c.json({ error: { code: error.code, message } }, 409);
    }
    if (isUniqueViolation(error)) {
      try {
        const replay = await replayMutationAfterRace(userId, key, hash);
        if (replay !== null) return c.json({ data: replay, syncStatus: 'confirmed' }, 200);
      } catch (raceError) {
        if (raceError instanceof MutationConflict) return c.json({ error: { code: raceError.code, message: 'This idempotency key was already used for different data.' } }, 409);
        throw raceError;
      }
      return c.json({ error: { code: 'MUTATION_RACE', message: 'Retry this operation with the same idempotency key.' } }, 409);
    }
    throw error;
  }
});

class MutationConflict extends Error { constructor(readonly code: string) { super(code); } }
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
