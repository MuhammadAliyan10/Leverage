import { enumerateDueOccurrences, nextOccurrenceDate, type RecurrenceFrequency } from '../../finance/recurrence.ts';
import { CLASSIFICATIONS, resolveClassification } from '../../finance/domain.ts';
import { projectDebtRepayments } from '../../finance/debtSchedule.ts';

export interface ObligationsSql {
  getFirstAsync<T>(sql: string, params?: readonly (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]>;
  runAsync(sql: string, params?: readonly (string | number | null)[]): Promise<unknown>;
}
export interface RecurringScheduleDraft {
  id: string; ownerId: string; scheduleType: 'income' | 'expense' | 'transfer' | 'bill'; name: string;
  amountMinor: number; currency: string; classificationId?: string | null; accountId: string; toAccountId?: string | null;
  billId?: string | null; frequency: RecurrenceFrequency; startDate: string; endDate?: string | null;
}
interface ScheduleRow extends RecurringScheduleDraft { nextDueDate: string; status: 'active' | 'paused' | 'cancelled' }
interface BillRow { id: string; ownerId: string; name: string; categoryId: string; amountMinor: number; currency: string; dueDate: string; accountId: string; status: string; paidMinor: number; reminderId:string|null }
interface DebtRow { id: string; ownerId: string; direction: 'borrowed' | 'lent'; counterparty: string; principalMinor: number; currency: string; accountId: string; interestRateBps: number; status: string; principalSettledMinor: number; interestPaidMinor: number; interestAccruedMinor: number }

function validateDraft(input: RecurringScheduleDraft): void {
  if (!input.id.trim() || !input.ownerId.trim() || input.name.trim().length < 1 || input.name.trim().length > 120) throw new Error('Schedule ID, profile and a 1–120 character name are required.');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('Scheduled amount must be positive integer minor units.');
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('Schedule currency must be a three-letter ISO code.');
  if (!input.accountId.trim()) throw new Error('A funding account is required.');
  if (input.scheduleType === 'transfer' && (!input.toAccountId || input.toAccountId === input.accountId)) throw new Error('Choose a different destination account for a transfer.');
  if (input.scheduleType !== 'transfer' && input.toAccountId) throw new Error('Only transfer schedules can have a destination account.');
  if (input.scheduleType === 'bill' && !input.billId) throw new Error('A recurring bill must reference its bill.');
  if (input.scheduleType !== 'bill' && input.billId) throw new Error('Only a bill schedule can reference a bill.');
  if (input.classificationId) {
    const classification = resolveClassification(input.classificationId);
    const expected = input.scheduleType === 'income' ? 'Income' : input.scheduleType === 'expense' ? 'Expense' : null;
    if (!classification || !expected || CLASSIFICATIONS[classification].type !== expected) throw new Error('Schedule classification does not match its transaction type.');
  }
  const result = enumerateDueOccurrences({ startDate: input.startDate, nextDueDate: input.startDate, endDate: input.endDate ?? null, frequency: input.frequency, throughDate: input.startDate, maxOccurrences: 1 });
  if (result.occurrenceDates.length !== 1) throw new Error('Schedule start date is invalid.');
}
function localCalendarDate(): string {
  const date=new Date();
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function validateCalendarDate(value:string,label:string):void {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
  enumerateDueOccurrences({startDate:value,nextDueDate:value,endDate:value,frequency:'daily',throughDate:value,maxOccurrences:1});
}

async function recalculateDebtSummary(sql:ObligationsSql,ownerId:string,debtId:string):Promise<void>{
  const totals=await sql.getFirstAsync<{principal:number;settled:number;accrued:number;paid:number}>(`SELECT
    COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=? AND e.ownerId=? AND e.eventType IN ('borrow','lend') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS principal,
    COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=? AND e.ownerId=? AND e.eventType IN ('principal_repayment','receivable_payment','settlement') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS settled,
    COALESCE((SELECT SUM(CASE WHEN e.eventType='charge' THEN e.amountMinor ELSE -e.amountMinor END) FROM DebtInterestEvent e WHERE e.debtId=? AND e.ownerId=?),0) AS accrued,
    COALESCE((SELECT SUM(e.interestMinor) FROM DebtEvent e WHERE e.debtId=? AND e.ownerId=? AND e.eventType='interest' AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS paid`,[debtId,ownerId,debtId,ownerId,debtId,ownerId,debtId,ownerId]);
  if(BigInt(totals?.settled??0)>BigInt(totals?.principal??0)||BigInt(totals?.paid??0)>BigInt(totals?.accrued??0)) throw new Error('Debt correction would make outstanding principal or interest invalid.');
  const settled=BigInt(totals?.settled??0)>=BigInt(totals?.principal??0)&&BigInt(totals?.paid??0)>=BigInt(totals?.accrued??0);
  await sql.runAsync('UPDATE Debt SET principalMinor=?,status=?,updatedAt=? WHERE id=? AND ownerId=?',[totals?.principal??0,settled?'settled':'open',new Date().toISOString(),debtId,ownerId]);
  if(settled) await sql.runAsync("UPDATE DebtRepaymentSchedule SET status='completed',updatedAt=? WHERE debtId=? AND ownerId=? AND status='active'",[new Date().toISOString(),debtId,ownerId]);
}

export function createObligationsStore(
  read: () => Promise<ObligationsSql>,
  write: <T>(task: (sql: ObligationsSql) => Promise<T>) => Promise<T>,
) {
  return {
    schedule: {
      save: (draft: RecurringScheduleDraft) => write(async (sql) => {
        validateDraft(draft);
        const old = await sql.getFirstAsync<ScheduleRow>('SELECT * FROM RecurringSchedule WHERE id=? AND ownerId=?', [draft.id,draft.ownerId]);
        const now = new Date().toISOString();
        if (old) {
          if (old.status === 'cancelled') throw new Error('Cancelled schedules are immutable. Create a new schedule.');
          if (old.scheduleType !== draft.scheduleType || old.billId !== (draft.billId ?? null)) throw new Error('A schedule type cannot change; create a separate schedule instead.');
          const firstUnresolved = await sql.getFirstAsync<{ occurrenceDate: string }>("SELECT MIN(occurrenceDate) AS occurrenceDate FROM ScheduleOccurrence WHERE scheduleId=? AND status='pending'", [draft.id]);
          const nextDate = firstUnresolved?.occurrenceDate ?? (old.nextDueDate < draft.startDate ? draft.startDate : old.nextDueDate);
          await sql.runAsync('UPDATE RecurringSchedule SET name=?,amountMinor=?,currency=?,classificationId=?,accountId=?,toAccountId=?,frequency=?,startDate=?,endDate=?,nextDueDate=?,updatedAt=? WHERE id=? AND ownerId=? AND status != \'cancelled\'', [draft.name.trim(),draft.amountMinor,draft.currency,draft.classificationId ?? null,draft.accountId,draft.toAccountId ?? null,draft.frequency,draft.startDate,draft.endDate ?? null,nextDate,now,draft.id,draft.ownerId]);
          return { ...draft, nextDueDate: nextDate, status: old.status };
        }
        await sql.runAsync('INSERT INTO RecurringSchedule (id,ownerId,scheduleType,name,amountMinor,currency,classificationId,accountId,toAccountId,billId,frequency,startDate,endDate,nextDueDate,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,? ,\'active\',?,?)', [draft.id,draft.ownerId,draft.scheduleType,draft.name.trim(),draft.amountMinor,draft.currency,draft.classificationId ?? null,draft.accountId,draft.toAccountId ?? null,draft.billId ?? null,draft.frequency,draft.startDate,draft.endDate ?? null,draft.startDate,now,now]);
        return { ...draft, nextDueDate: draft.startDate, status: 'active' as const };
      }),
      list: async (ownerId: string): Promise<ScheduleRow[]> => {
        if (!ownerId.trim()) throw new Error('A profile is required to read schedules.');
        return (await (await read()).getAllAsync<ScheduleRow>('SELECT * FROM RecurringSchedule WHERE ownerId=? ORDER BY nextDueDate,id', [ownerId]));
      },
      setStatus: (ownerId: string, id: string, status: 'paused' | 'active' | 'cancelled') => write(async (sql) => {
        if (!ownerId.trim() || !id.trim()) throw new Error('A profile and schedule are required.');
        const result = await sql.runAsync('UPDATE RecurringSchedule SET status=?,updatedAt=? WHERE ownerId=? AND id=? AND status != \'cancelled\'', [status,new Date().toISOString(),ownerId,id]);
        if (result && typeof result === 'object' && 'changes' in result && (result as {changes:number}).changes === 0) throw new Error('Active or paused schedule was not found.');
      }),
      generateDue: (ownerId: string, throughDate: string) => write(async (sql) => {
        if (!ownerId.trim()) throw new Error('A profile is required to generate due occurrences.');
        enumerateDueOccurrences({ startDate: throughDate, nextDueDate: throughDate, endDate: throughDate, frequency: 'daily', throughDate, maxOccurrences: 1 });
        const schedules = await sql.getAllAsync<ScheduleRow>("SELECT * FROM RecurringSchedule WHERE ownerId=? AND status='active' AND nextDueDate<=? ORDER BY nextDueDate,id", [ownerId,throughDate]);
        let generated = 0;
        const now = new Date().toISOString();
        for (const schedule of schedules) {
          const due = enumerateDueOccurrences({ startDate:schedule.startDate,nextDueDate:schedule.nextDueDate,endDate:schedule.endDate ?? null,frequency:schedule.frequency,throughDate,maxOccurrences:5000 });
          for (const occurrenceDate of due.occurrenceDates) {
            const occurrenceId = `${schedule.id}:${occurrenceDate}`;
            if (schedule.scheduleType === 'bill' && schedule.billId) {
              const template = await sql.getFirstAsync<{name:string;categoryId:string;amountMinor:number;currency:string;accountId:string}>('SELECT name,categoryId,amountMinor,currency,accountId FROM Bill WHERE id=? AND ownerId=?',[schedule.billId,ownerId]);
              if (!template) throw new Error(`Recurring bill template ${schedule.billId} is unavailable.`);
              const billId = `${schedule.id}:bill:${occurrenceDate}`;
              const status = occurrenceDate < throughDate ? 'overdue' : occurrenceDate === throughDate ? 'due' : 'upcoming';
              await sql.runAsync('INSERT OR IGNORE INTO Bill(id,ownerId,name,categoryId,amountMinor,currency,dueDate,accountId,scheduleId,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[billId,ownerId,template.name,template.categoryId,template.amountMinor,template.currency,occurrenceDate,template.accountId,schedule.id,status,now,now]);
            }
            await sql.runAsync("INSERT OR IGNORE INTO ScheduleOccurrence(id,ownerId,scheduleId,occurrenceDate,status,createdAt) VALUES(?,?,?,?,'pending',?)", [occurrenceId,ownerId,schedule.id,occurrenceDate,now]);
            generated++;
          }
          const endDate = schedule.endDate ?? null;
          const ended = endDate !== null && due.nextDueDate > endDate;
          await sql.runAsync('UPDATE RecurringSchedule SET nextDueDate=?,status=?,updatedAt=? WHERE id=? AND ownerId=?', [due.nextDueDate,ended?'cancelled':'active',now,schedule.id,ownerId]);
        }
        return generated;
      }),
      occurrences: async (ownerId: string, status?: 'pending'|'posted'|'skipped') => {
        if (!ownerId.trim()) throw new Error('A profile is required to read occurrences.');
        return (await read()).getAllAsync(`SELECT o.*,s.name,s.scheduleType,s.amountMinor,s.currency,s.accountId,s.toAccountId,s.classificationId,s.billId FROM ScheduleOccurrence o JOIN RecurringSchedule s ON s.id=o.scheduleId AND s.ownerId=o.ownerId WHERE o.ownerId=?${status ? ' AND o.status=?' : ''} ORDER BY o.occurrenceDate,o.id`, status ? [ownerId,status] : [ownerId]);
      },
      resolveOccurrence: (ownerId: string, id: string, status: 'skipped'|'posted', transactionId?: string, resolvedAt = new Date().toISOString()) => write(async (sql) => {
        if (!ownerId.trim() || !id.trim() || (status === 'posted' && !transactionId)) throw new Error('Occurrence resolution is incomplete.');
        await sql.runAsync("UPDATE ScheduleOccurrence SET status=?,transactionId=?,resolvedAt=? WHERE id=? AND ownerId=? AND status='pending'", [status,transactionId ?? null,resolvedAt,id,ownerId]);
        const row = await sql.getFirstAsync<{status:string;transactionId:string|null}>('SELECT status,transactionId FROM ScheduleOccurrence WHERE id=? AND ownerId=?',[id,ownerId]);
        if (!row || row.status !== status || row.transactionId !== (transactionId ?? null)) throw new Error('Occurrence was already resolved or is unavailable.');
      }),
      skipOccurrence: (ownerId:string,id:string) => write(async(sql)=>{
        const occurrence=await sql.getFirstAsync<{scheduleId:string;occurrenceDate:string;status:string;scheduleType:string}>('SELECT o.scheduleId,o.occurrenceDate,o.status,s.scheduleType FROM ScheduleOccurrence o JOIN RecurringSchedule s ON s.id=o.scheduleId AND s.ownerId=o.ownerId WHERE o.id=? AND o.ownerId=?',[id,ownerId]);
        if(!occurrence||occurrence.status!=='pending') throw new Error('Pending occurrence was not found or was already resolved.');
        await sql.runAsync("UPDATE ScheduleOccurrence SET status='skipped',resolvedAt=? WHERE id=? AND ownerId=? AND status='pending'",[new Date().toISOString(),id,ownerId]);
        if(occurrence.scheduleType==='bill') await sql.runAsync("UPDATE Bill SET status='skipped',updatedAt=? WHERE ownerId=? AND scheduleId=? AND dueDate=? AND status IN ('upcoming','due','overdue')",[new Date().toISOString(),ownerId,occurrence.scheduleId,occurrence.occurrenceDate]);
      }),
      postOccurrence: <T>(ownerId:string,id:string,transactionId:string,post:(sql:ObligationsSql,schedule:ScheduleRow,occurrence:{occurrenceDate:string})=>Promise<T>) => write(async(sql)=>{
        const occurrence=await sql.getFirstAsync<{scheduleId:string;occurrenceDate:string;status:string;ownerId:string}>('SELECT scheduleId,occurrenceDate,status,ownerId FROM ScheduleOccurrence WHERE id=? AND ownerId=?',[id,ownerId]);
        if(!occurrence||occurrence.status!=='pending') throw new Error('Pending occurrence was not found or was already resolved.');
        const schedule=await sql.getFirstAsync<ScheduleRow>('SELECT * FROM RecurringSchedule WHERE id=? AND ownerId=?',[occurrence.scheduleId,ownerId]);
        if(!schedule) throw new Error('Occurrence schedule is unavailable.');
        await post(sql,schedule,{occurrenceDate:occurrence.occurrenceDate});
        await sql.runAsync("UPDATE ScheduleOccurrence SET status='posted',transactionId=?,resolvedAt=? WHERE id=? AND ownerId=? AND status='pending'",[transactionId,new Date().toISOString(),id,ownerId]);
        return {schedule,occurrenceDate:occurrence.occurrenceDate};
      }),
    },
    bill: {
      createRecurring: (input:{bill:{id:string;ownerId:string;name:string;categoryId:string;amountMinor:number;currency:string;dueDate:string;accountId:string};schedule:{id:string;frequency:RecurrenceFrequency;endDate?:string|null}}) => write(async(sql)=>{
        const {bill,schedule}=input;
        if(!bill.id.trim()||!bill.ownerId.trim()||!bill.name.trim()||!Number.isSafeInteger(bill.amountMinor)||bill.amountMinor<=0) throw new Error('Recurring bill details are invalid.');
        validateCalendarDate(bill.dueDate,'Recurring bill due date');
        const now=new Date().toISOString();
        const nextDueDate=nextOccurrenceDate(bill.dueDate,bill.dueDate,schedule.frequency);
        await sql.runAsync("INSERT INTO Bill(id,ownerId,name,categoryId,amountMinor,currency,dueDate,accountId,scheduleId,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,NULL,'upcoming',?,?)",[bill.id,bill.ownerId,bill.name.trim(),bill.categoryId,bill.amountMinor,bill.currency,bill.dueDate,bill.accountId,now,now]);
        await sql.runAsync("INSERT INTO RecurringSchedule(id,ownerId,scheduleType,name,amountMinor,currency,classificationId,accountId,toAccountId,billId,frequency,startDate,endDate,nextDueDate,status,createdAt,updatedAt) VALUES(?,?, 'bill',?,?,?,NULL,?,NULL,?,?,?,?,?,'active',?,?)",[schedule.id,bill.ownerId,bill.name.trim(),bill.amountMinor,bill.currency,bill.accountId,bill.id,schedule.frequency,bill.dueDate,schedule.endDate??null,nextDueDate,now,now]);
        await sql.runAsync('UPDATE Bill SET scheduleId=? WHERE id=? AND ownerId=?',[schedule.id,bill.id,bill.ownerId]);
      }),
      create: (input: {id:string;ownerId:string;name:string;categoryId:string;amountMinor:number;currency:string;dueDate:string;accountId:string;scheduleId?:string|null}) => write(async (sql) => {
        if (!input.id.trim() || !input.ownerId.trim() || !input.name.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor<=0) throw new Error('Bill details are invalid.');
        validateCalendarDate(input.dueDate,'Bill due date');
        const now = new Date().toISOString();
        await sql.runAsync("INSERT INTO Bill(id,ownerId,name,categoryId,amountMinor,currency,dueDate,accountId,scheduleId,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,'upcoming',?,?)",[input.id,input.ownerId,input.name.trim(),input.categoryId,input.amountMinor,input.currency,input.dueDate,input.accountId,input.scheduleId??null,now,now]);
      }),
      setReminder: (ownerId:string,id:string,reminderId:string|null) => write(async(sql)=>{
        const result=await sql.runAsync(`UPDATE Bill SET reminderId=?,updatedAt=? WHERE ownerId=? AND id=?${reminderId===null?'':" AND status NOT IN ('paid','cancelled','skipped')"}`,[reminderId,new Date().toISOString(),ownerId,id]);
        if(result&&typeof result==='object'&&'changes' in result&&(result as {changes:number}).changes===0) throw new Error('Bill was not found or is closed for reminder setup.');
      }),
      list: async (ownerId:string, today = localCalendarDate()): Promise<BillRow[]> => {
        if (!ownerId.trim()) throw new Error('A profile is required to read bills.');
        await write(async(sql)=>{ await sql.runAsync(`UPDATE Bill SET status=CASE
          WHEN status IN ('cancelled','skipped') THEN status
          WHEN COALESCE((SELECT SUM(p.amountMinor) FROM BillPayment p WHERE p.billId=Bill.id AND p.ownerId=Bill.ownerId AND NOT EXISTS(SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)),0)>=amountMinor THEN 'paid'
          WHEN COALESCE((SELECT SUM(p.amountMinor) FROM BillPayment p WHERE p.billId=Bill.id AND p.ownerId=Bill.ownerId AND NOT EXISTS(SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)),0)>0 THEN 'partial'
          WHEN dueDate<? THEN 'overdue' WHEN dueDate=? THEN 'due' ELSE 'upcoming' END,updatedAt=? WHERE ownerId=?`,[today,today,new Date().toISOString(),ownerId]); });
        return (await read()).getAllAsync<BillRow>(`SELECT b.*,COALESCE((SELECT SUM(p.amountMinor) FROM BillPayment p WHERE p.billId=b.id AND p.ownerId=b.ownerId
          AND NOT EXISTS (SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)),0) AS paidMinor FROM Bill b WHERE b.ownerId=? ORDER BY b.dueDate,b.id`,[ownerId]);
      },
      upcoming: async (ownerId:string, today = localCalendarDate()): Promise<BillRow[]> => {
        if (!ownerId.trim()) throw new Error('A profile is required to read upcoming bills.');
        validateCalendarDate(today, 'Current date');
        return (await read()).getAllAsync<BillRow>(`SELECT b.*,
          COALESCE((SELECT SUM(p.amountMinor) FROM BillPayment p WHERE p.billId=b.id AND p.ownerId=b.ownerId
            AND NOT EXISTS (SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)),0) AS paidMinor,
          CASE WHEN b.dueDate<? THEN 'overdue' WHEN b.dueDate=? THEN 'due' ELSE 'upcoming' END AS status
          FROM Bill b WHERE b.ownerId=? AND b.status NOT IN ('cancelled','skipped')
            AND COALESCE((SELECT SUM(p.amountMinor) FROM BillPayment p WHERE p.billId=b.id AND p.ownerId=b.ownerId
              AND NOT EXISTS (SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)),0)<b.amountMinor
          ORDER BY b.dueDate,b.id LIMIT 20`, [today, today, ownerId]);
      },
      recordPayment: <T>(input:{id:string;ownerId:string;billId:string;amountMinor:number;transactionId:string;idempotencyKey:string;paidAt:string}, postExpense:(sql:ObligationsSql)=>Promise<T>) => write(async(sql)=>{
        if (!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0) throw new Error('Bill payment must be positive integer minor units.');
        const existing=await sql.getFirstAsync<{id:string;billId:string;amountMinor:number;transactionId:string;paidAt:string}>('SELECT id,billId,amountMinor,transactionId,paidAt FROM BillPayment WHERE ownerId=? AND idempotencyKey=?',[input.ownerId,input.idempotencyKey]);
        if(existing){if(existing.id!==input.id||existing.billId!==input.billId||existing.amountMinor!==input.amountMinor||existing.transactionId!==input.transactionId||existing.paidAt!==input.paidAt) throw new Error('Payment idempotency key was reused for different details.');return {alreadyPaid:true as const};}
        const bill=await sql.getFirstAsync<BillRow>(`SELECT b.*,COALESCE((SELECT SUM(p.amountMinor) FROM BillPayment p WHERE p.billId=b.id AND p.ownerId=b.ownerId
          AND NOT EXISTS (SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)),0) AS paidMinor FROM Bill b WHERE b.id=? AND b.ownerId=?`,[input.billId,input.ownerId]);
        if(!bill||['cancelled','skipped'].includes(bill.status)) throw new Error('This bill is unavailable for payment.');
        if(BigInt(bill.paidMinor)+BigInt(input.amountMinor)>BigInt(bill.amountMinor)) throw new Error('Payment exceeds the bill amount remaining.');
        await postExpense(sql);
        await sql.runAsync('INSERT INTO BillPayment(id,ownerId,billId,amountMinor,transactionId,paidAt,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.billId,input.amountMinor,input.transactionId,input.paidAt,input.idempotencyKey,new Date().toISOString()]);
        const paid=BigInt(bill.paidMinor)+BigInt(input.amountMinor)>=BigInt(bill.amountMinor);
        await sql.runAsync('UPDATE Bill SET status=?,updatedAt=? WHERE id=? AND ownerId=?',[paid?'paid':'partial',new Date().toISOString(),input.billId,input.ownerId]);
        return {alreadyPaid:false as const};
      }),
      correctPayment: <T>(input:{id:string;ownerId:string;billId:string;paymentId:string;reversalTransactionId:string;reason:string;replacement?:{id:string;transactionId:string;amountMinor:number;accountId?:string;idempotencyKey:string;paidAt:string}} ,postReversal:(sql:ObligationsSql,payment:{id:string;transactionId:string;amountMinor:number;accountId:string})=>Promise<T>,postReplacement:(sql:ObligationsSql,bill:{id:string;ownerId:string;accountId:string;categoryId:string},replacement:{transactionId:string;amountMinor:number;accountId?:string;paidAt:string})=>Promise<unknown>)=>write(async(sql)=>{
        if(!input.id.trim()||!input.ownerId.trim()||!input.billId.trim()||!input.paymentId.trim()||input.reason.trim().length<1||input.reason.trim().length>500) throw new Error('A correction ID, profile, bill, payment and reason are required.');
        const prior=await sql.getFirstAsync<{id:string}>('SELECT id FROM BillPaymentCorrection WHERE ownerId=? AND originalPaymentId=?',[input.ownerId,input.paymentId]);
        if(prior) throw new Error('This bill payment was already corrected. Correct the replacement payment instead.');
        const payment=await sql.getFirstAsync<{id:string;billId:string;transactionId:string;amountMinor:number;paidAt:string}>('SELECT id,billId,transactionId,amountMinor,paidAt FROM BillPayment WHERE id=? AND ownerId=? AND billId=?',[input.paymentId,input.ownerId,input.billId]);
        if(!payment) throw new Error('Bill payment was not found in this profile.');
        const tx=await sql.getFirstAsync<{accountId:string}>('SELECT accountId FROM "Transaction" WHERE id=? AND ownerId=?',[payment.transactionId,input.ownerId]);
        if(!tx?.accountId) throw new Error('Original bill payment has no valid source account.');
        const bill=await sql.getFirstAsync<{id:string;ownerId:string;accountId:string;categoryId:string;amountMinor:number;currency:string}>('SELECT id,ownerId,accountId,categoryId,amountMinor,currency FROM Bill WHERE id=? AND ownerId=?',[input.billId,input.ownerId]);
        if(!bill) throw new Error('Bill was not found in this profile.');
        await postReversal(sql,{...payment,accountId:tx.accountId});
        await sql.runAsync('INSERT INTO BillPaymentCorrection(id,ownerId,billId,originalPaymentId,reversalTransactionId,replacementPaymentId,reason,createdAt) VALUES(?,?,?,?,?,NULL,?,?)',[input.id,input.ownerId,input.billId,payment.id,input.reversalTransactionId,input.reason.trim(),new Date().toISOString()]);
        if(input.replacement){
          const r=input.replacement;
          if(!r.id.trim()||!r.transactionId.trim()||!r.idempotencyKey.trim()||!Number.isSafeInteger(r.amountMinor)||r.amountMinor<=0) throw new Error('Replacement bill payment details are invalid.');
          const paid=await sql.getFirstAsync<{total:number}>('SELECT COALESCE(SUM(p.amountMinor),0) AS total FROM BillPayment p WHERE p.ownerId=? AND p.billId=? AND NOT EXISTS(SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)',[input.ownerId,input.billId]);
          if(BigInt(paid?.total??0)+BigInt(r.amountMinor)>BigInt(bill.amountMinor)) throw new Error('Replacement payment exceeds the bill amount remaining.');
          await postReplacement(sql,bill,{transactionId:r.transactionId,amountMinor:r.amountMinor,accountId:r.accountId,paidAt:r.paidAt});
          await sql.runAsync('INSERT INTO BillPayment(id,ownerId,billId,amountMinor,transactionId,paidAt,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?)',[r.id,input.ownerId,input.billId,r.amountMinor,r.transactionId,r.paidAt,r.idempotencyKey,new Date().toISOString()]);
          await sql.runAsync('INSERT INTO BillPaymentCorrectionReplacement(correctionId,replacementPaymentId) VALUES(?,?)',[input.id,r.id]);
        }
        const paid=await sql.getFirstAsync<{total:number}>('SELECT COALESCE(SUM(p.amountMinor),0) AS total FROM BillPayment p WHERE p.ownerId=? AND p.billId=? AND NOT EXISTS(SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)',[input.ownerId,input.billId]);
        const status=BigInt(paid?.total??0)===0n?'upcoming':BigInt(paid?.total??0)>=BigInt(bill.amountMinor)?'paid':'partial';
        await sql.runAsync('UPDATE Bill SET status=?,updatedAt=? WHERE id=? AND ownerId=?',[status,new Date().toISOString(),input.billId,input.ownerId]);
      }),
      cancel: (ownerId:string,id:string) => write(async(sql)=>{
        const count=await sql.getFirstAsync<{count:number}>(`SELECT COUNT(*) AS count FROM BillPayment p WHERE p.ownerId=? AND p.billId=? AND NOT EXISTS(SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)`,[ownerId,id]);
        if((count?.count??0)>0) throw new Error('A bill with payment history cannot be cancelled; mark it skipped instead.');
        const bill=await sql.getFirstAsync<{reminderId:string|null}>('SELECT reminderId FROM Bill WHERE ownerId=? AND id=? AND status NOT IN (\'paid\',\'cancelled\')',[ownerId,id]);
        if(!bill) throw new Error('Open bill was not found.');
        await sql.runAsync("UPDATE Bill SET status='cancelled',reminderId=NULL,updatedAt=? WHERE ownerId=? AND id=? AND status NOT IN ('paid','cancelled')",[new Date().toISOString(),ownerId,id]);
        return bill.reminderId;
      }),
      setStatus: (ownerId:string,id:string,status:'cancelled'|'skipped') => write(async(sql)=>{
        const count=await sql.getFirstAsync<{count:number}>(`SELECT COUNT(*) AS count FROM BillPayment p WHERE p.ownerId=? AND p.billId=? AND NOT EXISTS(SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id)`,[ownerId,id]);
        if((count?.count??0)>0) throw new Error('Bills with payment history cannot be cancelled or skipped.');
        const bill=await sql.getFirstAsync<{reminderId:string|null}>('SELECT reminderId FROM Bill WHERE ownerId=? AND id=? AND status IN (\'upcoming\',\'due\',\'overdue\')',[ownerId,id]);
        if(!bill) throw new Error('Open bill was not found.');
        await sql.runAsync("UPDATE Bill SET status=?,reminderId=NULL,updatedAt=? WHERE ownerId=? AND id=? AND status IN ('upcoming','due','overdue')",[status,new Date().toISOString(),ownerId,id]);
        return bill.reminderId;
      }),
      history: async(ownerId:string,billId:string) => (await read()).getAllAsync(`SELECT p.*,EXISTS(SELECT 1 FROM BillPaymentCorrection c WHERE c.originalPaymentId=p.id) AS corrected,c.reason,c.reversalTransactionId,
        (SELECT r.replacementPaymentId FROM BillPaymentCorrectionReplacement r JOIN BillPaymentCorrection x ON x.id=r.correctionId WHERE x.originalPaymentId=p.id) AS replacementPaymentId
        FROM BillPayment p LEFT JOIN BillPaymentCorrection c ON c.originalPaymentId=p.id WHERE p.ownerId=? AND p.billId=? ORDER BY p.paidAt,p.id`,[ownerId,billId]),
    },
    debt: {
      create: <T>(input:{id:string;ownerId:string;direction:'borrowed'|'lent';counterparty:string;principalMinor:number;currency:string;accountId:string;interestRateBps?:number;openedAt:string;dueDate?:string|null;transactionId:string;eventId:string;idempotencyKey:string},postCashEffect:(sql:ObligationsSql)=>Promise<T>) => write(async(sql)=>{
        if(!input.id.trim()||!input.ownerId.trim()||!input.counterparty.trim()||!Number.isSafeInteger(input.principalMinor)||input.principalMinor<=0||!Number.isSafeInteger(input.interestRateBps??0)||(input.interestRateBps??0)<0||(input.interestRateBps??0)>100000) throw new Error('Debt details are invalid.');
        const now=new Date().toISOString();
        await sql.runAsync("INSERT INTO Debt(id,ownerId,direction,counterparty,principalMinor,currency,accountId,interestRateBps,openedAt,dueDate,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,'open',?,?)",[input.id,input.ownerId,input.direction,input.counterparty.trim(),input.principalMinor,input.currency,input.accountId,input.interestRateBps??0,input.openedAt,input.dueDate??null,now,now]);
        await postCashEffect(sql);
        await sql.runAsync('INSERT INTO DebtEvent(id,ownerId,debtId,eventType,principalMinor,interestMinor,accountId,transactionId,eventDate,idempotencyKey,note,createdAt) VALUES(?,?,?,?,?,0,?,?,?,? ,?,?)',[input.eventId,input.ownerId,input.id,input.direction==='borrowed'?'borrow':'lend',input.principalMinor,input.accountId,input.transactionId,input.openedAt,input.idempotencyKey,'Initial principal',now]);
      }),
      list: async(ownerId:string):Promise<DebtRow[]> => {
        if(!ownerId.trim()) throw new Error('A profile is required to read debts.');
        return (await read()).getAllAsync<DebtRow>(`SELECT d.*,
          COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.ownerId=d.ownerId AND e.eventType IN ('borrow','lend') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS principalMinor,
          COALESCE((SELECT SUM(CASE WHEN (d.direction='borrowed' AND e.eventType='principal_repayment') OR (d.direction='lent' AND e.eventType='receivable_payment') OR e.eventType='settlement' THEN e.principalMinor ELSE 0 END) FROM DebtEvent e WHERE e.debtId=d.id AND e.ownerId=d.ownerId AND NOT EXISTS (SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS principalSettledMinor,
          COALESCE((SELECT SUM(e.interestMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.ownerId=d.ownerId AND NOT EXISTS (SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS interestPaidMinor,
          COALESCE((SELECT SUM(CASE WHEN e.eventType='charge' THEN e.amountMinor ELSE -e.amountMinor END) FROM DebtInterestEvent e WHERE e.debtId=d.id AND e.ownerId=d.ownerId),0) AS interestAccruedMinor,
          CASE WHEN d.status='cancelled' THEN 'cancelled' WHEN COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.ownerId=d.ownerId AND e.eventType IN ('borrow','lend') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0)<=COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.ownerId=d.ownerId AND (e.eventType IN ('principal_repayment','receivable_payment','settlement')) AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0)
          AND COALESCE((SELECT SUM(CASE WHEN i.eventType='charge' THEN i.amountMinor ELSE -i.amountMinor END) FROM DebtInterestEvent i WHERE i.debtId=d.id AND i.ownerId=d.ownerId),0)<=COALESCE((SELECT SUM(e.interestMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.ownerId=d.ownerId AND e.eventType='interest' AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) THEN 'settled' ELSE 'open' END AS status
          FROM Debt d WHERE d.ownerId=? ORDER BY d.status,d.dueDate,d.id`,[ownerId]);
      },
      recordEvent: <T>(input:{id:string;ownerId:string;debtId:string;eventType:'principal_repayment'|'receivable_payment'|'interest'|'settlement';principalMinor:number;interestMinor:number;accountId:string;transactionId:string;eventDate:string;idempotencyKey:string;note?:string},postCashEffect:(sql:ObligationsSql)=>Promise<T>) => write(async(sql)=>{
        if(!Number.isSafeInteger(input.principalMinor)||input.principalMinor<0||!Number.isSafeInteger(input.interestMinor)||input.interestMinor<0||input.principalMinor+input.interestMinor<=0) throw new Error('Debt event amount is invalid.');
        if(input.principalMinor>0&&input.interestMinor>0) throw new Error('Record principal and interest as separate events so reports classify them correctly.');
        const old=await sql.getFirstAsync<{id:string;debtId:string;eventType:string;principalMinor:number;interestMinor:number;accountId:string;transactionId:string;eventDate:string}>('SELECT id,debtId,eventType,principalMinor,interestMinor,accountId,transactionId,eventDate FROM DebtEvent WHERE ownerId=? AND idempotencyKey=?',[input.ownerId,input.idempotencyKey]);
        if(old){if(old.id!==input.id||old.debtId!==input.debtId||old.eventType!==input.eventType||old.principalMinor!==input.principalMinor||old.interestMinor!==input.interestMinor||old.accountId!==input.accountId||old.transactionId!==input.transactionId||old.eventDate!==input.eventDate) throw new Error('Debt idempotency key was reused for different details.');return {alreadyRecorded:true as const};}
        const debt=await sql.getFirstAsync<DebtRow>(`SELECT d.*,
          COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.eventType IN ('borrow','lend') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS principalMinor,
          COALESCE((SELECT SUM(CASE WHEN (d.direction='borrowed' AND e.eventType='principal_repayment') OR (d.direction='lent' AND e.eventType='receivable_payment') OR e.eventType='settlement' THEN e.principalMinor ELSE 0 END) FROM DebtEvent e WHERE e.debtId=d.id AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS principalSettledMinor,
          COALESCE((SELECT SUM(e.interestMinor) FROM DebtEvent e WHERE e.debtId=d.id AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS interestPaidMinor,
          COALESCE((SELECT SUM(CASE WHEN e.eventType='charge' THEN e.amountMinor ELSE -e.amountMinor END) FROM DebtInterestEvent e WHERE e.debtId=d.id),0) AS interestAccruedMinor,
          CASE WHEN COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.eventType IN ('borrow','lend') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0)<=COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.eventType IN ('principal_repayment','receivable_payment','settlement') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AND COALESCE((SELECT SUM(CASE WHEN x.eventType='charge' THEN x.amountMinor ELSE -x.amountMinor END) FROM DebtInterestEvent x WHERE x.debtId=d.id),0)<=COALESCE((SELECT SUM(e.interestMinor) FROM DebtEvent e WHERE e.debtId=d.id AND e.eventType='interest' AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) THEN 'settled' ELSE 'open' END AS status
          FROM Debt d WHERE d.id=? AND d.ownerId=?`,[input.debtId,input.ownerId]);
        if(!debt||debt.status!=='open') throw new Error('Open debt was not found.');
        const applicableType=debt.direction==='borrowed'?'principal_repayment':'receivable_payment';
        if(input.eventType!=='interest'&&input.eventType!=='settlement'&&input.eventType!==applicableType) throw new Error('Repayment type does not match the debt direction.');
        if(BigInt(debt.principalSettledMinor)+BigInt(input.principalMinor)>BigInt(debt.principalMinor)) throw new Error('Principal payment exceeds the outstanding principal.');
        if(input.eventType==='settlement'&&BigInt(debt.principalSettledMinor)+BigInt(input.principalMinor)!==BigInt(debt.principalMinor)) throw new Error('A settlement must pay the full remaining principal; use a repayment for a partial amount.');
        if(input.eventType==='interest'){
          const accrued=await sql.getFirstAsync<{amount:number}>(`SELECT COALESCE((SELECT SUM(CASE WHEN x.eventType='charge' THEN x.amountMinor ELSE -x.amountMinor END) FROM DebtInterestEvent x WHERE x.debtId=? AND x.ownerId=? AND x.eventDate<=?),0) AS amount`,[input.debtId,input.ownerId,input.eventDate]);
          const paid=await sql.getFirstAsync<{amount:number}>(`SELECT COALESCE(SUM(e.interestMinor),0) AS amount FROM DebtEvent e WHERE e.debtId=? AND e.ownerId=? AND e.eventType='interest' AND e.eventDate<=? AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)`,[input.debtId,input.ownerId,input.eventDate]);
          if(BigInt(paid?.amount??0)+BigInt(input.interestMinor)>BigInt(accrued?.amount??0)) throw new Error('Interest payment exceeds interest charged and still outstanding. Record the explicit interest charge first.');
        }
        await postCashEffect(sql);
        await sql.runAsync('INSERT INTO DebtEvent(id,ownerId,debtId,eventType,principalMinor,interestMinor,accountId,transactionId,eventDate,idempotencyKey,note,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.debtId,input.eventType,input.principalMinor,input.interestMinor,input.accountId,input.transactionId,input.eventDate,input.idempotencyKey,input.note??'',new Date().toISOString()]);
        await recalculateDebtSummary(sql,input.ownerId,input.debtId);
        return {alreadyRecorded:false as const};
      }),
      correctEvent: <T>(input:{id:string;ownerId:string;debtId:string;eventId:string;reversalTransactionId:string;reason:string;replacement?:{id:string;eventType:'borrow'|'lend'|'principal_repayment'|'receivable_payment'|'interest'|'settlement';principalMinor:number;interestMinor:number;accountId:string;transactionId:string;eventDate:string;idempotencyKey:string;note?:string}},postReversal:(sql:ObligationsSql,event:{id:string;transactionId:string;principalMinor:number;interestMinor:number;accountId:string})=>Promise<T>,postReplacement:(sql:ObligationsSql,replacement:NonNullable<typeof input.replacement>)=>Promise<unknown>)=>write(async(sql)=>{
        if(!input.id.trim()||!input.ownerId.trim()||!input.debtId.trim()||!input.eventId.trim()||input.reason.trim().length<1||input.reason.trim().length>500) throw new Error('A correction ID, profile, debt event and reason are required.');
        if(await sql.getFirstAsync('SELECT id FROM DebtEventCorrection WHERE ownerId=? AND originalEventId=?',[input.ownerId,input.eventId])) throw new Error('This debt event was already corrected. Correct its replacement event instead.');
        const event=await sql.getFirstAsync<{id:string;debtId:string;eventType:string;principalMinor:number;interestMinor:number;accountId:string;transactionId:string}>('SELECT id,debtId,eventType,principalMinor,interestMinor,accountId,transactionId FROM DebtEvent WHERE id=? AND ownerId=? AND debtId=?',[input.eventId,input.ownerId,input.debtId]);
        if(!event) throw new Error('Debt event was not found in this profile.');
        if(['borrow','lend'].includes(event.eventType)&&!input.replacement) throw new Error('Opening principal corrections must include a replacement opening event.');
        await postReversal(sql,event);
        await sql.runAsync('INSERT INTO DebtEventCorrection(id,ownerId,debtId,originalEventId,reversalTransactionId,replacementEventId,reason,createdAt) VALUES(?,?,?,?,?,NULL,?,?)',[input.id,input.ownerId,input.debtId,input.eventId,input.reversalTransactionId,input.reason.trim(),new Date().toISOString()]);
        if(input.replacement){
          const r=input.replacement;
          if(!Number.isSafeInteger(r.principalMinor)||r.principalMinor<0||!Number.isSafeInteger(r.interestMinor)||r.interestMinor<0||r.principalMinor+r.interestMinor<=0||((r.principalMinor>0)&&(r.interestMinor>0))) throw new Error('Replacement debt event amount is invalid.');
          const debt=await sql.getFirstAsync<DebtRow>(`SELECT d.*,COALESCE((SELECT SUM(CASE WHEN (d.direction='borrowed' AND e.eventType='principal_repayment') OR (d.direction='lent' AND e.eventType='receivable_payment') OR e.eventType='settlement' THEN e.principalMinor ELSE 0 END) FROM DebtEvent e WHERE e.debtId=d.id AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS principalSettledMinor,0 AS interestPaidMinor FROM Debt d WHERE d.id=? AND d.ownerId=?`,[input.debtId,input.ownerId]);
          if(!debt) throw new Error('Debt was not found in this profile.');
          const initial=await sql.getFirstAsync<{amount:number}>('SELECT COALESCE(SUM(e.principalMinor),0) AS amount FROM DebtEvent e WHERE e.debtId=? AND e.eventType IN (\'borrow\',\'lend\') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)',[input.debtId]);
          const remainingInitial=BigInt(initial?.amount??0);
          const openingCorrection=['borrow','lend'].includes(event.eventType);
          const correctedPrincipal=openingCorrection?remainingInitial+BigInt(r.principalMinor):BigInt(debt.principalMinor);
          if(openingCorrection) await sql.runAsync('UPDATE Debt SET principalMinor=?,status=?,updatedAt=? WHERE id=? AND ownerId=?',[Number(correctedPrincipal), 'open',new Date().toISOString(),input.debtId,input.ownerId]);
          const applicable=debt.direction==='borrowed'?'principal_repayment':'receivable_payment';
          if(r.eventType!== 'interest' && r.eventType!==applicable && r.eventType!==(debt.direction==='borrowed'?'borrow':'lend') && r.eventType!=='settlement') throw new Error('Replacement event type does not match the debt direction.');
          if((r.eventType==='borrow'&&debt.direction!=='borrowed')||(r.eventType==='lend'&&debt.direction!=='lent')) throw new Error('Replacement opening event does not match the debt direction.');
          const settled=BigInt(debt.principalSettledMinor)+BigInt(r.principalMinor);
          if(['principal_repayment','receivable_payment','settlement'].includes(r.eventType)&&settled>correctedPrincipal) throw new Error('Replacement payment exceeds the corrected outstanding principal.');
          if(r.eventType==='interest'){
            const accrued=await sql.getFirstAsync<{amount:number}>(`SELECT COALESCE(SUM(CASE WHEN e.eventType='charge' THEN e.amountMinor ELSE -e.amountMinor END),0) AS amount FROM DebtInterestEvent e WHERE e.debtId=? AND e.ownerId=? AND e.eventDate<=?`,[input.debtId,input.ownerId,r.eventDate]);
            const paid=await sql.getFirstAsync<{amount:number}>(`SELECT COALESCE(SUM(e.interestMinor),0) AS amount FROM DebtEvent e WHERE e.debtId=? AND e.ownerId=? AND e.eventType='interest' AND e.eventDate<=? AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)`,[input.debtId,input.ownerId,r.eventDate]);
            if(BigInt(paid?.amount??0)+BigInt(r.interestMinor)>BigInt(accrued?.amount??0)) throw new Error('Replacement interest payment exceeds accrued interest.');
          }
          if(!openingCorrection) await sql.runAsync("UPDATE Debt SET status='open',updatedAt=? WHERE id=? AND ownerId=?",[new Date().toISOString(),input.debtId,input.ownerId]);
          await postReplacement(sql,r);
          await sql.runAsync('INSERT INTO DebtEvent(id,ownerId,debtId,eventType,principalMinor,interestMinor,accountId,transactionId,eventDate,idempotencyKey,note,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[r.id,input.ownerId,input.debtId,r.eventType,r.principalMinor,r.interestMinor,r.accountId,r.transactionId,r.eventDate,r.idempotencyKey,r.note??'',new Date().toISOString()]);
          await sql.runAsync('INSERT INTO DebtEventCorrectionReplacement(correctionId,replacementEventId) VALUES(?,?)',[input.id,r.id]);
        }
        await recalculateDebtSummary(sql,input.ownerId,input.debtId);
      }),
      chargeInterest: (input:{id:string;ownerId:string;debtId:string;amountMinor:number;eventDate:string;idempotencyKey:string;note?:string})=>write(async(sql)=>{
        if(!input.id.trim()||!input.ownerId.trim()||!input.debtId.trim()||!input.idempotencyKey.trim()||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0||!Number.isFinite(new Date(input.eventDate).getTime())) throw new Error('Interest charge details are invalid.');
        const existing=await sql.getFirstAsync<{id:string;debtId:string;amountMinor:number;eventDate:string}>('SELECT id,debtId,amountMinor,eventDate FROM DebtInterestEvent WHERE ownerId=? AND idempotencyKey=?',[input.ownerId,input.idempotencyKey]);
        if(existing){if(existing.id!==input.id||existing.debtId!==input.debtId||existing.amountMinor!==input.amountMinor||existing.eventDate!==input.eventDate) throw new Error('Interest idempotency key was reused for different details.');return {alreadyCharged:true as const};}
        await sql.runAsync("INSERT INTO DebtInterestEvent(id,ownerId,debtId,eventType,amountMinor,reversalOfEventId,eventDate,idempotencyKey,note,createdAt) VALUES(?,?,?,'charge',?,NULL,?,?,?,?)",[input.id,input.ownerId,input.debtId,input.amountMinor,input.eventDate,input.idempotencyKey,input.note??'',new Date().toISOString()]);
        await recalculateDebtSummary(sql,input.ownerId,input.debtId);
        return {alreadyCharged:false as const};
      }),
      correctInterestCharge: (input:{id:string;ownerId:string;debtId:string;eventId:string;reason:string;replacement?:{id:string;amountMinor:number;eventDate:string;idempotencyKey:string;note?:string}})=>write(async(sql)=>{
        if(!input.id.trim()||!input.ownerId.trim()||!input.debtId.trim()||input.reason.trim().length<1||input.reason.trim().length>500) throw new Error('An interest correction reason is required.');
        if(await sql.getFirstAsync('SELECT id FROM DebtInterestEvent WHERE reversalOfEventId=? AND ownerId=?',[input.eventId,input.ownerId])) throw new Error('This interest charge was already corrected.');
        const charge=await sql.getFirstAsync<{id:string;amountMinor:number;eventDate:string}>('SELECT id,amountMinor,eventDate FROM DebtInterestEvent WHERE id=? AND ownerId=? AND debtId=? AND eventType=\'charge\'',[input.eventId,input.ownerId,input.debtId]);
        if(!charge) throw new Error('Interest charge was not found in this profile.');
        const paid=await sql.getFirstAsync<{amount:number}>('SELECT COALESCE(SUM(e.interestMinor),0) AS amount FROM DebtEvent e WHERE e.debtId=? AND e.ownerId=? AND e.eventType=\'interest\' AND e.eventDate>=? AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)',[input.debtId,input.ownerId,charge.eventDate]);
        if((paid?.amount??0)>0&&!input.replacement) throw new Error('Replace a charged interest amount when interest has already been paid.');
        await sql.runAsync("INSERT INTO DebtInterestEvent(id,ownerId,debtId,eventType,amountMinor,reversalOfEventId,eventDate,idempotencyKey,note,createdAt) VALUES(?,?,?,'reversal',?,?,?,?,?,?)",[`${input.id}:reversal`,input.ownerId,input.debtId,charge.amountMinor,charge.id,charge.eventDate,`${input.id}:reversal`,input.reason.trim(),new Date().toISOString()]);
        if(input.replacement){
          const r=input.replacement;
          if(!Number.isSafeInteger(r.amountMinor)||r.amountMinor<=0||!Number.isFinite(new Date(r.eventDate).getTime())||!r.id.trim()||!r.idempotencyKey.trim()) throw new Error('Replacement interest charge is invalid.');
          const prior=await sql.getFirstAsync<{amount:number}>('SELECT COALESCE(SUM(CASE WHEN eventType=\'charge\' THEN amountMinor ELSE -amountMinor END),0) AS amount FROM DebtInterestEvent WHERE debtId=? AND ownerId=?',[input.debtId,input.ownerId]);
          const paidToDate=await sql.getFirstAsync<{amount:number}>('SELECT COALESCE(SUM(e.interestMinor),0) AS amount FROM DebtEvent e WHERE e.debtId=? AND e.ownerId=? AND e.eventType=\'interest\' AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)',[input.debtId,input.ownerId]);
          if(BigInt(paidToDate?.amount??0)>BigInt(prior?.amount??0)+BigInt(r.amountMinor)) throw new Error('Corrected charge would be lower than interest already paid.');
          await sql.runAsync("INSERT INTO DebtInterestEvent(id,ownerId,debtId,eventType,amountMinor,reversalOfEventId,eventDate,idempotencyKey,note,createdAt) VALUES(?,?,?,'charge',?,NULL,?,?,?,?)",[r.id,input.ownerId,input.debtId,r.amountMinor,r.eventDate,r.idempotencyKey,r.note??input.reason.trim(),new Date().toISOString()]);
        }
        await recalculateDebtSummary(sql,input.ownerId,input.debtId);
        return {corrected:true as const};
      }),
      createRepaymentSchedule: (input:{id:string;ownerId:string;debtId:string;frequency:'monthly'|'yearly';firstDueDate:string;installmentAmountMinor:number;interestMethod:'none'|'fixed'|'declining';rateBps:number;installmentCount:number})=>write(async(sql)=>{
        if(!input.id.trim()||!input.ownerId.trim()||!input.debtId.trim()) throw new Error('Schedule ID, profile and debt are required.');
        const debt=await sql.getFirstAsync<DebtRow>(`SELECT d.*,COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND ((d.direction='borrowed' AND e.eventType='principal_repayment') OR (d.direction='lent' AND e.eventType='receivable_payment') OR e.eventType='settlement') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS principalSettledMinor,0 AS interestPaidMinor FROM Debt d WHERE d.id=? AND d.ownerId=?`,[input.debtId,input.ownerId]);
        if(!debt||debt.status!=='open') throw new Error('An open debt is required for a repayment schedule.');
        if(input.interestMethod!=='none'&&input.rateBps===0) throw new Error('Choose a positive interest rate or select no interest.');
        projectDebtRepayments({principalMinor:debt.principalMinor-debt.principalSettledMinor,installmentAmountMinor:input.installmentAmountMinor,frequency:input.frequency,firstDueDate:input.firstDueDate,installmentCount:input.installmentCount,interestMethod:input.interestMethod,annualRateBps:input.rateBps},input.firstDueDate);
        const now=new Date().toISOString();
        await sql.runAsync("INSERT INTO DebtRepaymentSchedule(id,ownerId,debtId,frequency,firstDueDate,installmentAmountMinor,interestMethod,rateBps,installmentCount,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?)",[input.id,input.ownerId,input.debtId,input.frequency,input.firstDueDate,input.installmentAmountMinor,input.interestMethod,input.rateBps,input.installmentCount,now,now]);
      }),
      repaymentSchedules: async(ownerId:string,asOfDate=localCalendarDate())=>{
        if(!ownerId.trim()) throw new Error('A profile is required to read repayment schedules.');
        const rows=await (await read()).getAllAsync<{id:string;ownerId:string;debtId:string;frequency:'monthly'|'yearly';firstDueDate:string;installmentAmountMinor:number;interestMethod:'none'|'fixed'|'declining';rateBps:number;installmentCount:number;status:string;principalMinor:number;principalSettledMinor:number;currency:string;counterparty:string}>(`SELECT s.*,d.principalMinor,d.currency,d.counterparty,
          COALESCE((SELECT SUM(e.principalMinor) FROM DebtEvent e WHERE e.debtId=d.id AND ((d.direction='borrowed' AND e.eventType='principal_repayment') OR (d.direction='lent' AND e.eventType='receivable_payment') OR e.eventType='settlement') AND NOT EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id)),0) AS principalSettledMinor
          FROM DebtRepaymentSchedule s JOIN Debt d ON d.id=s.debtId AND d.ownerId=s.ownerId WHERE s.ownerId=? ORDER BY s.firstDueDate,s.id`,[ownerId]);
        return rows.map((row)=>({...row,installments:row.principalMinor<=row.principalSettledMinor?[]:projectDebtRepayments({principalMinor:row.principalMinor-row.principalSettledMinor,installmentAmountMinor:row.installmentAmountMinor,frequency:row.frequency,firstDueDate:row.firstDueDate,installmentCount:row.installmentCount,interestMethod:row.interestMethod,annualRateBps:row.rateBps},asOfDate)}));
      },
      cancelRepaymentSchedule:(ownerId:string,id:string)=>write(async(sql)=>{
        const result=await sql.runAsync("UPDATE DebtRepaymentSchedule SET status='cancelled',updatedAt=? WHERE id=? AND ownerId=? AND status='active'",[new Date().toISOString(),id,ownerId]);
        if(result&&typeof result==='object'&&'changes' in result&&(result as {changes:number}).changes===0) throw new Error('Active repayment schedule was not found.');
      }),
      history: async(ownerId:string,debtId:string) => (await read()).getAllAsync(`SELECT e.id,e.ownerId,e.debtId,e.eventType,e.principalMinor,e.interestMinor,e.accountId,e.transactionId,e.eventDate,e.note,
        EXISTS(SELECT 1 FROM DebtEventCorrection c WHERE c.originalEventId=e.id) AS corrected,0 AS isAccrual FROM DebtEvent e WHERE e.ownerId=? AND e.debtId=?
        UNION ALL SELECT i.id,i.ownerId,i.debtId,CASE WHEN i.eventType='charge' THEN 'interest_charge' ELSE 'interest_reversal' END AS eventType,0 AS principalMinor,i.amountMinor AS interestMinor,NULL AS accountId,NULL AS transactionId,i.eventDate,i.note,
        EXISTS(SELECT 1 FROM DebtInterestEvent r WHERE r.reversalOfEventId=i.id) AS corrected,1 AS isAccrual FROM DebtInterestEvent i WHERE i.ownerId=? AND i.debtId=? ORDER BY eventDate,id`,[ownerId,debtId,ownerId,debtId]),
    },
  };
}
