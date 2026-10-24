export interface TransactionPageCursor {
  date: string;
  id: string;
}

export interface TransactionFilters {
  search?: string;
  types?: readonly string[];
  startDate?: string;
  endDate?: string;
  accountId?: string;
  categoryId?: string;
  currency?: string;
}

/** Selects the latest still-eligible account used for this activity, without loading history. */
export function buildRecentAccountPreferenceQuery(ownerId: string, type: 'Expense' | 'Income' | 'Transfer'):
  { sql: string; params: string[] } {
  if (!ownerId.trim()) throw new Error('A profile is required to choose a remembered account.');
  return {
    sql: `SELECT t.accountId FROM "Transaction" t
      INNER JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId AND a.archivedAt IS NULL
      WHERE t.ownerId=? AND t.type=? AND t.accountId IS NOT NULL
      ORDER BY t.date DESC,t.id DESC LIMIT 1`,
    params: [ownerId, type],
  };
}

/** Aggregates account cash effects in SQLite so screens never materialize the full ledger for balances. */
export function buildAccountBalanceQuery(ownerId: string, includeArchived = false): { sql: string; params: string[] } {
  if (!ownerId.trim()) throw new Error('A profile is required to calculate account balances.');
  return {
    sql: `WITH profile(ownerId) AS (SELECT ?), cash_events(accountId,delta) AS (
      SELECT t.accountId,CASE WHEN t.type IN ('Income','Refund') THEN t.amountMinor ELSE -t.amountMinor END
        FROM "Transaction" t,profile p WHERE t.ownerId=p.ownerId AND t.type IN ('Income','Expense','Refund') AND t.accountId IS NOT NULL
      UNION ALL
      SELECT t.accountId,-t.amountMinor FROM "Transaction" t,profile p WHERE t.ownerId=p.ownerId AND t.type='Transfer' AND t.accountId IS NOT NULL
      UNION ALL
      SELECT t.toAccountId,t.amountMinor FROM "Transaction" t,profile p WHERE t.ownerId=p.ownerId AND t.type='Transfer' AND t.toAccountId IS NOT NULL
      UNION ALL
      SELECT t.accountId,CASE original.type WHEN 'Income' THEN -t.amountMinor WHEN 'Expense' THEN t.amountMinor WHEN 'Transfer' THEN t.amountMinor END
        FROM "Transaction" t JOIN "Transaction" original ON original.id=t.reversalOfId AND original.ownerId=t.ownerId,profile p
        WHERE t.ownerId=p.ownerId AND t.type='Reversal' AND original.type IN ('Income','Expense','Transfer') AND t.accountId IS NOT NULL
      UNION ALL
      SELECT t.toAccountId,-t.amountMinor FROM "Transaction" t
        JOIN "Transaction" original ON original.id=t.reversalOfId AND original.ownerId=t.ownerId,profile p
        WHERE t.ownerId=p.ownerId AND t.type='Reversal' AND original.type='Transfer' AND t.toAccountId IS NOT NULL
    )
    SELECT a.id,a.ownerId,a.name,a.type,a.balanceMinor AS openingBalanceMinor,
      a.balanceMinor+COALESCE(SUM(events.delta),0) AS currentBalanceMinor,a.currency,a.createdAt,a.archivedAt,a.synced
    FROM Account a,profile p LEFT JOIN cash_events events ON events.accountId=a.id
    WHERE a.ownerId=p.ownerId${includeArchived ? '' : ' AND a.archivedAt IS NULL'}
    GROUP BY a.id,a.ownerId,a.name,a.type,a.balanceMinor,a.currency,a.createdAt,a.archivedAt,a.synced
    ORDER BY a.createdAt ASC,a.id ASC`,
    params: [ownerId],
  };
}

/** Calculates one historical cash snapshot inside SQLite without materializing ledger history in JS. */
export function buildHistoricalAccountBalanceQuery(ownerId:string,asOfDate:string):{sql:string;params:string[]} {
  if(!ownerId.trim())throw new Error('A profile is required to calculate historical account balances.');
  if(!Number.isFinite(Date.parse(asOfDate)))throw new Error('A valid historical cutoff is required.');
  return {
    sql:`WITH parameters(ownerId,cutoff) AS (VALUES(?,?)),cash_events(accountId,delta) AS (
      SELECT t.accountId,CASE WHEN t.type IN ('Income','Refund') THEN t.amountMinor ELSE -t.amountMinor END
      FROM "Transaction" t,parameters p WHERE t.ownerId=p.ownerId AND t.date<=p.cutoff AND t.type IN ('Income','Expense','Refund') AND t.accountId IS NOT NULL
      UNION ALL SELECT t.accountId,-t.amountMinor FROM "Transaction" t,parameters p WHERE t.ownerId=p.ownerId AND t.date<=p.cutoff AND t.type='Transfer' AND t.accountId IS NOT NULL
      UNION ALL SELECT t.toAccountId,t.amountMinor FROM "Transaction" t,parameters p WHERE t.ownerId=p.ownerId AND t.date<=p.cutoff AND t.type='Transfer' AND t.toAccountId IS NOT NULL
      UNION ALL SELECT t.accountId,CASE original.type WHEN 'Income' THEN -t.amountMinor WHEN 'Expense' THEN t.amountMinor WHEN 'Transfer' THEN t.amountMinor END
      FROM "Transaction" t JOIN "Transaction" original ON original.id=t.reversalOfId AND original.ownerId=t.ownerId,parameters p
      WHERE t.ownerId=p.ownerId AND t.date<=p.cutoff AND t.type='Reversal' AND original.type IN ('Income','Expense','Transfer') AND t.accountId IS NOT NULL
      UNION ALL SELECT t.toAccountId,-t.amountMinor FROM "Transaction" t JOIN "Transaction" original ON original.id=t.reversalOfId AND original.ownerId=t.ownerId,parameters p
      WHERE t.ownerId=p.ownerId AND t.date<=p.cutoff AND t.type='Reversal' AND original.type='Transfer' AND t.toAccountId IS NOT NULL
    )
    SELECT a.id,a.ownerId,a.name,a.type,a.balanceMinor AS openingBalanceMinor,a.balanceMinor+COALESCE(SUM(events.delta),0) AS balanceMinor,a.currency,a.createdAt,a.archivedAt,a.synced
    FROM Account a,parameters p LEFT JOIN cash_events events ON events.accountId=a.id
    WHERE a.ownerId=p.ownerId AND a.createdAt<=p.cutoff
    GROUP BY a.id,a.ownerId,a.name,a.type,a.balanceMinor,a.currency,a.createdAt,a.archivedAt,a.synced
    ORDER BY a.createdAt,a.id`,
    params:[ownerId,asOfDate],
  };
}

export function buildTransactionPagePredicate({
  ownerId,
  order = 'desc',
  cursor,
  synced,
  take,
}: {
  ownerId: string;
  order?: 'asc' | 'desc';
  cursor?: TransactionPageCursor;
  synced?: boolean;
  take?: number;
}): { whereSql: string; orderSql: string; limitSql: string; params: (string | number | null)[] } {
  if (!ownerId.trim()) throw new Error('A profile is required to read transactions.');
  if (take !== undefined && (!Number.isSafeInteger(take) || take < 0)) throw new Error('take must be a non-negative safe integer.');
  if (cursor && (!Number.isFinite(new Date(cursor.date).getTime()) || !cursor.id.trim())) throw new Error('Transaction cursor is invalid.');

  const params: (string | number | null)[] = [ownerId];
  const predicates = ['t.ownerId = ?'];
  if (synced !== undefined) {
    predicates.push('t.synced = ?');
    params.push(synced ? 1 : 0);
  }
  if (cursor) {
    predicates.push(order === 'asc'
      ? '(t.date > ? OR (t.date = ? AND t.id > ?))'
      : '(t.date < ? OR (t.date = ? AND t.id < ?))');
    params.push(cursor.date, cursor.date, cursor.id);
  }
  const limit = take !== undefined ? take : cursor ? 51 : undefined;
  if (limit !== undefined) params.push(limit);
  return {
    whereSql: predicates.join(' AND '),
    orderSql: `t.date ${order.toUpperCase()}, t.id ${order.toUpperCase()}`,
    limitSql: limit === undefined ? '' : ' LIMIT ?',
    params,
  };
}

export function buildFilteredTransactionPredicate({
  ownerId,
  order = 'desc',
  cursor,
  take,
  filters = {},
}: {
  ownerId: string;
  order?: 'asc' | 'desc';
  cursor?: TransactionPageCursor;
  take?: number;
  filters?: TransactionFilters;
}): { whereSql: string; orderSql: string; limitSql: string; params: (string | number | null)[] } {
  if (!ownerId.trim()) throw new Error('A profile is required to read transactions.');
  if (take !== undefined && (!Number.isSafeInteger(take) || take < 0)) throw new Error('take must be a non-negative safe integer.');
  if (cursor && (!Number.isFinite(new Date(cursor.date).getTime()) || !cursor.id.trim())) throw new Error('Transaction cursor is invalid.');
  const params: (string | number | null)[] = [ownerId];
  const predicates = ['t.ownerId = ?'];
  if (cursor) {
    predicates.push(order === 'asc'
      ? '(t.date > ? OR (t.date = ? AND t.id > ?))'
      : '(t.date < ? OR (t.date = ? AND t.id < ?))');
    params.push(cursor.date, cursor.date, cursor.id);
  }
  const search = filters.search?.trim().toLocaleLowerCase('en-US');
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    predicates.push(`(LOWER(COALESCE(t.note,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.sourceName,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.categoryId,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.classificationId,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(a.name,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(destination.name,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(linked.note,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(linked.sourceName,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(linked.categoryId,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(bill.name,debt.counterparty,asset.name,holding.name,'')) LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (filters.types?.length) {
    predicates.push(`t.type IN (${filters.types.map(() => '?').join(',')})`);
    params.push(...filters.types);
  }
  if (filters.startDate) { predicates.push('t.date >= ?'); params.push(filters.startDate); }
  if (filters.endDate) { predicates.push('t.date < ?'); params.push(filters.endDate); }
  if (filters.accountId) { predicates.push('(t.accountId = ? OR t.toAccountId = ?)'); params.push(filters.accountId, filters.accountId); }
  if (filters.categoryId) { predicates.push('(t.classificationId = ? OR t.categoryId = ? OR linked.classificationId = ? OR linked.categoryId = ? OR linkedRoot.classificationId = ? OR linkedRoot.categoryId = ?)'); params.push(filters.categoryId, filters.categoryId, filters.categoryId, filters.categoryId, filters.categoryId, filters.categoryId); }
  if (filters.currency) { predicates.push('(a.currency = ? OR destination.currency = ?)'); params.push(filters.currency, filters.currency); }
  const limit = take !== undefined ? take : cursor ? 51 : undefined;
  if (limit !== undefined) params.push(limit);
  return {
    whereSql: predicates.join(' AND '),
    orderSql: `t.date ${order.toUpperCase()}, t.id ${order.toUpperCase()}`,
    limitSql: limit === undefined ? '' : ' LIMIT ?',
    params,
  };
}

export function buildTransactionListQuery({
  ownerId,
  limit = 50,
  cursor,
  filters,
}: {
  ownerId: string;
  limit?: number;
  cursor?: TransactionPageCursor;
  filters?: TransactionFilters;
}): { sql: string; params: (string | number | null)[] } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Transaction page size must be between 1 and 100.');
  const page = buildFilteredTransactionPredicate({ ownerId, order: 'desc', take: limit + 1, cursor, filters });
  return {
    sql: `SELECT t.id,t.ownerId,t.amountMinor,t.type,t.categoryId,t.classificationId,t.accountId,t.toAccountId,t.date,t.note,t.sourceName,t.paymentMethod,t.sourceAmountMinor,t.sourceCurrency,t.exchangeRate,t.referenceNumber,t.taxStatus,t.taxYear,t.synced,t.reversalOfId,t.correctionOfId,
      a.currency AS accountCurrency,a.name AS accountName,destination.currency AS destinationCurrency,destination.name AS destinationName,
      linked.id AS linkedOriginalId,linked.type AS linkedOriginalType,COALESCE(linkedRoot.categoryId,linked.categoryId) AS linkedOriginalCategory,COALESCE(linkedRoot.note,linked.note) AS linkedOriginalNote,
      COALESCE('Bill · '||bill.name,'Debt · '||debt.counterparty,'Asset · '||asset.name,'Investment · '||holding.name) AS specializedContext,
      (SELECT COALESCE(SUM(refund.amountMinor),0) FROM "Transaction" refund WHERE refund.ownerId=t.ownerId AND refund.type='Refund' AND refund.reversalOfId=COALESCE(t.reversalOfId,t.correctionOfId,t.id)) AS refundedMinor
      FROM "Transaction" t
      LEFT JOIN Account a ON a.id=t.accountId AND a.ownerId=t.ownerId
      LEFT JOIN Account destination ON destination.id=t.toAccountId AND destination.ownerId=t.ownerId
      LEFT JOIN "Transaction" linked ON linked.id=COALESCE(t.reversalOfId,t.correctionOfId) AND linked.ownerId=t.ownerId
      LEFT JOIN "Transaction" linkedRoot ON linkedRoot.id=linked.reversalOfId AND linkedRoot.ownerId=linked.ownerId
      LEFT JOIN BillPayment billPayment ON billPayment.ownerId=t.ownerId AND billPayment.transactionId=CASE WHEN t.type='Reversal' THEN t.reversalOfId ELSE t.id END
      LEFT JOIN Bill bill ON bill.id=billPayment.billId AND bill.ownerId=billPayment.ownerId
      LEFT JOIN DebtEvent debtEvent ON debtEvent.ownerId=t.ownerId AND debtEvent.transactionId=CASE WHEN t.type='Reversal' THEN t.reversalOfId ELSE t.id END
      LEFT JOIN Debt debt ON debt.id=debtEvent.debtId AND debt.ownerId=debtEvent.ownerId
      LEFT JOIN AssetActivity assetActivity ON assetActivity.ownerId=t.ownerId AND assetActivity.transactionId=CASE WHEN t.type='Reversal' THEN t.reversalOfId ELSE t.id END
      LEFT JOIN Asset asset ON asset.id=assetActivity.assetId AND asset.ownerId=assetActivity.ownerId
      LEFT JOIN InvestmentEvent investmentEvent ON investmentEvent.ownerId=t.ownerId AND investmentEvent.transactionId=CASE WHEN t.type='Reversal' THEN t.reversalOfId ELSE t.id END
      LEFT JOIN InvestmentHolding holding ON holding.id=investmentEvent.holdingId AND holding.ownerId=investmentEvent.ownerId
      WHERE ${page.whereSql} ORDER BY ${page.orderSql}${page.limitSql}`,
    params: page.params,
  };
}
