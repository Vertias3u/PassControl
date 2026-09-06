import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ agent: null as any, logs: [] as any[], tasks: [] as Promise<unknown>[], writeBarrier: null as Promise<void> | null }));
vi.mock('server-only', () => ({}));
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => { h.tasks.push(p); } }));
vi.mock('@/lib/control/auth', () => ({ authenticateApiKey: async () => ({ok:true,userId:'test-tenant',keyId:'test-key',scope:'write'}) }));
vi.mock('@/lib/ratelimit', () => ({ rateLimit: async () => ({success:true,remaining:99}), peekRateLimit: async () => ({success:true}) }));
vi.mock('@/lib/audit', () => ({ recordAdminAction: async () => {} }));
vi.mock('@/lib/observability', () => ({ captureError: async () => {}, captureSecurityEvent: async () => {}, logFailOpen: () => {} }));
vi.mock('@/lib/owner/current', () => ({ readCurrentOwner: async () => null }));
vi.mock('@/lib/state/killswitch', async (original) => ({...await original<any>(), readKillState: async () => ({platformKill:false,tenantKill:false,denylist:[]})}));
vi.mock('@/lib/state/redis', () => ({
 claimNonce: async () => true, touchLastSeen: async () => {}, redis: () => ({}),
 isSuspended: async () => false, getCachedAgentPolicy: async () => JSON.stringify({p:{},s:null}),
 setCachedAgentPolicy: async () => {}, purgeAgentPolicy: async () => {},
 getCachedKey: async () => { throw new Error('demo must not resolve keys'); }, setCachedKey: async () => {},
}));
vi.mock('@/lib/state/holds', () => ({
 openHold: async () => ({ok:true,reserved:1}),
 settleKnown: async (p:any) => ({applied:true,appliedTokens:p.tokens,appliedMicrocents:p.microcents}),
 establishBudgetState: async () => {}, releaseUndispatched: async () => ({}), settleUnknown: async () => ({}),
}));
vi.mock('@/lib/log', () => ({ writeLog: async (row:any) => { if (h.writeBarrier) await h.writeBarrier; h.logs.push({...row, user_id:row.userId, agent_id:row.agentId}); }, mirrorSpend: async () => {} }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({
 from: (table:string) => {
  const filters: [string,unknown][]=[];
  const result = () => ({data: (table==='agents' ? [h.agent] : table==='agent_logs' ? h.logs : []).filter(Boolean).find(r=>filters.every(([k,v])=>r[k]===v)) ?? null,error:null});
  const b:any={select:()=>b,eq:(k:string,v:unknown)=>{filters.push([k,v]);return b;},
   maybeSingle:async()=>result(),single:async()=>result(),
   insert:(r:any)=>{h.agent={...r,id:'11111111-2222-4333-8444-555555555555',status:'active',created_at:new Date().toISOString(),expires_at:null};return b;},
   then:(resolve:any)=>Promise.resolve(result()).then(resolve)};
  return b;
 },
}) }));
import { POST as create } from '@/app/api/control/v1/agents/route';
import { POST as challenge } from '@/app/api/auth/challenge/route';
import { POST as proxy } from '@/app/api/v1/[provider]/[...path]/route';
import { GET as receipt } from '@/app/api/control/v1/receipts/[id]/route';
import { GET as jwks } from '@/app/.well-known/jwks.json/route';

it.each([false, true])('login verifies its receipt after real creation (receipt write delayed: %s)', async (delayed) => {
 h.agent=null; h.logs=[]; h.tasks=[];
 let finishWrite: () => void = () => {};
 h.writeBarrier=delayed ? new Promise<void>(resolve => {finishWrite=resolve;}) : null;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pc-login-sequence-'));
 const origin='http://127.0.0.1:12345';
 vi.stubEnv('XDG_CONFIG_HOME',dir); vi.stubEnv('PASSCONTROL_DEMO','1');
 vi.stubEnv('VISA_SECRET','test-only-visa-secret-at-least-32-bytes');
 vi.stubEnv('INSTANCE_SIGNING_KEY',Buffer.alloc(32,7).toString('base64url'));
 vi.stubEnv('PASSCONTROL_ISSUER',origin);
 const output=vi.spyOn(console,'log').mockImplementation(()=>{});
 const seen:string[]=[];
 const fetcher=async (url:string,init:RequestInit={})=>{
  const p=new URL(url).pathname; seen.push(p);
  if(p==='/api/auth/device/start') return Response.json({device_code:'d'.repeat(43),user_code:'FKDR8T2W',verification_uri:origin+'/dashboard/cli',expires_in:600,interval:1});
  if(p==='/api/auth/device/token') return Response.json({api_key:'pc_'+ 'k'.repeat(43)});
  if(p==='/api/control/v1/agents' && init.method==='GET') return Response.json({data:[]});
  const req=new Request(url,init);
  if(p==='/api/control/v1/agents') return create(req);
  if(p==='/api/auth/challenge') return challenge(req);
  if(p==='/api/v1/demo/chat/completions') return proxy(req,{params:Promise.resolve({provider:'demo',path:['chat','completions']})});
  if(p.startsWith('/api/control/v1/receipts/')) {
   // A background DB insert may commit after the first read. Let that real
   // read finish, then permit the pending write; no sleep or failed insert.
   const response=await receipt(req,{params:Promise.resolve({id:p.split('/').pop()!})});
   finishWrite();
   return response;
  }
  if(p==='/.well-known/jwks.json') return jwks();
  throw new Error('unexpected request '+p);
 };
 try {
  const url=new URL('../cli/login.mjs',import.meta.url).href;
  const {loginCommand}=await import(/* @vite-ignore */ url);
  const result=await loginCommand({gateway:origin,name:'sequence-test',new:true},{fetch:fetcher,openUrl:()=>{},sleep:async()=>{}});
  await Promise.allSettled(h.tasks);
  expect(h.logs).toHaveLength(1);
  expect(h.logs[0].receipt).toEqual(expect.any(String));
  expect(h.agent.allowed_scopes).toContainEqual({provider:'demo',models:['*']});
  expect(result.proof,JSON.stringify({proof:result.proof,seen,logCount:h.logs.length})).toMatchObject({visa:true,call:true,receipt:'verified'});
 } finally {
  finishWrite(); await Promise.allSettled(h.tasks); output.mockRestore(); vi.unstubAllEnvs(); fs.rmSync(dir,{recursive:true,force:true});
 }
});
