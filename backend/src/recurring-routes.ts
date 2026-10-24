import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Prisma } from './generated/prisma/client.js';
import { prisma } from './db.js';

type Variables = { userId: string };
const currencies = ['PKR','USD','GBP','EUR','AED','SAR'] as const;
const positiveMinor = z.string().regex(/^[1-9]\d{0,15}$/).refine((v) => BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const instant = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === v;
});
const recurringInput = z.object({
  id: z.string().trim().min(1).max(160),
  scheduleType: z.enum(['income','expense','transfer']),
  name: z.string().trim().min(1).max(120),
  amountMinor: positiveMinor,
  currency: z.enum(currencies),
  classificationId: z.string().trim().min(1).max(80).nullable().optional(),
  accountId: z.string().uuid(),
  toAccountId: z.string().uuid().nullable().optional(),
  frequency: z.enum(['daily','weekly','monthly','yearly']),
  startDate: dateOnly,
  endDate: dateOnly.nullable().optional(),
  nextDueDate: dateOnly,
  status: z.enum(['active','paused','cancelled']).optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
}).superRefine((p, ctx) => {
  const toAccountId = p.toAccountId ?? null;
  if (p.scheduleType === 'transfer' && (!toAccountId || toAccountId === p.accountId)) ctx.addIssue({ code:'custom',path:['toAccountId'],message:'A transfer schedule needs a different destination account.' });
  if (p.scheduleType !== 'transfer' && toAccountId) ctx.addIssue({ code:'custom',path:['toAccountId'],message:'Only transfers can have a destination account.' });
  if ((p.endDate ?? null) && p.startDate > (p.endDate as string)) ctx.addIssue({ code:'custom',path:['endDate'],message:'End date must not precede the start date.' });
  const allowed = p.scheduleType === 'income'
    ? new Set(['salary','freelance','business_revenue','family_gift','foreign_remittance','investment_return','rental_income','other_income'])
    : p.scheduleType === 'expense'
      ? new Set(['food','transport','bills','shopping','health','bank_fee','housing','other_expense'])
      : new Set(['internal_transfer']);
  if (p.classificationId && !allowed.has(p.classificationId)) ctx.addIssue({ code:'custom',path:['classificationId'],message:'Classification does not match the schedule type.' });
  if (p.scheduleType === 'transfer' && p.classificationId !== 'internal_transfer') ctx.addIssue({ code:'custom',path:['classificationId'],message:'Transfer schedules must use internal_transfer.' });
});
const occurrenceCreate = z.object({
  id: z.string().trim().min(1).max(220),
  occurrenceDate: dateOnly,
  status: z.literal('pending'),
  createdAt: z.string().datetime({ offset: true }).optional(),
});
const occurrenceResolve = z.object({
  status: z.enum(['posted','skipped']),
  transactionId: z.string().uuid().nullable().optional(),
  resolvedAt: z.string().datetime({ offset: true }),
  expectedRevision: z.number().int().min(1),
});

class Conflict extends Error { constructor(readonly code: string) { super(code); } }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item)) as Prisma.InputJsonValue;
}
function key(value: string | undefined): string | null { return value && /^[A-Za-z0-9._:-]{8,160}$/.test(value) ? value : null; }
async function prior(tx: Prisma.TransactionClient, userId: string, idempotencyKey: string, requestHash: string): Promise<unknown | null> {
  const receipt = await tx.mutationReceipt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
  if (!receipt) return null;
  if (receipt.requestHash !== requestHash) throw new Conflict('IDEMPOTENCY_KEY_REUSED');
  return receipt.response;
}
async function remember(tx: Prisma.TransactionClient, userId: string, idempotencyKey: string, mutationType: string, requestHash: string, response: unknown): Promise<void> {
  await tx.mutationReceipt.create({ data: { userId, idempotencyKey, mutationType, requestHash, response: json(response) } });
}
async function publish(tx: Prisma.TransactionClient, userId: string, entityType: string, entityId: string, revision: number, payload: unknown): Promise<void> {
  const user = await tx.user.update({ where: { id: userId }, data: { syncRevision: { increment: 1n } }, select: { syncRevision: true } });
  await tx.changeLog.create({ data: { userId, entityType, entityId, revision, cursor: user.syncRevision, payload: json(payload) } });
}
function serializeSchedule(row: {
  id: string; scheduleType: string; name: string; amountMinor: bigint; currency: string; classificationId: string | null;
  accountId: string; toAccountId: string | null; frequency: string; startDate: Date; endDate: Date | null; nextDueDate: Date;
  status: string; revision: number; createdAt: Date; updatedAt: Date;
}) {
  return { ...row, amountMinor: row.amountMinor.toString(), startDate: row.startDate.toISOString().slice(0,10),
    endDate: row.endDate?.toISOString().slice(0,10) ?? null, nextDueDate: row.nextDueDate.toISOString().slice(0,10),
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function serializeOccurrence(row: {
  id: string; scheduleId: string; occurrenceDate: Date; status: string; transactionId: string | null;
  revision: number; createdAt: Date; resolvedAt: Date | null;
}) {
  return { ...row, occurrenceDate: row.occurrenceDate.toISOString().slice(0,10),
    createdAt: row.createdAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null };
}

export const recurringRoutes = new Hono<{ Variables: Variables }>();

recurringRoutes.post('/recurring-schedules', async (c) => {
  const idempotencyKey = key(c.req.header('Idempotency-Key'));
  if (!idempotencyKey) return c.json({ error:{ code:'IDEMPOTENCY_KEY_REQUIRED', message:'Provide an Idempotency-Key header.' } },400);
  const parsed = recurringInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || parsed.data.expectedUpdatedAt) return c.json({ error:{ code:'INVALID_RECURRING_SCHEDULE', message:'Recurring schedule details are invalid.' } },400);
  const userId = c.get('userId'), p = parsed.data, digest = hash(p);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const replay = await prior(tx,userId,idempotencyKey,digest); if (replay) return replay;
      if (p.scheduleType === 'transfer' && (p.toAccountId ?? null) === p.accountId) throw new Conflict('SCHEDULE_ACCOUNTS_INVALID');
      for (const accountId of [p.accountId,p.toAccountId].filter((id): id is string => Boolean(id))) {
        const account = await tx.financeAccount.findFirst({ where:{ id:accountId,userId,archivedAt:null,currency:p.currency } });
        if (!account) throw new Conflict('SCHEDULE_ACCOUNT_UNAVAILABLE');
      }
      const row = await tx.recurringSchedule.create({ data:{
        id:p.id,userId,scheduleType:p.scheduleType,name:p.name,amountMinor:BigInt(p.amountMinor),currency:p.currency,
        classificationId:p.classificationId ?? null,accountId:p.accountId,toAccountId:p.toAccountId ?? null,frequency:p.frequency,
        startDate:new Date(`${p.startDate}T00:00:00.000Z`),endDate:p.endDate ? new Date(`${p.endDate}T00:00:00.000Z`) : null,
        nextDueDate:new Date(`${p.nextDueDate}T00:00:00.000Z`),status:p.status ?? 'active',
        ...(p.createdAt ? { createdAt:new Date(p.createdAt) } : {}),...(p.updatedAt ? { updatedAt:new Date(p.updatedAt) } : {}),
      } });
      const response = serializeSchedule(row);
      await remember(tx,userId,idempotencyKey,'recurring.schedule.create',digest,response);
      await publish(tx,userId,'recurring_schedule',row.id,row.revision,response);
      return response;
    },{ isolationLevel:'Serializable' });
    return c.json({ data:result,syncStatus:'confirmed' },201);
  } catch (error) {
    if (error instanceof Conflict) return c.json({ error:{ code:error.code,message:'The recurring schedule conflicts with an unavailable account or existing record.' } },409);
    throw error;
  }
});

recurringRoutes.patch('/recurring-schedules/:id', async (c) => {
  const idempotencyKey = key(c.req.header('Idempotency-Key'));
  if (!idempotencyKey) return c.json({ error:{ code:'IDEMPOTENCY_KEY_REQUIRED', message:'Provide an Idempotency-Key header.' } },400);
  const parsed = recurringInput.safeParse(await c.req.json().catch(() => null));
  const id = c.req.param('id');
  if (!parsed.success || !parsed.data.expectedUpdatedAt || parsed.data.id !== id) return c.json({ error:{ code:'INVALID_RECURRING_SCHEDULE', message:'Recurring schedule update is invalid.' } },400);
  const userId = c.get('userId'), p = parsed.data, digest = hash({ id,p });
  try {
    const result = await prisma.$transaction(async (tx) => {
      const replay = await prior(tx,userId,idempotencyKey,digest); if (replay) return replay;
      const current = await tx.recurringSchedule.findFirst({ where:{ id,userId } });
      if (!current) throw new Conflict('RECURRING_SCHEDULE_UNAVAILABLE');
      if (current.updatedAt.toISOString() !== p.expectedUpdatedAt) throw new Conflict('REVISION_CONFLICT');
      if (current.scheduleType !== p.scheduleType) throw new Conflict('SCHEDULE_TYPE_IMMUTABLE');
      if (current.status === 'cancelled') throw new Conflict('RECURRING_SCHEDULE_UNAVAILABLE');
      for (const accountId of [p.accountId,p.toAccountId].filter((value): value is string => Boolean(value))) {
        const account = await tx.financeAccount.findFirst({ where:{ id:accountId,userId,archivedAt:null,currency:p.currency } });
        if (!account) throw new Conflict('SCHEDULE_ACCOUNT_UNAVAILABLE');
      }
      const updatedAt = new Date(Math.max(Date.now(),current.updatedAt.getTime()+1));
      const row = await tx.recurringSchedule.update({ where:{ id_userId:{id,userId} },data:{
        name:p.name,amountMinor:BigInt(p.amountMinor),currency:p.currency,classificationId:p.classificationId ?? null,
        accountId:p.accountId,toAccountId:p.toAccountId ?? null,frequency:p.frequency,startDate:new Date(`${p.startDate}T00:00:00.000Z`),
        endDate:p.endDate ? new Date(`${p.endDate}T00:00:00.000Z`) : null,nextDueDate:new Date(`${p.nextDueDate}T00:00:00.000Z`),
        status:p.status ?? current.status,revision:{increment:1},updatedAt,
      } });
      const response = serializeSchedule(row);
      await remember(tx,userId,idempotencyKey,'recurring.schedule.update',digest,response);
      await publish(tx,userId,'recurring_schedule',row.id,row.revision,response);
      return response;
    },{ isolationLevel:'Serializable' });
    return c.json({ data:result,syncStatus:'confirmed' });
  } catch (error) {
    if (error instanceof Conflict) return c.json({ error:{ code:error.code,message:error.code==='REVISION_CONFLICT'?'This schedule changed on another device. Refresh before editing.':'The recurring schedule is unavailable or invalid.' } },error.code==='REVISION_CONFLICT'?409:409);
    throw error;
  }
});

recurringRoutes.post('/recurring-schedules/:id/occurrences', async (c) => {
  const idempotencyKey = key(c.req.header('Idempotency-Key'));
  if (!idempotencyKey) return c.json({ error:{ code:'IDEMPOTENCY_KEY_REQUIRED', message:'Provide an Idempotency-Key header.' } },400);
  const parsed = occurrenceCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error:{ code:'INVALID_SCHEDULE_OCCURRENCE', message:'Schedule occurrence details are invalid.' } },400);
  const userId = c.get('userId'), scheduleId = c.req.param('id'), p = parsed.data, digest = hash({ scheduleId,p });
  try {
    const result = await prisma.$transaction(async (tx) => {
      const replay = await prior(tx,userId,idempotencyKey,digest); if (replay) return replay;
      const schedule = await tx.recurringSchedule.findFirst({ where:{ id:scheduleId,userId } });
      if (!schedule) throw new Conflict('RECURRING_SCHEDULE_UNAVAILABLE');
      if (p.occurrenceDate < schedule.startDate.toISOString().slice(0,10) || (schedule.endDate && p.occurrenceDate > schedule.endDate.toISOString().slice(0,10))) throw new Conflict('OCCURRENCE_OUTSIDE_SCHEDULE');
      const row = await tx.scheduleOccurrence.create({ data:{ id:p.id,userId,scheduleId,occurrenceDate:new Date(`${p.occurrenceDate}T00:00:00.000Z`),status:'pending',...(p.createdAt?{createdAt:new Date(p.createdAt)}:{}) } });
      const response = serializeOccurrence(row);
      await remember(tx,userId,idempotencyKey,'recurring.occurrence.create',digest,response);
      await publish(tx,userId,'schedule_occurrence',row.id,row.revision,response);
      return response;
    },{ isolationLevel:'Serializable' });
    return c.json({ data:result,syncStatus:'confirmed' },201);
  } catch (error) {
    if (error instanceof Conflict) return c.json({ error:{ code:error.code,message:'The schedule occurrence is outside its schedule or unavailable.' } },409);
    throw error;
  }
});

recurringRoutes.put('/recurring-schedules/:id/occurrences/:occurrenceId', async (c) => {
  const idempotencyKey = key(c.req.header('Idempotency-Key'));
  if (!idempotencyKey) return c.json({ error:{ code:'IDEMPOTENCY_KEY_REQUIRED', message:'Provide an Idempotency-Key header.' } },400);
  const parsed = occurrenceResolve.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || (parsed.data.status==='posted' ? !parsed.data.transactionId : Boolean(parsed.data.transactionId))) return c.json({ error:{ code:'INVALID_SCHEDULE_OCCURRENCE', message:'Occurrence resolution is invalid.' } },400);
  const userId = c.get('userId'), scheduleId = c.req.param('id'), occurrenceId = c.req.param('occurrenceId'), p = parsed.data, digest = hash({ scheduleId,occurrenceId,p });
  try {
    const result = await prisma.$transaction(async (tx) => {
      const replay = await prior(tx,userId,idempotencyKey,digest); if (replay) return replay;
      const row = await tx.scheduleOccurrence.findFirst({ where:{ id:occurrenceId,userId,scheduleId } });
      if (!row) throw new Conflict('SCHEDULE_OCCURRENCE_UNAVAILABLE');
      if (row.revision !== p.expectedRevision) throw new Conflict('REVISION_CONFLICT');
      if (row.status !== 'pending') throw new Conflict('SCHEDULE_OCCURRENCE_RESOLVED');
      const schedule = await tx.recurringSchedule.findFirst({ where:{ id:scheduleId,userId } });
      if (!schedule) throw new Conflict('RECURRING_SCHEDULE_UNAVAILABLE');
      if (p.status === 'posted') {
        const transaction = await tx.financeTransaction.findFirst({ where:{ id:p.transactionId!,userId } });
        if (!transaction || transaction.amountMinor !== schedule.amountMinor || transaction.currency !== schedule.currency || transaction.accountId !== schedule.accountId ||
          (schedule.scheduleType==='income' && transaction.type!=='income') || (schedule.scheduleType==='expense' && transaction.type!=='expense') ||
          (schedule.scheduleType==='transfer' && (transaction.type!=='transfer' || transaction.toAccountId!==schedule.toAccountId))) throw new Conflict('SCHEDULE_TRANSACTION_MISMATCH');
      }
      const updated = await tx.scheduleOccurrence.update({ where:{ id_userId:{id:occurrenceId,userId} },data:{ status:p.status,transactionId:p.transactionId ?? null,resolvedAt:new Date(p.resolvedAt),revision:{increment:1} } });
      const response = serializeOccurrence(updated);
      await remember(tx,userId,idempotencyKey,'recurring.occurrence.resolve',digest,response);
      await publish(tx,userId,'schedule_occurrence',updated.id,updated.revision,response);
      return response;
    },{ isolationLevel:'Serializable' });
    return c.json({ data:result,syncStatus:'confirmed' });
  } catch (error) {
    if (error instanceof Conflict) return c.json({ error:{ code:error.code,message:'The schedule occurrence changed or its linked transaction does not match.' } },409);
    throw error;
  }
});
