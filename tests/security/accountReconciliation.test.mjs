import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAccountReconciliation } from '../../src/cloud/accountReconciliation.ts';

const local = {
  entityId:'wallet-id',mutationId:'original-key',
  payload:{id:'wallet-id',name:'Wallet Cash',type:'cash',currency:'PKR',openingBalanceMinor:'170000'},
  local:{name:'Wallet Cash',type:'cash',currency:'PKR',openingBalanceMinor:'170000',currentBalanceMinor:'170000'},
};
const preview = {
  status:'verified',eligible:true,
  account:{id:'wallet-id',name:'Wallet Cash',type:'cash',currency:'PKR',openingBalanceMinor:'170000',currentBalanceMinor:'170000',revision:1},
  evidence:{ownerMatches:true,creationRecordMatches:true,creationRecordCount:1,receiptStatus:'missing',openingBalanceIsAccountField:true},
  reason:null,
};

test('allows reconciliation only when owner, immutable creation evidence, and exact account balances match', () => {
  assert.deepEqual(assessAccountReconciliation(local,preview),{eligible:true,reasons:[]});
});

test('does not accept a matching account ID or name when balance or ownership differs', () => {
  const changedBalance={...preview,account:{...preview.account,currentBalanceMinor:'169000'}};
  assert.equal(assessAccountReconciliation(local,changedBalance).eligible,false);
  const changedOwner={...preview,evidence:{...preview.evidence,ownerMatches:false}};
  assert.equal(assessAccountReconciliation(local,changedOwner).eligible,false);
});

test('does not allow reconciliation when history is ambiguous or the receipt conflicts', () => {
  const multipleHistory={...preview,evidence:{...preview.evidence,creationRecordCount:2}};
  assert.equal(assessAccountReconciliation(local,multipleHistory).eligible,false);
  const receiptConflict={...preview,evidence:{...preview.evidence,receiptStatus:'conflicting'}};
  assert.equal(assessAccountReconciliation(local,receiptConflict).eligible,false);
});
