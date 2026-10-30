import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { BottomSheetTextInput as TextInput } from '@gorhom/bottom-sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DoneHeader } from '../components/ui/DoneHeader';
import { ActionSheet } from '../components/ui/ActionSheet';
import { SectionHeading } from '../components/ui/SectionHeading';
import { useAppConfirm } from '../components/ui/useAppConfirm';
import { BADGE_NEUTRAL, BADGE_NEUTRAL_TEXT, BADGE_PRIMARY, BADGE_PRIMARY_TEXT } from '../components/ui/badgeStyles';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../src/context/AuthContext';
import { useAccounts } from '../hooks/queries/useAccounts';
import { DatePickerField } from '../components/ui/DatePickerField';
import { localDb } from '../src/db/local/client';
import { formatGroupedAmountInput, formatMinorUnits, parseMinorUnits } from '../src/finance/ledger';
import type { RecurrenceFrequency } from '../src/finance/recurrence';
import { calculateDebtPositions } from '../src/finance/debtPosition';
import { cancelBillReminder, scheduleBillReminder } from '../src/security/localReminders';

type BillRecord = Awaited<ReturnType<typeof localDb.obligations.bills.list>>[number];
type BillPaymentRecord = Awaited<ReturnType<typeof localDb.obligations.bills.history>>[number];
type DebtRecord = Awaited<ReturnType<typeof localDb.obligations.debts.list>>[number];
type DebtHistoryRecord = Awaited<ReturnType<typeof localDb.obligations.debts.history>>[number];
type DebtCashEventType = 'borrow'|'lend'|'principal_repayment'|'receivable_payment'|'interest'|'settlement';
function isDebtCashEventType(value:string):value is DebtCashEventType {
  return value==='borrow'||value==='lend'||value==='principal_repayment'||value==='receivable_payment'||value==='interest'||value==='settlement';
}

const makeId = () => Crypto.randomUUID();
const ObligationBusyContext = createContext(false);
const today = () => {const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
const frequencies: RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];
const categories = [
  { id: 'salary', label: 'Salary' }, { id: 'family_gift', label: 'Family support' },
  { id: 'other_income', label: 'Other income' }, { id: 'bills', label: 'Bills' },
  { id: 'housing', label: 'Housing' }, { id: 'other_expense', label: 'Other expense' },
];

function Choice({ label, selected, onPress }: {label:string;selected:boolean;onPress:()=>void}) {
  const busy = useContext(ObligationBusyContext);
  return <Pressable disabled={busy} accessibilityRole="button" accessibilityState={{ selected, disabled: busy, busy }} onPress={onPress} className={`mr-2 mt-2 rounded-full px-3 py-2 ${selected ? BADGE_PRIMARY : BADGE_NEUTRAL} ${busy ? 'opacity-60' : ''}`}><Text className={`font-body text-xs ${selected ? `font-semibold ${BADGE_PRIMARY_TEXT}` : BADGE_NEUTRAL_TEXT}`}>{label}</Text></Pressable>;
}
function Field({ value, onChangeText, placeholder, numeric = false, amount = false }: {value:string;onChangeText:(value:string)=>void;placeholder:string;numeric?:boolean;amount?:boolean}) {
  const busy = useContext(ObligationBusyContext);
  return <View className="mt-2"><Text className="font-body mb-1 text-xs font-semibold text-gray-600 dark:text-neutral-300">{placeholder}</Text><TextInput editable={!busy} accessibilityLabel={placeholder} value={value} onChangeText={(text) => onChangeText(amount ? formatGroupedAmountInput(text) : text)} placeholder={placeholder} keyboardType={numeric?'decimal-pad':'default'} inputMode={numeric?'decimal':'text'} className="font-body rounded-xl bg-gray-100 px-3 py-3 text-gray-900 dark:bg-neutral-800 dark:text-white" /></View>;
}
function Card({ title, children }: {title:string;children:React.ReactNode}) {
  return <View className="mb-4 rounded-md border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"><SectionHeading title={title} size="compact" className="mb-3"/>{children}</View>;
}

export default function ObligationsScreen() {
  const { confirm, dialog } = useAppConfirm();
  const router = useRouter();
  const { user, profileSettings } = useAuth();
  const client = useQueryClient();
  const accountQuery = useAccounts();
  const accounts = useMemo(()=>accountQuery.data ?? [],[accountQuery.data]);
  const [accountId,setAccountId] = useState('');
  const [destinationId,setDestinationId] = useState('');
  const [type,setType] = useState<'income'|'expense'|'transfer'>('expense');
  const [frequency,setFrequency] = useState<RecurrenceFrequency>('monthly');
  const [scheduleName,setScheduleName] = useState('');
  const [scheduleAmount,setScheduleAmount] = useState('');
  const [categoryId,setCategoryId] = useState('bills');
  const [scheduleEnd,setScheduleEnd] = useState('');
  const [scheduleStart,setScheduleStart] = useState(today());
  const [subscriptionName,setSubscriptionName] = useState('');
  const [subscriptionAmount,setSubscriptionAmount] = useState('');
  const [subscriptionStart,setSubscriptionStart] = useState(today());
  const [subscriptionFrequency,setSubscriptionFrequency] = useState<Extract<RecurrenceFrequency,'monthly'|'yearly'>>('monthly');
  const [editingScheduleId,setEditingScheduleId] = useState<string|null>(null);
  const [activeRecurringDrawer,setActiveRecurringDrawer] = useState<'subscription'|'schedule'|'bill'|'bill-payment'|'bill-correction'|null>(null);
  const [activeBillId,setActiveBillId] = useState<string|null>(null);
  const [activeBillPaymentId,setActiveBillPaymentId] = useState<string|null>(null);
  const [billName,setBillName] = useState('');
  const [billAmount,setBillAmount] = useState('');
  const [billDue,setBillDue] = useState(today());
  const [billRecurring,setBillRecurring] = useState(false);
  const [billFrequency,setBillFrequency] = useState<RecurrenceFrequency>('monthly');
  const [debtDirection,setDebtDirection] = useState<'borrowed'|'lent'>('borrowed');
  const [counterparty,setCounterparty] = useState('');
  const [debtAmount,setDebtAmount] = useState('');
  const [interestBps,setInterestBps] = useState('0');
  const [interestOnly,setInterestOnly] = useState(false);
  const [activeDebtDrawer,setActiveDebtDrawer] = useState<'create'|'activity'|'plan'|'correction'|null>(null);
  const [activeDebtId,setActiveDebtId] = useState<string|null>(null);
  const [activeDebtEventId,setActiveDebtEventId] = useState<string|null>(null);
  const [historyBillId,setHistoryBillId] = useState<string|null>(null);
  const [historyDebtId,setHistoryDebtId] = useState<string|null>(null);
  const [paymentAmount,setPaymentAmount] = useState<Record<string,string>>({});
  const [scheduleCount,setScheduleCount] = useState('12');
  const [scheduleMethod,setScheduleMethod] = useState<'none'|'fixed'|'declining'>('none');
  const [repaymentFrequency,setRepaymentFrequency] = useState<'monthly'|'yearly'>('monthly');
  const [repaymentStart,setRepaymentStart] = useState(today());
  const [busy,setBusy] = useState(false);
  const operationInFlight = useRef(false);
  const [feedback,setFeedback] = useState<{message:string;error:boolean}|null>(null);
  const query = useQuery({
    queryKey:['obligations',user?.id], enabled:!!user, staleTime:0, refetchOnMount:'always',
    queryFn:async()=>{
      if(!user) throw new Error('Sign in to manage scheduled finances.');
      await localDb.obligations.schedules.generateDue(user.id,today());
      const [schedules,occurrences,bills,debts,repaymentSchedules]=await Promise.all([
        localDb.obligations.schedules.list(user.id),localDb.obligations.schedules.occurrences(user.id),
        localDb.obligations.bills.list(user.id),localDb.obligations.debts.list(user.id),localDb.obligations.debts.repaymentSchedules(user.id),
      ]);
      return {schedules,occurrences,bills,debts,repaymentSchedules};
    },
  });
  const refetchObligations=query.refetch;
  useFocusEffect(useCallback(()=>{void refetchObligations();},[refetchObligations]));
  const billHistoryQuery=useQuery({queryKey:['bill-history',user?.id,historyBillId],enabled:!!user&&!!historyBillId,queryFn:()=>localDb.obligations.bills.history(user!.id,historyBillId!)});
  const debtHistoryQuery=useQuery({queryKey:['debt-history',user?.id,historyDebtId],enabled:!!user&&!!historyDebtId,queryFn:()=>localDb.obligations.debts.history(user!.id,historyDebtId!)});
  const currentAccount = useMemo(()=>accounts.find((account)=>account.id===accountId)??accounts[0], [accounts,accountId]);
  const run = async(task:()=>Promise<unknown>,success:string,after?:()=>void) => {
    // Prevent a fast double tap from posting two distinct, valid ledger events.
    if(operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    setFeedback({message:'Saving…',error:false});
    try { await task(); await client.invalidateQueries({queryKey:['obligations',user?.id]}); await client.invalidateQueries({queryKey:['accounts',user?.id]}); await client.invalidateQueries({queryKey:['transactions',user?.id]}); await client.invalidateQueries({queryKey:['bill-history',user?.id]}); await client.invalidateQueries({queryKey:['debt-history',user?.id]}); await client.invalidateQueries({queryKey:['dashboard']}); await client.invalidateQueries({queryKey:['financial-report',user?.id]}); await client.invalidateQueries({queryKey:['insights',user?.id]}); after?.(); setFeedback({message:success,error:false}); }
    catch(error) { setFeedback({message:error instanceof Error?error.message:'Please try again.',error:true}); }
    finally { operationInFlight.current = false; setBusy(false); }
  };
  const confirmAction=(title:string,message:string,actionLabel:string):Promise<boolean>=>confirm({title,message,confirmLabel:actionLabel,destructive:true});
  const confirmThenRun=(title:string,message:string,actionLabel:string,task:()=>Promise<unknown>,success:string)=>{
    void confirmAction(title,message,actionLabel).then((confirmed)=>{if(confirmed) void run(task,success);});
  };
  const closeObligations=()=>{if(router.canGoBack())router.back();else router.replace('/(tabs)');};
  const saveSchedule=()=>{
    if(!user||!currentAccount) {setFeedback({message:'Create or select an account before scheduling a transaction.',error:true});return;}
    if(type==='transfer'&&(!destinationId||destinationId===currentAccount.id)) {setFeedback({message:'Select a different destination account in the same currency.',error:true});return;}
    const destination=accounts.find((account)=>account.id===destinationId);
    if(type==='transfer'&&destination?.currency!==currentAccount.currency) {setFeedback({message:'Transfers need accounts in the same currency.',error:true});return;}
    void run(()=>localDb.obligations.schedules.save({id:editingScheduleId??makeId(),ownerId:user.id,scheduleType:type,name:scheduleName,amountMinor:parseMinorUnits(scheduleAmount),currency:currentAccount.currency,accountId:currentAccount.id,toAccountId:type==='transfer'?destinationId:null,frequency,startDate:scheduleStart,endDate:scheduleEnd||null,classificationId:type==='transfer'?null:categoryId}), 'Schedule saved. Due dates will remain pending until you approve them.',()=>{setEditingScheduleId(null);setScheduleName('');setScheduleAmount('');setActiveRecurringDrawer(null);});
  };
  const saveSubscription=()=>{
    if(!user||!currentAccount) {setFeedback({message:'Create or select an account before scheduling a subscription.',error:true});return;}
    void run(()=>localDb.obligations.schedules.save({
      id:makeId(),ownerId:user.id,scheduleType:'expense',name:subscriptionName,amountMinor:parseMinorUnits(subscriptionAmount),
      currency:currentAccount.currency,accountId:currentAccount.id,frequency:subscriptionFrequency,startDate:subscriptionStart,
      classificationId:'bills',
    }), 'Subscription schedule saved. Leverage will show each due charge for confirmation before it changes your balance.',()=>{
      setSubscriptionName('');setSubscriptionAmount('');setSubscriptionStart(today());setActiveRecurringDrawer(null);
    });
  };
  const saveBill=()=>{
    if(!user||!currentAccount) {setFeedback({message:'Create or select an account before adding a bill.',error:true});return;}
    const id=makeId();
    void run(()=>billRecurring?localDb.obligations.createRecurringBill({bill:{id,ownerId:user.id,name:billName,categoryId:'bills',amountMinor:parseMinorUnits(billAmount),currency:currentAccount.currency,dueDate:billDue,accountId:currentAccount.id},schedule:{id:`${id}:repeat`,frequency:billFrequency}}):localDb.obligations.bills.create({id,ownerId:user.id,name:billName,categoryId:'bills',amountMinor:parseMinorUnits(billAmount),currency:currentAccount.currency,dueDate:billDue,accountId:currentAccount.id}), 'Bill saved. No money has left your account.',()=>{setBillName('');setBillAmount('');setBillDue(today());setBillRecurring(false);setActiveRecurringDrawer(null);});
  };
  const recordBillPayment=(bill:BillRecord)=>{
    if(!user) return;
    void run(async()=>{
      const id=makeId();
      await localDb.obligations.createBillPayment({id,ownerId:user.id,billId:bill.id,amountMinor:parseMinorUnits(paymentAmount[bill.id]??''),transactionId:`${id}:tx`,idempotencyKey:id,paidAt:new Date().toISOString()});
      const updated=(await localDb.obligations.bills.list(user.id)).find((item)=>item.id===bill.id);
      if(updated?.status==='paid'&&bill.reminderId){await cancelBillReminder(user.id,bill.id,bill.reminderId);await localDb.obligations.setBillReminder(user.id,bill.id,null);}
    },'Payment posted after the ledger write committed.',()=>{setPaymentAmount((values)=>({...values,[bill.id]:''}));setActiveRecurringDrawer(null);});
  };
  const remindBill=async(billId:string)=>{
    if(!user) return;
    if(!profileSettings.remindersEnabled) {setFeedback({message:'Enable local bill reminders in Settings first.',error:true});return;}
    await run(()=>scheduleBillReminder(user.id,billId),'Reminder scheduled for 9:00 AM on the bill due date.');
  };
  const saveDebt=()=>{
    if(!user||!currentAccount) {setFeedback({message:'Create or select an account before recording debt.',error:true});return;}
    const id=makeId();
    void run(()=>localDb.obligations.createDebt({id,ownerId:user.id,direction:debtDirection,counterparty,principalMinor:parseMinorUnits(debtAmount),currency:currentAccount.currency,accountId:currentAccount.id,interestRateBps:Number(interestBps),openedAt:new Date().toISOString(),transactionId:`${id}:opening`,idempotencyKey:`${id}:opening`}),debtDirection==='borrowed'?'Borrowing recorded as cash and a liability, not income.':'Loan recorded as a receivable, not spending.',()=>{setCounterparty('');setDebtAmount('');setInterestBps('0');setActiveDebtDrawer(null);});
  };
  const settleDebt=(debt:{id:string;direction:'borrowed'|'lent';counterparty:string;principalMinor:number;principalSettledMinor:number;currency:string;accountId:string})=>{
    if(!user) return;
    const input=paymentAmount[debt.id]??'';
    void run(async()=>{
      const amount=parseMinorUnits(input);
      const id=makeId();
      const account=accounts.find((item)=>item.id===debt.accountId);
      if(!account||account.currency!==debt.currency) throw new Error('The original debt account is not available in this currency.');
      await localDb.obligations.recordDebtEvent({id,ownerId:user.id,debtId:debt.id,eventType:interestOnly?'interest':debt.direction==='borrowed'?'principal_repayment':'receivable_payment',principalMinor:interestOnly?0:amount,interestMinor:interestOnly?amount:0,accountId:debt.accountId,transactionId:`${id}:tx`,eventDate:new Date().toISOString(),idempotencyKey:`${id}:event`,note:`${interestOnly?'Interest':'Principal repayment'} · ${debt.counterparty}`});
      setPaymentAmount((value)=>({...value,[debt.id]:''}));
    },interestOnly?'Interest payment recorded and cash movement posted.':'Principal updated and cash movement recorded.',()=>{setPaymentAmount((value)=>({...value,[debt.id]:''}));setActiveDebtDrawer(null);});
  };
  const correctBillPayment=(bill:BillRecord,payment:BillPaymentRecord)=>{
    if(!user) return;
    void confirmAction('Correct bill payment?','The original payment stays in history. Leverage will append a full reversal and optionally a replacement using the amount entered below.','Reverse / replace').then((confirmed)=>{
      if(!confirmed) return;
      void run(async()=>{
        const id=makeId(); const entered=paymentAmount[payment.id]?.trim();
        await localDb.obligations.correctBillPayment({id,ownerId:user.id,billId:bill.id,paymentId:payment.id,reversalTransactionId:`${id}:reversal`,reason:'Payment corrected by user',...(entered?{replacement:{id:`${id}:payment`,transactionId:`${id}:tx`,amountMinor:parseMinorUnits(entered),accountId:currentAccount?.currency===bill.currency?currentAccount.id:undefined,idempotencyKey:`${id}:key`,paidAt:new Date().toISOString()}}:{})});
        setPaymentAmount((current)=>({...current,[payment.id]:''}));
      },'Correction committed to the bill and transaction history.',()=>setActiveRecurringDrawer(null));
    });
  };
  const correctDebtEvent=(debt:DebtRecord,event:DebtHistoryRecord)=>{
    if(!user) return;
    void confirmAction('Correct debt event?','The original cash event will be reversed. Enter a replacement amount first to replace it, or leave the amount blank to reverse it only.','Correct event').then((confirmed)=>{
      if(!confirmed) return;
      void run(async()=>{
        const id=makeId();const entered=paymentAmount[event.id]?.trim();
        if(event.isAccrual){
          await localDb.obligations.debts.correctInterestCharge({id,ownerId:user.id,debtId:debt.id,eventId:event.id,reason:'Interest charge corrected by user',...(entered?{replacement:{id:`${id}:charge`,amountMinor:parseMinorUnits(entered),eventDate:new Date().toISOString(),idempotencyKey:`${id}:key`,note:'Corrected interest charge'}}:{})});
          setPaymentAmount((current)=>({...current,[event.id]:''}));
          return;
        }
        if(!isDebtCashEventType(event.eventType))throw new Error('This debt event cannot be replaced from the current history view.');
        const eventType=event.eventType;
        const replacementAccountId=currentAccount?.currency===debt.currency?currentAccount.id:event.accountId;
        const replacement=entered?(()=>{if(!replacementAccountId)throw new Error('The original event has no account available for its replacement.');const amount=parseMinorUnits(entered);return {id:`${id}:event`,eventType,principalMinor:eventType==='interest'?0:amount,interestMinor:eventType==='interest'?amount:0,accountId:replacementAccountId,transactionId:`${id}:tx`,eventDate:new Date().toISOString(),idempotencyKey:`${id}:key`,note:'Corrected debt event'};})():undefined;
        await localDb.obligations.correctDebtEvent({id,ownerId:user.id,debtId:debt.id,eventId:event.id,reversalTransactionId:`${id}:reversal`,reason:'Debt event corrected by user',...(replacement?{replacement}:{})});
        setPaymentAmount((current)=>({...current,[event.id]:''}));
      },'Correction committed to the debt and transaction history.',()=>{setActiveDebtDrawer(null);setActiveDebtEventId(null);});
    });
  };
  const createRepaymentSchedule=(debt:DebtRecord)=>{
    if(!user) return;
    void run(()=>localDb.obligations.debts.createRepaymentSchedule({id:makeId(),ownerId:user.id,debtId:debt.id,frequency:repaymentFrequency,firstDueDate:repaymentStart,installmentAmountMinor:parseMinorUnits(paymentAmount[debt.id]??''),interestMethod:scheduleMethod,rateBps:scheduleMethod==='none'?0:debt.interestRateBps,installmentCount:Number(scheduleCount)}),'Projected installments saved. No cash movement was posted.',()=>setActiveDebtDrawer(null));
  };
  const activeDebt=query.data?.debts.find((debt)=>debt.id===activeDebtId)??null;
  const activeDebtEvent=debtHistoryQuery.data?.find((event)=>event.id===activeDebtEventId)??null;
  const activeBill=query.data?.bills.find((bill)=>bill.id===activeBillId)??null;
  const activeBillPayment=billHistoryQuery.data?.find((payment)=>payment.id===activeBillPaymentId)??null;
  const recurringDrawerTitle=activeRecurringDrawer==='subscription'?'Add subscription':activeRecurringDrawer==='schedule'?(editingScheduleId?'Edit recurring transaction':'Add recurring transaction'):activeRecurringDrawer==='bill'?'Add bill':activeRecurringDrawer==='bill-payment'?'Record bill payment':activeRecurringDrawer==='bill-correction'?'Correct bill payment':'Upcoming bills';
  const debtDrawerTitle=activeDebtDrawer==='create'?'Add debt':activeDebtDrawer==='activity'?'Record debt activity':activeDebtDrawer==='plan'?'Plan repayments':'Correct debt event';

  return <ObligationBusyContext.Provider value={busy}><SafeAreaView edges={['left', 'right', 'bottom']} className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title="Recurring & Debt" onDone={closeObligations} />
    <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{paddingBottom:32}}>
      {query.isLoading||accountQuery.isLoading?<Text className="font-body py-4 text-gray-500">Loading obligations…</Text>:null}
      {!!feedback?<Text accessibilityRole={feedback.error?'alert':'text'} accessibilityLiveRegion="polite" className={`font-body mb-3 rounded-xl p-3 text-sm ${feedback.error?'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200':'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'}`}>{feedback.message}</Text>:null}
      {query.isError?<View className="mb-3 rounded-xl bg-red-50 p-3 dark:bg-red-950"><Text className="font-body text-sm text-red-700 dark:text-red-200">{query.error.message}</Text><Pressable accessibilityRole="button" onPress={()=>void query.refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>:null}
      {accountQuery.error?<View className="mb-3 rounded-xl bg-red-50 p-3 dark:bg-red-950"><Text className="font-body text-sm text-red-700 dark:text-red-200">Accounts could not be loaded: {accountQuery.error.message}</Text><Pressable accessibilityRole="button" onPress={()=>void accountQuery.refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>:null}
      <Text className="font-body mb-3 text-sm text-gray-600 dark:text-neutral-300">A plan does not change your balance. Your balance changes only after you record a confirmed payment.</Text>
      <Card title="Subscriptions">
        <Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Track subscription charges and get reminders. Charges only affect your balance after you confirm and record them.</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setFeedback(null);setActiveRecurringDrawer('subscription');}} className="houselog-button mt-4 min-h-11 items-center justify-center px-4"><Text className="font-body font-semibold text-white">＋ Add subscription</Text></Pressable>
      </Card>
      <Card title="Create a recurring transaction">
        <Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Set up repeating income, expenses, or transfers. Each due item stays pending until you review it.</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setFeedback(null);setEditingScheduleId(null);setScheduleName('');setScheduleAmount('');setScheduleStart(today());setScheduleEnd('');setType('expense');setCategoryId('bills');setActiveRecurringDrawer('schedule');}} className="houselog-button mt-4 min-h-11 items-center justify-center px-4"><Text className="font-body font-semibold text-white">＋ Add recurring transaction</Text></Pressable>
      </Card>
      <Card title="Schedules">
        {query.data?.schedules.length===0?<Text className="font-body mt-2 text-gray-500">No recurring schedules yet.</Text>:null}
        {query.data?.schedules.map((schedule)=><View key={schedule.id} className="mt-3 rounded-md bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{schedule.name} · {schedule.status} · {schedule.frequency}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">{formatMinorUnits(schedule.amountMinor,schedule.currency)} · next {schedule.nextDueDate} · {schedule.scheduleType}</Text><View className="flex-row flex-wrap">{schedule.status!=='cancelled'?<>{schedule.scheduleType!=='bill'?<Choice label="Edit" selected={false} onPress={()=>{setFeedback(null);setEditingScheduleId(schedule.id);if(schedule.scheduleType!=='bill')setType(schedule.scheduleType);setScheduleName(schedule.name);setScheduleAmount((schedule.amountMinor/100).toFixed(2));setFrequency(schedule.frequency);setScheduleStart(schedule.startDate);setScheduleEnd(schedule.endDate??'');setAccountId(schedule.accountId);setDestinationId(schedule.toAccountId??'');setCategoryId(schedule.classificationId??'other_expense');setActiveRecurringDrawer('schedule');}}/>:null}<Choice label={schedule.status==='paused'?'Resume':'Pause'} selected={false} onPress={()=>void run(()=>localDb.obligations.schedules.setStatus(user!.id,schedule.id,schedule.status==='paused'?'active':'paused'),'Schedule status updated.')}/><Choice label="Cancel" selected={false} onPress={()=>confirmThenRun('Cancel schedule?','Pending occurrences stay visible; future dates stop being generated.','Cancel schedule',()=>localDb.obligations.schedules.setStatus(user!.id,schedule.id,'cancelled'),'Future dates cancelled.')}/></>:null}</View></View>)}
      </Card>
      <Card title="Upcoming & missed occurrences">
        {!query.data?.occurrences.filter((item)=>item.status==='pending').length?<Text className="font-body mt-2 text-gray-500">No pending occurrences. Opening this screen catches missed dates while keeping them unposted.</Text>:null}
        {query.data?.occurrences.filter((item)=>item.status==='pending').map((item)=>{
          const account=accounts.find((candidate)=>candidate.id===item.accountId);
          const insufficient=account&&account.currency===item.currency&&account.balanceMinor<item.amountMinor;
          const isSubscriptionExpense=item.scheduleType==='expense'&&item.classificationId==='bills';
          return <View key={item.id} className="mt-3 rounded-md bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{item.name} · {item.occurrenceDate}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">{item.scheduleType==='bill'?'Bill due':item.scheduleType} · {formatMinorUnits(item.amountMinor,item.currency)} · Pending approval</Text>{isSubscriptionExpense?<Text className={`font-body mt-2 text-xs ${insufficient?'text-amber-700 dark:text-amber-300':'text-gray-500 dark:text-neutral-400'}`}>{insufficient?`Balance is below the charge (${formatMinorUnits(account.balanceMinor,item.currency)} available). Confirm with the provider before recording.`:'Record only after confirming the provider charged this account. Leverage does not initiate the payment.'}</Text>:null}<View className="mt-2 flex-row">{item.scheduleType!=='bill'?<Pressable disabled={busy} accessibilityRole="button" accessibilityState={{disabled:busy,busy}} onPress={()=>void run(()=>localDb.obligations.postOccurrence({ownerId:user!.id,id:item.id,transactionId:makeId()}),isSubscriptionExpense?'Subscription charge recorded in account history.':'Occurrence posted to account history.')} className="houselog-button mr-2 px-3 py-2"><Text className="font-body text-xs font-bold text-white">{isSubscriptionExpense?'Record after charge':'Post now'}</Text></Pressable>:null}<Pressable disabled={busy} accessibilityRole="button" accessibilityState={{disabled:busy,busy}} onPress={()=>void run(()=>localDb.obligations.skipOccurrence(user!.id,item.id),'Occurrence skipped; no balance changed.')} className="rounded-lg bg-gray-200 px-3 py-2 dark:bg-neutral-700"><Text className="font-body text-xs text-gray-800 dark:text-white">Skip</Text></Pressable></View></View>;
        })}
      </Card>
      <Card title="Bills">
        <Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Track due dates and payments. Adding a bill does not post a payment.</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setFeedback(null);setBillName('');setBillAmount('');setBillDue(today());setBillRecurring(false);setActiveRecurringDrawer('bill');}} className="houselog-button mt-4 min-h-11 items-center justify-center px-4"><Text className="font-body font-semibold text-white">＋ Add bill</Text></Pressable>
        {query.data?.bills.length===0?<Text className="font-body mt-3 text-sm text-gray-500 dark:text-neutral-400">No bills recorded yet.</Text>:null}
        {query.data?.bills.map((bill)=><View key={bill.id} className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-neutral-700 dark:bg-neutral-800">
          <View className="flex-row items-start justify-between gap-2"><View className="flex-1"><Text className="font-body font-semibold text-gray-900 dark:text-white">{bill.name}</Text><Text className="font-body mt-1 text-xs capitalize text-gray-500 dark:text-neutral-400">Due {bill.dueDate}{bill.scheduleId?' · recurring':''} · {bill.status}</Text></View><Text className="font-body text-xs font-semibold text-primary">{formatMinorUnits(bill.amountMinor-bill.paidMinor,bill.currency)} left</Text></View>
          <View className="mt-3 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-neutral-700"><View className="h-full rounded-full bg-primary" style={{width:`${bill.amountMinor>0?Math.min(100,Math.max(0,bill.paidMinor*100/bill.amountMinor)):0}%`}}/></View>
          <Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{formatMinorUnits(bill.paidMinor,bill.currency)} paid of {formatMinorUnits(bill.amountMinor,bill.currency)}</Text>
          <View className="mt-2 flex-row flex-wrap">{bill.status!=='paid'&&bill.status!=='cancelled'&&bill.status!=='skipped'?<Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setFeedback(null);setActiveBillId(bill.id);setPaymentAmount((values)=>({...values,[bill.id]:''}));setActiveRecurringDrawer('bill-payment');}} className="houselog-button mr-2 mt-2 px-3 py-2"><Text className="font-body text-xs font-semibold text-white">＋ Record payment</Text></Pressable>:null}<Choice label={historyBillId===bill.id?'Hide history':'Payment history'} selected={historyBillId===bill.id} onPress={()=>setHistoryBillId(historyBillId===bill.id?null:bill.id)}/>{bill.status!=='paid'&&bill.status!=='cancelled'&&bill.status!=='skipped'?<Choice label="Skip bill" selected={false} onPress={()=>confirmThenRun('Skip this bill?','The bill record will remain in history.','Skip',async()=>{const reminderId=await localDb.obligations.setBillStatus(user!.id,bill.id,'skipped');if(reminderId) await cancelBillReminder(user!.id,bill.id,reminderId);},'Bill skipped; its reminder was cancelled.')}/>:null}{bill.status!=='paid'&&bill.status!=='cancelled'&&bill.paidMinor===0?<Choice label="Cancel bill" selected={false} onPress={()=>confirmThenRun('Cancel this bill?','The bill remains in history. Any existing payment must be corrected separately.','Cancel bill',async()=>{const reminderId=await localDb.obligations.cancelBill(user!.id,bill.id);if(reminderId) await cancelBillReminder(user!.id,bill.id,reminderId);},'Bill cancelled; its reminder was cancelled.')}/>:null}</View>
          {bill.status!=='paid'&&bill.status!=='cancelled'&&bill.status!=='skipped'?<Pressable disabled={busy} accessibilityRole="button" onPress={()=>void remindBill(bill.id)} className="mt-2 self-start rounded-lg bg-primary/10 px-3 py-2"><Text className="font-body text-xs font-semibold text-primary">{bill.reminderId?'Reschedule reminder':'Set reminder'}</Text></Pressable>:null}
          {historyBillId===bill.id?<View className="mt-3 border-t border-gray-200 pt-2 dark:border-neutral-700">{billHistoryQuery.isLoading?<Text className="font-body py-2 text-xs text-gray-500 dark:text-neutral-400">Loading payment history…</Text>:null}{billHistoryQuery.data?.length===0&&!billHistoryQuery.isLoading?<Text className="font-body py-2 text-xs text-gray-500 dark:text-neutral-400">No payments recorded.</Text>:null}{billHistoryQuery.data?.map((payment)=><View key={payment.id} className="border-b border-gray-200 py-2 last:border-0 dark:border-neutral-700"><Text className="font-body text-xs text-gray-600 dark:text-neutral-300">{new Date(payment.paidAt).toLocaleDateString()} · {formatMinorUnits(payment.amountMinor,bill.currency)}{payment.corrected?' · corrected':''}</Text>{!payment.corrected?<Pressable accessibilityRole="button" onPress={()=>{setFeedback(null);setActiveBillId(bill.id);setActiveBillPaymentId(payment.id);setPaymentAmount((values)=>({...values,[payment.id]:''}));setActiveRecurringDrawer('bill-correction');}} className="mt-2 self-start"><Text className="font-body text-xs font-semibold text-primary">Correct payment</Text></Pressable>:null}</View>)}</View>:null}
        </View>)}
      </Card>
      <View className="mb-3 mt-2 flex-row items-center justify-between gap-3"><View className="flex-1"><Text className="font-heading text-lg font-bold text-gray-900 dark:text-white">Borrowed and lent money</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Track balances, repayments, and interest in one place.</Text></View><Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setFeedback(null);setActiveDebtDrawer('create');}} className="houselog-button min-h-10 justify-center px-3"><Text className="font-body text-sm font-semibold text-white">＋ Add debt</Text></Pressable></View>
      {!query.isLoading&&!query.isError&&query.data?.debts.length===0?<View className="mb-3 rounded-md border border-dashed border-gray-300 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900"><Text className="font-body font-semibold text-gray-900 dark:text-white">No debts recorded</Text><Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Add money borrowed or lent to see the balance and manage activity.</Text><Pressable accessibilityRole="button" onPress={()=>setActiveDebtDrawer('create')} className="mt-3 self-start"><Text className="font-body font-semibold text-primary">Add your first debt →</Text></Pressable></View>:null}
      {query.data?.debts.map((debt)=>{
        const remainingPrincipal=Math.max(0,debt.principalMinor-debt.principalSettledMinor);
        const outstandingInterest=Math.max(0,debt.interestAccruedMinor-debt.interestPaidMinor);
        const principalProgress=debt.principalMinor>0?Math.min(100,(debt.principalSettledMinor/debt.principalMinor)*100):0;
        return <View key={debt.id} className="mb-3 rounded-md border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <View className="flex-row items-start justify-between gap-3"><View className="flex-1"><Text className="font-heading text-base font-bold text-gray-900 dark:text-white">{debt.counterparty}</Text><Text className="font-body mt-1 text-xs capitalize text-gray-500 dark:text-neutral-400">{debt.direction==='borrowed'?'You borrowed':'You lent'} · {debt.status} · {(debt.interestRateBps/100).toFixed(2)}% yearly</Text></View><Text className={`font-body rounded-full px-2 py-1 text-xs ${debt.direction==='borrowed'?BADGE_NEUTRAL:BADGE_PRIMARY} ${debt.direction==='borrowed'?BADGE_NEUTRAL_TEXT:BADGE_PRIMARY_TEXT}`}>{debt.direction==='borrowed'?'Liability':'Receivable'}</Text></View>
          <View className="mt-4 flex-row gap-3"><View className="flex-1 rounded-md bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Principal remaining</Text><Text className="font-heading mt-1 text-base font-bold text-gray-900 dark:text-white">{formatMinorUnits(remainingPrincipal,debt.currency)}</Text></View><View className="flex-1 rounded-md bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Interest outstanding</Text><Text className="font-heading mt-1 text-base font-bold text-gray-900 dark:text-white">{formatMinorUnits(outstandingInterest,debt.currency)}</Text></View></View>
          <View accessibilityRole="progressbar" accessibilityLabel={`${debt.counterparty} principal repaid`} accessibilityValue={{min:0,max:100,now:principalProgress}} className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800"><View className="h-full rounded-full bg-primary" style={{width:`${principalProgress}%`}}/></View><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">{formatMinorUnits(debt.principalSettledMinor,debt.currency)} repaid of {formatMinorUnits(debt.principalMinor,debt.currency)} · {formatMinorUnits(debt.interestPaidMinor,debt.currency)} interest paid</Text>
          <View className="mt-3 flex-row flex-wrap gap-2">{debt.status==='open'?<><Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setFeedback(null);setActiveDebtId(debt.id);setInterestOnly(false);setActiveDebtDrawer('activity');}} className="houselog-button px-3 py-2"><Text className="font-body text-xs font-semibold text-white">＋ Record activity</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setFeedback(null);setActiveDebtId(debt.id);setActiveDebtDrawer('plan');}} className="rounded-md bg-gray-100 px-3 py-2 dark:bg-neutral-800"><Text className="font-body text-xs font-semibold text-gray-700 dark:text-neutral-200">Plan repayments</Text></Pressable></>:null}<Pressable accessibilityRole="button" disabled={busy} onPress={()=>setHistoryDebtId(historyDebtId===debt.id?null:debt.id)} className="rounded-md bg-gray-100 px-3 py-2 dark:bg-neutral-800"><Text className="font-body text-xs font-semibold text-gray-700 dark:text-neutral-200">{historyDebtId===debt.id?'Hide history':'History'}</Text></Pressable></View>
          {historyDebtId===debt.id?<View className="mt-3 border-t border-gray-100 pt-3 dark:border-neutral-800">{debtHistoryQuery.isLoading?<Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Loading debt history…</Text>:null}{debtHistoryQuery.error?<Text className="font-body text-xs text-red-700 dark:text-red-300">History could not be loaded: {debtHistoryQuery.error.message}</Text>:null}{debtHistoryQuery.data?.length===0&&!debtHistoryQuery.isLoading?<Text className="font-body text-xs text-gray-500 dark:text-neutral-400">No activity recorded yet.</Text>:null}{debtHistoryQuery.data?.map((event)=><View key={event.id} className="border-b border-gray-100 py-2 last:border-0 dark:border-neutral-800"><Text className="font-body text-xs capitalize text-gray-600 dark:text-neutral-300">{new Date(event.eventDate).toLocaleDateString()} · {event.eventType.replace('_',' ')} · {formatMinorUnits(event.principalMinor+event.interestMinor,debt.currency)}{event.transactionId?` · ${event.transactionId}`:event.isAccrual?' · no cash movement':''}{event.corrected?' · corrected':''}</Text>{!event.corrected&&event.eventType!=='interest_reversal'?<Pressable accessibilityRole="button" onPress={()=>{setFeedback(null);setActiveDebtId(debt.id);setActiveDebtEventId(event.id);setPaymentAmount((values)=>({...values,[event.id]:''}));setActiveDebtDrawer('correction');}} className="mt-2 self-start"><Text className="font-body text-xs font-semibold text-primary">Correct event</Text></Pressable>:null}</View>)}</View>:null}
        </View>;
      })}
      <Card title="Debt position">
        {query.data?.debts.length?calculateDebtPositions(query.data.debts).map((position)=><View key={position.currency} className="mt-2 rounded-md bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body text-xs font-semibold text-gray-500 dark:text-neutral-400">{position.currency} · NET DEBT POSITION</Text><View className="mt-3 flex-row gap-3"><View className="flex-1"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Receivable</Text><Text className="font-body mt-1 font-semibold text-gray-900 dark:text-white">{formatMinorUnits(position.receivablesMinor,position.currency)}</Text></View><View className="flex-1"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Liability</Text><Text className="font-body mt-1 font-semibold text-gray-900 dark:text-white">{formatMinorUnits(position.liabilitiesMinor,position.currency)}</Text></View></View><Text className="font-body mt-3 border-t border-gray-200 pt-2 text-sm font-semibold text-primary dark:border-neutral-700">Net worth effect · {formatMinorUnits(position.netWorthEffectMinor,position.currency)}</Text></View>):<Text className="font-body mt-2 text-gray-500">No outstanding money owed to you or by you.</Text>}
        <Text className="font-body mt-2 text-xs text-gray-500">Money you borrow adds to what you owe. Money you lend adds to what others owe you. Neither counts as income or spending.</Text>
      </Card>
      <Card title="Repayment schedules · planned only">
        <Field value={scheduleCount} onChangeText={setScheduleCount} placeholder={`Number of ${repaymentFrequency} installments`} numeric/>
        <DatePickerField label="First due date" value={repaymentStart} onChangeText={setRepaymentStart}/>
        <View className="flex-row flex-wrap"><Choice label="Monthly" selected={repaymentFrequency==='monthly'} onPress={()=>setRepaymentFrequency('monthly')}/><Choice label="Yearly" selected={repaymentFrequency==='yearly'} onPress={()=>setRepaymentFrequency('yearly')}/></View>
        <View className="flex-row flex-wrap"><Choice label="No interest" selected={scheduleMethod==='none'} onPress={()=>setScheduleMethod('none')}/><Choice label="Fixed interest" selected={scheduleMethod==='fixed'} onPress={()=>setScheduleMethod('fixed')}/><Choice label="Declining balance" selected={scheduleMethod==='declining'} onPress={()=>setScheduleMethod('declining')}/></View>
        <Text className="font-body mt-2 text-xs text-gray-500">Interest estimates use the yearly rate you entered. Planned payments do not change balances until you record them.</Text>
        {query.data?.repaymentSchedules.map((schedule)=><View key={schedule.id} className="mt-3 rounded-md bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{schedule.counterparty} · {schedule.status} · {schedule.frequency}</Text>{schedule.installments.slice(0,12).map((installment)=><Text key={installment.sequence} className="font-body mt-1 text-xs text-gray-600 dark:text-neutral-300">{installment.dueDate} · {installment.status} · principal {formatMinorUnits(installment.principalMinor,schedule.currency)} + interest {formatMinorUnits(installment.interestMinor,schedule.currency)} · remaining {formatMinorUnits(installment.remainingPrincipalMinor,schedule.currency)}</Text>)}{schedule.status==='active'?<Choice label="Cancel plan" selected={false} onPress={()=>void run(()=>localDb.obligations.debts.cancelRepaymentSchedule(user!.id,schedule.id),'Repayment plan cancelled. Posted history is unchanged.')}/>:null}</View>)}
      </Card>
      {accounts.length===0?<Text className="font-body mb-3 text-amber-700">Create an account before recording scheduled cash movements or debts.</Text>:null}
    </ScrollView>
    <ActionSheet visible={activeRecurringDrawer!==null} title={recurringDrawerTitle} onClose={()=>setActiveRecurringDrawer(null)}>
      {!!feedback?<Text accessibilityRole={feedback.error?'alert':'text'} accessibilityLiveRegion="polite" className={`font-body mb-3 rounded-xl p-3 text-sm ${feedback.error?'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200':'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'}`}>{feedback.message}</Text>:null}
      {activeRecurringDrawer==='subscription'?<>
        <Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Leverage reminds you of the renewal. It never charges the account automatically.</Text>
        <Field value={subscriptionName} onChangeText={setSubscriptionName} placeholder="Subscription name, e.g. Spotify"/><Field value={subscriptionAmount} onChangeText={setSubscriptionAmount} placeholder={`Charge amount · ${currentAccount?.currency??'select account'}`} numeric amount/>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Charge account</Text><View className="mt-1 flex-row flex-wrap">{accounts.map((account)=><Choice key={account.id} label={`${account.name} · ${account.currency}`} selected={currentAccount?.id===account.id} onPress={()=>setAccountId(account.id)}/>)}</View>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Renewal frequency</Text><View className="mt-1 flex-row flex-wrap"><Choice label="Monthly" selected={subscriptionFrequency==='monthly'} onPress={()=>setSubscriptionFrequency('monthly')}/><Choice label="Yearly" selected={subscriptionFrequency==='yearly'} onPress={()=>setSubscriptionFrequency('yearly')}/></View>
        <DatePickerField label="Next charge date" value={subscriptionStart} onChangeText={setSubscriptionStart}/>
        {!accounts.length?<Pressable accessibilityRole="link" onPress={()=>{setActiveRecurringDrawer(null);router.push('/accounts');}} className="mt-4"><Text className="font-body font-semibold text-primary">Add an account before saving →</Text></Pressable>:null}
        <Pressable accessibilityRole="button" disabled={busy||!currentAccount} onPress={saveSubscription} className={`houselog-button mt-5 min-h-12 items-center justify-center ${busy||!currentAccount?'opacity-60':''}`}><Text className="font-body font-bold text-white">Save subscription</Text></Pressable>
      </>:null}
      {activeRecurringDrawer==='schedule'?<>
        <Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Due items stay pending. No account balance changes until you approve and post an occurrence.</Text>
        {editingScheduleId?<Text className="font-body mt-3 text-xs font-semibold text-primary">Changes apply to future dates. Payments already recorded stay in history.</Text>:null}
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Transaction type</Text><View className="mt-1 flex-row flex-wrap">{(['income','expense','transfer'] as const).map((item)=><Choice key={item} label={item==='income'?'Income':item==='expense'?'Expense':'Transfer'} selected={type===item} onPress={()=>{setType(item);if(item==='income'&&!['salary','family_gift','other_income'].includes(categoryId))setCategoryId('salary');if(item==='expense'&&['salary','family_gift','other_income'].includes(categoryId))setCategoryId('bills');}}/>)}</View>
        <Field value={scheduleName} onChangeText={setScheduleName} placeholder="Schedule name"/><Field value={scheduleAmount} onChangeText={setScheduleAmount} placeholder={`Amount · ${currentAccount?.currency??'account currency'}`} numeric amount/>
        {type!=='transfer'?<><Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Category</Text><View className="mt-1 flex-row flex-wrap">{categories.filter((category)=>type==='income'?['salary','family_gift','other_income'].includes(category.id):!['salary','family_gift','other_income'].includes(category.id)).map((category)=><Choice key={category.id} label={category.label} selected={categoryId===category.id} onPress={()=>setCategoryId(category.id)}/>)}</View></>:null}
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Funding account · {currentAccount?.currency??'select account'}</Text><View className="mt-1 flex-row flex-wrap">{accounts.map((account)=><Choice key={account.id} label={`${account.name} · ${account.currency}`} selected={currentAccount?.id===account.id} onPress={()=>setAccountId(account.id)}/>)}</View>
        {type==='transfer'?<><Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Destination account · same currency</Text><View className="mt-1 flex-row flex-wrap">{accounts.filter((account)=>account.id!==currentAccount?.id&&account.currency===currentAccount?.currency).map((account)=><Choice key={account.id} label={account.name} selected={destinationId===account.id} onPress={()=>setDestinationId(account.id)}/>)}</View></>:null}
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Repeat</Text><View className="mt-1 flex-row flex-wrap">{frequencies.map((value)=><Choice key={value} label={value} selected={frequency===value} onPress={()=>setFrequency(value)}/>)}</View>
        <DatePickerField label="Start date" value={scheduleStart} onChangeText={setScheduleStart}/><DatePickerField label="End date (optional)" value={scheduleEnd} onChangeText={setScheduleEnd} placeholder="No end date" clearable/>
        {!accounts.length?<Pressable accessibilityRole="link" onPress={()=>{setActiveRecurringDrawer(null);router.push('/accounts');}} className="mt-4"><Text className="font-body font-semibold text-primary">Add an account before saving →</Text></Pressable>:null}
        <Pressable accessibilityRole="button" disabled={busy||!currentAccount} onPress={saveSchedule} className={`houselog-button mt-5 min-h-12 items-center justify-center ${busy||!currentAccount?'opacity-60':''}`}><Text className="font-body font-bold text-white">{editingScheduleId?'Save future schedule':'Save schedule'}</Text></Pressable>
        {editingScheduleId?<Pressable accessibilityRole="button" disabled={busy} onPress={()=>{setEditingScheduleId(null);setActiveRecurringDrawer(null);}} className="mt-2 min-h-10 items-center justify-center"><Text className="font-body text-primary">Cancel editing</Text></Pressable>:null}
      </>:null}
      {activeRecurringDrawer==='bill'?<>
        <Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Save the bill to track its due date. This does not post a payment or change your balance.</Text>
        <Field value={billName} onChangeText={setBillName} placeholder="Bill name"/><Field value={billAmount} onChangeText={setBillAmount} placeholder={`Amount · ${currentAccount?.currency??'account currency'}`} numeric amount/><DatePickerField label="Due date" value={billDue} onChangeText={setBillDue}/>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Bill type</Text><View className="mt-1 flex-row flex-wrap"><Choice label="One-time" selected={!billRecurring} onPress={()=>setBillRecurring(false)}/><Choice label="Repeating" selected={billRecurring} onPress={()=>setBillRecurring(true)}/></View>
        {billRecurring?<><Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Repeat frequency</Text><View className="mt-1 flex-row flex-wrap">{frequencies.map((value)=><Choice key={value} label={value} selected={billFrequency===value} onPress={()=>setBillFrequency(value)}/>)}</View></>:null}
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Bill account · {currentAccount?.currency??'select account'}</Text><View className="mt-1 flex-row flex-wrap">{accounts.map((account)=><Choice key={account.id} label={`${account.name} · ${account.currency}`} selected={currentAccount?.id===account.id} onPress={()=>setAccountId(account.id)}/>)}</View>
        {!accounts.length?<Pressable accessibilityRole="link" onPress={()=>{setActiveRecurringDrawer(null);router.push('/accounts');}} className="mt-4"><Text className="font-body font-semibold text-primary">Add an account before saving →</Text></Pressable>:null}
        <Pressable accessibilityRole="button" disabled={busy||!currentAccount} onPress={saveBill} className={`houselog-button mt-5 min-h-12 items-center justify-center ${busy||!currentAccount?'opacity-60':''}`}><Text className="font-body font-bold text-white">Save bill</Text></Pressable>
      </>:null}
      {activeRecurringDrawer==='bill-payment'&&activeBill?<>
        <View className="mb-4 rounded-md border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"><Text className="font-heading text-base font-bold text-gray-900 dark:text-white">{activeBill.name}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Due {activeBill.dueDate} · {activeBill.currency}</Text><View className="mt-3 flex-row justify-between border-t border-gray-100 pt-3 dark:border-neutral-800"><View><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Remaining</Text><Text className="font-body mt-1 font-semibold text-gray-900 dark:text-white">{formatMinorUnits(activeBill.amountMinor-activeBill.paidMinor,activeBill.currency)}</Text></View><View className="items-end"><Text className="font-body text-xs text-gray-500 dark:text-neutral-400">Paid so far</Text><Text className="font-body mt-1 font-semibold text-gray-900 dark:text-white">{formatMinorUnits(activeBill.paidMinor,activeBill.currency)}</Text></View></View></View>
        <Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Record a payment after it leaves the account. This action updates the linked bill and transaction history.</Text>
        <Field value={paymentAmount[activeBill.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[activeBill.id]:value}))} placeholder={`Payment amount · ${activeBill.currency}`} numeric amount/>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>setPaymentAmount((values)=>({...values,[activeBill.id]:formatGroupedAmountInput(((activeBill.amountMinor-activeBill.paidMinor)/100).toFixed(2))}))} className="mt-2 self-start"><Text className="font-body text-xs font-semibold text-primary">Fill remaining amount</Text></Pressable>
        <Text className="font-body mt-3 text-xs text-gray-500 dark:text-neutral-400">Account · {accounts.find((account)=>account.id===activeBill.accountId)?.name??'linked bill account'}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>recordBillPayment(activeBill)} className={`houselog-button mt-5 min-h-12 items-center justify-center ${busy?'opacity-60':''}`}><Text className="font-body font-bold text-white">Record payment</Text></Pressable>
      </>:null}
      {activeRecurringDrawer==='bill-correction'&&activeBill&&activeBillPayment?<>
        <View className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950"><Text className="font-body font-semibold text-amber-900 dark:text-amber-100">Original payment stays in history</Text><Text className="font-body mt-1 text-sm text-amber-800 dark:text-amber-200">Confirming appends a full reversal. Add a replacement amount to reverse and replace, or leave it blank to reverse only.</Text></View>
        <Text className="font-body text-sm text-gray-600 dark:text-neutral-300">{activeBill.name} · {new Date(activeBillPayment.paidAt).toLocaleDateString()} · {formatMinorUnits(activeBillPayment.amountMinor,activeBill.currency)}</Text>
        <Field value={paymentAmount[activeBillPayment.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[activeBillPayment.id]:value}))} placeholder={`Replacement amount (optional) · ${activeBill.currency}`} numeric amount/>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>correctBillPayment(activeBill,activeBillPayment)} className={`houselog-button mt-5 min-h-12 items-center justify-center ${busy?'opacity-60':''}`}><Text className="font-body font-bold text-white">Review and correct payment</Text></Pressable>
      </>:null}
    </ActionSheet>
    <ActionSheet visible={activeDebtDrawer!==null} title={debtDrawerTitle} onClose={()=>setActiveDebtDrawer(null)}>
      {!!feedback?<Text accessibilityRole={feedback.error?'alert':'text'} accessibilityLiveRegion="polite" className={`font-body mb-3 rounded-xl p-3 text-sm ${feedback.error?'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200':'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'}`}>{feedback.message}</Text>:null}
      {activeDebtDrawer==='create'?<>
        <Text className="font-body text-sm text-gray-600 dark:text-neutral-300">Opening a debt records the cash movement and tracks the matching liability or receivable.</Text>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Direction</Text><View className="mt-1 flex-row flex-wrap"><Choice label="Borrowed · I owe" selected={debtDirection==='borrowed'} onPress={()=>setDebtDirection('borrowed')}/><Choice label="Lent · owed to me" selected={debtDirection==='lent'} onPress={()=>setDebtDirection('lent')}/></View>
        <Field value={counterparty} onChangeText={setCounterparty} placeholder="Person or institution"/><Field value={debtAmount} onChangeText={setDebtAmount} placeholder={`Principal amount · ${currentAccount?.currency??'account currency'}`} numeric amount/><Field value={interestBps} onChangeText={(value)=>setInterestBps(value.replace(/[^0-9]/g,''))} placeholder="Annual interest · basis points (1200 = 12%)" numeric/>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Cash account · {currentAccount?.currency??'select an account'}</Text><View className="mt-1 flex-row flex-wrap">{accounts.map((account)=><Choice key={account.id} label={`${account.name} · ${account.currency}`} selected={currentAccount?.id===account.id} onPress={()=>setAccountId(account.id)}/>)}</View>
        {!accounts.length?<View className="mt-3 rounded-md bg-amber-50 p-3 dark:bg-amber-950"><Text className="font-body text-sm text-amber-800 dark:text-amber-200">Add an account before recording the opening cash movement.</Text><Pressable accessibilityRole="link" onPress={()=>{setActiveDebtDrawer(null);router.push('/accounts');}} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Open accounts →</Text></Pressable></View>:null}
        <Pressable accessibilityRole="button" disabled={busy||!currentAccount} accessibilityState={{disabled:busy||!currentAccount,busy}} onPress={saveDebt} className={`houselog-button mt-5 min-h-12 items-center justify-center ${busy||!currentAccount?'opacity-60':''}`}><Text className="font-body font-bold text-white">Record {debtDirection==='borrowed'?'borrowing':'money lent'}</Text></Pressable>
      </>:null}
      {activeDebtDrawer==='activity'&&activeDebt?<>
        <View className="mb-4 rounded-md border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"><Text className="font-heading text-base font-bold text-gray-900 dark:text-white">{activeDebt.counterparty}</Text><Text className="font-body mt-1 text-xs capitalize text-gray-500 dark:text-neutral-400">{activeDebt.direction==='borrowed'?'Principal you owe':'Principal owed to you'} · {activeDebt.currency}</Text><Text className="font-heading mt-3 text-xl font-bold text-gray-900 dark:text-white">{formatMinorUnits(Math.max(0,activeDebt.principalMinor-activeDebt.principalSettledMinor),activeDebt.currency)}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">principal remaining</Text></View>
        <Text className="font-body text-xs font-semibold text-gray-600 dark:text-neutral-300">Activity type</Text><View className="mt-1 flex-row flex-wrap"><Choice label="Principal payment" selected={!interestOnly} onPress={()=>setInterestOnly(false)}/><Choice label="Interest payment" selected={interestOnly} onPress={()=>setInterestOnly(true)}/></View>
        <Field value={paymentAmount[activeDebt.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[activeDebt.id]:value}))} placeholder={`${interestOnly?'Interest payment':'Principal payment'} · ${activeDebt.currency}`} numeric amount/>
        {!interestOnly?<Pressable accessibilityRole="button" disabled={busy||activeDebt.principalSettledMinor>=activeDebt.principalMinor} onPress={()=>setPaymentAmount((value)=>({...value,[activeDebt.id]:formatGroupedAmountInput((Math.max(0,activeDebt.principalMinor-activeDebt.principalSettledMinor)/100).toFixed(2))}))} className="mt-2 self-start"><Text className="font-body text-xs font-semibold text-primary">Fill remaining principal</Text></Pressable>:null}
        <Text className="font-body mt-3 text-xs text-gray-500 dark:text-neutral-400">Cash movement uses the debt’s original account: {accounts.find((account)=>account.id===activeDebt.accountId)?.name??'original account'} · {activeDebt.currency}.</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>settleDebt(activeDebt)} className={`houselog-button mt-5 min-h-12 items-center justify-center ${busy?'opacity-60':''}`}><Text className="font-body font-bold text-white">Record {interestOnly?'interest payment':'principal payment'}</Text></Pressable>
        <View className="mt-4 border-t border-gray-200 pt-4 dark:border-neutral-800"><Text className="font-body text-sm font-semibold text-gray-900 dark:text-white">Charge interest without a cash movement</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Adds an interest charge to the balance. Use this when interest accrues but has not been paid.</Text><Field value={paymentAmount[activeDebt.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[activeDebt.id]:value}))} placeholder={`Interest accrued · ${activeDebt.currency}`} numeric amount/><Pressable accessibilityRole="button" disabled={busy} onPress={()=>void run(()=>localDb.obligations.debts.chargeInterest({id:makeId(),ownerId:user!.id,debtId:activeDebt.id,amountMinor:parseMinorUnits(paymentAmount[activeDebt.id]??''),eventDate:new Date().toISOString(),idempotencyKey:makeId(),note:'Interest charged'}),'Interest charge recorded; no cash moved.',()=>{setPaymentAmount((value)=>({...value,[activeDebt.id]:''}));setActiveDebtDrawer(null);})} className={`mt-3 min-h-11 items-center justify-center border border-primary ${busy?'opacity-60':''}`}><Text className="font-body font-semibold text-primary">Charge interest (no cash)</Text></Pressable></View>
      </>:null}
      {activeDebtDrawer==='plan'&&activeDebt?<>
        <View className="mb-3 rounded-md border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"><Text className="font-heading text-base font-bold text-gray-900 dark:text-white">{activeDebt.counterparty} · {activeDebt.currency}</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Principal remaining {formatMinorUnits(Math.max(0,activeDebt.principalMinor-activeDebt.principalSettledMinor),activeDebt.currency)}</Text></View>
        <Text className="font-body text-sm text-gray-600 dark:text-neutral-300">This creates a repayment projection only. It does not change the balance or post cash transactions.</Text>
        <Field value={paymentAmount[activeDebt.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[activeDebt.id]:value}))} placeholder={`Installment amount · ${activeDebt.currency}`} numeric amount/><Field value={scheduleCount} onChangeText={(value)=>setScheduleCount(value.replace(/[^0-9]/g,''))} placeholder={`Number of ${repaymentFrequency} installments (1–600)`} numeric/>
        <DatePickerField label="First due date" value={repaymentStart} onChangeText={setRepaymentStart}/>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Frequency</Text><View className="mt-1 flex-row flex-wrap"><Choice label="Monthly" selected={repaymentFrequency==='monthly'} onPress={()=>setRepaymentFrequency('monthly')}/><Choice label="Yearly" selected={repaymentFrequency==='yearly'} onPress={()=>setRepaymentFrequency('yearly')}/></View>
        <Text className="font-body mt-4 text-xs font-semibold text-gray-600 dark:text-neutral-300">Interest projection</Text><View className="mt-1 flex-row flex-wrap"><Choice label="No interest" selected={scheduleMethod==='none'} onPress={()=>setScheduleMethod('none')}/><Choice label="Fixed interest" selected={scheduleMethod==='fixed'} onPress={()=>setScheduleMethod('fixed')}/><Choice label="Declining balance" selected={scheduleMethod==='declining'} onPress={()=>setScheduleMethod('declining')}/></View>
        <Text className="font-body mt-2 text-xs text-gray-500 dark:text-neutral-400">Interest estimates use this debt’s {(activeDebt.interestRateBps/100).toFixed(2)}% yearly rate.</Text><Pressable accessibilityRole="button" disabled={busy} onPress={()=>createRepaymentSchedule(activeDebt)} className={`houselog-button mt-5 min-h-12 items-center justify-center ${busy?'opacity-60':''}`}><Text className="font-body font-bold text-white">Save repayment plan</Text></Pressable>
      </>:null}
      {activeDebtDrawer==='correction'&&activeDebt&&activeDebtEvent?<>
        <View className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950"><Text className="font-body font-semibold text-amber-900 dark:text-amber-100">Original event stays in history</Text><Text className="font-body mt-1 text-sm text-amber-800 dark:text-amber-200">Confirming will append a reversal. Add a replacement amount to reverse and replace; leave it blank to reverse only.</Text></View>
        <Text className="font-body text-xs text-gray-500 dark:text-neutral-400">{new Date(activeDebtEvent.eventDate).toLocaleDateString()} · {activeDebtEvent.eventType.replace('_',' ')} · {formatMinorUnits(activeDebtEvent.principalMinor+activeDebtEvent.interestMinor,activeDebt.currency)}</Text>
        <Field value={paymentAmount[activeDebtEvent.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[activeDebtEvent.id]:value}))} placeholder={`Replacement amount (optional) · ${activeDebt.currency}`} numeric amount/>
        <Pressable accessibilityRole="button" disabled={busy} onPress={()=>correctDebtEvent(activeDebt,activeDebtEvent)} className={`houselog-button mt-5 min-h-12 items-center justify-center ${busy?'opacity-60':''}`}><Text className="font-body font-bold text-white">Review and correct event</Text></Pressable>
      </>:null}
    </ActionSheet>
    {dialog}
  </SafeAreaView></ObligationBusyContext.Provider>;
}
