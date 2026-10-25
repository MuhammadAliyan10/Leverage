import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DoneHeader } from '../components/ui/DoneHeader';
import { useAppConfirm } from '../components/ui/useAppConfirm';
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

const makeId = () => `hl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const today = () => {const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
const frequencies: RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];
const categories = [
  { id: 'salary', label: 'Salary' }, { id: 'family_gift', label: 'Family support' },
  { id: 'other_income', label: 'Other income' }, { id: 'bills', label: 'Bills' },
  { id: 'housing', label: 'Housing' }, { id: 'other_expense', label: 'Other expense' },
];

function Choice({ label, selected, onPress }: {label:string;selected:boolean;onPress:()=>void}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} className={`mr-2 mt-2 rounded-full px-3 py-2 ${selected?'bg-primary':'bg-gray-100 dark:bg-neutral-800'}`}><Text className={["font-body", (selected?'text-xs font-semibold text-white':'text-xs text-gray-700 dark:text-neutral-200')].filter(Boolean).join(' ')}>{label}</Text></Pressable>;
}
function Field({ value, onChangeText, placeholder, numeric = false, amount = false }: {value:string;onChangeText:(value:string)=>void;placeholder:string;numeric?:boolean;amount?:boolean}) {
  return <TextInput accessibilityLabel={placeholder} value={value} onChangeText={(text) => onChangeText(amount ? formatGroupedAmountInput(text) : text)} placeholder={placeholder} keyboardType={numeric?'decimal-pad':'default'} className="font-body mt-2 rounded-xl bg-gray-100 px-3 py-3 text-gray-900 dark:bg-neutral-800 dark:text-white" />;
}
function Card({ title, children }: {title:string;children:React.ReactNode}) {
  return <View className="mb-4 rounded-2xl bg-white p-4 dark:bg-neutral-900"><Text className="font-body text-base font-bold text-gray-900 dark:text-white">{title}</Text>{children}</View>;
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
    void run(()=>localDb.obligations.schedules.save({id:editingScheduleId??makeId(),ownerId:user.id,scheduleType:type,name:scheduleName,amountMinor:parseMinorUnits(scheduleAmount),currency:currentAccount.currency,accountId:currentAccount.id,toAccountId:type==='transfer'?destinationId:null,frequency,startDate:scheduleStart,endDate:scheduleEnd||null,classificationId:type==='transfer'?null:categoryId}), 'Schedule saved. Due dates will remain pending until you approve them.',()=>{setEditingScheduleId(null);setScheduleName('');setScheduleAmount('');});
  };
  const saveSubscription=()=>{
    if(!user||!currentAccount) {setFeedback({message:'Create or select an account before scheduling a subscription.',error:true});return;}
    void run(()=>localDb.obligations.schedules.save({
      id:makeId(),ownerId:user.id,scheduleType:'expense',name:subscriptionName,amountMinor:parseMinorUnits(subscriptionAmount),
      currency:currentAccount.currency,accountId:currentAccount.id,frequency:subscriptionFrequency,startDate:subscriptionStart,
      classificationId:'bills',
    }), 'Subscription schedule saved. Leverage will show each due charge for confirmation before it changes your balance.',()=>{
      setSubscriptionName('');setSubscriptionAmount('');setSubscriptionStart(today());
    });
  };
  const saveBill=()=>{
    if(!user||!currentAccount) {setFeedback({message:'Create or select an account before adding a bill.',error:true});return;}
    const id=makeId();
    void run(()=>billRecurring?localDb.obligations.createRecurringBill({bill:{id,ownerId:user.id,name:billName,categoryId:'bills',amountMinor:parseMinorUnits(billAmount),currency:currentAccount.currency,dueDate:billDue,accountId:currentAccount.id},schedule:{id:`${id}:repeat`,frequency:billFrequency}}):localDb.obligations.bills.create({id,ownerId:user.id,name:billName,categoryId:'bills',amountMinor:parseMinorUnits(billAmount),currency:currentAccount.currency,dueDate:billDue,accountId:currentAccount.id}), 'Bill saved. No money has left your account.');
  };
  const remindBill=async(billId:string)=>{
    if(!user) return;
    if(!profileSettings.remindersEnabled) {setFeedback({message:'Enable local bill reminders in Settings first.',error:true});return;}
    try {
      await scheduleBillReminder(user.id,billId);
      await client.invalidateQueries({queryKey:['obligations',user.id]});
      setFeedback({message:'Reminder scheduled for 9:00 AM on the bill due date.',error:false});
    } catch(error) { setFeedback({message:error instanceof Error?error.message:'Reminder could not be scheduled. Please try again.',error:true}); }
  };
  const saveDebt=()=>{
    if(!user||!currentAccount) {setFeedback({message:'Create or select an account before recording debt.',error:true});return;}
    const id=makeId();
    void run(()=>localDb.obligations.createDebt({id,ownerId:user.id,direction:debtDirection,counterparty,principalMinor:parseMinorUnits(debtAmount),currency:currentAccount.currency,accountId:currentAccount.id,interestRateBps:Number(interestBps),openedAt:new Date().toISOString(),transactionId:`${id}:opening`,idempotencyKey:`${id}:opening`}),debtDirection==='borrowed'?'Borrowing recorded as cash and a liability, not income.':'Loan recorded as a receivable, not spending.');
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
    },interestOnly?'Interest payment recorded and cash movement posted.':'Principal updated and cash movement recorded.');
  };
  const correctBillPayment=(bill:BillRecord,payment:BillPaymentRecord)=>{
    if(!user) return;
    void confirmAction('Correct bill payment?','The original payment stays in history. Leverage will append a full reversal and optionally a replacement using the amount entered below.','Reverse / replace').then((confirmed)=>{
      if(!confirmed) return;
      void run(async()=>{
        const id=makeId(); const entered=paymentAmount[payment.id]?.trim();
        await localDb.obligations.correctBillPayment({id,ownerId:user.id,billId:bill.id,paymentId:payment.id,reversalTransactionId:`${id}:reversal`,reason:'Payment corrected by user',...(entered?{replacement:{id:`${id}:payment`,transactionId:`${id}:tx`,amountMinor:parseMinorUnits(entered),accountId:currentAccount?.currency===bill.currency?currentAccount.id:undefined,idempotencyKey:`${id}:key`,paidAt:new Date().toISOString()}}:{})});
        setPaymentAmount((current)=>({...current,[payment.id]:''}));
      },'Correction committed to the bill and transaction history.');
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
      },'Correction committed to the debt and transaction history.');
    });
  };
  const createRepaymentSchedule=(debt:DebtRecord)=>{
    if(!user) return;
    void run(()=>localDb.obligations.debts.createRepaymentSchedule({id:makeId(),ownerId:user.id,debtId:debt.id,frequency:repaymentFrequency,firstDueDate:repaymentStart,installmentAmountMinor:parseMinorUnits(paymentAmount[debt.id]??''),interestMethod:scheduleMethod,rateBps:scheduleMethod==='none'?0:debt.interestRateBps,installmentCount:Number(scheduleCount)}),'Projected installments saved. No cash movement was posted.');
  };

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <DoneHeader title="Recurring & Debt" onDone={closeObligations} />
    <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{paddingBottom:32}}>
      {query.isLoading||accountQuery.isLoading?<Text className="font-body py-4 text-gray-500">Loading obligations…</Text>:null}
      {!!feedback?<Text accessibilityRole={feedback.error?'alert':'text'} accessibilityLiveRegion="polite" className={`font-body mb-3 rounded-xl p-3 text-sm ${feedback.error?'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-200':'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'}`}>{feedback.message}</Text>:null}
      {query.isError?<View className="mb-3 rounded-xl bg-red-50 p-3 dark:bg-red-950"><Text className="font-body text-sm text-red-700 dark:text-red-200">{query.error.message}</Text><Pressable accessibilityRole="button" onPress={()=>void query.refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>:null}
      {accountQuery.error?<View className="mb-3 rounded-xl bg-red-50 p-3 dark:bg-red-950"><Text className="font-body text-sm text-red-700 dark:text-red-200">Accounts could not be loaded: {accountQuery.error.message}</Text><Pressable accessibilityRole="button" onPress={()=>void accountQuery.refetch()} className="mt-2 self-start"><Text className="font-body font-semibold text-primary">Try again</Text></Pressable></View>:null}
      <Text className="font-body mb-3 text-sm text-gray-600 dark:text-neutral-300">Planned entries never change balances. Only a posted occurrence or recorded payment creates a ledger transaction.</Text>
      <Card title="Subscriptions">
        <Text className="font-body mt-1 text-sm text-gray-600 dark:text-neutral-300">Set the provider, amount, account and next charge date. Leverage tracks each renewal and keeps it pending until you confirm the provider charged you. It records the expense in your ledger; it cannot initiate a JazzCash or bank payment.</Text>
        <Field value={subscriptionName} onChangeText={setSubscriptionName} placeholder="Subscription name, e.g. Spotify"/>
        <Field value={subscriptionAmount} onChangeText={setSubscriptionAmount} placeholder={`Charge amount (${currentAccount?.currency??'PKR'})`} numeric amount/>
        <Text className="font-body mt-3 text-xs text-gray-500 dark:text-neutral-400">Charge account · {currentAccount?.name??'choose an account below'}</Text>
        <View className="flex-row flex-wrap">{accounts.map((account)=><Choice key={account.id} label={`${account.name} · ${account.currency}`} selected={currentAccount?.id===account.id} onPress={()=>setAccountId(account.id)}/>)}</View>
        <Text className="font-body mt-3 text-xs font-semibold text-gray-700 dark:text-neutral-200">Renewal frequency</Text>
        <View className="flex-row"><Choice label="Monthly" selected={subscriptionFrequency==='monthly'} onPress={()=>setSubscriptionFrequency('monthly')}/><Choice label="Yearly" selected={subscriptionFrequency==='yearly'} onPress={()=>setSubscriptionFrequency('yearly')}/></View>
        <DatePickerField label="Next charge date" value={subscriptionStart} onChangeText={setSubscriptionStart}/>
        <Pressable disabled={busy} accessibilityRole="button" onPress={saveSubscription} className="houselog-button mt-4 items-center px-4 py-3"><Text className="font-body font-bold text-white">Save subscription</Text></Pressable>
      </Card>
      <Card title="Create a recurring transaction">
        {editingScheduleId?<Text className="font-body mt-2 text-xs font-semibold text-primary">Editing future dates only. Already posted transactions remain unchanged.</Text>:null}
        <View className="flex-row flex-wrap">{(['income','expense','transfer'] as const).map((item)=><Choice key={item} label={item} selected={type===item} onPress={()=>{setType(item);if(item==='income'&&!['salary','family_gift','other_income'].includes(categoryId))setCategoryId('salary');if(item==='expense'&&['salary','family_gift','other_income'].includes(categoryId))setCategoryId('bills');}}/>)}</View>
        <Field value={scheduleName} onChangeText={setScheduleName} placeholder="Name, e.g. monthly salary"/>
        <Field value={scheduleAmount} onChangeText={setScheduleAmount} placeholder="Amount" numeric amount/>
        {type!=='transfer'?<View className="flex-row flex-wrap">{categories.filter((c)=>type==='income'?['salary','family_gift','other_income'].includes(c.id):!['salary','family_gift','other_income'].includes(c.id)).map((category)=><Choice key={category.id} label={category.label} selected={categoryId===category.id} onPress={()=>setCategoryId(category.id)}/>)}</View>:null}
        <Text className="font-body mt-3 text-xs text-gray-500">Funding account · {currentAccount?.name??'choose an account below'}</Text>
        <View className="flex-row flex-wrap">{accounts.map((account)=><Choice key={account.id} label={`${account.name} · ${account.currency}`} selected={currentAccount?.id===account.id} onPress={()=>setAccountId(account.id)}/>)}</View>
        {type==='transfer'?<><Text className="font-body mt-2 text-xs text-gray-500">Destination account</Text><View className="flex-row flex-wrap">{accounts.filter((account)=>account.id!==currentAccount?.id&&account.currency===currentAccount?.currency).map((account)=><Choice key={account.id} label={account.name} selected={destinationId===account.id} onPress={()=>setDestinationId(account.id)}/>)}</View></>:null}
        <View className="flex-row flex-wrap">{frequencies.map((value)=><Choice key={value} label={value} selected={frequency===value} onPress={()=>setFrequency(value)}/>)}</View>
        <DatePickerField label="Start date" value={scheduleStart} onChangeText={setScheduleStart}/>
        <DatePickerField label="End date (optional)" value={scheduleEnd} onChangeText={setScheduleEnd} placeholder="No end date" clearable/>
        <Pressable disabled={busy} onPress={saveSchedule} className="houselog-button mt-4 items-center px-4 py-3"><Text className="font-body font-bold text-white">{editingScheduleId?'Save future schedule':'Save schedule'}</Text></Pressable>
        {editingScheduleId?<Pressable onPress={()=>setEditingScheduleId(null)} className="mt-2 items-center p-2"><Text className="font-body text-primary">Cancel editing</Text></Pressable>:null}
      </Card>
      <Card title="Schedules">
        {query.data?.schedules.length===0?<Text className="font-body mt-2 text-gray-500">No recurring schedules yet.</Text>:null}
        {query.data?.schedules.map((schedule)=><View key={schedule.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{schedule.name} · {schedule.status} · {schedule.frequency}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">{formatMinorUnits(schedule.amountMinor,schedule.currency)} · next {schedule.nextDueDate} · {schedule.scheduleType}</Text><View className="flex-row flex-wrap">{schedule.status!=='cancelled'?<>{schedule.scheduleType!=='bill'?<Choice label="Edit" selected={false} onPress={()=>{setEditingScheduleId(schedule.id);if(schedule.scheduleType!=='bill')setType(schedule.scheduleType);setScheduleName(schedule.name);setScheduleAmount((schedule.amountMinor/100).toFixed(2));setFrequency(schedule.frequency);setScheduleStart(schedule.startDate);setScheduleEnd(schedule.endDate??'');setAccountId(schedule.accountId);setDestinationId(schedule.toAccountId??'');setCategoryId(schedule.classificationId??'other_expense');}}/>:null}<Choice label={schedule.status==='paused'?'Resume':'Pause'} selected={false} onPress={()=>void run(()=>localDb.obligations.schedules.setStatus(user!.id,schedule.id,schedule.status==='paused'?'active':'paused'),'Schedule status updated.')}/><Choice label="Cancel" selected={false} onPress={()=>confirmThenRun('Cancel schedule?','Pending occurrences stay visible; future dates stop being generated.','Cancel schedule',()=>localDb.obligations.schedules.setStatus(user!.id,schedule.id,'cancelled'),'Future dates cancelled.')}/></>:null}</View></View>)}
      </Card>
      <Card title="Upcoming & missed occurrences">
        {!query.data?.occurrences.filter((item)=>item.status==='pending').length?<Text className="font-body mt-2 text-gray-500">No pending occurrences. Opening this screen catches missed dates while keeping them unposted.</Text>:null}
        {query.data?.occurrences.filter((item)=>item.status==='pending').map((item)=>{
          const account=accounts.find((candidate)=>candidate.id===item.accountId);
          const insufficient=account&&account.currency===item.currency&&account.balanceMinor<item.amountMinor;
          const isSubscriptionExpense=item.scheduleType==='expense'&&item.classificationId==='bills';
          return <View key={item.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{item.name} · {item.occurrenceDate}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">{item.scheduleType==='bill'?'Bill due':item.scheduleType} · {formatMinorUnits(item.amountMinor,item.currency)} · Pending approval</Text>{isSubscriptionExpense?<Text className={`font-body mt-2 text-xs ${insufficient?'text-amber-700 dark:text-amber-300':'text-gray-500 dark:text-neutral-400'}`}>{insufficient?`Balance is below the charge (${formatMinorUnits(account.balanceMinor,item.currency)} available). Confirm with the provider before recording.`:'Record only after confirming the provider charged this account. Leverage does not initiate the payment.'}</Text>:null}<View className="mt-2 flex-row">{item.scheduleType!=='bill'?<Pressable onPress={()=>void run(()=>localDb.obligations.postOccurrence({ownerId:user!.id,id:item.id,transactionId:makeId()}),isSubscriptionExpense?'Subscription charge recorded in account history.':'Occurrence posted to account history.')} className="houselog-button mr-2 px-3 py-2"><Text className="font-body text-xs font-bold text-white">{isSubscriptionExpense?'Record after charge':'Post now'}</Text></Pressable>:null}<Pressable onPress={()=>void run(()=>localDb.obligations.skipOccurrence(user!.id,item.id),'Occurrence skipped; no balance changed.')} className="rounded-lg bg-gray-200 px-3 py-2 dark:bg-neutral-700"><Text className="font-body text-xs text-gray-800 dark:text-white">Skip</Text></Pressable></View></View>;
        })}
      </Card>
      <Card title="One-time bill">
        <Field value={billName} onChangeText={setBillName} placeholder="Bill name"/><Field value={billAmount} onChangeText={setBillAmount} placeholder="Amount" numeric amount/><DatePickerField label="Due date" value={billDue} onChangeText={setBillDue}/>
        <View className="flex-row flex-wrap"><Choice label={billRecurring?'Recurring':'One-time'} selected={!billRecurring} onPress={()=>setBillRecurring(false)}/><Choice label="Make recurring" selected={billRecurring} onPress={()=>setBillRecurring(true)}/></View>
        {billRecurring?<View className="flex-row flex-wrap">{frequencies.map((value)=><Choice key={value} label={value} selected={billFrequency===value} onPress={()=>setBillFrequency(value)}/>)}</View>:null}
        <Text className="font-body mt-2 text-xs text-gray-500">Bill account · {currentAccount?.name??'choose an account above'}</Text>
        <Pressable disabled={busy} onPress={saveBill} className="houselog-button mt-3 items-center px-4 py-3"><Text className="font-body font-bold text-white">Add bill (no payment)</Text></Pressable>
        {query.data?.bills.map((bill)=><View key={bill.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{bill.name} · {bill.status} · due {bill.dueDate}{bill.scheduleId?' · recurring':''}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">Paid {formatMinorUnits(bill.paidMinor,bill.currency)} of {formatMinorUnits(bill.amountMinor,bill.currency)} · remaining {formatMinorUnits(bill.amountMinor-bill.paidMinor,bill.currency)}</Text><View className="flex-row flex-wrap"><Choice label={historyBillId===bill.id?'Hide history':'Payment history'} selected={historyBillId===bill.id} onPress={()=>setHistoryBillId(historyBillId===bill.id?null:bill.id)}/>{bill.status!=='paid'&&bill.status!=='cancelled'&&bill.status!=='skipped'?<Choice label="Skip unpaid bill" selected={false} onPress={()=>confirmThenRun('Skip this bill?','The bill record will remain in history.','Skip',async()=>{const reminderId=await localDb.obligations.setBillStatus(user!.id,bill.id,'skipped');if(reminderId) await cancelBillReminder(user!.id,bill.id,reminderId);},'Bill skipped; its reminder was cancelled.') }/>:null}{bill.status!=='paid'&&bill.status!=='cancelled'&&bill.paidMinor===0?<Choice label="Cancel bill" selected={false} onPress={()=>confirmThenRun('Cancel this bill?','The bill remains in history. Any existing payment must be corrected separately.','Cancel bill',async()=>{const reminderId=await localDb.obligations.cancelBill(user!.id,bill.id);if(reminderId) await cancelBillReminder(user!.id,bill.id,reminderId);},'Bill cancelled; its reminder was cancelled.') }/>:null}</View>{historyBillId===bill.id?billHistoryQuery.data?.map((payment)=><View key={payment.id} className="mt-2 rounded-lg bg-white p-2 dark:bg-neutral-900"><Text className="font-body text-xs text-gray-600 dark:text-neutral-300">{new Date(payment.paidAt).toLocaleDateString()} · {formatMinorUnits(payment.amountMinor,bill.currency)} · transaction {payment.transactionId}{payment.corrected?' · corrected':''}</Text>{!payment.corrected?<><Field value={paymentAmount[payment.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[payment.id]:value}))} placeholder="Replacement amount (blank reverses only)" numeric amount/><Choice label="Correct payment" selected={false} onPress={()=>correctBillPayment(bill,payment)}/></>:null}</View>):null}{bill.status!=='paid'&&bill.status!=='cancelled'&&bill.status!=='skipped'?<><View className="flex-row items-center"><View className="flex-1"><Field value={paymentAmount[bill.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[bill.id]:value}))} placeholder="Payment amount" numeric amount/></View><Pressable onPress={()=>void run(async()=>{const id=makeId();await localDb.obligations.createBillPayment({id,ownerId:user!.id,billId:bill.id,amountMinor:parseMinorUnits(paymentAmount[bill.id]??''),transactionId:`${id}:tx`,idempotencyKey:id,paidAt:new Date().toISOString()});const updated=(await localDb.obligations.bills.list(user!.id)).find((item)=>item.id===bill.id);if(updated?.status==='paid'&&bill.reminderId){await cancelBillReminder(user!.id,bill.id,bill.reminderId);await localDb.obligations.setBillReminder(user!.id,bill.id,null);}},'Payment posted after the ledger write committed.')} className="houselog-button ml-2 mt-2 px-3 py-3"><Text className="font-body text-xs font-bold text-white">Pay</Text></Pressable></View><Pressable onPress={()=>void remindBill(bill.id)} className="mt-2 self-start rounded-lg bg-primary/10 px-3 py-2"><Text className="font-body text-xs font-semibold text-primary">{bill.reminderId?'Reschedule reminder':'Set reminder'}</Text></Pressable></>:null}</View>)}
      </Card>
      <Card title="Borrowed and lent money">
        <View className="flex-row flex-wrap"><Choice label="Borrowed" selected={debtDirection==='borrowed'} onPress={()=>setDebtDirection('borrowed')}/><Choice label="Lent to someone" selected={debtDirection==='lent'} onPress={()=>setDebtDirection('lent')}/></View>
        <Field value={counterparty} onChangeText={setCounterparty} placeholder="Person / institution"/><Field value={debtAmount} onChangeText={setDebtAmount} placeholder="Principal amount" numeric amount/><Field value={interestBps} onChangeText={setInterestBps} placeholder="Annual interest rate (basis points, e.g. 1200 = 12%)" numeric/>
        <Pressable disabled={busy} onPress={saveDebt} className="houselog-button mt-3 items-center px-4 py-3"><Text className="font-body font-bold text-white">Record {debtDirection==='borrowed'?'borrowing':'money lent'}</Text></Pressable>
        {query.data?.debts.map((debt)=><View key={debt.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{debt.direction==='borrowed'?'Owe':'Owed to you'} · {debt.counterparty} · {debt.status}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">Principal remaining {formatMinorUnits(Math.max(0,debt.principalMinor-debt.principalSettledMinor),debt.currency)} · interest owed {formatMinorUnits(Math.max(0,debt.interestAccruedMinor-debt.interestPaidMinor),debt.currency)} · interest paid {formatMinorUnits(debt.interestPaidMinor,debt.currency)} · rate {(debt.interestRateBps/100).toFixed(2)}% p.a.</Text><Choice label={historyDebtId===debt.id?'Hide history':'Debt history'} selected={historyDebtId===debt.id} onPress={()=>setHistoryDebtId(historyDebtId===debt.id?null:debt.id)}/>{historyDebtId===debt.id?debtHistoryQuery.data?.map((event)=><View key={event.id} className="mt-2 rounded-lg bg-white p-2 dark:bg-neutral-900"><Text className="font-body text-xs text-gray-600 dark:text-neutral-300">{new Date(event.eventDate).toLocaleDateString()} · {event.eventType.replace('_',' ')} · {formatMinorUnits(event.principalMinor+event.interestMinor,debt.currency)}{event.transactionId?` · ${event.transactionId}`:event.isAccrual?' · no cash movement':''}{event.corrected?' · corrected':''}</Text>{!event.corrected&&event.eventType!=='interest_reversal'?<><Field value={paymentAmount[event.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[event.id]:value}))} placeholder="Replacement amount (blank reverses only)" numeric amount/><Choice label="Correct event" selected={false} onPress={()=>correctDebtEvent(debt,event)}/></>:null}</View>):null}{debt.status==='open'?<><View className="flex-row flex-wrap"><Choice label="Principal" selected={!interestOnly} onPress={()=>setInterestOnly(false)}/><Choice label="Interest" selected={interestOnly} onPress={()=>setInterestOnly(true)}/></View><View className="flex-row items-center"><View className="flex-1"><Field value={paymentAmount[debt.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[debt.id]:value}))} placeholder={interestOnly?'Interest amount':'Principal payment'} numeric amount/></View><Pressable disabled={busy} onPress={()=>settleDebt(debt)} className="houselog-button ml-2 mt-2 px-3 py-3"><Text className="font-body text-xs font-bold text-white">Record</Text></Pressable></View><View className="flex-row flex-wrap"><Choice label="Fill remaining principal" selected={false} onPress={()=>{setInterestOnly(false);setPaymentAmount((value)=>({...value,[debt.id]:formatGroupedAmountInput(((debt.principalMinor-debt.principalSettledMinor)/100).toFixed(2))}));}}/><Choice label="Charge interest (no cash)" selected={false} onPress={()=>void run(()=>localDb.obligations.debts.chargeInterest({id:makeId(),ownerId:user!.id,debtId:debt.id,amountMinor:parseMinorUnits(paymentAmount[debt.id]??''),eventDate:new Date().toISOString(),idempotencyKey:makeId(),note:'Interest charged'}),'Interest charge recorded; no cash moved.')}/></View></>:null}</View>)}
      </Card>
      <Card title="Debt position">
        {query.data?.debts.length?calculateDebtPositions(query.data.debts).map((position)=><Text key={position.currency} className="font-body mt-2 text-sm text-gray-700 dark:text-neutral-200">{position.currency} · receivables {formatMinorUnits(position.receivablesMinor,position.currency)} · liabilities {formatMinorUnits(position.liabilitiesMinor,position.currency)} · net worth effect {formatMinorUnits(position.netWorthEffectMinor,position.currency)}</Text>):<Text className="font-body mt-2 text-gray-500">No outstanding debts or receivables.</Text>}
        <Text className="font-body mt-2 text-xs text-gray-500">Borrowed principal is a liability; lent principal is a receivable. Neither is revenue or spending.</Text>
      </Card>
      <Card title="Repayment schedules · planned only">
        <Field value={scheduleCount} onChangeText={setScheduleCount} placeholder={`Number of ${repaymentFrequency} installments`} numeric/>
        <DatePickerField label="First due date" value={repaymentStart} onChangeText={setRepaymentStart}/>
        <View className="flex-row flex-wrap"><Choice label="Monthly" selected={repaymentFrequency==='monthly'} onPress={()=>setRepaymentFrequency('monthly')}/><Choice label="Yearly" selected={repaymentFrequency==='yearly'} onPress={()=>setRepaymentFrequency('yearly')}/></View>
        <View className="flex-row flex-wrap"><Choice label="No interest" selected={scheduleMethod==='none'} onPress={()=>setScheduleMethod('none')}/><Choice label="Fixed interest" selected={scheduleMethod==='fixed'} onPress={()=>setScheduleMethod('fixed')}/><Choice label="Declining balance" selected={scheduleMethod==='declining'} onPress={()=>setScheduleMethod('declining')}/></View>
        <Text className="font-body mt-2 text-xs text-gray-500">Interest projections use each debt’s explicitly recorded annual rate. Installments remain planned and never post cash.</Text>
        {query.data?.debts.filter((debt)=>debt.status==='open').map((debt)=><View key={debt.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{debt.counterparty} · {debt.currency}</Text><Field value={paymentAmount[debt.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[debt.id]:value}))} placeholder="Installment amount" numeric amount/><Pressable disabled={busy} onPress={()=>createRepaymentSchedule(debt)} className="houselog-button mt-2 self-start px-3 py-2"><Text className="font-body text-xs font-bold text-white">Add {repaymentFrequency} plan</Text></Pressable></View>)}
        {query.data?.repaymentSchedules.map((schedule)=><View key={schedule.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{schedule.counterparty} · {schedule.status} · {schedule.frequency}</Text>{schedule.installments.slice(0,12).map((installment)=><Text key={installment.sequence} className="font-body mt-1 text-xs text-gray-600 dark:text-neutral-300">{installment.dueDate} · {installment.status} · principal {formatMinorUnits(installment.principalMinor,schedule.currency)} + interest {formatMinorUnits(installment.interestMinor,schedule.currency)} · remaining {formatMinorUnits(installment.remainingPrincipalMinor,schedule.currency)}</Text>)}{schedule.status==='active'?<Choice label="Cancel plan" selected={false} onPress={()=>void run(()=>localDb.obligations.debts.cancelRepaymentSchedule(user!.id,schedule.id),'Repayment plan cancelled. Posted history is unchanged.')}/>:null}</View>)}
      </Card>
      {accounts.length===0?<Text className="font-body mb-3 text-amber-700">Create an account before recording scheduled cash movements or debts.</Text>:null}
    </ScrollView>
    {dialog}
  </SafeAreaView>;
}
