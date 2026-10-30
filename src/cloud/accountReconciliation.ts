export type LocalAccountConflict = {
  entityId: string;
  mutationId: string;
  payload: { id: string; name: string; type: string; currency: string; openingBalanceMinor: string };
  local: { name: string; type: string; currency: string; openingBalanceMinor: string; currentBalanceMinor: string };
};

export type CloudAccountReconciliationPreview = {
  status: 'verified' | 'conflict';
  eligible: boolean;
  account: { id: string; name: string; type: string; currency: string; openingBalanceMinor: string; currentBalanceMinor: string; revision: number } | null;
  evidence: { ownerMatches: boolean; creationRecordMatches: boolean; creationRecordCount: number; receiptStatus: 'missing' | 'matching' | 'conflicting'; openingBalanceIsAccountField: true };
  reason: string | null;
};

/** Require both stable identity and complete financial-field/balance evidence before offering receipt reconciliation. */
export function assessAccountReconciliation(local: LocalAccountConflict, cloud: CloudAccountReconciliationPreview): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (cloud.status !== 'verified' || !cloud.account) reasons.push(cloud.reason ?? 'The cloud account could not be verified.');
  else {
    const account = cloud.account;
    if (account.id !== local.entityId || account.id !== local.payload.id) reasons.push('The account IDs do not match.');
    if (account.name !== local.payload.name || account.name !== local.local.name) reasons.push('The account name does not match.');
    if (account.type !== local.payload.type || account.type !== local.local.type) reasons.push('The account type does not match.');
    if (account.currency !== local.payload.currency || account.currency !== local.local.currency) reasons.push('The account currency does not match.');
    if (account.openingBalanceMinor !== local.payload.openingBalanceMinor || account.openingBalanceMinor !== local.local.openingBalanceMinor) reasons.push('The original opening balance does not match.');
    if (account.currentBalanceMinor !== local.local.currentBalanceMinor) reasons.push('The current cloud and device balances differ.');
    if (!cloud.evidence.ownerMatches) reasons.push('The cloud record is not owned by the signed-in cloud profile.');
    if (!cloud.evidence.creationRecordMatches || cloud.evidence.creationRecordCount !== 1) reasons.push('The cloud does not have exactly one matching original account creation record.');
    if (cloud.evidence.receiptStatus === 'conflicting') reasons.push('The original mutation ID already has a different cloud receipt.');
    if (!cloud.eligible) reasons.push(cloud.reason ?? 'The cloud account is not safe to reconcile.');
  }
  return { eligible: reasons.length === 0, reasons };
}
