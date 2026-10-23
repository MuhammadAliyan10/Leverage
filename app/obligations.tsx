import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View, Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../src/context/AuthContext';
import * as Notifications from 'expo-notifications';
import { useAccounts } from '../hooks/queries/useAccounts';
import { localDb } from '../src/db/local/client';
import { formatMinorUnits, parseMinorUnits } from '../src/finance/ledger';
import type { RecurrenceFrequency } from '../src/finance/recurrence';
import { calculateDebtPositions } from '../src/finance/debtPosition';

const makeId = () => `hl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const today = () => {const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
const frequencies: RecurrenceFrequency[] = ['daily', 'weekly', 'monthly', 'yearly'];
const categories = [
  { id: 'salary', label: 'Salary' }, { id: 'family_gift', label: 'Family support' },
  { id: 'other_income', label: 'Other income' }, { id: 'bills', label: 'Bills' },
  { id: 'housing', label: 'Housing' }, { id: 'other_expense', label: 'Other expense' },
];

function Choice({ label, selected, onPress }: {label:string;selected:boolean;onPress:()=>void}) {
  return <Pressable onPress={onPress} className={`mr-2 mt-2 rounded-full px-3 py-2 ${selected?'bg-primary':'bg-gray-100 dark:bg-neutral-800'}`}><Text className={["font-body", (selected?'text-xs font-semibold text-white':'text-xs text-gray-700 dark:text-neutral-200')].filter(Boolean).join(' ')}>{label}</Text></Pressable>;
}
function Field({ value, onChangeText, placeholder, numeric = false }: {value:string;onChangeText:(value:string)=>void;placeholder:string;numeric?:boolean}) {
  return <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} keyboardType={numeric?'decimal-pad':'default'} className="font-body mt-2 rounded-xl bg-gray-100 px-3 py-3 text-gray-900 dark:bg-neutral-800 dark:text-white" />;
}
function Card({ title, children }: {title:string;children:React.ReactNode}) {
  return <View className="mb-4 rounded-2xl bg-white p-4 dark:bg-neutral-900"><Text className="font-body text-base font-bold text-gray-900 dark:text-white">{title}</Text>{children}</View>;
}

export default function ObligationsScreen() {
  const router = useRouter();
  const { user } = useAuth();
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
    setBusy(true);
    try { await task(); await client.invalidateQueries({queryKey:['obligations',user?.id]}); await client.invalidateQueries({queryKey:['accounts',user?.id]}); await client.invalidateQueries({queryKey:['dashboard']}); await client.invalidateQueries({queryKey:['financial-report',user?.id]}); after?.(); Alert.alert('Saved',success); }
    catch(error) { Alert.alert('Could not save',error instanceof Error?error.message:'Please try again.'); }
    finally { setBusy(false); }
  };
  const saveSchedule=()=>{
    if(!user||!currentAccount) return Alert.alert('Choose an account','Create an account before scheduling a transaction.');
    if(type==='transfer'&&(!destinationId||destinationId===currentAccount.id)) return Alert.alert('Choose a destination','Select a different same-currency account.');
    const destination=accounts.find((account)=>account.id===destinationId);
    if(type==='transfer'&&destination?.currency!==currentAccount.currency) return Alert.alert('Currency mismatch','Transfers need accounts in the same currency.');
    void run(()=>localDb.obligations.schedules.save({id:editingScheduleId??makeId(),ownerId:user.id,scheduleType:type,name:scheduleName,amountMinor:parseMinorUnits(scheduleAmount),currency:currentAccount.currency,accountId:currentAccount.id,toAccountId:type==='transfer'?destinationId:null,frequency,startDate:scheduleStart,endDate:scheduleEnd||null,classificationId:type==='transfer'?null:categoryId}), 'Schedule saved. Due dates will remain pending until you approve them.',()=>{setEditingScheduleId(null);setScheduleName('');setScheduleAmount('');});
  };
  const saveBill=()=>{
    if(!user||!currentAccount) return Alert.alert('Choose an account','Create an account before adding a bill.');
    const id=makeId();
    void run(()=>billRecurring?localDb.obligations.createRecurringBill({bill:{id,ownerId:user.id,name:billName,categoryId:'bills',amountMinor:parseMinorUnits(billAmount),currency:currentAccount.currency,dueDate:billDue,accountId:currentAccount.id},schedule:{id:`${id}:repeat`,frequency:billFrequency}}):localDb.obligations.bills.create({id,ownerId:user.id,name:billName,categoryId:'bills',amountMinor:parseMinorUnits(billAmount),currency:currentAccount.currency,dueDate:billDue,accountId:currentAccount.id}), 'Bill saved. No money has left your account.');
  };
  const remindBill=async(bill:any)=>{
    if(!user||Platform.OS==='web') return Alert.alert('Reminders unavailable','Local bill reminders are supported on the installed iOS and Android app.');
    try {
      const permission=await Notifications.requestPermissionsAsync();
      if(!permission.granted) throw new Error('Allow notifications in device settings to schedule bill reminders.');
      if(Platform.OS==='android') await Notifications.setNotificationChannelAsync('bill-reminders',{name:'Bill reminders',importance:Notifications.AndroidImportance.DEFAULT});
      const [year,month,day]=bill.dueDate.split('-').map(Number);
      const triggerDate=new Date(year,month-1,day,9,0,0);
      if(triggerDate.getTime()<=Date.now()) throw new Error('Choose a future due date to schedule a reminder.');
      const reminderId=await Notifications.scheduleNotificationAsync({content:{title:`${bill.name} is due today`,body:`${formatMinorUnits(bill.amountMinor-bill.paidMinor,bill.currency)} remaining`,data:{url:'/obligations',billId:bill.id}},trigger:{type:Notifications.SchedulableTriggerInputTypes.DATE,date:triggerDate}});
      await localDb.obligations.setBillReminder(user.id,bill.id,reminderId);
      if(bill.reminderId) await Notifications.cancelScheduledNotificationAsync(bill.reminderId).catch(()=>undefined);
      await client.invalidateQueries({queryKey:['obligations',user.id]});
      Alert.alert('Reminder scheduled','HouseLog will remind you at 9:00 AM on the bill due date.');
    } catch(error) { Alert.alert('Reminder not scheduled',error instanceof Error?error.message:'Please try again.'); }
  };
  const saveDebt=()=>{
    if(!user||!currentAccount) return Alert.alert('Choose an account','Create an account before recording debt.');
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
    },'Principal updated and cash movement recorded.');
  };
  const correctBillPayment=(bill:{id:string;currency:string},payment:any)=>{
    if(!user) return;
    Alert.alert('Correct bill payment?','The original payment stays in history. HouseLog will append a full reversal and optionally a replacement using the amount entered below.',[
      {text:'Keep',style:'cancel'},
      {text:'Reverse / replace',style:'destructive',onPress:()=>void run(async()=>{
        const id=makeId(); const entered=paymentAmount[payment.id]?.trim();
        await localDb.obligations.correctBillPayment({id,ownerId:user.id,billId:bill.id,paymentId:payment.id,reversalTransactionId:`${id}:reversal`,reason:'Payment corrected by user',...(entered?{replacement:{id:`${id}:payment`,transactionId:`${id}:tx`,amountMinor:parseMinorUnits(entered),accountId:currentAccount?.currency===bill.currency?currentAccount.id:undefined,idempotencyKey:`${id}:key`,paidAt:new Date().toISOString()}}:{})});
        setPaymentAmount((current)=>({...current,[payment.id]:''}));
      },'Correction committed to the bill and transaction history.')},
    ]);
  };
  const correctDebtEvent=(debt:any,event:any)=>{
    if(!user) return;
    Alert.alert('Correct debt event?','The original cash event will be reversed. Enter a replacement amount first to replace it, or leave the amount blank to reverse it only.',[
      {text:'Keep',style:'cancel'},
      {text:'Correct event',style:'destructive',onPress:()=>void run(async()=>{
        const id=makeId();const entered=paymentAmount[event.id]?.trim();
        if(event.isAccrual){
          await localDb.obligations.debts.correctInterestCharge({id,ownerId:user.id,debtId:debt.id,eventId:event.id,reason:'Interest charge corrected by user',...(entered?{replacement:{id:`${id}:charge`,amountMinor:parseMinorUnits(entered),eventDate:new Date().toISOString(),idempotencyKey:`${id}:key`,note:'Corrected interest charge'}}:{})});
          setPaymentAmount((current)=>({...current,[event.id]:''}));
          return;
        }
        const eventType=event.eventType as 'borrow'|'lend'|'principal_repayment'|'receivable_payment'|'interest'|'settlement';
        await localDb.obligations.correctDebtEvent({id,ownerId:user.id,debtId:debt.id,eventId:event.id,reversalTransactionId:`${id}:reversal`,reason:'Debt event corrected by user',...(entered?{replacement:{id:`${id}:event`,eventType,principalMinor:eventType==='interest'?0:parseMinorUnits(entered),interestMinor:eventType==='interest'?parseMinorUnits(entered):0,accountId:currentAccount?.currency===debt.currency?currentAccount.id:event.accountId,transactionId:`${id}:tx`,eventDate:new Date().toISOString(),idempotencyKey:`${id}:key`,note:'Corrected debt event'}}:{})});
        setPaymentAmount((current)=>({...current,[event.id]:''}));
      },'Correction committed to the debt and transaction history.')},
    ]);
  };
  const createRepaymentSchedule=(debt:any)=>{
    if(!user) return;
    void run(()=>localDb.obligations.debts.createRepaymentSchedule({id:makeId(),ownerId:user.id,debtId:debt.id,frequency:repaymentFrequency,firstDueDate:repaymentStart,installmentAmountMinor:parseMinorUnits(paymentAmount[debt.id]??''),interestMethod:scheduleMethod,rateBps:scheduleMethod==='none'?0:debt.interestRateBps,installmentCount:Number(scheduleCount)}),'Projected installments saved. No cash movement was posted.');
  };

  return <SafeAreaView className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <View className="flex-row items-center border-b border-gray-200 px-5 py-4 dark:border-neutral-800"><Pressable onPress={()=>router.back()}><Text className="font-body font-bold text-primary">Done</Text></Pressable><Text className="font-heading flex-1 text-center text-lg font-bold text-gray-900 dark:text-white">Recurring & Debt</Text><View className="w-10"/></View>
    <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{paddingBottom:32}}>
      {query.isLoading||accountQuery.isLoading?<Text className="font-body py-4 text-gray-500">Loading obligations…</Text>:null}
      {query.isError?<Text className="font-body mb-3 text-red-600">{query.error.message}</Text>:null}
      <Text className="font-body mb-3 text-sm text-gray-600 dark:text-neutral-300">Planned entries never change balances. Only a posted occurrence or recorded payment creates a ledger transaction.</Text>
      <Card title="Create a recurring transaction">
        {editingScheduleId?<Text className="font-body mt-2 text-xs font-semibold text-primary">Editing future dates only. Already posted transactions remain unchanged.</Text>:null}
        <View className="flex-row flex-wrap">{(['income','expense','transfer'] as const).map((item)=><Choice key={item} label={item} selected={type===item} onPress={()=>setType(item)}/>)}</View>
        <Field value={scheduleName} onChangeText={setScheduleName} placeholder="Name, e.g. monthly salary"/>
        <Field value={scheduleAmount} onChangeText={setScheduleAmount} placeholder="Amount" numeric/>
        {type!=='transfer'?<View className="flex-row flex-wrap">{categories.filter((c)=>type==='income'?['salary','family_gift','other_income'].includes(c.id):!['salary','family_gift','other_income'].includes(c.id)).map((category)=><Choice key={category.id} label={category.label} selected={categoryId===category.id} onPress={()=>setCategoryId(category.id)}/>)}</View>:null}
        <Text className="font-body mt-3 text-xs text-gray-500">Funding account · {currentAccount?.name??'choose an account below'}</Text>
        <View className="flex-row flex-wrap">{accounts.map((account)=><Choice key={account.id} label={`${account.name} · ${account.currency}`} selected={currentAccount?.id===account.id} onPress={()=>setAccountId(account.id)}/>)}</View>
        {type==='transfer'?<><Text className="font-body mt-2 text-xs text-gray-500">Destination account</Text><View className="flex-row flex-wrap">{accounts.filter((account)=>account.id!==currentAccount?.id&&account.currency===currentAccount?.currency).map((account)=><Choice key={account.id} label={account.name} selected={destinationId===account.id} onPress={()=>setDestinationId(account.id)}/>)}</View></>:null}
        <View className="flex-row flex-wrap">{frequencies.map((value)=><Choice key={value} label={value} selected={frequency===value} onPress={()=>setFrequency(value)}/>)}</View>
        <Field value={scheduleStart} onChangeText={setScheduleStart} placeholder="Start date YYYY-MM-DD"/>
        <Field value={scheduleEnd} onChangeText={setScheduleEnd} placeholder="End date YYYY-MM-DD (optional)"/>
        <Pressable disabled={busy} onPress={saveSchedule} className="houselog-button mt-4 items-center px-4 py-3"><Text className="font-body font-bold text-white">{editingScheduleId?'Save future schedule':'Save schedule'}</Text></Pressable>
        {editingScheduleId?<Pressable onPress={()=>setEditingScheduleId(null)} className="mt-2 items-center p-2"><Text className="font-body text-primary">Cancel editing</Text></Pressable>:null}
      </Card>
      <Card title="Schedules">
        {query.data?.schedules.length===0?<Text className="font-body mt-2 text-gray-500">No recurring schedules yet.</Text>:null}
        {query.data?.schedules.map((schedule:any)=><View key={schedule.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{schedule.name} · {schedule.status} · {schedule.frequency}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">{formatMinorUnits(schedule.amountMinor,schedule.currency)} · next {schedule.nextDueDate} · {schedule.scheduleType}</Text><View className="flex-row flex-wrap">{schedule.status!=='cancelled'?<>{schedule.scheduleType!=='bill'?<Choice label="Edit" selected={false} onPress={()=>{setEditingScheduleId(schedule.id);setType(schedule.scheduleType);setScheduleName(schedule.name);setScheduleAmount((schedule.amountMinor/100).toFixed(2));setFrequency(schedule.frequency);setScheduleStart(schedule.startDate);setScheduleEnd(schedule.endDate??'');setAccountId(schedule.accountId);setDestinationId(schedule.toAccountId??'');setCategoryId(schedule.classificationId??'other_expense');}}/>:null}<Choice label={schedule.status==='paused'?'Resume':'Pause'} selected={false} onPress={()=>void run(()=>localDb.obligations.schedules.setStatus(user!.id,schedule.id,schedule.status==='paused'?'active':'paused'),'Schedule status updated.')}/><Choice label="Cancel" selected={false} onPress={()=>Alert.alert('Cancel schedule?','Pending occurrences stay visible; future dates stop being generated.',[{text:'Keep',style:'cancel'},{text:'Cancel schedule',style:'destructive',onPress:()=>void run(()=>localDb.obligations.schedules.setStatus(user!.id,schedule.id,'cancelled'),'Future dates cancelled.')}])}/></>:null}</View></View>)}
      </Card>
      <Card title="Upcoming & missed occurrences">
        {!query.data?.occurrences.filter((item:any)=>item.status==='pending').length?<Text className="font-body mt-2 text-gray-500">No pending occurrences. Opening this screen catches missed dates while keeping them unposted.</Text>:null}
        {query.data?.occurrences.filter((item:any)=>item.status==='pending').map((item:any)=><View key={item.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{item.name} · {item.occurrenceDate}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">{item.scheduleType==='bill'?'Bill due':item.scheduleType} · {formatMinorUnits(item.amountMinor,item.currency)} · Pending approval</Text><View className="mt-2 flex-row">{item.scheduleType!=='bill'?<Pressable onPress={()=>void run(()=>localDb.obligations.postOccurrence({ownerId:user!.id,id:item.id,transactionId:makeId()}),'Occurrence posted to account history.')} className="houselog-button mr-2 px-3 py-2"><Text className="font-body text-xs font-bold text-white">Post now</Text></Pressable>:null}<Pressable onPress={()=>void run(()=>localDb.obligations.skipOccurrence(user!.id,item.id),'Occurrence skipped; no balance changed.')} className="rounded-lg bg-gray-200 px-3 py-2 dark:bg-neutral-700"><Text className="font-body text-xs text-gray-800 dark:text-white">Skip</Text></Pressable></View></View>)}
      </Card>
      <Card title="One-time bill">
        <Field value={billName} onChangeText={setBillName} placeholder="Bill name"/><Field value={billAmount} onChangeText={setBillAmount} placeholder="Amount" numeric/><Field value={billDue} onChangeText={setBillDue} placeholder="Due date YYYY-MM-DD"/>
        <View className="flex-row flex-wrap"><Choice label={billRecurring?'Recurring':'One-time'} selected={!billRecurring} onPress={()=>setBillRecurring(false)}/><Choice label="Make recurring" selected={billRecurring} onPress={()=>setBillRecurring(true)}/></View>
        {billRecurring?<View className="flex-row flex-wrap">{frequencies.map((value)=><Choice key={value} label={value} selected={billFrequency===value} onPress={()=>setBillFrequency(value)}/>)}</View>:null}
        <Text className="font-body mt-2 text-xs text-gray-500">Bill account · {currentAccount?.name??'choose an account above'}</Text>
        <Pressable disabled={busy} onPress={saveBill} className="houselog-button mt-3 items-center px-4 py-3"><Text className="font-body font-bold text-white">Add bill (no payment)</Text></Pressable>
        {query.data?.bills.map((bill:any)=><View key={bill.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{bill.name} · {bill.status} · due {bill.dueDate}{bill.scheduleId?' · recurring':''}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">Paid {formatMinorUnits(bill.paidMinor,bill.currency)} of {formatMinorUnits(bill.amountMinor,bill.currency)} · remaining {formatMinorUnits(bill.amountMinor-bill.paidMinor,bill.currency)}</Text><View className="flex-row flex-wrap"><Choice label={historyBillId===bill.id?'Hide history':'Payment history'} selected={historyBillId===bill.id} onPress={()=>setHistoryBillId(historyBillId===bill.id?null:bill.id)}/>{bill.status!=='paid'&&bill.status!=='cancelled'&&bill.status!=='skipped'?<Choice label="Skip unpaid bill" selected={false} onPress={()=>Alert.alert('Skip this bill?','The bill record will remain in history.',[{text:'Keep',style:'cancel'},{text:'Skip',style:'destructive',onPress:()=>void run(async()=>{const reminderId=await localDb.obligations.setBillStatus(user!.id,bill.id,'skipped');if(reminderId) await Notifications.cancelScheduledNotificationAsync(reminderId).catch(()=>undefined);},'Bill skipped; its reminder was cancelled.')}])}/>:null}{bill.status!=='paid'&&bill.status!=='cancelled'&&bill.paidMinor===0?<Choice label="Cancel bill" selected={false} onPress={()=>Alert.alert('Cancel this bill?','The bill remains in history. Any existing payment must be corrected separately.',[{text:'Keep',style:'cancel'},{text:'Cancel bill',style:'destructive',onPress:()=>void run(async()=>{const reminderId=await localDb.obligations.cancelBill(user!.id,bill.id);if(reminderId) await Notifications.cancelScheduledNotificationAsync(reminderId).catch(()=>undefined);},'Bill cancelled; its reminder was cancelled.')}])}/>:null}</View>{historyBillId===bill.id?billHistoryQuery.data?.map((payment:any)=><View key={payment.id} className="mt-2 rounded-lg bg-white p-2 dark:bg-neutral-900"><Text className="font-body text-xs text-gray-600 dark:text-neutral-300">{new Date(payment.paidAt).toLocaleDateString()} · {formatMinorUnits(payment.amountMinor,bill.currency)} · transaction {payment.transactionId}{payment.corrected?' · corrected':''}</Text>{!payment.corrected?<><Field value={paymentAmount[payment.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[payment.id]:value}))} placeholder="Replacement amount (blank reverses only)" numeric/><Choice label="Correct payment" selected={false} onPress={()=>correctBillPayment(bill,payment)}/></>:null}</View>):null}{bill.status!=='paid'&&bill.status!=='cancelled'&&bill.status!=='skipped'?<><View className="flex-row items-center"><View className="flex-1"><Field value={paymentAmount[bill.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[bill.id]:value}))} placeholder="Payment amount" numeric/></View><Pressable onPress={()=>void run(async()=>{const id=makeId();await localDb.obligations.createBillPayment({id,ownerId:user!.id,billId:bill.id,amountMinor:parseMinorUnits(paymentAmount[bill.id]??''),transactionId:`${id}:tx`,idempotencyKey:id,paidAt:new Date().toISOString()});const updated=(await localDb.obligations.bills.list(user!.id)).find((item:any)=>item.id===bill.id);if(updated?.status==='paid'&&bill.reminderId){await Notifications.cancelScheduledNotificationAsync(bill.reminderId);await localDb.obligations.setBillReminder(user!.id,bill.id,null);}},'Payment posted after the ledger write committed.')} className="houselog-button ml-2 mt-2 px-3 py-3"><Text className="font-body text-xs font-bold text-white">Pay</Text></Pressable></View><Pressable onPress={()=>void remindBill(bill)} className="mt-2 self-start rounded-lg bg-primary/10 px-3 py-2"><Text className="font-body text-xs font-semibold text-primary">{bill.reminderId?'Reschedule reminder':'Set reminder'}</Text></Pressable></>:null}</View>)}
      </Card>
      <Card title="Borrowed and lent money">
        <View className="flex-row flex-wrap"><Choice label="Borrowed" selected={debtDirection==='borrowed'} onPress={()=>setDebtDirection('borrowed')}/><Choice label="Lent to someone" selected={debtDirection==='lent'} onPress={()=>setDebtDirection('lent')}/></View>
        <Field value={counterparty} onChangeText={setCounterparty} placeholder="Person / institution"/><Field value={debtAmount} onChangeText={setDebtAmount} placeholder="Principal amount" numeric/><Field value={interestBps} onChangeText={setInterestBps} placeholder="Annual interest rate (basis points, e.g. 1200 = 12%)" numeric/>
        <Pressable disabled={busy} onPress={saveDebt} className="houselog-button mt-3 items-center px-4 py-3"><Text className="font-body font-bold text-white">Record {debtDirection==='borrowed'?'borrowing':'money lent'}</Text></Pressable>
        {query.data?.debts.map((debt:any)=><View key={debt.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{debt.direction==='borrowed'?'Owe':'Owed to you'} · {debt.counterparty} · {debt.status}</Text><Text className="font-body mt-1 text-gray-600 dark:text-neutral-300">Principal remaining {formatMinorUnits(Math.max(0,debt.principalMinor-debt.principalSettledMinor),debt.currency)} · interest owed {formatMinorUnits(Math.max(0,debt.interestAccruedMinor-debt.interestPaidMinor),debt.currency)} · interest paid {formatMinorUnits(debt.interestPaidMinor,debt.currency)} · rate {(debt.interestRateBps/100).toFixed(2)}% p.a.</Text><Choice label={historyDebtId===debt.id?'Hide history':'Debt history'} selected={historyDebtId===debt.id} onPress={()=>setHistoryDebtId(historyDebtId===debt.id?null:debt.id)}/>{historyDebtId===debt.id?debtHistoryQuery.data?.map((event:any)=><View key={event.id} className="mt-2 rounded-lg bg-white p-2 dark:bg-neutral-900"><Text className="font-body text-xs text-gray-600 dark:text-neutral-300">{new Date(event.eventDate).toLocaleDateString()} · {event.eventType.replace('_',' ')} · {formatMinorUnits(event.principalMinor+event.interestMinor,debt.currency)}{event.transactionId?` · ${event.transactionId}`:event.isAccrual?' · no cash movement':''}{event.corrected?' · corrected':''}</Text>{!event.corrected&&event.eventType!=='interest_reversal'?<><Field value={paymentAmount[event.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[event.id]:value}))} placeholder="Replacement amount (blank reverses only)" numeric/><Choice label="Correct event" selected={false} onPress={()=>correctDebtEvent(debt,event)}/></>:null}</View>):null}{debt.status==='open'?<><View className="flex-row flex-wrap"><Choice label="Principal" selected={!interestOnly} onPress={()=>setInterestOnly(false)}/><Choice label="Interest" selected={interestOnly} onPress={()=>setInterestOnly(true)}/></View><View className="flex-row items-center"><View className="flex-1"><Field value={paymentAmount[debt.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[debt.id]:value}))} placeholder={interestOnly?'Interest amount':'Principal payment'} numeric/></View><Pressable onPress={()=>settleDebt(debt)} className="houselog-button ml-2 mt-2 px-3 py-3"><Text className="font-body text-xs font-bold text-white">Record</Text></Pressable></View><View className="flex-row flex-wrap"><Choice label="Fill remaining principal" selected={false} onPress={()=>setPaymentAmount((value)=>({...value,[debt.id]:((debt.principalMinor-debt.principalSettledMinor)/100).toFixed(2)}))}/><Choice label="Charge interest (no cash)" selected={false} onPress={()=>void run(()=>localDb.obligations.debts.chargeInterest({id:makeId(),ownerId:user!.id,debtId:debt.id,amountMinor:parseMinorUnits(paymentAmount[debt.id]??''),eventDate:new Date().toISOString(),idempotencyKey:makeId(),note:'Interest charged'}),'Interest charge recorded; no cash moved.')}/></View></>:null}</View>)}
      </Card>
      <Card title="Debt position">
        {query.data?.debts.length?calculateDebtPositions(query.data.debts).map((position)=><Text key={position.currency} className="font-body mt-2 text-sm text-gray-700 dark:text-neutral-200">{position.currency} · receivables {formatMinorUnits(position.receivablesMinor,position.currency)} · liabilities {formatMinorUnits(position.liabilitiesMinor,position.currency)} · net worth effect {formatMinorUnits(position.netWorthEffectMinor,position.currency)}</Text>):<Text className="font-body mt-2 text-gray-500">No outstanding debts or receivables.</Text>}
        <Text className="font-body mt-2 text-xs text-gray-500">Borrowed principal is a liability; lent principal is a receivable. Neither is revenue or spending.</Text>
      </Card>
      <Card title="Repayment schedules · planned only">
        <Field value={scheduleCount} onChangeText={setScheduleCount} placeholder={`Number of ${repaymentFrequency} installments`} numeric/>
        <Field value={repaymentStart} onChangeText={setRepaymentStart} placeholder="First due date YYYY-MM-DD"/>
        <View className="flex-row flex-wrap"><Choice label="Monthly" selected={repaymentFrequency==='monthly'} onPress={()=>setRepaymentFrequency('monthly')}/><Choice label="Yearly" selected={repaymentFrequency==='yearly'} onPress={()=>setRepaymentFrequency('yearly')}/></View>
        <View className="flex-row flex-wrap"><Choice label="No interest" selected={scheduleMethod==='none'} onPress={()=>setScheduleMethod('none')}/><Choice label="Fixed interest" selected={scheduleMethod==='fixed'} onPress={()=>setScheduleMethod('fixed')}/><Choice label="Declining balance" selected={scheduleMethod==='declining'} onPress={()=>setScheduleMethod('declining')}/></View>
        <Text className="font-body mt-2 text-xs text-gray-500">Interest projections use each debt’s explicitly recorded annual rate. Installments remain planned and never post cash.</Text>
        {query.data?.debts.filter((debt:any)=>debt.status==='open').map((debt:any)=><View key={debt.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{debt.counterparty} · {debt.currency}</Text><Field value={paymentAmount[debt.id]??''} onChangeText={(value)=>setPaymentAmount((old)=>({...old,[debt.id]:value}))} placeholder="Installment amount" numeric/><Pressable onPress={()=>createRepaymentSchedule(debt)} className="houselog-button mt-2 self-start px-3 py-2"><Text className="font-body text-xs font-bold text-white">Add monthly plan</Text></Pressable></View>)}
        {query.data?.repaymentSchedules.map((schedule:any)=><View key={schedule.id} className="mt-3 rounded-xl bg-gray-50 p-3 dark:bg-neutral-800"><Text className="font-body font-semibold text-gray-900 dark:text-white">{schedule.counterparty} · {schedule.status} · {schedule.frequency}</Text>{schedule.installments.slice(0,12).map((installment:any)=><Text key={installment.sequence} className="font-body mt-1 text-xs text-gray-600 dark:text-neutral-300">{installment.dueDate} · {installment.status} · principal {formatMinorUnits(installment.principalMinor,schedule.currency)} + interest {formatMinorUnits(installment.interestMinor,schedule.currency)} · remaining {formatMinorUnits(installment.remainingPrincipalMinor,schedule.currency)}</Text>)}{schedule.status==='active'?<Choice label="Cancel plan" selected={false} onPress={()=>void run(()=>localDb.obligations.debts.cancelRepaymentSchedule(user!.id,schedule.id),'Repayment plan cancelled. Posted history is unchanged.')}/>:null}</View>)}
      </Card>
      {accounts.length===0?<Text className="font-body mb-3 text-amber-700">Create an account before recording scheduled cash movements or debts.</Text>:null}
    </ScrollView>
  </SafeAreaView>;
}
