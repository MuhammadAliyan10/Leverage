import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Prisma } from './generated/prisma/client.js';
import { prisma } from './db.js';

type Vars = { userId: string };
const currencies = ['PKR','USD','GBP','EUR','AED','SAR'] as const;
const amount = z.string().regex(/^[1-9]\d{0,15}$/).refine((v) => BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => Number.isFinite(Date.parse(`${v}T00:00:00.000Z`)) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0,10) === v).nullable();
const goalInput = z.object({ id:z.string().uuid().optional(), name:z.string().trim().min(1).max(100), targetMinor:amount, currency:z.enum(currencies), targetDate:date.optional(), createdAt:z.string().datetime({offset:true}).optional(), updatedAt:z.string().datetime({offset:true}).optional() });
const goalUpdateInput = z.object({ name:z.string().trim().min(1).max(100), targetMinor:amount, targetDate:date.optional(), status:z.enum(['active','completed','archived']).optional(), completedAt:z.string().datetime({offset:true}).nullable().optional(), archivedAt:z.string().datetime({offset:true}).nullable().optional(), expectedUpdatedAt:z.string().datetime({offset:true}), updatedAt:z.string().datetime({offset:true}).optional() });
const goalEventInput = z.object({
  id:z.string().uuid(), eventType:z.enum(['planned','allocate','release','transfer_in','transfer_out']), amountMinor:amount,
  currency:z.enum(currencies), accountId:z.string().uuid().nullable().optional(), sourceAccountId:z.string().uuid().optional(),
  destinationAccountId:z.string().uuid().optional(), eventDate:z.string().datetime({offset:true}), note:z.string().max(1000).default(''),
});
const emergencyConfigInput = z.object({ currency:z.enum(currencies), coverageMonths:z.number().int().min(1).max(60), essentialMonthlyMinor:z.string().regex(/^(0|[1-9]\d{0,15})$/).refine((v)=>BigInt(v)<=BigInt(Number.MAX_SAFE_INTEGER)) });
const emergencyEventInput = z.object({ id:z.string().uuid(), eventType:z.enum(['allocate','release','transfer_in','transfer_out']), amountMinor:amount, currency:z.enum(currencies), accountId:z.string().uuid().optional(), sourceAccountId:z.string().uuid().optional(), destinationAccountId:z.string().uuid().optional(), eventDate:z.string().datetime({offset:true}), note:z.string().max(1000).default('') });
class Conflict extends Error { constructor(readonly code:string){super(code);} }
function idemKey(value:string|undefined):string|null { return value && /^[A-Za-z0-9._:-]{8,160}$/.test(value) ? value : null; }
function hash(value:unknown):string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function json(value:unknown):Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value,(_k,v:unknown)=>typeof v==='bigint'?v.toString():v)) as Prisma.InputJsonValue; }
async function change(tx:Prisma.TransactionClient,userId:string,entityType:string,entityId:string,revision:number,payload:unknown):Promise<void> {
  const user=await tx.user.update({where:{id:userId},data:{syncRevision:{increment:1n}},select:{syncRevision:true}});
  await tx.changeLog.create({data:{userId,entityType,entityId,revision,cursor:user.syncRevision,payload:json(payload)}});
}
async function receipt(tx:Prisma.TransactionClient,userId:string,key:string,requestHash:string):Promise<unknown|null> {
  const old=await tx.mutationReceipt.findUnique({where:{userId_idempotencyKey:{userId,idempotencyKey:key}}});
  if(!old)return null;
  if(old.requestHash!==requestHash)throw new Conflict('IDEMPOTENCY_KEY_REUSED');
  return old.response;
}
async function saveReceipt(tx:Prisma.TransactionClient,userId:string,key:string,type:string,requestHash:string,response:unknown,transactionId?:string):Promise<void> {
  await tx.mutationReceipt.create({data:{userId,idempotencyKey:key,mutationType:type,requestHash,response:json(response),...(transactionId?{transactionId}:{})}});
}
async function cashAndReserved(tx:Prisma.TransactionClient,userId:string,accountId:string,currency:string):Promise<{cash:bigint;reserved:bigint}> {
  const rows=await tx.$queryRaw<Array<{cash:bigint;reserved:bigint}>>`
    SELECT
      (a."openingBalanceMinor" + COALESCE(SUM(CASE
        WHEN t."type" IN ('income','refund') AND t."accountId"=a."id" THEN t."amountMinor"
        WHEN t."type"='expense' AND t."accountId"=a."id" THEN -t."amountMinor"
        WHEN t."type"='transfer' AND t."accountId"=a."id" THEN -t."amountMinor"
        WHEN t."type"='transfer' AND t."toAccountId"=a."id" THEN t."amountMinor"
        WHEN t."type"='reversal' AND original."type"='income' AND t."accountId"=a."id" THEN -t."amountMinor"
        WHEN t."type"='reversal' AND original."type"='expense' AND t."accountId"=a."id" THEN t."amountMinor"
        WHEN t."type"='reversal' AND original."type"='transfer' AND t."accountId"=a."id" THEN t."amountMinor"
        WHEN t."type"='reversal' AND original."type"='transfer' AND t."toAccountId"=a."id" THEN -t."amountMinor"
        ELSE 0 END),0))::bigint AS cash,
      (COALESCE((SELECT SUM(CASE WHEN e."eventType" IN ('allocate','transfer_in') THEN e."amountMinor" ELSE -e."amountMinor" END) FROM "SavingsGoalEvent" e WHERE e."userId"=a."userId" AND e."accountId"=a."id"),0)
       + COALESCE((SELECT SUM(CASE WHEN e."eventType" IN ('allocate','transfer_in') THEN e."amountMinor" ELSE -e."amountMinor" END) FROM "EmergencyFundEvent" e WHERE e."userId"=a."userId" AND e."accountId"=a."id"),0))::bigint AS reserved
    FROM "FinanceAccount" a
    LEFT JOIN "FinanceTransaction" t ON t."userId"=a."userId" AND (t."accountId"=a."id" OR t."toAccountId"=a."id")
    LEFT JOIN "FinanceTransaction" original ON original."userId"=t."userId" AND original."id"=t."reversalOfId"
    WHERE a."userId"=${userId} AND a."id"=${accountId} AND a."currency"=${currency} AND a."archivedAt" IS NULL
    GROUP BY a."id",a."userId"`;
  if(!rows[0])throw new Conflict('ACCOUNT_UNAVAILABLE');
  return rows[0];
}
async function createLinkedTransfer(tx:Prisma.TransactionClient,userId:string,input:{id:string;amountMinor:string;currency:string;eventDate:string;note:string;sourceAccountId:string;destinationAccountId:string}):Promise<string> {
  if(input.sourceAccountId===input.destinationAccountId)throw new Conflict('ACCOUNT_UNAVAILABLE');
  const source=await tx.financeAccount.findFirst({where:{id:input.sourceAccountId,userId,archivedAt:null}});
  const destination=await tx.financeAccount.findFirst({where:{id:input.destinationAccountId,userId,archivedAt:null}});
  if(!source||!destination||source.currency!==input.currency||destination.currency!==input.currency)throw new Conflict('ACCOUNT_UNAVAILABLE');
  const sourceTotals=await cashAndReserved(tx,userId,source.id,input.currency);
  if(sourceTotals.cash-BigInt(input.amountMinor)<sourceTotals.reserved)throw new Conflict('INSUFFICIENT_UNRESERVED_FUNDS');
  const transactionId=`fund-transfer:${input.id}`;
  await tx.financeTransaction.create({data:{id:transactionId,userId,amountMinor:BigInt(input.amountMinor),currency:input.currency,type:'transfer',classificationId:'internal_transfer',categoryLabel:'Internal transfer',accountId:source.id,toAccountId:destination.id,occurredAt:new Date(input.eventDate),note:input.note||null,taxStatus:'not_applicable'}});
  return transactionId;
}

export const savingsRoutes=new Hono<{Variables:Vars}>();
savingsRoutes.get('/savings/goals',async(c)=>{
  const userId=c.get('userId');
  const rows=await prisma.savingsGoal.findMany({where:{userId},orderBy:[{createdAt:'desc'},{id:'asc'}]});
  const data=await Promise.all(rows.map(async(goal)=>{
    const totals=await prisma.savingsGoalEvent.groupBy({by:['eventType'],where:{userId,goalId:goal.id},_sum:{amountMinor:true}});
    const sum=(types:string[])=>totals.filter((r)=>types.includes(r.eventType)).reduce((n,r)=>n+(r._sum.amountMinor??0n),0n);
    return {...goal,targetMinor:goal.targetMinor.toString(),actualMinor:(sum(['allocate','transfer_in'])-sum(['release','transfer_out'])).toString(),plannedMinor:sum(['planned']).toString(),targetDate:goal.targetDate?.toISOString().slice(0,10)??null};
  }));
  return c.json({data});
});
savingsRoutes.post('/savings/goals',async(c)=>{
  const key=idemKey(c.req.header('Idempotency-Key')); if(!key)return c.json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'Provide an Idempotency-Key header.'}},400);
  const parsed=goalInput.safeParse(await c.req.json().catch(()=>null)); if(!parsed.success)return c.json({error:{code:'INVALID_SAVINGS_GOAL',message:'Savings goal details are invalid.'}},400);
  const userId=c.get('userId'), p=parsed.data, digest=hash(p);
  try {
    const result=await prisma.$transaction(async(tx)=>{
      const previous=await receipt(tx,userId,key,digest); if(previous)return previous;
      const record=await tx.savingsGoal.create({data:{id:p.id??randomUUID(),userId,name:p.name,targetMinor:BigInt(p.targetMinor),currency:p.currency,targetDate:p.targetDate?new Date(`${p.targetDate}T00:00:00.000Z`):null,...(p.createdAt?{createdAt:new Date(p.createdAt)}:{}),...(p.updatedAt?{updatedAt:new Date(p.updatedAt)}:{})}});
      const response={id:record.id,name:record.name,targetMinor:record.targetMinor.toString(),currency:record.currency,targetDate:record.targetDate?.toISOString().slice(0,10)??null,status:record.status,revision:record.revision,completedAt:null,archivedAt:null,createdAt:record.createdAt.toISOString(),updatedAt:record.updatedAt.toISOString()};
      await saveReceipt(tx,userId,key,'saving.goal.create',digest,response); await change(tx,userId,'savings_goal',record.id,1,response); return response;
    },{isolationLevel:'Serializable'});
    return c.json({data:result,syncStatus:'confirmed'},201);
  } catch(e){ if(e instanceof Conflict)return c.json({error:{code:e.code,message:'This request conflicts with an existing financial record.'}},409); throw e; }
});
savingsRoutes.patch('/savings/goals/:id',async(c)=>{
  const key=idemKey(c.req.header('Idempotency-Key')); if(!key)return c.json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'Provide an Idempotency-Key header.'}},400);
  const parsed=goalUpdateInput.safeParse(await c.req.json().catch(()=>null)); if(!parsed.success)return c.json({error:{code:'INVALID_SAVINGS_GOAL',message:'Savings goal update is invalid.'}},400);
  const userId=c.get('userId'),id=c.req.param('id'),p=parsed.data,digest=hash({id,...p});
  try {
    const result=await prisma.$transaction(async(tx)=>{
      const previous=await receipt(tx,userId,key,digest);if(previous)return previous;
      const current=await tx.savingsGoal.findFirst({where:{id,userId}}); if(!current)throw new Conflict('SAVINGS_GOAL_UNAVAILABLE');
      if(current.updatedAt.toISOString()!==p.expectedUpdatedAt)throw new Conflict('REVISION_CONFLICT');
      if(current.status==='archived')throw new Conflict('SAVINGS_GOAL_UNAVAILABLE');
      const status=p.status??current.status;
      if(status==='completed'){
        const totals=await tx.savingsGoalEvent.groupBy({by:['eventType'],where:{userId,goalId:id},_sum:{amountMinor:true}});
        const actual=totals.filter((r)=>['allocate','transfer_in'].includes(r.eventType)).reduce((n,r)=>n+(r._sum.amountMinor??0n),0n)-totals.filter((r)=>['release','transfer_out'].includes(r.eventType)).reduce((n,r)=>n+(r._sum.amountMinor??0n),0n);
        if(actual<BigInt(p.targetMinor))throw new Conflict('GOAL_TARGET_NOT_REACHED');
      }
      const updatedAt=new Date(Math.max(Date.now(),current.updatedAt.getTime()+1));
      const updated=await tx.savingsGoal.update({where:{id_userId:{id,userId}},data:{name:p.name,targetMinor:BigInt(p.targetMinor),targetDate:p.targetDate?new Date(`${p.targetDate}T00:00:00.000Z`):null,status,completedAt:status==='completed'?(p.completedAt?new Date(p.completedAt):updatedAt):null,archivedAt:status==='archived'?(p.archivedAt?new Date(p.archivedAt):updatedAt):null,updatedAt,revision:{increment:1}}});
      const revision=updated.revision;
      const response={id:updated.id,name:updated.name,targetMinor:updated.targetMinor.toString(),currency:updated.currency,targetDate:updated.targetDate?.toISOString().slice(0,10)??null,status:updated.status,completedAt:updated.completedAt?.toISOString()??null,archivedAt:updated.archivedAt?.toISOString()??null,createdAt:updated.createdAt.toISOString(),updatedAt:updated.updatedAt.toISOString(),revision};
      await saveReceipt(tx,userId,key,'saving.goal.update',digest,response);await change(tx,userId,'savings_goal',id,revision,response);return response;
    },{isolationLevel:'Serializable'});
    return c.json({data:result,syncStatus:'confirmed'});
  } catch(e){if(e instanceof Conflict)return c.json({error:{code:e.code,message:e.code==='REVISION_CONFLICT'?'The savings goal changed on another device. Refresh before editing.':'The savings goal is unavailable.'}},e.code==='REVISION_CONFLICT'?409:404);throw e;}
});
savingsRoutes.post('/savings/goals/:id/events',async(c)=>{
  const key=idemKey(c.req.header('Idempotency-Key'));if(!key)return c.json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'Provide an Idempotency-Key header.'}},400);
  const parsed=goalEventInput.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:{code:'INVALID_SAVINGS_EVENT',message:'Savings event details are invalid.'}},400);
  const userId=c.get('userId'),goalId=c.req.param('id'),p=parsed.data,digest=hash({goalId,...p});
  try{
    const result=await prisma.$transaction(async(tx)=>{
      const previous=await receipt(tx,userId,key,digest);if(previous)return previous;
      const goal=await tx.savingsGoal.findFirst({where:{id:goalId,userId}});if(!goal)throw new Conflict('SAVINGS_GOAL_UNAVAILABLE');
      if(goal.currency!==p.currency)throw new Conflict('CURRENCY_MISMATCH');
      if(goal.status!=='active'&& !['release','transfer_out'].includes(p.eventType))throw new Conflict('SAVINGS_GOAL_INACTIVE');
      let accountId:string|null=null,transactionId:string|null=null;
      if(p.eventType==='planned') {if(p.accountId||p.sourceAccountId||p.destinationAccountId)throw new Conflict('INVALID_EVENT_SHAPE');}
      else if(p.eventType==='allocate'||p.eventType==='release'){
        if(!p.accountId||p.sourceAccountId||p.destinationAccountId)throw new Conflict('INVALID_EVENT_SHAPE');
        accountId=p.accountId;
        const totals=await cashAndReserved(tx,userId,accountId,p.currency);
        if(p.eventType==='allocate'&&totals.cash-totals.reserved<BigInt(p.amountMinor))throw new Conflict('INSUFFICIENT_UNRESERVED_FUNDS');
        if(p.eventType==='release'){
          const reserved=await tx.$queryRaw<Array<{amount:bigint}>>`SELECT COALESCE(SUM(CASE WHEN "eventType" IN ('allocate','transfer_in') THEN "amountMinor" ELSE -"amountMinor" END),0)::bigint AS amount FROM "SavingsGoalEvent" WHERE "userId"=${userId} AND "goalId"=${goalId} AND "accountId"=${accountId}`;
          if((reserved[0]?.amount??0n)<BigInt(p.amountMinor))throw new Conflict('INSUFFICIENT_GOAL_RESERVATION');
        }
      } else {
        if(!p.sourceAccountId||!p.destinationAccountId||p.accountId)throw new Conflict('INVALID_EVENT_SHAPE');
        const actualAccount=p.eventType==='transfer_in'?p.destinationAccountId:p.sourceAccountId;
        if(p.eventType==='transfer_out'){
          const reserved=await tx.$queryRaw<Array<{amount:bigint}>>`SELECT COALESCE(SUM(CASE WHEN "eventType" IN ('allocate','transfer_in') THEN "amountMinor" ELSE -"amountMinor" END),0)::bigint AS amount FROM "SavingsGoalEvent" WHERE "userId"=${userId} AND "goalId"=${goalId} AND "accountId"=${actualAccount}`;
          if((reserved[0]?.amount??0n)<BigInt(p.amountMinor))throw new Conflict('INSUFFICIENT_GOAL_RESERVATION');
        }
        accountId=actualAccount;
        transactionId=await createLinkedTransfer(tx,userId,{id:p.id,amountMinor:p.amountMinor,currency:p.currency,eventDate:p.eventDate,note:p.note,sourceAccountId:p.sourceAccountId,destinationAccountId:p.destinationAccountId});
        if(p.eventType==='transfer_in'){
          const totals=await cashAndReserved(tx,userId,accountId,p.currency);
          if(totals.cash-totals.reserved<BigInt(p.amountMinor))throw new Conflict('INCONSISTENT_FUND_ALLOCATION');
        }
      }
      const event=await tx.savingsGoalEvent.create({data:{id:p.id,userId,goalId,eventType:p.eventType,amountMinor:BigInt(p.amountMinor),currency:p.currency,accountId,transactionId,idempotencyKey:key,eventDate:new Date(p.eventDate),note:p.note}});
      const response={...event,amountMinor:event.amountMinor.toString(),eventDate:event.eventDate.toISOString(),createdAt:event.createdAt.toISOString()};
      await saveReceipt(tx,userId,key,'saving.goal.event',digest,response,transactionId??undefined);
      if(transactionId)await change(tx,userId,'transaction',transactionId,1,{id:transactionId,type:'transfer',amountMinor:p.amountMinor,currency:p.currency,classificationId:'internal_transfer',categoryLabel:'Internal transfer',accountId:p.sourceAccountId,toAccountId:p.destinationAccountId,occurredAt:p.eventDate,note:p.note,taxStatus:'not_applicable'});
      await change(tx,userId,'savings_goal_event',event.id,1,response);
      return response;
    },{isolationLevel:'Serializable'});
    return c.json({data:result,syncStatus:'confirmed'},201);
  }catch(e){if(e instanceof Conflict){const unavailable=e.code==='SAVINGS_GOAL_UNAVAILABLE';return c.json({error:{code:e.code,message:unavailable?'The savings goal is unavailable.':'The savings event conflicts with the current account, goal, or available funds.'}},unavailable?404:409);}throw e;}
});
savingsRoutes.get('/emergency-fund/config',async(c)=>{
  const userId=c.get('userId'),config=await prisma.emergencyFundConfig.findUnique({where:{userId}});
  if(!config)return c.json({data:null});
  const events=await prisma.emergencyFundEvent.groupBy({by:['eventType'],where:{userId},_sum:{amountMinor:true}});
  const sum=(types:string[])=>events.filter((e)=>types.includes(e.eventType)).reduce((n,e)=>n+(e._sum.amountMinor??0n),0n);
  return c.json({data:{...config,essentialMonthlyMinor:config.essentialMonthlyMinor.toString(),allocatedMinor:(sum(['allocate','transfer_in'])-sum(['release','transfer_out'])).toString()}});
});
savingsRoutes.put('/emergency-fund/config',async(c)=>{
  const key=idemKey(c.req.header('Idempotency-Key'));if(!key)return c.json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'Provide an Idempotency-Key header.'}},400);
  const parsed=emergencyConfigInput.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:{code:'INVALID_EMERGENCY_CONFIG',message:'Emergency-fund settings are invalid.'}},400);
  const userId=c.get('userId'),p=parsed.data,digest=hash(p);
  try{const result=await prisma.$transaction(async(tx)=>{
    const previous=await receipt(tx,userId,key,digest);if(previous)return previous;
    const old=await tx.emergencyFundConfig.findUnique({where:{userId}});
    if(old&&old.currency!==p.currency){const count=await tx.emergencyFundEvent.count({where:{userId}});if(count)throw new Conflict('CURRENCY_HAS_HISTORY');}
    const row=await tx.emergencyFundConfig.upsert({where:{userId},create:{userId,currency:p.currency,coverageMonths:p.coverageMonths,essentialMonthlyMinor:BigInt(p.essentialMonthlyMinor)},update:{currency:p.currency,coverageMonths:p.coverageMonths,essentialMonthlyMinor:BigInt(p.essentialMonthlyMinor),updatedAt:new Date(),revision:{increment:1}}});
    const response={...row,essentialMonthlyMinor:row.essentialMonthlyMinor.toString(),updatedAt:row.updatedAt.toISOString()};
    await saveReceipt(tx,userId,key,'emergency.config.save',digest,response);await change(tx,userId,'emergency_config',userId,row.revision,response);return response;
  },{isolationLevel:'Serializable'});return c.json({data:result,syncStatus:'confirmed'});}catch(e){if(e instanceof Conflict)return c.json({error:{code:e.code,message:'Emergency-fund currency cannot change after it has history.'}},409);throw e;}
});
savingsRoutes.post('/emergency-fund/events',async(c)=>{
  const key=idemKey(c.req.header('Idempotency-Key'));if(!key)return c.json({error:{code:'IDEMPOTENCY_KEY_REQUIRED',message:'Provide an Idempotency-Key header.'}},400);
  const parsed=emergencyEventInput.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:{code:'INVALID_EMERGENCY_EVENT',message:'Emergency-fund event details are invalid.'}},400);
  const userId=c.get('userId'),p=parsed.data,digest=hash(p);
  try{const result=await prisma.$transaction(async(tx)=>{
    const previous=await receipt(tx,userId,key,digest);if(previous)return previous;
    const config=await tx.emergencyFundConfig.findUnique({where:{userId}});if(!config)throw new Conflict('EMERGENCY_CONFIG_REQUIRED');if(config.currency!==p.currency)throw new Conflict('CURRENCY_MISMATCH');
    let accountId:string,transactionId:string|null=null;
    if(p.eventType==='allocate'||p.eventType==='release'){
      if(!p.accountId||p.sourceAccountId||p.destinationAccountId)throw new Conflict('INVALID_EVENT_SHAPE');accountId=p.accountId;
      const totals=await cashAndReserved(tx,userId,accountId,p.currency);
      if(p.eventType==='allocate'&&totals.cash-totals.reserved<BigInt(p.amountMinor))throw new Conflict('INSUFFICIENT_UNRESERVED_FUNDS');
      if(p.eventType==='release'){
        const rows=await tx.$queryRaw<Array<{amount:bigint}>>`SELECT COALESCE(SUM(CASE WHEN "eventType" IN ('allocate','transfer_in') THEN "amountMinor" ELSE -"amountMinor" END),0)::bigint AS amount FROM "EmergencyFundEvent" WHERE "userId"=${userId} AND "accountId"=${accountId}`;
        if((rows[0]?.amount??0n)<BigInt(p.amountMinor))throw new Conflict('INSUFFICIENT_FUND_RESERVATION');
      }
    }else{
      if(!p.sourceAccountId||!p.destinationAccountId||p.accountId)throw new Conflict('INVALID_EVENT_SHAPE');
      accountId=p.eventType==='transfer_in'?p.destinationAccountId:p.sourceAccountId;
      if(p.eventType==='transfer_out'){
        const rows=await tx.$queryRaw<Array<{amount:bigint}>>`SELECT COALESCE(SUM(CASE WHEN "eventType" IN ('allocate','transfer_in') THEN "amountMinor" ELSE -"amountMinor" END),0)::bigint AS amount FROM "EmergencyFundEvent" WHERE "userId"=${userId} AND "accountId"=${accountId}`;
        if((rows[0]?.amount??0n)<BigInt(p.amountMinor))throw new Conflict('INSUFFICIENT_FUND_RESERVATION');
      }
      transactionId=await createLinkedTransfer(tx,userId,{id:p.id,amountMinor:p.amountMinor,currency:p.currency,eventDate:p.eventDate,note:p.note,sourceAccountId:p.sourceAccountId,destinationAccountId:p.destinationAccountId});
    }
    const event=await tx.emergencyFundEvent.create({data:{id:p.id,userId,eventType:p.eventType,amountMinor:BigInt(p.amountMinor),currency:p.currency,accountId,transactionId,idempotencyKey:key,eventDate:new Date(p.eventDate),note:p.note}});
    const response={...event,amountMinor:event.amountMinor.toString(),eventDate:event.eventDate.toISOString(),createdAt:event.createdAt.toISOString()};
    await saveReceipt(tx,userId,key,'emergency.event',digest,response,transactionId??undefined);
    if(transactionId)await change(tx,userId,'transaction',transactionId,1,{id:transactionId,type:'transfer',amountMinor:p.amountMinor,currency:p.currency,classificationId:'internal_transfer',categoryLabel:'Internal transfer',accountId:p.sourceAccountId,toAccountId:p.destinationAccountId,occurredAt:p.eventDate,note:p.note,taxStatus:'not_applicable'});
    await change(tx,userId,'emergency_event',event.id,1,response);return response;
  },{isolationLevel:'Serializable'});return c.json({data:result,syncStatus:'confirmed'},201);}catch(e){if(e instanceof Conflict)return c.json({error:{code:e.code,message:'The emergency-fund event conflicts with its settings, account, or available funds.'}},409);throw e;}
});
