import * as Crypto from 'expo-crypto';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { Plus, FolderKanban, ArrowRight, ArrowLeft, X } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlobalHeader } from '../../components/ui/GlobalHeader';
import { localDb } from '../../src/db/local/client';
import { formatMinorUnits } from '../../src/finance/ledger';
import type { ProjectKind } from '../../src/finance/projects';
import type { CurrencyCode } from '../../src/finance/domain';
import { useAuth } from '../../src/context/AuthContext';

const currencies: CurrencyCode[] = ['PKR','USD','GBP','EUR','AED','SAR'];
const kinds: {id:ProjectKind;label:string}[] = [{id:'personal',label:'Personal'},{id:'shared',label:'Shared'},{id:'work',label:'Work'},{id:'custom',label:'Custom'}];
const today = () => new Date().toISOString().slice(0,10);

export default function ProjectsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [projects,setProjects] = useState<Awaited<ReturnType<typeof localDb.projects.list>>>([]);
  const [showCreate,setShowCreate] = useState(false);
  const [name,setName] = useState('');
  const [description,setDescription] = useState('');
  const [kind,setKind] = useState<ProjectKind>('personal');
  const [currency,setCurrency] = useState<CurrencyCode>('PKR');
  const [budget,setBudget] = useState('');
  const [contributionTarget,setContributionTarget] = useState('');
  const [busy,setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!user) return;
    try { setProjects(await localDb.projects.list(user.id)); } catch (error) { Alert.alert('Projects unavailable', error instanceof Error ? error.message : 'Please try again.'); }
  },[user]);
  useFocusEffect(useCallback(() => { void load(); },[load]));

  const create = async () => {
    if (!user || busy) return;
    const label=name.trim(); if (!label) { Alert.alert('Project name required','Add a name to continue.'); return; }
    const amount=budget.trim() ? Number(budget.trim()) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0 || !/^\d+(\.\d{1,2})?$/.test(budget.trim()))) { Alert.alert('Check the budget','Enter a non-negative amount with up to two decimal places.'); return; }
    const target=contributionTarget.trim()?Number(contributionTarget.trim()):null;
    if(target!==null&&(!Number.isFinite(target)||target<0||!/^\d+(\.\d{1,2})?$/.test(contributionTarget.trim()))){Alert.alert('Check contribution minimum','Enter a non-negative amount with up to two decimal places.');return;}
    setBusy(true);
    try {
      const id=Crypto.randomUUID();
      const project=await localDb.projects.create({ id,ownerId:user.id,name:label,description,kind,currency,startDate:today(),budgetMinor:amount === null ? null : Math.round(amount*100),members:[{id:Crypto.randomUUID(),displayName:user.fullName,role:'owner',targetContributionMinor:target===null?null:Math.round(target*100)}] });
      setShowCreate(false); setName(''); setDescription(''); setBudget('');setContributionTarget(''); await load(); router.push(`/projects/${project.id}` as Href);
    } catch (error) { Alert.alert('Could not create project', error instanceof Error ? error.message : 'Please try again.'); }
    finally { setBusy(false); }
  };

  return <SafeAreaView edges={['left','right','bottom']} className="flex-1 bg-gray-50 dark:bg-neutral-950">
    <GlobalHeader title="Projects" description="Keep each activity's money in one place" onLeftPress={()=>router.canGoBack()?router.back():router.replace('/(tabs)')} LeftIcon={<ArrowLeft size={20} color="#635bff"/>} leftActionLabel="Back to home" onRightPress={()=>setShowCreate(true)} RightIcon={<Plus size={21} color="#635bff"/>} rightActionLabel="Create project" />
    <ScrollView contentContainerStyle={{padding:20,paddingBottom:36}}>
      <View className="mb-4 rounded-md border border-violet-100 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/30">
        <Text className="font-body text-sm font-bold text-gray-900 dark:text-white">A clear view of each project</Text>
        <Text className="font-body mt-1 text-xs leading-5 text-gray-600 dark:text-neutral-300">Track budgets, member-paid expenses, shared-fund contributions and what remains. Project amounts stay separate from personal account balances.</Text>
        <Text className="font-body mt-2 text-[11px] font-semibold text-violet-700 dark:text-violet-300">Saved on this device only · online invitations and shared sync are not enabled yet.</Text>
      </View>
      {projects.length ? projects.map((project)=><Pressable key={project.id} onPress={()=>router.push(`/projects/${project.id}` as Href)} className="mb-3 rounded-md border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <View className="flex-row items-center"><View className="mr-3 h-10 w-10 items-center justify-center rounded-md bg-violet-50 dark:bg-violet-950"><FolderKanban size={19} color="#635bff"/></View><View className="flex-1"><Text numberOfLines={1} className="font-body font-bold text-gray-900 dark:text-white">{project.name}</Text><Text className="font-body mt-1 text-xs capitalize text-gray-500 dark:text-neutral-400">{project.kind} · {project.status} · {project.members.length} {project.members.length===1?'member':'members'}</Text></View><ArrowRight size={18} color="#8b8b98"/></View>
        <View className="mt-4 flex-row justify-between"><View><Text className="font-body text-[11px] text-gray-500 dark:text-neutral-400">Spent</Text><Text className="font-body mt-1 text-sm font-semibold text-gray-900 dark:text-white">{formatMinorUnits(project.expenseMinor-project.refundMinor,project.currency)}</Text></View><View className="items-end"><Text className="font-body text-[11px] text-gray-500 dark:text-neutral-400">{project.remainingBudgetMinor===null?'Fund balance':'Budget left'}</Text><Text className="font-body mt-1 text-sm font-semibold text-gray-900 dark:text-white">{formatMinorUnits(project.remainingBudgetMinor ?? project.fundBalanceMinor,project.currency)}</Text></View></View>
      </Pressable>) : <View className="items-center rounded-md border border-dashed border-gray-300 bg-white px-6 py-10 dark:border-neutral-700 dark:bg-neutral-900"><FolderKanban size={30} color="#8b8b98"/><Text className="font-body mt-3 text-base font-bold text-gray-900 dark:text-white">No projects yet</Text><Text className="font-body mt-1 text-center text-sm text-gray-500 dark:text-neutral-400">Create a personal, shared or work project to start organizing its finances.</Text><Pressable onPress={()=>setShowCreate(true)} className="mt-5 rounded-md bg-primary px-5 py-3"><Text className="font-body font-semibold text-white">Create project</Text></Pressable></View>}
    </ScrollView>
    <Modal visible={showCreate} animationType="slide" transparent onRequestClose={()=>setShowCreate(false)}>
      <View className="flex-1 justify-end bg-black/50"><View className="rounded-t-2xl bg-white px-5 pb-8 pt-3 dark:bg-neutral-950">
        <View className="mb-4 flex-row items-center justify-between"><View><Text className="font-body text-lg font-bold text-gray-900 dark:text-white">Create project</Text><Text className="font-body mt-1 text-xs text-gray-500 dark:text-neutral-400">Budgets are plans; they do not add cash.</Text></View><Pressable onPress={()=>setShowCreate(false)} accessibilityLabel="Close" className="h-10 w-10 items-center justify-center rounded-md bg-gray-100 dark:bg-neutral-800"><X size={20} color="#8b8b98"/></Pressable></View>
        <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text className="mb-1.5 font-body text-xs text-gray-600 dark:text-neutral-300">Project name</Text><TextInput value={name} onChangeText={setName} placeholder="e.g. Northern areas trip" maxLength={100} className="mb-4 rounded-md border border-gray-300 bg-white px-4 py-3.5 font-body text-base text-gray-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white" />
          <Text className="mb-1.5 font-body text-xs text-gray-600 dark:text-neutral-300">Description · optional</Text><TextInput value={description} onChangeText={setDescription} placeholder="What are you planning?" multiline maxLength={2000} className="mb-4 min-h-20 rounded-md border border-gray-300 bg-white px-4 py-3 font-body text-sm text-gray-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white" />
          <Text className="mb-2 font-body text-xs text-gray-600 dark:text-neutral-300">Project type</Text><View className="mb-4 flex-row flex-wrap gap-2">{kinds.map((item)=><Pressable key={item.id} onPress={()=>setKind(item.id)} className={`rounded-full border px-3.5 py-2 ${kind===item.id?'border-violet-500 bg-violet-50 dark:bg-violet-950':'border-gray-300 dark:border-neutral-700'}`}><Text className={`font-body text-sm ${kind===item.id?'text-violet-700 dark:text-violet-300':'text-gray-700 dark:text-neutral-300'}`}>{item.label}</Text></Pressable>)}</View>
          <Text className="mb-2 font-body text-xs text-gray-600 dark:text-neutral-300">Currency</Text><View className="mb-4 flex-row flex-wrap gap-2">{currencies.map((item)=><Pressable key={item} onPress={()=>setCurrency(item)} className={`rounded-full border px-3.5 py-2 ${currency===item?'border-violet-500 bg-violet-50 dark:bg-violet-950':'border-gray-300 dark:border-neutral-700'}`}><Text className={`font-body text-sm ${currency===item?'text-violet-700 dark:text-violet-300':'text-gray-700 dark:text-neutral-300'}`}>{item}</Text></Pressable>)}</View>
          <Text className="mb-1.5 font-body text-xs text-gray-600 dark:text-neutral-300">Total budget · optional</Text><TextInput value={budget} onChangeText={setBudget} placeholder="0.00" keyboardType="decimal-pad" className="mb-4 rounded-md border border-gray-300 bg-white px-4 py-3.5 font-body text-base text-gray-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white" />
          <Text className="mb-1.5 font-body text-xs text-gray-600 dark:text-neutral-300">Your minimum contribution · optional</Text><TextInput value={contributionTarget} onChangeText={setContributionTarget} placeholder="e.g. 20,000" keyboardType="decimal-pad" className="mb-4 rounded-md border border-gray-300 bg-white px-4 py-3.5 font-body text-base text-gray-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white" />
        </ScrollView>
        <Pressable disabled={busy} onPress={()=>void create()} className="mt-3 items-center rounded-md bg-primary py-3.5 disabled:opacity-50"><Text className="font-body font-semibold text-white">{busy?'Creating…':'Create project'}</Text></Pressable>
      </View></View>
    </Modal>
  </SafeAreaView>;
}
