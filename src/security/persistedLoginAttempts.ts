import type { LoginRateLimit } from './loginRateLimit.ts';

export interface LoginAttemptState { failures:number; blockedUntil:number }

export interface PersistedLoginAttemptPort {
  read(key:string):Promise<LoginAttemptState|null>;
  /** Must apply the update atomically with respect to other writers of this key. */
  update(key:string,change:(current:LoginAttemptState|null)=>LoginAttemptState):Promise<LoginAttemptState>;
  clear(key:string):Promise<void>;
}

/** Policy shared by password sign-in and app unlock; its port persists state across restarts. */
export function createPersistedLoginAttempts(port:PersistedLoginAttemptPort,policy:LoginRateLimit) {
  return {
    remainingDelay:async(key:string,now=Date.now()):Promise<number>=>{
      const attempt=await port.read(key);
      return attempt?policy.delayFor(attempt.failures,attempt.blockedUntil,now):0;
    },
    recordFailure:async(key:string,now=Date.now()):Promise<number>=>{
      const next=await port.update(key,(prior)=>policy.next(prior?.failures??0,now));
      return policy.delayFor(next.failures,next.blockedUntil,now);
    },
    recordSuccess:(key:string):Promise<void>=>port.clear(key),
  };
}
