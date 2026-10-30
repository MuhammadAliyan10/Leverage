import { calculateProjectTotals, projectRemainingBudget, splitProjectExpense, type ProjectKind, type ProjectLifecycle, type ProjectSplitMethod } from '../../finance/projects.ts';
import type { CurrencyCode } from '../../finance/domain.ts';

export interface ProjectSql {
  runAsync(sql: string, params: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params: (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params: (string | number | null)[]): Promise<T[]>;
}
export interface ProjectMemberRecord {
  id: string; displayName: string; role: 'owner' | 'editor' | 'viewer'; identityType?: 'local' | 'registered'; cloudUserId?: string | null; targetContributionMinor?: number | null;
}
export interface ProjectRecord {
  id: string; ownerId: string; name: string; description: string; kind: ProjectKind; status: ProjectLifecycle;
  currency: CurrencyCode; startDate: string; endDate: string | null; budgetMinor: number | null; createdAt: string; updatedAt: string;
  expenseMinor: number; refundMinor: number; contributionMinor: number; withdrawalMinor: number; revenueMinor: number;
  groupFundSpentMinor: number; fundBalanceMinor: number; remainingBudgetMinor: number | null; members: ProjectMemberRecord[];
}
export interface ProjectExpenseRecord {
  id: string; amountMinor: number; currency: CurrencyCode; occurredAt: string; category: string; description: string; note: string;
  payerMemberId: string; payerName: string; fundingSource: 'member' | 'group_fund'; splitMethod: ProjectSplitMethod; allocatedMinor: number;
  accountId: string | null; transactionId: string | null; accountName: string | null;
}
export type ProjectsWrite = <T>(work: (sql: ProjectSql) => Promise<T>) => Promise<T>;
export type ProjectAccountExpensePoster = (sql: ProjectSql, input: { ownerId:string;expenseId:string;projectId:string;projectName:string;amountMinor:number;currency:CurrencyCode;category:string;description:string;note?:string;accountId:string;occurredAt:string }) => Promise<string>;
export type ProjectAccountRefundPoster = (sql:ProjectSql,input:{ownerId:string;refundId:string;expenseId:string;expenseTransactionId:string;amountMinor:number;currency:CurrencyCode;accountId:string;occurredAt:string;note?:string})=>Promise<string>;
export type ProjectCloudMutation = (sql:ProjectSql,input:{ownerId:string;projectId:string;mutationId:string;operation:string;payload:Record<string,unknown>})=>Promise<void>;

type ProjectRow = Omit<ProjectRecord, 'expenseMinor' | 'refundMinor' | 'contributionMinor' | 'withdrawalMinor' | 'revenueMinor' | 'groupFundSpentMinor' | 'fundBalanceMinor' | 'remainingBudgetMinor' | 'members'>;
type MemberRow = ProjectMemberRecord & { status: 'active' | 'removed' };
const dateKey = (input: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || new Date(`${input}T00:00:00.000Z`).toISOString().slice(0, 10) !== input) throw new Error('Use a valid project date.');
  return input;
};

export function createProjectsStore(database: ProjectSql, write: ProjectsWrite, postAccountExpense?: ProjectAccountExpensePoster, onAccountExpenseCommitted?: (ownerId:string)=>void, postAccountRefund?:ProjectAccountRefundPoster, queueCloudMutation?:ProjectCloudMutation) {
  const projectRow = async (ownerId: string, projectId: string, sql: ProjectSql = database): Promise<ProjectRow> => {
    const project = await sql.getFirstAsync<ProjectRow>('SELECT * FROM Project WHERE ownerId=? AND id=?', [ownerId, projectId]);
    if (!project) throw new Error('This project is unavailable.');
    return project;
  };

  async function hydrate(ownerId: string, row: ProjectRow, sql: ProjectSql = database): Promise<ProjectRecord> {
    const [members, expenseRows, cashRows, refundRows] = await Promise.all([
      sql.getAllAsync<MemberRow>("SELECT id,displayName,role,identityType,cloudUserId,status,targetContributionMinor FROM ProjectMember WHERE ownerId=? AND projectId=? AND status='active' ORDER BY createdAt,id", [ownerId,row.id]),
      sql.getAllAsync<{eventType: string; amountMinor: number; fundingSource?: string}>("SELECT 'expense' AS eventType,amountMinor,fundingSource FROM ProjectExpense WHERE ownerId=? AND projectId=?", [ownerId,row.id]),
      sql.getAllAsync<{eventType: string; amountMinor: number}>("SELECT eventType,amountMinor FROM ProjectCashEvent WHERE ownerId=? AND projectId=?", [ownerId,row.id]),
      sql.getAllAsync<{amountMinor:number;fundingSource:string}>("SELECT r.amountMinor,e.fundingSource FROM ProjectExpenseRefund r JOIN ProjectExpense e ON e.id=r.expenseId WHERE r.ownerId=? AND r.projectId=?",[ownerId,row.id]),
    ]);
    const totalRows = [...expenseRows.map((event) => ({
      type: 'expense' as const,
      amountMinor: event.amountMinor,
    })), ...refundRows.map((event) => ({type:'refund' as const,amountMinor:event.amountMinor})),
    ...cashRows.filter((event) => event.eventType === 'contribution' || event.eventType === 'revenue').map((event) => ({
      type: event.eventType as 'contribution' | 'revenue', amountMinor: event.amountMinor,
    }))];
    const totals = calculateProjectTotals(totalRows, row.budgetMinor ?? 0);
    totals.expenseMinor = expenseRows.reduce((sum,event) => sum + event.amountMinor,0);
    const withdrawals = cashRows.filter((event) => event.eventType === 'withdrawal').reduce((sum, event) => sum + event.amountMinor, 0);
    const adjustedFund = totals.contributionMinor + totals.externalRevenueMinor + refundRows.filter((event)=>event.fundingSource==='group_fund').reduce((sum,event)=>sum+event.amountMinor,0) - withdrawals - expenseRows
      .filter((event) => event.eventType === 'expense' && event.fundingSource === 'group_fund')
      .reduce((sum, event) => sum + event.amountMinor, 0);
    return {
      ...row,
      members: members.map(({ status: _status, ...member }) => member),
      expenseMinor: totals.expenseMinor,
      refundMinor: totals.refundMinor,
      contributionMinor: totals.contributionMinor,
      withdrawalMinor: withdrawals,
      revenueMinor: totals.externalRevenueMinor,
      groupFundSpentMinor: expenseRows.filter((event) => event.eventType === 'expense' && event.fundingSource === 'group_fund').reduce((sum, event) => sum + event.amountMinor, 0),
      fundBalanceMinor: adjustedFund,
      remainingBudgetMinor: row.budgetMinor === null ? null : projectRemainingBudget(totals),
    };
  }

  return {
    create: async (input: {
      id: string; ownerId: string; name: string; description?: string; kind: ProjectKind; currency: CurrencyCode;
      startDate: string; endDate?: string | null; budgetMinor?: number | null; members: readonly ProjectMemberRecord[];
    }): Promise<ProjectRecord> => write(async (sql) => {
      const name = input.name.trim();
      if (!name || name.length > 100 || input.description?.length! > 2000) throw new Error('Project name or description is invalid.');
      dateKey(input.startDate);
      if (input.endDate) { dateKey(input.endDate); if (input.endDate < input.startDate) throw new Error('The project end date must follow its start date.'); }
      if (input.budgetMinor != null && (!Number.isSafeInteger(input.budgetMinor) || input.budgetMinor < 0)) throw new Error('Project budget must be a non-negative amount.');
      if (!input.members.length || !input.members.some((member) => member.role === 'owner')) throw new Error('A project must have its owner as an active member.');
      if (input.members.some((member) => member.identityType === 'registered' || member.cloudUserId)) throw new Error('Registered project membership requires an authenticated invitation and is not available in offline projects.');
      const now = new Date().toISOString();
      await sql.runAsync('INSERT INTO Project(id,ownerId,name,description,kind,status,currency,startDate,endDate,budgetMinor,createdAt,updatedAt,archivedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,NULL)', [input.id,input.ownerId,name,input.description?.trim() ?? '',input.kind,'active',input.currency,input.startDate,input.endDate ?? null,input.budgetMinor ?? null,now,now]);
      for (const member of input.members) {
        const displayName = member.displayName.trim();
        if (!displayName || displayName.length > 100) throw new Error('A member name is invalid.');
        if (member.targetContributionMinor != null && (!Number.isSafeInteger(member.targetContributionMinor) || member.targetContributionMinor < 0)) throw new Error('Participant contribution target must be a non-negative amount.');
        await sql.runAsync('INSERT INTO ProjectMember(id,ownerId,projectId,displayName,role,identityType,cloudUserId,status,createdAt,targetContributionMinor) VALUES(?,?,?,?,?,?,?,?,?,?)', [member.id,input.ownerId,input.id,displayName,member.role,member.identityType ?? 'local',member.cloudUserId ?? null,'active',now,member.targetContributionMinor ?? null]);
      }
      if(queueCloudMutation){
        const owner=input.members.find((member)=>member.role==='owner')!;
        await queueCloudMutation(sql,{ownerId:input.ownerId,projectId:input.id,mutationId:`project.create:${input.id}`,operation:'project.create',payload:{project:{id:input.id,name,description:input.description?.trim()??'',kind:input.kind,currency:input.currency,startDate:input.startDate,endDate:input.endDate??null,budgetMinor:input.budgetMinor==null?null:String(input.budgetMinor)},ownerMemberId:owner.id}});
        for(const member of input.members.filter((candidate)=>candidate.id!==owner.id)) await queueCloudMutation(sql,{ownerId:input.ownerId,projectId:input.id,mutationId:`project.member.add:${member.id}`,operation:'project.mutate',payload:{operation:'project.member.add',payload:{id:`project.member.add:${member.id}`,memberId:member.id,displayName:member.displayName.trim(),role:member.role,targetContributionMinor:member.targetContributionMinor==null?null:String(member.targetContributionMinor)}}});
      }
      return hydrate(input.ownerId, await projectRow(input.ownerId,input.id,sql), sql);
    }),

    list: async (ownerId: string): Promise<ProjectRecord[]> => {
      const rows = await database.getAllAsync<ProjectRow>('SELECT * FROM Project WHERE ownerId=? ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'planned\' THEN 1 WHEN \'completed\' THEN 2 ELSE 3 END,updatedAt DESC,id', [ownerId]);
      return Promise.all(rows.map((row) => hydrate(ownerId,row)));
    },

    get: async (ownerId: string, projectId: string): Promise<ProjectRecord> => hydrate(ownerId, await projectRow(ownerId,projectId)),

    addMember: async (input: { ownerId: string; projectId: string; member: ProjectMemberRecord }): Promise<void> => write(async (sql) => {
      const project = await projectRow(input.ownerId,input.projectId,sql);
      if (project.status === 'archived' || project.status === 'completed') throw new Error('Reopen this project before adding participants.');
      const name = input.member.displayName.trim();
      if (input.member.identityType === 'registered' || input.member.cloudUserId) throw new Error('Registered project membership requires an authenticated invitation and is not available in offline projects.');
      if (!name || name.length > 100) throw new Error('Enter a valid participant name.');
      if (input.member.targetContributionMinor != null && (!Number.isSafeInteger(input.member.targetContributionMinor) || input.member.targetContributionMinor < 0)) throw new Error('Participant contribution target must be a non-negative amount.');
      await sql.runAsync('INSERT INTO ProjectMember(id,ownerId,projectId,displayName,role,identityType,cloudUserId,status,createdAt,targetContributionMinor) VALUES(?,?,?,?,?,?,?,?,?,?)', [input.member.id,input.ownerId,input.projectId,name,input.member.role,input.member.identityType ?? 'local',input.member.cloudUserId ?? null,'active',new Date().toISOString(),input.member.targetContributionMinor ?? null]);
      await queueCloudMutation?.(sql,{ownerId:input.ownerId,projectId:input.projectId,mutationId:`project.member.add:${input.member.id}`,operation:'project.mutate',payload:{operation:'project.member.add',payload:{id:`project.member.add:${input.member.id}`,memberId:input.member.id,displayName:name,role:input.member.role,targetContributionMinor:input.member.targetContributionMinor==null?null:String(input.member.targetContributionMinor)}}});
      await sql.runAsync('UPDATE Project SET updatedAt=? WHERE id=? AND ownerId=?', [new Date().toISOString(),input.projectId,input.ownerId]);
    }),

    setMemberContributionTarget: async(input:{ownerId:string;projectId:string;memberId:string;targetContributionMinor:number|null}):Promise<void>=>write(async(sql)=>{
      const project=await projectRow(input.ownerId,input.projectId,sql);
      if(project.status==='archived'||project.status==='completed')throw new Error('Reopen this project before changing participant targets.');
      if(input.targetContributionMinor!==null&&(!Number.isSafeInteger(input.targetContributionMinor)||input.targetContributionMinor<0))throw new Error('Participant contribution target must be a non-negative amount.');
      const result=await sql.runAsync("UPDATE ProjectMember SET targetContributionMinor=? WHERE id=? AND ownerId=? AND projectId=? AND status='active'",[input.targetContributionMinor,input.memberId,input.ownerId,input.projectId]);
      void result;
      const member=await sql.getFirstAsync<{id:string}>("SELECT id FROM ProjectMember WHERE id=? AND ownerId=? AND projectId=? AND status='active'",[input.memberId,input.ownerId,input.projectId]);
      if(!member)throw new Error('This project participant is unavailable.');
      await sql.runAsync('UPDATE Project SET updatedAt=? WHERE id=? AND ownerId=?',[new Date().toISOString(),input.projectId,input.ownerId]);
      const mutationId=`project.member.target:${input.memberId}:${Date.now()}`;
      await queueCloudMutation?.(sql,{ownerId:input.ownerId,projectId:input.projectId,mutationId,operation:'project.mutate',payload:{operation:'project.member.target',payload:{id:mutationId,memberId:input.memberId,targetContributionMinor:input.targetContributionMinor==null?null:String(input.targetContributionMinor)}}});
    }),

    addExpense: async (input: {
      id: string; ownerId: string; projectId: string; amountMinor: number; currency: CurrencyCode; occurredAt: string;
      category: string; description: string; note?: string; payerMemberId: string; fundingSource: 'member' | 'group_fund';
      splitMethod: ProjectSplitMethod; participants: readonly { memberId: string; value?: number }[]; recordedByMemberId: string; accountId?: string | null;
    }): Promise<void> => {
      await write(async (sql) => {
      const project = await projectRow(input.ownerId,input.projectId,sql);
      if (project.status === 'completed' || project.status === 'archived') throw new Error('Reopen this project before recording new expenses.');
      if (project.currency !== input.currency) throw new Error('Expense currency must match the project currency. Foreign currency conversion is not enabled for project entries yet.');
      const category = input.category.trim(); const description = input.description.trim();
      if (!category || category.length > 80 || !description || description.length > 200) throw new Error('Expense category and description are required.');
      if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error('Enter a valid expense date.');
      const active = await sql.getAllAsync<{id: string}>("SELECT id FROM ProjectMember WHERE ownerId=? AND projectId=? AND status='active'",[input.ownerId,input.projectId]);
      const activeIds = new Set(active.map((member) => member.id));
      if (!activeIds.has(input.payerMemberId) || !activeIds.has(input.recordedByMemberId) || input.participants.some((member) => !activeIds.has(member.memberId))) throw new Error('Expense participants must be active members of this project.');
      const shares = splitProjectExpense({amountMinor:input.amountMinor,method:input.splitMethod,participants:input.participants});
      const sum = shares.reduce((total, share) => total + share.amountMinor, 0);
      if (sum !== input.amountMinor) throw new Error('Expense allocations do not reconcile to the full amount.');
      const existing=await sql.getFirstAsync<{ownerId:string;projectId:string;amountMinor:number;currency:string;occurredAt:string;category:string;description:string;note:string;payerMemberId:string;fundingSource:string;splitMethod:ProjectSplitMethod;accountId:string|null;transactionId:string|null}>("SELECT ownerId,projectId,amountMinor,currency,occurredAt,category,description,note,payerMemberId,fundingSource,splitMethod,accountId,transactionId FROM ProjectExpense WHERE id=?",[input.id]);
      if(existing){
        const matches=existing.ownerId===input.ownerId&&existing.projectId===input.projectId&&existing.amountMinor===input.amountMinor&&existing.currency===input.currency&&existing.occurredAt===input.occurredAt&&existing.category===category&&existing.description===description&&existing.note===(input.note?.trim()??'')&&existing.payerMemberId===input.payerMemberId&&existing.fundingSource===input.fundingSource&&existing.splitMethod===input.splitMethod&&existing.accountId===(input.accountId??null);
        if(!matches)throw new Error('This project expense ID was already used for different financial details.');
        const priorShares=await sql.getAllAsync<{memberId:string;amountMinor:number}>('SELECT memberId,amountMinor FROM ProjectExpenseShare WHERE expenseId=? ORDER BY memberId',[input.id]);
        const expected=[...shares].sort((a,b)=>a.memberId.localeCompare(b.memberId));
        if(priorShares.length!==expected.length||priorShares.some((share,index)=>share.memberId!==expected[index]?.memberId||share.amountMinor!==expected[index]?.amountMinor))throw new Error('This project expense ID has conflicting participant allocations.');
        return;
      }
      if (input.fundingSource === 'group_fund') {
        const events = await sql.getAllAsync<{amountMinor: number; eventType: string}>("SELECT amountMinor,eventType FROM ProjectCashEvent WHERE ownerId=? AND projectId=? AND currency=?",[input.ownerId,input.projectId,input.currency]);
        const spent = await sql.getFirstAsync<{amountMinor: number | null}>("SELECT COALESCE(SUM(amountMinor),0) AS amountMinor FROM ProjectExpense WHERE ownerId=? AND projectId=? AND currency=? AND fundingSource='group_fund'",[input.ownerId,input.projectId,input.currency]);
        const balance = events.reduce((total,event) => total + (event.eventType === 'contribution' || event.eventType === 'revenue' ? event.amountMinor : -event.amountMinor),0) - (spent?.amountMinor ?? 0);
        if (balance < input.amountMinor) throw new Error('The group fund does not have enough recorded balance for this expense.');
      }
      if (input.accountId && !postAccountExpense) throw new Error('Personal-account project payments are unavailable in this build.');
      const accountId=input.accountId??null;
      if(accountId){const payer=await sql.getFirstAsync<{role:string}>("SELECT role FROM ProjectMember WHERE id=? AND ownerId=? AND projectId=? AND status='active'",[input.payerMemberId,input.ownerId,input.projectId]);if(payer?.role!=='owner')throw new Error('Only your own participant record can be linked to your personal cash account.');}
      const transactionId=accountId?await postAccountExpense!(sql,{ownerId:input.ownerId,expenseId:input.id,projectId:input.projectId,projectName:project.name,amountMinor:input.amountMinor,currency:input.currency,category,description,note:input.note,accountId,occurredAt:input.occurredAt}):null;
      const now = new Date().toISOString();
      await sql.runAsync('INSERT INTO ProjectExpense(id,ownerId,projectId,amountMinor,currency,occurredAt,category,description,note,payerMemberId,fundingSource,splitMethod,recordedByMemberId,createdAt,accountId,transactionId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.projectId,input.amountMinor,input.currency,input.occurredAt,category,description,input.note?.trim() ?? '',input.payerMemberId,input.fundingSource,input.splitMethod,input.recordedByMemberId,now,accountId,transactionId]);
      for (const share of shares) await sql.runAsync('INSERT INTO ProjectExpenseShare(expenseId,ownerId,projectId,memberId,amountMinor) VALUES(?,?,?,?,?)',[input.id,input.ownerId,input.projectId,share.memberId,share.amountMinor]);
      await queueCloudMutation?.(sql,{ownerId:input.ownerId,projectId:input.projectId,mutationId:`project.expense:${input.id}`,operation:'project.mutate',payload:{operation:'project.expense',payload:{id:input.id,amountMinor:String(input.amountMinor),currency:input.currency,occurredAt:input.occurredAt,category,description,note:input.note?.trim()??'',payerMemberId:input.payerMemberId,fundingSource:input.fundingSource,splitMethod:input.splitMethod,recordedByMemberId:input.recordedByMemberId,splitInputs:input.participants.map((entry)=>({memberId:entry.memberId,value:entry.value??1})),shares:shares.map((share)=>({memberId:share.memberId,amountMinor:String(share.amountMinor)}))}}});
      await sql.runAsync('UPDATE Project SET updatedAt=? WHERE id=? AND ownerId=?',[now,input.projectId,input.ownerId]);
      });
      if(input.accountId)onAccountExpenseCommitted?.(input.ownerId);
    },

    addCashEvent: async (input: { id: string; idempotencyKey: string; ownerId: string; projectId: string; memberId?: string | null; eventType: 'contribution' | 'revenue' | 'withdrawal'; amountMinor: number; currency: CurrencyCode; occurredAt: string; note?: string }): Promise<void> => write(async (sql) => {
      const normalizedNote=input.note?.trim()??'';
      const replay=await sql.getFirstAsync<{id:string;ownerId:string;projectId:string;memberId:string|null;eventType:string;amountMinor:number;currency:string;occurredAt:string;note:string;idempotencyKey:string}>("SELECT id,ownerId,projectId,memberId,eventType,amountMinor,currency,occurredAt,note,idempotencyKey FROM ProjectCashEvent WHERE ownerId=? AND (id=? OR idempotencyKey=?)",[input.ownerId,input.id,input.idempotencyKey]);
      if(replay){const matches=replay.id===input.id&&replay.projectId===input.projectId&&replay.memberId===(input.memberId??null)&&replay.eventType===input.eventType&&replay.amountMinor===input.amountMinor&&replay.currency===input.currency&&replay.occurredAt===input.occurredAt&&replay.note===normalizedNote&&replay.idempotencyKey===input.idempotencyKey;if(!matches)throw new Error('This project cash event ID or idempotency key was already used for different financial details.');return;}
      const project = await projectRow(input.ownerId,input.projectId,sql);
      if (project.status === 'completed' || project.status === 'archived') throw new Error('Reopen this project before recording a financial event.');
      if (project.currency !== input.currency) throw new Error('Project cash events must use the project currency.');
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !input.idempotencyKey.trim()) throw new Error('Enter a valid project amount.');
      if ((input.eventType === 'contribution' || input.eventType === 'withdrawal' || input.eventType === 'revenue') && !input.memberId) throw new Error('Choose the participant who owns this fund movement.');
      if(input.memberId){const member=await sql.getFirstAsync<{id:string}>("SELECT id FROM ProjectMember WHERE id=? AND ownerId=? AND projectId=? AND status='active'",[input.memberId,input.ownerId,input.projectId]);if(!member)throw new Error('Choose an active participant in this project.');}
      if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error('Enter a valid event date.');
      if (input.eventType === 'withdrawal') {
        const prior = await sql.getFirstAsync<{amountMinor:number|null}>("SELECT COALESCE(SUM(CASE WHEN eventType IN ('contribution','revenue') THEN amountMinor ELSE -amountMinor END),0) AS amountMinor FROM ProjectCashEvent WHERE ownerId=? AND projectId=? AND currency=?",[input.ownerId,input.projectId,input.currency]);
        const spent = await sql.getFirstAsync<{amountMinor:number|null}>("SELECT COALESCE((SELECT SUM(amountMinor) FROM ProjectExpense WHERE ownerId=? AND projectId=? AND currency=? AND fundingSource='group_fund'),0)-COALESCE((SELECT SUM(r.amountMinor) FROM ProjectExpenseRefund r JOIN ProjectExpense e ON e.id=r.expenseId WHERE e.ownerId=? AND e.projectId=? AND e.currency=? AND e.fundingSource='group_fund'),0) AS amountMinor",[input.ownerId,input.projectId,input.currency,input.ownerId,input.projectId,input.currency]);
        const balance=(prior?.amountMinor??0)-(spent?.amountMinor??0);
        if (balance < input.amountMinor) throw new Error('The group fund does not have enough recorded balance for this withdrawal.');
        const ownership=await memberBalances(input.ownerId,input.projectId,sql);
        if((ownership.get(input.memberId!)??0)<input.amountMinor)throw new Error('A participant cannot withdraw more than their remaining project-fund ownership.');
      }
      const now = new Date().toISOString();
      await sql.runAsync('INSERT INTO ProjectCashEvent(id,ownerId,projectId,memberId,eventType,amountMinor,currency,occurredAt,note,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.projectId,input.memberId ?? null,input.eventType,input.amountMinor,input.currency,input.occurredAt,input.note?.trim() ?? '',input.idempotencyKey,now]);
      await queueCloudMutation?.(sql,{ownerId:input.ownerId,projectId:input.projectId,mutationId:`project.${input.eventType}:${input.id}`,operation:'project.mutate',payload:{operation:`project.${input.eventType}`,payload:{id:input.id,memberId:input.memberId,currency:input.currency,amountMinor:String(input.amountMinor),occurredAt:input.occurredAt,note:input.note?.trim()??''}}});
      await sql.runAsync('UPDATE Project SET updatedAt=? WHERE id=? AND ownerId=?',[now,input.projectId,input.ownerId]);
    }),

    addRefund: async (input:{id:string;idempotencyKey:string;ownerId:string;projectId:string;expenseId:string;amountMinor:number;currency:CurrencyCode;occurredAt:string;note?:string}):Promise<void>=>{
      await write(async(sql)=>{
      const project=await projectRow(input.ownerId,input.projectId,sql);
      if(project.status==='completed'||project.status==='archived')throw new Error('Reopen this project before recording a refund.');
      if(project.currency!==input.currency||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0||!input.idempotencyKey.trim()||!Number.isFinite(Date.parse(input.occurredAt)))throw new Error('Refund details are invalid.');
      const prior=await sql.getFirstAsync<{ownerId:string;projectId:string;expenseId:string;amountMinor:number;currency:string;occurredAt:string;note:string;idempotencyKey:string;transactionId:string|null}>("SELECT ownerId,projectId,expenseId,amountMinor,currency,occurredAt,note,idempotencyKey,transactionId FROM ProjectExpenseRefund WHERE id=?",[input.id]);
      if(prior){if(prior.ownerId!==input.ownerId||prior.projectId!==input.projectId||prior.expenseId!==input.expenseId||prior.amountMinor!==input.amountMinor||prior.currency!==input.currency||prior.occurredAt!==input.occurredAt||prior.note!==(input.note?.trim()??'')||prior.idempotencyKey!==input.idempotencyKey)throw new Error('This project refund ID was already used for different financial details.');return;}
      const expense=await sql.getFirstAsync<{amountMinor:number;currency:string;accountId:string|null;transactionId:string|null}>("SELECT amountMinor,currency,accountId,transactionId FROM ProjectExpense WHERE id=? AND ownerId=? AND projectId=?",[input.expenseId,input.ownerId,input.projectId]);
      if(!expense||expense.currency!==input.currency)throw new Error('The referenced project expense is unavailable or uses a different currency.');
      const refunded=await sql.getFirstAsync<{amountMinor:number|null}>("SELECT COALESCE(SUM(amountMinor),0) AS amountMinor FROM ProjectExpenseRefund WHERE ownerId=? AND projectId=? AND expenseId=?",[input.ownerId,input.projectId,input.expenseId]);
      if((refunded?.amountMinor??0)+input.amountMinor>expense.amountMinor)throw new Error('Refunds cannot exceed the original project expense.');
      if(expense.transactionId&&expense.accountId&&!postAccountRefund)throw new Error('Linked project refunds are unavailable in this build.');
      const transactionId=expense.transactionId&&expense.accountId?await postAccountRefund!(sql,{ownerId:input.ownerId,refundId:input.id,expenseId:input.expenseId,expenseTransactionId:expense.transactionId,amountMinor:input.amountMinor,currency:input.currency,accountId:expense.accountId,occurredAt:input.occurredAt,note:input.note}):null;
      await sql.runAsync('INSERT INTO ProjectExpenseRefund(id,ownerId,projectId,expenseId,amountMinor,currency,occurredAt,note,idempotencyKey,createdAt,transactionId) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.projectId,input.expenseId,input.amountMinor,input.currency,input.occurredAt,input.note?.trim()??'',input.idempotencyKey,new Date().toISOString(),transactionId]);
      await queueCloudMutation?.(sql,{ownerId:input.ownerId,projectId:input.projectId,mutationId:`project.refund:${input.id}`,operation:'project.mutate',payload:{operation:'project.refund',payload:{id:input.id,expenseId:input.expenseId,amountMinor:String(input.amountMinor),currency:input.currency,occurredAt:input.occurredAt,note:input.note?.trim()??''}}});
      });
      if(postAccountRefund)onAccountExpenseCommitted?.(input.ownerId);
    },

    addSettlement: async (input: { id: string; idempotencyKey: string; ownerId: string; projectId: string; fromMemberId: string; toMemberId: string; amountMinor: number; currency: CurrencyCode; occurredAt: string; note?: string }): Promise<void> => write(async (sql) => {
      const normalizedNote=input.note?.trim()??'';
      const replay=await sql.getFirstAsync<{id:string;ownerId:string;projectId:string;fromMemberId:string;toMemberId:string;amountMinor:number;currency:string;occurredAt:string;note:string;idempotencyKey:string}>("SELECT id,ownerId,projectId,fromMemberId,toMemberId,amountMinor,currency,occurredAt,note,idempotencyKey FROM ProjectSettlement WHERE ownerId=? AND (id=? OR idempotencyKey=?)",[input.ownerId,input.id,input.idempotencyKey]);
      if(replay){const matches=replay.id===input.id&&replay.projectId===input.projectId&&replay.fromMemberId===input.fromMemberId&&replay.toMemberId===input.toMemberId&&replay.amountMinor===input.amountMinor&&replay.currency===input.currency&&replay.occurredAt===input.occurredAt&&replay.note===normalizedNote&&replay.idempotencyKey===input.idempotencyKey;if(!matches)throw new Error('This project settlement ID or idempotency key was already used for different financial details.');return;}
      const project = await projectRow(input.ownerId,input.projectId,sql);
      if (project.status === 'completed' || project.status === 'archived') throw new Error('Reopen this project before recording a settlement.');
      if (project.currency !== input.currency || input.fromMemberId === input.toMemberId || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('Settlement details are invalid.');
      const balances = await memberBalances(input.ownerId,input.projectId,sql);
      if ((balances.get(input.fromMemberId) ?? 0) + input.amountMinor > 0 || (balances.get(input.toMemberId) ?? 0) - input.amountMinor < 0) throw new Error('Settlement exceeds the outstanding balance between these participants.');
      await sql.runAsync('INSERT INTO ProjectSettlement(id,ownerId,projectId,fromMemberId,toMemberId,amountMinor,currency,occurredAt,note,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.projectId,input.fromMemberId,input.toMemberId,input.amountMinor,input.currency,input.occurredAt,input.note?.trim() ?? '',input.idempotencyKey,new Date().toISOString()]);
      await queueCloudMutation?.(sql,{ownerId:input.ownerId,projectId:input.projectId,mutationId:`project.settlement:${input.id}`,operation:'project.mutate',payload:{operation:'project.settlement',payload:{id:input.id,fromMemberId:input.fromMemberId,toMemberId:input.toMemberId,amountMinor:String(input.amountMinor),currency:input.currency,occurredAt:input.occurredAt,note:input.note?.trim()??''}}});
    }),

    memberBalances: async (ownerId: string, projectId: string): Promise<{memberId:string;displayName:string;balanceMinor:number}[]> => {
      const members = await database.getAllAsync<{id:string;displayName:string}>("SELECT id,displayName FROM ProjectMember WHERE ownerId=? AND projectId=? AND status='active' ORDER BY displayName,id",[ownerId,projectId]);
      const balances = await memberBalances(ownerId,projectId,database);
      return members.map((member) => ({memberId:member.id,displayName:member.displayName,balanceMinor:balances.get(member.id) ?? 0}));
    },

    contributionTotals: async (ownerId: string, projectId: string): Promise<{memberId:string;amountMinor:number}[]> => database.getAllAsync<{memberId:string;amountMinor:number}>(`SELECT m.id AS memberId,COALESCE(SUM(CASE WHEN e.eventType='contribution' THEN e.amountMinor WHEN e.eventType='withdrawal' THEN -e.amountMinor ELSE 0 END),0) AS amountMinor FROM ProjectMember m LEFT JOIN ProjectCashEvent e ON e.ownerId=m.ownerId AND e.projectId=m.projectId AND e.memberId=m.id WHERE m.ownerId=? AND m.projectId=? AND m.status='active' GROUP BY m.id ORDER BY m.createdAt,m.id`,[ownerId,projectId]),

    expenses: async (ownerId: string, projectId: string): Promise<ProjectExpenseRecord[]> => database.getAllAsync<ProjectExpenseRecord>(`SELECT e.id,e.amountMinor,e.currency,e.occurredAt,e.category,e.description,e.note,e.payerMemberId,p.displayName AS payerName,e.fundingSource,e.splitMethod,e.accountId,e.transactionId,a.name AS accountName,COALESCE((SELECT SUM(s.amountMinor) FROM ProjectExpenseShare s WHERE s.expenseId=e.id),0) AS allocatedMinor FROM ProjectExpense e JOIN ProjectMember p ON p.id=e.payerMemberId AND p.projectId=e.projectId LEFT JOIN Account a ON a.id=e.accountId AND a.ownerId=e.ownerId WHERE e.ownerId=? AND e.projectId=? ORDER BY e.occurredAt DESC,e.id DESC`,[ownerId,projectId]),

    setCategoryBudget: async(input:{id:string;ownerId:string;projectId:string;category:string;amountMinor:number;currency:CurrencyCode}):Promise<void>=>write(async(sql)=>{
      const project=await projectRow(input.ownerId,input.projectId,sql);
      if(project.status==='completed'||project.status==='archived')throw new Error('Reopen this project before changing its category budget.');
      const category=input.category.trim();
      if(!category||category.length>80||project.currency!==input.currency||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<0)throw new Error('Category budget details are invalid.');
      const now=new Date().toISOString();
      await sql.runAsync(`INSERT INTO ProjectBudget(id,ownerId,projectId,category,amountMinor,currency,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(projectId,category) DO UPDATE SET amountMinor=excluded.amountMinor,updatedAt=excluded.updatedAt WHERE ProjectBudget.ownerId=excluded.ownerId`,[input.id,input.ownerId,input.projectId,category,input.amountMinor,input.currency,now,now]);
      await queueCloudMutation?.(sql,{ownerId:input.ownerId,projectId:input.projectId,mutationId:`project.budget:${input.id}:${input.amountMinor}`,operation:'project.mutate',payload:{operation:'project.budget.set',payload:{id:input.id,category,amountMinor:String(input.amountMinor),currency:input.currency}}});
    }),

    categoryBudgets: async(ownerId:string,projectId:string)=>database.getAllAsync<{id:string;category:string;budgetMinor:number;spentMinor:number;remainingMinor:number;currency:CurrencyCode}>(`SELECT b.id,b.category,b.amountMinor AS budgetMinor,b.currency,COALESCE((SELECT SUM(e.amountMinor)-COALESCE((SELECT SUM(r.amountMinor) FROM ProjectExpenseRefund r WHERE r.ownerId=e.ownerId AND r.projectId=e.projectId AND r.expenseId=e.id),0) FROM ProjectExpense e WHERE e.ownerId=b.ownerId AND e.projectId=b.projectId AND e.category=b.category),0) AS spentMinor,b.amountMinor-COALESCE((SELECT SUM(e.amountMinor)-COALESCE((SELECT SUM(r.amountMinor) FROM ProjectExpenseRefund r WHERE r.ownerId=e.ownerId AND r.projectId=e.projectId AND r.expenseId=e.id),0) FROM ProjectExpense e WHERE e.ownerId=b.ownerId AND e.projectId=b.projectId AND e.category=b.category),0) AS remainingMinor FROM ProjectBudget b WHERE b.ownerId=? AND b.projectId=? ORDER BY b.category,b.id`,[ownerId,projectId]),

    complete: async (ownerId: string, projectId: string): Promise<void> => write(async (sql) => {
      const project=await projectRow(ownerId,projectId,sql);
      if(project.status!=='active'&&project.status!=='planned')return;
      const updated = await sql.runAsync("UPDATE Project SET status='completed',updatedAt=? WHERE id=? AND ownerId=? AND status IN ('active','planned')",[new Date().toISOString(),projectId,ownerId]);
      void updated;
      const mutationId=`project.complete:${projectId}:${Date.now()}`;
      await queueCloudMutation?.(sql,{ownerId,projectId,mutationId,operation:'project.mutate',payload:{operation:'project.complete',payload:{id:mutationId}}});
    }),

    reopen: async (ownerId: string, projectId: string): Promise<void> => write(async (sql) => {
      const project = await projectRow(ownerId,projectId,sql);
      if (project.status !== 'archived'&&project.status !=='completed')return;
      if (project.status === 'archived') await sql.runAsync("UPDATE Project SET status='active',archivedAt=NULL,updatedAt=? WHERE id=? AND ownerId=?",[new Date().toISOString(),projectId,ownerId]);
      else await sql.runAsync("UPDATE Project SET status='active',updatedAt=? WHERE id=? AND ownerId=?",[new Date().toISOString(),projectId,ownerId]);
      const mutationId=`project.reopen:${projectId}:${Date.now()}`;
      await queueCloudMutation?.(sql,{ownerId,projectId,mutationId,operation:'project.mutate',payload:{operation:'project.reopen',payload:{id:mutationId}}});
    }),

    archive: async (ownerId: string, projectId: string): Promise<void> => write(async (sql) => {
      const project = await projectRow(ownerId,projectId,sql);
      if (project.status === 'archived') return;
      const now = new Date().toISOString();
      await sql.runAsync("UPDATE Project SET status='archived',archivedAt=?,updatedAt=? WHERE id=? AND ownerId=?",[now,now,projectId,ownerId]);
      const mutationId=`project.archive:${projectId}:${Date.now()}`;
      await queueCloudMutation?.(sql,{ownerId,projectId,mutationId,operation:'project.mutate',payload:{operation:'project.archive',payload:{id:mutationId}}});
    }),
  };
}

async function memberBalances(ownerId: string, projectId: string, sql: ProjectSql): Promise<Map<string,number>> {
  const balances = new Map<string,number>();
  const expenses=await sql.getAllAsync<{id:string;amountMinor:number;payerMemberId:string;fundingSource:string;refundMinor:number}>(`SELECT e.id,e.amountMinor,e.payerMemberId,e.fundingSource,COALESCE((SELECT SUM(r.amountMinor) FROM ProjectExpenseRefund r WHERE r.expenseId=e.id),0) AS refundMinor FROM ProjectExpense e WHERE e.ownerId=? AND e.projectId=? ORDER BY e.occurredAt,e.id`,[ownerId,projectId]);
  for(const expense of expenses){
    const shares=await sql.getAllAsync<{memberId:string;amountMinor:number}>('SELECT memberId,amountMinor FROM ProjectExpenseShare WHERE ownerId=? AND projectId=? AND expenseId=? ORDER BY memberId',[ownerId,projectId,expense.id]);
    const netAmount=expense.amountMinor-expense.refundMinor;
    const scaled: {memberId:string;amountMinor:number}[]=[];
    let allocated=0;
    for(let index=0;index<shares.length;index++){
      const share=shares[index]!;
      const amount=index===shares.length-1?netAmount-allocated:Number(BigInt(netAmount)*BigInt(share.amountMinor)/BigInt(expense.amountMinor));
      allocated+=amount; scaled.push({memberId:share.memberId,amountMinor:amount});
    }
    // The value is a receivable for a member-paid expense. For pooled-fund
    // activity the same member shares instead reduce each member's beneficial
    // ownership of the cash remaining in the fund.
    if(expense.fundingSource==='member'){
      const payerNext=(balances.get(expense.payerMemberId)??0)+netAmount;
      if(!Number.isSafeInteger(payerNext))throw new Error('Participant balances exceed the supported amount range.');
      balances.set(expense.payerMemberId,payerNext);
    }
    for(const share of scaled){
      const next=(balances.get(share.memberId)??0)-share.amountMinor;
      if(!Number.isSafeInteger(next))throw new Error('Participant balances exceed the supported amount range.');
      balances.set(share.memberId,next);
    }
  }
  const cashEvents=await sql.getAllAsync<{memberId:string|null;eventType:'contribution'|'revenue'|'withdrawal';amountMinor:number}>(
    "SELECT memberId,eventType,amountMinor FROM ProjectCashEvent WHERE ownerId=? AND projectId=? AND eventType IN ('contribution','revenue','withdrawal') ORDER BY occurredAt,id",[ownerId,projectId]);
  for(const event of cashEvents){
    // External project revenue has no participant ownership assignment in the
    // existing schema. It remains in fund cash, but never silently changes
    // individual member claims.
    if(!event.memberId)continue;
    const delta=event.eventType==='withdrawal'?-event.amountMinor:event.amountMinor;
    const next=(balances.get(event.memberId)??0)+delta;
    if(!Number.isSafeInteger(next))throw new Error('Participant balances exceed the supported amount range.');
    balances.set(event.memberId,next);
  }
  const settlements=await sql.getAllAsync<{memberId:string;amountMinor:number;kind:'from_settlement'|'to_settlement'}>(`SELECT fromMemberId AS memberId,amountMinor,'from_settlement' AS kind FROM ProjectSettlement WHERE ownerId=? AND projectId=? UNION ALL SELECT toMemberId,amountMinor,'to_settlement' FROM ProjectSettlement WHERE ownerId=? AND projectId=?`,[ownerId,projectId,ownerId,projectId]);
  for (const row of settlements) {
    const delta = row.kind === 'from_settlement' ? row.amountMinor : -row.amountMinor;
    const next = (balances.get(row.memberId) ?? 0) + delta;
    if (!Number.isSafeInteger(next)) throw new Error('Participant balances exceed the supported amount range.');
    balances.set(row.memberId,next);
  }
  return balances;
}
