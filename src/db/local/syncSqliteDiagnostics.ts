import type * as SQLite from 'expo-sqlite';

type BindValue = string | number | null;
type Executor = Pick<SQLite.SQLiteDatabase, 'prepareAsync'>;
type SqlKind = 'run' | 'first' | 'all';

function describeOperation(sql: string): string {
  const verb = /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase() ?? 'SQL';
  const table = /\b(?:FROM|INTO|UPDATE|TABLE)\s+["`[]?([a-zA-Z_][\w]*)/i.exec(sql)?.[1];
  return table ? `${verb} ${table}` : verb;
}

function errorDetails(error: unknown): { code: string | null; message: string; stack: string | null } {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; resultCode?: unknown };
    const rawCode = candidate.code ?? candidate.resultCode;
    return {
      code: typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : null,
      message: error.message.slice(0, 500),
      stack: error.stack?.slice(0, 2500) ?? null,
    };
  }
  return { code: null, message: String(error).slice(0, 500), stack: null };
}

function reportFailure(context: string, operation: string, stage: 'execute' | 'finalize', error: unknown): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.error('[sync-sqlite]', JSON.stringify({ context, operation, stage, ...errorDetails(error) }));
  }
}

/**
 * Uses an explicitly managed statement so Expo web's finalize error cannot
 * replace the original execute/read error. It never logs SQL parameters.
 */
export async function executeSyncDiagnosticSql<T>(
  database: Executor,
  context: string,
  sql: string,
  params: readonly BindValue[],
  kind: SqlKind,
): Promise<T> {
  const operation = describeOperation(sql);
  const statement = await database.prepareAsync(sql);
  let operationError: unknown;
  let value!: T;
  try {
    const result = await statement.executeAsync([...params]);
    if (kind === 'run') value = result as T;
    else if (kind === 'first') value = await result.getFirstAsync() as T;
    else value = await result.getAllAsync() as T;
  } catch (error) {
    operationError = error;
    reportFailure(context, operation, 'execute', error);
    const details = errorDetails(error);
    throw new Error(`SYNC_SQL_EXECUTE_FAILED:${context}:${operation}:${details.code ?? 'no-code'}:${details.message}`, { cause: error });
  } finally {
    try {
      await statement.finalizeAsync();
    } catch (finalizeError) {
      reportFailure(context, operation, 'finalize', finalizeError);
      if (operationError === undefined) {
        const details = errorDetails(finalizeError);
        throw new Error(`SYNC_SQL_FINALIZE_FAILED:${context}:${operation}:${details.code ?? 'no-code'}:${details.message}`, { cause: finalizeError });
      }
    }
  }
  return value;
}
