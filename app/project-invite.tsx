import { useLocalSearchParams, useRouter } from 'expo-router';
import { CheckCircle2, Link2 } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/context/AuthContext';
import { cloudFetch } from '../src/cloud/authClient';
import { localDb } from '../src/db/local/client';
import { syncOfflineData } from '../utils/syncEngine';

export default function ProjectInviteScreen() {
  const params=useLocalSearchParams<{token?:string}>();
  const token=Array.isArray(params.token)?params.token[0]:params.token;
  const router=useRouter();const {user}=useAuth();const [busy,setBusy]=useState(false);const [accepted,setAccepted]=useState(false);
  const accept=async()=>{
    if(!user||!token||busy)return;
    setBusy(true);
    try{
      const response=await cloudFetch(user.id,'/api/v1/projects/invitations/accept',{method:'POST',body:JSON.stringify({token})});
      const body=await response.json().catch(()=>null) as {data?:{projectId?:string};projectId?:string}|null;
      if(!response.ok)throw new Error('This invitation is invalid, expired, already used, or belongs to a different signed-in email.');
      const projectId=body?.data?.projectId??body?.projectId;
      if(!projectId)throw new Error('The invitation was accepted, but the project identifier was missing. Sync this profile to download the project.');
      await syncOfflineData(user.id);
      const project=await localDb.projects.get(user.id,projectId).catch(()=>null);
      if(!project)throw new Error('The invitation was accepted. Sync is pending; reopen this screen after the project finishes downloading.');
      setAccepted(true);router.replace(`/projects/${encodeURIComponent(projectId)}`);
    }catch(error){Alert.alert('Could not accept invitation',error instanceof Error?error.message:'Please try again.');}
    finally{setBusy(false);}
  };
  return <SafeAreaView className="flex-1 bg-gray-50 px-5 dark:bg-neutral-950"><View className="flex-1 justify-center"><View className="mb-5 h-14 w-14 items-center justify-center rounded-2xl bg-violet-100 dark:bg-violet-950"><Link2 size={26} color="#635bff"/></View><Text className="font-body text-2xl font-bold text-gray-900 dark:text-white">Project invitation</Text><Text className="font-body mt-2 text-sm leading-6 text-gray-600 dark:text-neutral-300">Accept this invitation with the verified Leverage account that received it. Project data will sync to this device after authorization.</Text><Pressable disabled={!token||!user||busy||accepted} onPress={()=>void accept()} className="mt-6 items-center rounded-md bg-primary py-3.5 disabled:opacity-50"><Text className="font-body font-semibold text-white">{accepted?'Accepted':busy?'Checking invitation…':!user?'Sign in to accept':'Accept invitation'}</Text></Pressable>{!token?<Text className="font-body mt-4 text-sm text-rose-600 dark:text-rose-400">Invitation token is missing from this link.</Text>:null}<View className="mt-5 flex-row items-center"><CheckCircle2 size={15} color="#059669"/><Text className="font-body ml-2 text-xs text-gray-500 dark:text-neutral-400">Invitation tokens are single use and expire after seven days.</Text></View></View></SafeAreaView>;
}
