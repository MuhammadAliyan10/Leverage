export interface TransactionPageCursor {
  date: string;
  id: string;
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
