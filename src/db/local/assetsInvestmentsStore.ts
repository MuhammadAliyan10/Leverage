import { calculateHoldingPosition, ownedAssetValue, type InvestmentEvent } from '../../finance/assetsInvestments.ts';
import { isCurrencyCode } from '../../finance/domain.ts';
import { buildHistoricalAccountBalanceQuery } from './queryBuilders.ts';

export interface AssetSql {
  getFirstAsync<T>(sql: string, params?: readonly (string | number | null)[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params?: readonly (string | number | null)[]): Promise<T[]>;
  runAsync(sql: string, params?: readonly (string | number | null)[]): Promise<unknown>;
}

type TransactionInput = { id: string; ownerId: string; amountMinor: number; type: 'Income' | 'Expense'; categoryId: string; accountId: string; date: string; note: string };
type AssetRow = { id: string; ownerId: string; name: string; category: string; currency: string; purchaseValueMinor: number; purchaseDate: string; ownershipBps: number; notes: string; currentValueMinor: number; currentOwnershipBps: number; valuationDate: string | null; valuationSource: string | null; disposalProceedsMinor: number };
type PortfolioRow = { id: string; ownerId: string; name: string; currency: string; cashAccountId: string; createdAt: string; cashAccountName: string };
type HoldingRow = { id: string; ownerId: string; portfolioId: string; symbol: string; name: string; category: string; currency: string; eventType: InvestmentEvent['eventType']; quantityMicros: number; unitPriceMinor: number; feeMinor: number; amountMinor: number; splitNumerator: number; splitDenominator: number; eventDate: string; currentPriceMinor: number | null; priceDate: string | null; priceSource: string | null; portfolioName: string; cashAccountId: string };

function validIdentity(...values: string[]): void { if (values.some((value) => !value?.trim())) throw new Error('Record ID and profile are required.'); }
function positiveMinor(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${label} must be integer minor units.`);
}
function isoDate(input: string, label: string): string {
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid.`);
  return date.toISOString();
}
function scaledProduct(a: number, b: number, divisor: bigint): number {
  const result = (BigInt(a) * BigInt(b) + divisor / 2n) / divisor;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds the supported range.');
  return Number(result);
}

export function createAssetsInvestmentsStore(read: () => Promise<AssetSql>, write: <T>(task: (sql: AssetSql) => Promise<T>) => Promise<T>) {
  const ensureAccount = async (sql: AssetSql, ownerId: string, accountId: string, currency: string) => {
    const row = await sql.getFirstAsync<{ id: string }>('SELECT id FROM Account WHERE id=? AND ownerId=? AND currency=? AND archivedAt IS NULL', [accountId, ownerId, currency]);
    if (!row) throw new Error('Choose an active account owned by this profile and using the same currency.');
  };
  const postCash = async (sql: AssetSql, input: TransactionInput) => {
    validIdentity(input.id, input.ownerId, input.accountId);
    positiveMinor(input.amountMinor, 'Cash movement');
    const date = isoDate(input.date, 'Cash movement date');
    const account = await sql.getFirstAsync<{ currency: string }>('SELECT currency FROM Account WHERE id=? AND ownerId=? AND archivedAt IS NULL', [input.accountId, input.ownerId]);
    if (!account) throw new Error('Cash account is unavailable.');
    const existing = await sql.getFirstAsync<{ ownerId: string; amountMinor: number; type: string; categoryId: string; accountId: string }>('SELECT ownerId,amountMinor,type,categoryId,accountId FROM "Transaction" WHERE id=?', [input.id]);
    if (existing) {
      if (existing.ownerId !== input.ownerId || existing.amountMinor !== input.amountMinor || existing.type !== input.type || existing.categoryId !== input.categoryId || existing.accountId !== input.accountId) throw new Error('Cash transaction ID is already used for different details.');
    } else {
      await sql.runAsync('INSERT INTO "Transaction"(id,ownerId,amount,amountMinor,type,category,categoryId,classificationId,accountId,toAccountId,date,note,taxStatus,synced) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,\'unreviewed\',0)', [input.id,input.ownerId,input.amountMinor/100,input.amountMinor,input.type,input.categoryId,input.categoryId,null,input.accountId,date,input.note.slice(0,2000)]);
    }
    if(input.type==='Expense'){
      const balance=await sql.getFirstAsync<{amountMinor:number}>('SELECT a.balanceMinor+COALESCE(SUM(CASE WHEN t.type IN (\'Income\',\'Refund\') AND t.accountId=a.id THEN t.amountMinor WHEN t.type=\'Expense\' AND t.accountId=a.id THEN -t.amountMinor WHEN t.type=\'Transfer\' AND t.accountId=a.id THEN -t.amountMinor WHEN t.type=\'Transfer\' AND t.toAccountId=a.id THEN t.amountMinor WHEN t.type=\'Reversal\' AND original.type=\'Income\' AND t.accountId=a.id THEN -t.amountMinor WHEN t.type=\'Reversal\' AND original.type=\'Expense\' AND t.accountId=a.id THEN t.amountMinor WHEN t.type=\'Reversal\' AND original.type=\'Refund\' AND t.accountId=a.id THEN -t.amountMinor WHEN t.type=\'Reversal\' AND original.type=\'Transfer\' AND t.accountId=a.id THEN t.amountMinor WHEN t.type=\'Reversal\' AND original.type=\'Transfer\' AND t.toAccountId=a.id THEN -t.amountMinor ELSE 0 END),0) AS amountMinor FROM Account a LEFT JOIN "Transaction" t ON t.ownerId=a.ownerId AND (t.accountId=a.id OR t.toAccountId=a.id) LEFT JOIN "Transaction" original ON original.id=t.reversalOfId AND original.ownerId=t.ownerId WHERE a.id=? AND a.ownerId=? GROUP BY a.id',[input.accountId,input.ownerId]);
      if(!balance||!Number.isSafeInteger(balance.amountMinor)||balance.amountMinor<0)throw new Error('This purchase would exceed the available account balance.');
    }
  };
  const assetRows = async (sql: AssetSql, ownerId: string): Promise<AssetRow[]> => sql.getAllAsync<AssetRow>(`
    SELECT a.id,a.ownerId,a.name,a.category,a.currency,a.purchaseValueMinor,a.purchaseDate,a.ownershipBps,a.notes,
      COALESCE(v.valueMinor,a.purchaseValueMinor) AS currentValueMinor,
      COALESCE(v.valuationDate,a.purchaseDate) AS valuationDate,COALESCE(v.source,'Purchase value') AS valuationSource,
      a.ownershipBps-COALESCE((SELECT SUM(x.ownershipBps) FROM AssetActivity x WHERE x.assetId=a.id AND x.ownerId=a.ownerId AND x.eventType='disposal'),0) AS currentOwnershipBps,
      COALESCE((SELECT SUM(x.proceedsMinor) FROM AssetActivity x WHERE x.assetId=a.id AND x.ownerId=a.ownerId AND x.eventType='disposal'),0) AS disposalProceedsMinor
    FROM Asset a LEFT JOIN AssetValuation v ON v.id=(SELECT vv.id FROM AssetValuation vv WHERE vv.assetId=a.id AND vv.ownerId=a.ownerId ORDER BY vv.valuationDate DESC,vv.id DESC LIMIT 1)
    WHERE a.ownerId=? ORDER BY a.createdAt DESC,a.id`, [ownerId]);
  const holdingRows = async (sql: AssetSql, ownerId: string): Promise<HoldingRow[]> => sql.getAllAsync<HoldingRow>(`
    SELECT h.id,h.ownerId,h.portfolioId,h.symbol,h.name,h.category,h.currency,e.eventType,e.quantityMicros,e.unitPriceMinor,e.feeMinor,e.amountMinor,e.splitNumerator,e.splitDenominator,e.eventDate,
      COALESCE((SELECT p.unitPriceMinor FROM InvestmentPrice p WHERE p.holdingId=h.id AND p.ownerId=h.ownerId ORDER BY p.priceDate DESC,p.id DESC LIMIT 1),(SELECT e.unitPriceMinor FROM InvestmentEvent e WHERE e.holdingId=h.id AND e.ownerId=h.ownerId AND e.eventType IN ('buy','sell') ORDER BY e.eventDate DESC,e.id DESC LIMIT 1)) AS currentPriceMinor,
      COALESCE((SELECT p.priceDate FROM InvestmentPrice p WHERE p.holdingId=h.id AND p.ownerId=h.ownerId ORDER BY p.priceDate DESC,p.id DESC LIMIT 1),(SELECT e.eventDate FROM InvestmentEvent e WHERE e.holdingId=h.id AND e.ownerId=h.ownerId AND e.eventType IN ('buy','sell') ORDER BY e.eventDate DESC,e.id DESC LIMIT 1)) AS priceDate,
      COALESCE((SELECT p.source FROM InvestmentPrice p WHERE p.holdingId=h.id AND p.ownerId=h.ownerId ORDER BY p.priceDate DESC,p.id DESC LIMIT 1),'Last execution price') AS priceSource,
      ip.name AS portfolioName,ip.cashAccountId
    FROM InvestmentHolding h JOIN InvestmentPortfolio ip ON ip.id=h.portfolioId AND ip.ownerId=h.ownerId
    LEFT JOIN InvestmentEvent e ON e.holdingId=h.id AND e.ownerId=h.ownerId
    WHERE h.ownerId=? ORDER BY ip.name,h.symbol,e.eventDate,e.id`, [ownerId]);
  const mapHoldings = (rows: HoldingRow[]) => {
    const grouped = new Map<string, { meta: HoldingRow; events: InvestmentEvent[] }>();
    for (const row of rows) {
      let holding = grouped.get(row.id);
      if (!holding) { holding = { meta: row, events: [] }; grouped.set(row.id, holding); }
      if (row.eventType) holding.events.push({ eventType: row.eventType, quantityMicros: row.quantityMicros, unitPriceMinor: row.unitPriceMinor, feeMinor: row.feeMinor, amountMinor: row.amountMinor, splitNumerator: row.splitNumerator, splitDenominator: row.splitDenominator });
    }
    return [...grouped.values()].map(({ meta, events }) => ({ ...meta, ...calculateHoldingPosition(events, meta.currentPriceMinor), priceDate: meta.priceDate, priceSource: meta.priceSource }));
  };
  const historyData = async (ownerId:string,dates:readonly string[]) => {
    validIdentity(ownerId);const sql=await read();
    const accountBalanceSnapshots=await Promise.all(dates.map(async(asOfDate)=>{
      const query=buildHistoricalAccountBalanceQuery(ownerId,asOfDate);
      const accounts=await sql.getAllAsync<{id:string;ownerId:string;name:string;type:string;balanceMinor:number;currency:string;createdAt:string;archivedAt:string|null; synced:number}>(query.sql,query.params);
      return {asOfDate,accounts:accounts.map((account)=>({...account,synced:Boolean(account.synced)}))};
    }));
    const groupBy = <T,>(rows: readonly T[], keyOf: (row:T)=>string): Map<string,T[]> => {
      const groups=new Map<string,T[]>();
      for(const row of rows){const key=keyOf(row);const group=groups.get(key);if(group)group.push(row);else groups.set(key,[row]);}
      return groups;
    };
    const assetRows=await sql.getAllAsync<{id:string;currency:string;purchaseDate:string;purchaseValueMinor:number;ownershipBps:number}>('SELECT id,currency,purchaseDate,purchaseValueMinor,ownershipBps FROM Asset WHERE ownerId=?',[ownerId]);
    const valuations=await sql.getAllAsync<{assetId:string;valueMinor:number;valuationDate:string}>('SELECT assetId,valueMinor,valuationDate FROM AssetValuation WHERE ownerId=? ORDER BY assetId,valuationDate,id',[ownerId]);
    const disposals=await sql.getAllAsync<{assetId:string;ownershipBps:number;eventDate:string}>('SELECT assetId,ownershipBps,eventDate FROM AssetActivity WHERE ownerId=? AND eventType=\'disposal\' ORDER BY assetId,eventDate,id',[ownerId]);
    const valuationsByAsset=groupBy(valuations,(row)=>row.assetId);
    const disposalsByAsset=groupBy(disposals,(row)=>row.assetId);
    const assets=assetRows.map((asset)=>({ ...asset,
      valuations:(valuationsByAsset.get(asset.id)??[]).map((row)=>({valueMinor:row.valueMinor,date:row.valuationDate})),
      disposals:(disposalsByAsset.get(asset.id)??[]).map((row)=>({ownershipBps:row.ownershipBps,date:row.eventDate})),
    }));
    const holdingRows=await sql.getAllAsync<{id:string;currency:string}>('SELECT id,currency FROM InvestmentHolding WHERE ownerId=?',[ownerId]);
    const investmentEvents=await sql.getAllAsync<{holdingId:string;eventType:InvestmentEvent['eventType'];quantityMicros:number;unitPriceMinor:number;feeMinor:number;amountMinor:number;splitNumerator:number;splitDenominator:number;eventDate:string}>('SELECT holdingId,eventType,quantityMicros,unitPriceMinor,feeMinor,amountMinor,splitNumerator,splitDenominator,eventDate FROM InvestmentEvent WHERE ownerId=? ORDER BY holdingId,eventDate,id',[ownerId]);
    const prices=await sql.getAllAsync<{holdingId:string;unitPriceMinor:number;priceDate:string}>('SELECT holdingId,unitPriceMinor,priceDate FROM InvestmentPrice WHERE ownerId=? ORDER BY holdingId,priceDate,id',[ownerId]);
    const eventsByHolding=groupBy(investmentEvents,(row)=>row.holdingId);
    const pricesByHolding=groupBy(prices,(row)=>row.holdingId);
    const holdings=holdingRows.map((holding)=>({ ...holding,
      events:(eventsByHolding.get(holding.id)??[]).map((row)=>({eventType:row.eventType,quantityMicros:row.quantityMicros,unitPriceMinor:row.unitPriceMinor,feeMinor:row.feeMinor,amountMinor:row.amountMinor,splitNumerator:row.splitNumerator,splitDenominator:row.splitDenominator,date:row.eventDate})),
      prices:(pricesByHolding.get(holding.id)??[]).map((row)=>({unitPriceMinor:row.unitPriceMinor,date:row.priceDate})),
    }));
    const debtRows=await sql.getAllAsync<{id:string;direction:'borrowed'|'lent';currency:string;principalMinor:number;openedAt:string}>('SELECT id,direction,currency,principalMinor,openedAt FROM Debt WHERE ownerId=?',[ownerId]);
    const debtEvents=await sql.getAllAsync<{debtId:string;id:string;eventType:string;principalMinor:number;interestMinor:number;eventDate:string}>('SELECT debtId,id,eventType,principalMinor,interestMinor,eventDate FROM DebtEvent WHERE ownerId=? ORDER BY debtId,eventDate,id',[ownerId]);
    const corrections=await sql.getAllAsync<{debtId:string;originalEventId:string;createdAt:string}>('SELECT debtId,originalEventId,createdAt FROM DebtEventCorrection WHERE ownerId=? ORDER BY debtId,createdAt,id',[ownerId]);
    const interestEvents=await sql.getAllAsync<{debtId:string;eventType:'charge'|'reversal';amountMinor:number;eventDate:string}>('SELECT debtId,eventType,amountMinor,eventDate FROM DebtInterestEvent WHERE ownerId=? ORDER BY debtId,eventDate,id',[ownerId]);
    const debtEventsByDebt=groupBy(debtEvents,(row)=>row.debtId);
    const correctionsByDebt=groupBy(corrections,(row)=>row.debtId);
    const interestEventsByDebt=groupBy(interestEvents,(row)=>row.debtId);
    const debts=debtRows.map((debt)=>({ ...debt,
      events:debtEventsByDebt.get(debt.id)??[],
      corrections:correctionsByDebt.get(debt.id)??[],
      interestEvents:interestEventsByDebt.get(debt.id)??[],
    }));
    return {assets,holdings,debts,accountBalanceSnapshots};
  };

  return {
    historyData,
    asset: {
      list: async (ownerId: string) => {
        validIdentity(ownerId); const sql = await read();
        return (await assetRows(sql, ownerId)).map((row) => ({ ...row, ownedValueMinor: ownedAssetValue({ currency: row.currency, ownershipBps: row.currentOwnershipBps, currentValueMinor: row.currentValueMinor }), status: row.currentOwnershipBps === 0 ? (row.disposalProceedsMinor > 0 ? 'sold' : 'disposed') : 'active' }));
      },
      create: async (input: { id:string;ownerId:string;name:string;category:'property'|'vehicle'|'precious_metal'|'valuable'|'business_equity'|'other';currency:string;purchaseValueMinor:number;purchaseDate:string;ownershipBps:number;notes?:string;fundingAccountId?:string|null;transactionId?:string|null;idempotencyKey:string }) => write(async (sql) => {
        validIdentity(input.id,input.ownerId,input.idempotencyKey);
        if (!isCurrencyCode(input.currency) || !Number.isSafeInteger(input.ownershipBps) || input.ownershipBps < 1 || input.ownershipBps > 10000) throw new Error('Asset currency or ownership share is invalid.');
        positiveMinor(input.purchaseValueMinor,'Purchase value');
        const date=isoDate(input.purchaseDate,'Purchase date');
        if(Date.parse(date)>Date.now())throw new Error('Asset purchase date cannot be in the future.');
        const existing=await sql.getFirstAsync<{id:string;ownerId:string;name:string;category:string;currency:string;purchaseValueMinor:number;purchaseDate:string;ownershipBps:number}>('SELECT id,ownerId,name,category,currency,purchaseValueMinor,purchaseDate,ownershipBps FROM Asset WHERE id=?',[input.id]);
        if(existing){const activity=await sql.getFirstAsync<{accountId:string|null;transactionId:string|null}>('SELECT accountId,transactionId FROM AssetActivity WHERE assetId=? AND ownerId=? AND eventType=\'acquisition\'',[input.id,input.ownerId]);const expectedTransaction=input.fundingAccountId?(input.transactionId??`${input.id}:purchase`):null;if(existing.ownerId!==input.ownerId||existing.name!==input.name.trim()||existing.category!==input.category||existing.currency!==input.currency||existing.purchaseValueMinor!==input.purchaseValueMinor||existing.purchaseDate!==date||existing.ownershipBps!==input.ownershipBps||activity?.accountId!==(input.fundingAccountId??null)||activity?.transactionId!==expectedTransaction) throw new Error('Asset ID was already used for different details.');return (await assetRows(sql,input.ownerId)).find((row)=>row.id===input.id)!;}
        const notes=(input.notes??'').trim();if(notes.length>2000)throw new Error('Notes must be 2,000 characters or fewer.');
        const cost=scaledProduct(input.purchaseValueMinor,input.ownershipBps,10000n);
        if(input.fundingAccountId){if(cost<=0)throw new Error('Your owned share of the purchase must be at least one minor currency unit.');await ensureAccount(sql,input.ownerId,input.fundingAccountId,input.currency);await postCash(sql,{id:input.transactionId??`${input.id}:purchase`,ownerId:input.ownerId,amountMinor:cost,type:'Expense',categoryId:'asset_purchase',accountId:input.fundingAccountId,date,note:`Asset purchase · ${input.name}`});}
        await sql.runAsync('INSERT INTO Asset(id,ownerId,name,category,currency,purchaseValueMinor,purchaseDate,ownershipBps,notes,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.name.trim(),input.category,input.currency,input.purchaseValueMinor,date,input.ownershipBps,notes,new Date().toISOString()]);
        await sql.runAsync('INSERT INTO AssetValuation(id,ownerId,assetId,valueMinor,valuationDate,source,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?)',[`${input.id}:initial-valuation`,input.ownerId,input.id,input.purchaseValueMinor,date,'Purchase value',`${input.idempotencyKey}:valuation`,new Date().toISOString()]);
        await sql.runAsync('INSERT INTO AssetActivity(id,ownerId,assetId,eventType,ownershipBps,costBasisMinor,proceedsMinor,accountId,transactionId,eventDate,idempotencyKey,createdAt) VALUES(?,?,? ,\'acquisition\',?,?,0,?,?,?,?,?)',[`${input.id}:acquisition`,input.ownerId,input.id,input.ownershipBps,cost,input.fundingAccountId??null,input.fundingAccountId?(input.transactionId??`${input.id}:purchase`):null,date,input.idempotencyKey,new Date().toISOString()]);
        return (await assetRows(sql,input.ownerId)).find((row)=>row.id===input.id)!;
      }),
      update: async(input:{ownerId:string;assetId:string;name:string;category:'property'|'vehicle'|'precious_metal'|'valuable'|'business_equity'|'other';notes?:string})=>write(async(sql)=>{
        validIdentity(input.ownerId,input.assetId);const name=input.name.trim();const notes=(input.notes??'').trim();if(name.length<1||name.length>120||notes.length>2000)throw new Error('Asset details are invalid.');
        const result=await sql.runAsync('UPDATE Asset SET name=?,category=?,notes=? WHERE id=? AND ownerId=?',[name,input.category,notes,input.assetId,input.ownerId]);void result;
        const row=(await assetRows(sql,input.ownerId)).find((item)=>item.id===input.assetId);if(!row)throw new Error('Asset was not found for this profile.');return row;
      }),
      addValuation: async(input:{id:string;ownerId:string;assetId:string;valueMinor:number;valuationDate:string;source:string;idempotencyKey:string})=>write(async(sql)=>{
        validIdentity(input.id,input.ownerId,input.assetId,input.idempotencyKey);positiveMinor(input.valueMinor,'Estimated value',true);const date=isoDate(input.valuationDate,'Valuation date');if(Date.parse(date)>Date.now())throw new Error('Valuation date cannot be in the future.');const source=input.source.trim();if(source.length<1||source.length>120)throw new Error('Valuation source must be between 1 and 120 characters.');
        const existing=await sql.getFirstAsync<{id:string;ownerId:string;assetId:string;valueMinor:number;valuationDate:string;source:string}>('SELECT id,ownerId,assetId,valueMinor,valuationDate,source FROM AssetValuation WHERE id=? OR (ownerId=? AND idempotencyKey=?) LIMIT 1',[input.id,input.ownerId,input.idempotencyKey]);if(existing){if(existing.ownerId!==input.ownerId||existing.assetId!==input.assetId||existing.valueMinor!==input.valueMinor||existing.valuationDate!==date||existing.source!==source)throw new Error('Valuation request conflicts with existing history.');return;}
        await sql.runAsync('INSERT INTO AssetValuation(id,ownerId,assetId,valueMinor,valuationDate,source,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.assetId,input.valueMinor,date,source,input.idempotencyKey,new Date().toISOString()]);
      }),
      dispose: async(input:{id:string;ownerId:string;assetId:string;portionBps:number;proceedsMinor:number;accountId?:string|null;transactionId?:string|null;eventDate:string;idempotencyKey:string})=>write(async(sql)=>{
        validIdentity(input.id,input.ownerId,input.assetId,input.idempotencyKey);if(!Number.isSafeInteger(input.portionBps)||input.portionBps<1||input.portionBps>10000)throw new Error('Disposal share must be between 0.01% and 100%.');positiveMinor(input.proceedsMinor,'Sale proceeds',true);const date=isoDate(input.eventDate,'Disposal date');if(Date.parse(date)>Date.now())throw new Error('Disposal date cannot be in the future.');
        const prior=await sql.getFirstAsync<{ownerId:string;assetId:string;ownershipBps:number;costBasisMinor:number;proceedsMinor:number;eventDate:string}>('SELECT ownerId,assetId,ownershipBps,costBasisMinor,proceedsMinor,eventDate FROM AssetActivity WHERE id=? OR (ownerId=? AND idempotencyKey=?) LIMIT 1',[input.id,input.ownerId,input.idempotencyKey]);if(prior){if(prior.ownerId!==input.ownerId||prior.assetId!==input.assetId||prior.proceedsMinor!==input.proceedsMinor||prior.eventDate!==date)throw new Error('Disposal request conflicts with existing history.');const current=(await assetRows(sql,input.ownerId)).find((row)=>row.id===input.assetId)?.currentOwnershipBps??0;return {disposedOwnershipBps:prior.ownershipBps,costBasisMinor:prior.costBasisMinor,remainingOwnershipBps:current};}
        const asset=(await assetRows(sql,input.ownerId)).find((row)=>row.id===input.assetId);if(!asset||asset.currentOwnershipBps<=0)throw new Error('Active asset was not found.');
        const disposed=scaledProduct(asset.currentOwnershipBps,input.portionBps,10000n);if(disposed<1)throw new Error('Disposal share is smaller than the supported ownership precision.');
        const currentBasis=scaledProduct(asset.purchaseValueMinor,asset.currentOwnershipBps,BigInt(asset.ownershipBps));const cost=disposed===asset.currentOwnershipBps?currentBasis:scaledProduct(currentBasis,disposed,BigInt(asset.currentOwnershipBps));
        if(input.proceedsMinor>0){if(!input.accountId)throw new Error('Choose an account for sale proceeds.');await ensureAccount(sql,input.ownerId,input.accountId,asset.currency);await postCash(sql,{id:input.transactionId??`${input.id}:proceeds`,ownerId:input.ownerId,amountMinor:input.proceedsMinor,type:'Income',categoryId:'asset_sale_proceeds',accountId:input.accountId,date,note:`Asset disposal · ${asset.name}`});}
        await sql.runAsync('INSERT INTO AssetActivity(id,ownerId,assetId,eventType,ownershipBps,costBasisMinor,proceedsMinor,accountId,transactionId,eventDate,idempotencyKey,createdAt) VALUES(?,?,?,\'disposal\',?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.assetId,disposed,cost,input.proceedsMinor,input.proceedsMinor>0?input.accountId??null:null,input.proceedsMinor>0?(input.transactionId??`${input.id}:proceeds`):null,date,input.idempotencyKey,new Date().toISOString()]);
        return {disposedOwnershipBps:disposed,costBasisMinor:cost,remainingOwnershipBps:asset.currentOwnershipBps-disposed};
      }),
      history: async(ownerId:string,assetId:string)=>{validIdentity(ownerId,assetId);const sql=await read();return sql.getAllAsync<{id:string;valueMinor:number;valuationDate:string;source:string}>('SELECT id,valueMinor,valuationDate,source FROM AssetValuation WHERE ownerId=? AND assetId=? ORDER BY valuationDate DESC,id DESC',[ownerId,assetId]);},
    },
    portfolio: {
      list: async(ownerId:string)=>{validIdentity(ownerId);const sql=await read();return sql.getAllAsync<PortfolioRow>('SELECT p.id,p.ownerId,p.name,p.currency,p.cashAccountId,p.createdAt,a.name AS cashAccountName FROM InvestmentPortfolio p JOIN Account a ON a.id=p.cashAccountId AND a.ownerId=p.ownerId WHERE p.ownerId=? ORDER BY p.name,p.currency',[ownerId]);},
      create: async(input:{id:string;ownerId:string;name:string;currency:string;cashAccountId:string})=>write(async(sql)=>{validIdentity(input.id,input.ownerId,input.cashAccountId);const name=input.name.trim();if(name.length<1||name.length>120||!/^[A-Z]{3}$/.test(input.currency))throw new Error('Portfolio details are invalid.');const existing=await sql.getFirstAsync<{ownerId:string;name:string;currency:string;cashAccountId:string}>('SELECT ownerId,name,currency,cashAccountId FROM InvestmentPortfolio WHERE id=?',[input.id]);if(existing){if(existing.ownerId!==input.ownerId||existing.name!==name||existing.currency!==input.currency||existing.cashAccountId!==input.cashAccountId)throw new Error('Portfolio ID was already used for different details.');return {...input,name};}await ensureAccount(sql,input.ownerId,input.cashAccountId,input.currency);await sql.runAsync('INSERT INTO InvestmentPortfolio(id,ownerId,name,currency,cashAccountId,createdAt) VALUES(?,?,?,?,?,?)',[input.id,input.ownerId,name,input.currency,input.cashAccountId,new Date().toISOString()]);return {...input,name};}),
    },
    holding: {
      list: async(ownerId:string)=>{validIdentity(ownerId);const sql=await read();return mapHoldings(await holdingRows(sql,ownerId));},
      create: async(input:{id:string;ownerId:string;portfolioId:string;symbol:string;name:string;category:'stock'|'etf'|'mutual_fund'|'bond'|'sukuk'|'gold'|'crypto'|'other'})=>write(async(sql)=>{validIdentity(input.id,input.ownerId,input.portfolioId);const symbol=input.symbol.trim().toUpperCase();const name=input.name.trim();if(symbol.length<1||symbol.length>24||name.length<1||name.length>120)throw new Error('Holding details are invalid.');const existing=await sql.getFirstAsync<{ownerId:string;portfolioId:string;symbol:string;name:string;category:string}>('SELECT ownerId,portfolioId,symbol,name,category FROM InvestmentHolding WHERE id=?',[input.id]);if(existing){if(existing.ownerId!==input.ownerId||existing.portfolioId!==input.portfolioId||existing.symbol!==symbol||existing.name!==name||existing.category!==input.category)throw new Error('Holding ID was already used for different details.');return {...input,symbol,name};}const portfolio=await sql.getFirstAsync<{currency:string}>('SELECT currency FROM InvestmentPortfolio WHERE id=? AND ownerId=?',[input.portfolioId,input.ownerId]);if(!portfolio)throw new Error('Portfolio was not found for this profile.');await sql.runAsync('INSERT INTO InvestmentHolding(id,ownerId,portfolioId,symbol,name,category,currency,createdAt) VALUES(?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.portfolioId,symbol,name,input.category,portfolio.currency,new Date().toISOString()]);return {...input,symbol,name};}),
      setPrice: async(input:{id:string;ownerId:string;holdingId:string;unitPriceMinor:number;priceDate:string;source:string;idempotencyKey:string})=>write(async(sql)=>{validIdentity(input.id,input.ownerId,input.holdingId,input.idempotencyKey);positiveMinor(input.unitPriceMinor,'Market price',true);const date=isoDate(input.priceDate,'Price date');if(Date.parse(date)>Date.now())throw new Error('Price date cannot be in the future.');const source=input.source.trim();if(source.length<1||source.length>120)throw new Error('Price source must be between 1 and 120 characters.');const existing=await sql.getFirstAsync<{ownerId:string;holdingId:string;unitPriceMinor:number;priceDate:string;source:string}>('SELECT ownerId,holdingId,unitPriceMinor,priceDate,source FROM InvestmentPrice WHERE id=? OR (ownerId=? AND idempotencyKey=?) LIMIT 1',[input.id,input.ownerId,input.idempotencyKey]);if(existing){if(existing.ownerId!==input.ownerId||existing.holdingId!==input.holdingId||existing.unitPriceMinor!==input.unitPriceMinor||existing.priceDate!==date||existing.source!==source)throw new Error('Price request conflicts with existing valuation history.');return;}await sql.runAsync('INSERT INTO InvestmentPrice(id,ownerId,holdingId,unitPriceMinor,priceDate,source,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.holdingId,input.unitPriceMinor,date,source,input.idempotencyKey,new Date().toISOString()]);}),
      history: async(ownerId:string,holdingId:string)=>{validIdentity(ownerId,holdingId);const sql=await read();return sql.getAllAsync<{id:string;eventType:string;quantityMicros:number;unitPriceMinor:number;feeMinor:number;amountMinor:number;splitNumerator:number;splitDenominator:number;eventDate:string}>('SELECT id,eventType,quantityMicros,unitPriceMinor,feeMinor,amountMinor,splitNumerator,splitDenominator,eventDate FROM InvestmentEvent WHERE ownerId=? AND holdingId=? ORDER BY eventDate DESC,id DESC',[ownerId,holdingId]);},
      recordEvent: async(input:{id:string;ownerId:string;holdingId:string;eventType:'buy'|'sell'|'split'|'dividend';quantityMicros?:number;unitPriceMinor?:number;feeMinor?:number;amountMinor?:number;splitNumerator?:number;splitDenominator?:number;eventDate:string;idempotencyKey:string;transactionId?:string})=>write(async(sql)=>{
        validIdentity(input.id,input.ownerId,input.holdingId,input.idempotencyKey);const date=isoDate(input.eventDate,'Investment event date');if(Date.parse(date)>Date.now())throw new Error('Investment event date cannot be in the future.');const holding=await sql.getFirstAsync<{currency:string;portfolioId:string}>('SELECT currency,portfolioId FROM InvestmentHolding WHERE id=? AND ownerId=?',[input.holdingId,input.ownerId]);if(!holding)throw new Error('Holding was not found for this profile.');const portfolio=await sql.getFirstAsync<{cashAccountId:string}>('SELECT cashAccountId FROM InvestmentPortfolio WHERE id=? AND ownerId=?',[holding.portfolioId,input.ownerId]);if(!portfolio)throw new Error('Portfolio was not found.');
        const quantity=input.quantityMicros??0,price=input.unitPriceMinor??0,fee=input.feeMinor??0,amount=input.amountMinor??0,num=input.splitNumerator??0,den=input.splitDenominator??0;
        for(const [value,label,zero] of [[quantity,'Quantity',true],[price,'Price',true],[fee,'Fee',true],[amount,'Amount',true]] as const)positiveMinor(value,label,zero);
        const previous=await sql.getFirstAsync<{ownerId:string;holdingId:string;eventType:string;quantityMicros:number;unitPriceMinor:number;feeMinor:number;amountMinor:number;splitNumerator:number;splitDenominator:number;eventDate:string}>('SELECT ownerId,holdingId,eventType,quantityMicros,unitPriceMinor,feeMinor,amountMinor,splitNumerator,splitDenominator,eventDate FROM InvestmentEvent WHERE id=? OR (ownerId=? AND idempotencyKey=?) LIMIT 1',[input.id,input.ownerId,input.idempotencyKey]);
        if(previous){const expectedAmount=input.eventType==='buy'||input.eventType==='sell'?scaledProduct(quantity,price,1_000_000n):amount;if(previous.ownerId!==input.ownerId||previous.holdingId!==input.holdingId||previous.eventType!==input.eventType||previous.quantityMicros!==quantity||previous.unitPriceMinor!==price||previous.feeMinor!==fee||previous.amountMinor!==expectedAmount||previous.splitNumerator!==num||previous.splitDenominator!==den||previous.eventDate!==date)throw new Error('Investment event request conflicts with existing history.');return {id:input.id,eventType:input.eventType,cashAmountMinor:input.eventType==='buy'?expectedAmount+fee:input.eventType==='sell'?expectedAmount-fee:input.eventType==='dividend'?expectedAmount:0,grossAmountMinor:input.eventType==='buy'||input.eventType==='sell'?expectedAmount:0};}
        const rows=await sql.getAllAsync<Omit<HoldingRow,'currentPriceMinor'|'priceDate'|'priceSource'|'portfolioName'|'cashAccountId'>>('SELECT eventType,quantityMicros,unitPriceMinor,feeMinor,amountMinor,splitNumerator,splitDenominator,eventDate FROM InvestmentEvent WHERE holdingId=? AND ownerId=? ORDER BY eventDate,id',[input.holdingId,input.ownerId]);
        const position=calculateHoldingPosition(rows.map(({eventType,quantityMicros,unitPriceMinor,feeMinor,amountMinor,splitNumerator,splitDenominator})=>({eventType,quantityMicros,unitPriceMinor,feeMinor,amountMinor,splitNumerator,splitDenominator})),null);
        const gross=input.eventType==='buy'||input.eventType==='sell'?scaledProduct(quantity,price,1_000_000n):0;
        if(input.eventType==='split'&&(!Number.isSafeInteger(num)||!Number.isSafeInteger(den)||num<=0||den<=0))throw new Error('Stock split ratio must use positive whole numbers.');
        if(input.eventType==='split'&&position.quantityMicros<=0)throw new Error('A stock split requires an existing holding.');
        let cash:TransactionInput|null=null;
        if(input.eventType==='buy'){if(quantity<=0||price<=0)throw new Error('A buy needs a positive quantity and price.');cash={id:input.transactionId??`${input.id}:cash`,ownerId:input.ownerId,amountMinor:gross+fee,type:'Expense',categoryId:'investment_purchase',accountId:portfolio.cashAccountId,date,note:`Investment purchase · ${input.holdingId}`};}
        if(input.eventType==='sell'){if(quantity<=0||quantity>position.quantityMicros||price<=0)throw new Error('Sale quantity exceeds the available holding.');if(gross<=fee)throw new Error('Sale fees must be less than gross proceeds.');cash={id:input.transactionId??`${input.id}:cash`,ownerId:input.ownerId,amountMinor:gross-fee,type:'Income',categoryId:'investment_sale_proceeds',accountId:portfolio.cashAccountId,date,note:`Investment sale · ${input.holdingId}`};}
        if(input.eventType==='dividend'){if(amount<=0)throw new Error('Dividend must be positive.');cash={id:input.transactionId??`${input.id}:cash`,ownerId:input.ownerId,amountMinor:amount,type:'Income',categoryId:'investment_dividend',accountId:portfolio.cashAccountId,date,note:`Investment dividend · ${input.holdingId}`};}
        if(cash)await postCash(sql,cash);
        await sql.runAsync('INSERT INTO InvestmentEvent(id,ownerId,holdingId,eventType,quantityMicros,unitPriceMinor,feeMinor,amountMinor,splitNumerator,splitDenominator,transactionId,eventDate,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[input.id,input.ownerId,input.holdingId,input.eventType,quantity,price,fee,input.eventType==='buy'||input.eventType==='sell'?gross:amount,num,den,cash?.id??null,date,input.idempotencyKey,new Date().toISOString()]);
        if(input.eventType==='buy'||input.eventType==='sell')await sql.runAsync('INSERT INTO InvestmentPrice(id,ownerId,holdingId,unitPriceMinor,priceDate,source,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?)',[`${input.id}:execution-price`,input.ownerId,input.holdingId,price,date,'Trade execution',`${input.idempotencyKey}:execution-price`,new Date().toISOString()]);
        if(input.eventType==='split'){
          const priorPrice=await sql.getFirstAsync<{unitPriceMinor:number}>('SELECT unitPriceMinor FROM InvestmentPrice WHERE ownerId=? AND holdingId=? ORDER BY priceDate DESC,id DESC LIMIT 1',[input.ownerId,input.holdingId]);
          if(priorPrice){const adjusted=Number((BigInt(priorPrice.unitPriceMinor)*BigInt(den)+BigInt(num)/2n)/BigInt(num));await sql.runAsync('INSERT INTO InvestmentPrice(id,ownerId,holdingId,unitPriceMinor,priceDate,source,idempotencyKey,createdAt) VALUES(?,?,?,?,?,?,?,?)',[`${input.id}:split-price`,input.ownerId,input.holdingId,adjusted,new Date(new Date(date).getTime()+1).toISOString(),'Stock split adjustment',`${input.idempotencyKey}:split-price`,new Date().toISOString()]);}
        }
        return {id:input.id,eventType:input.eventType,cashAmountMinor:cash?.amountMinor??0,grossAmountMinor:gross};
      }),
    },
  };
}
