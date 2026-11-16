import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
// Real Relay HTTP ingress, receipts, locks, manager and writer subprocess.
// Only Gateway responses and public SDK storage adapter are synthetic.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'pool-guard-dev-'));
const candidate=process.argv[2], mode=process.argv[3];
process.env.OPENCLAW_STATE_DIR=root;
for(const key of ['OPENAI_API_KEY','OPENAI_BASE_URL'])delete process.env[key];
const configPath=path.join(root,'config.json'),sdk=path.join(root,'sdk');
await fs.mkdir(path.join(root,'bin'));await fs.mkdir(sdk);
await fs.writeFile(path.join(sdk,'package.json'),JSON.stringify({name:'openclaw',type:'module',exports:{'./plugin-sdk/provider-auth':'./auth.mjs','./plugin-sdk/session-store-runtime':'./sessions.mjs','./plugin-sdk/runtime-config-snapshot':'./snapshot.mjs','./plugin-sdk/agent-scope-runtime':'./agents.mjs'}}));
await fs.writeFile(path.join(sdk,'cli.mjs'),'');await fs.symlink(path.join(sdk,'cli.mjs'),path.join(root,'bin/openclaw'));
process.env.PATH=path.join(root,'bin')+':'+process.env.PATH;
await fs.writeFile(path.join(sdk,'auth.mjs'),`import fs from 'node:fs/promises';
export async function updateAuthProfileStoreWithLock({updater}){const p=process.env.OPENCLAW_STATE_DIR+'/store.json';let s;try{s=JSON.parse(await fs.readFile(p,'utf8'))}catch{s={profiles:{}}}if(updater(s)){await fs.writeFile(p,JSON.stringify(s));let n=0;try{n=Number(await fs.readFile(p+'.effects','utf8'))}catch{}await fs.writeFile(p+'.effects',String(n+1))}return s}`);
await fs.writeFile(path.join(sdk,'sessions.mjs'),'export function listSessionEntries(){return []} export async function patchSessionEntry(){throw Error("unexpected session write")}');
await fs.writeFile(path.join(sdk,'snapshot.mjs'),'export function setRuntimeConfigSnapshot(){}');
await fs.writeFile(path.join(sdk,'agents.mjs'),'export function listAgentIds(){return ["main"]}');
const config={agents:{defaults:{model:{primary:'openai/gpt-6.1-sol',fallbacks:[]}}},models:{providers:{openai:{api:'openai-chatgpt-responses'}}}};
const text=JSON.stringify(config);await fs.writeFile(configPath,text);
const load=p=>import(pathToFileURL(path.join(candidate,'dist',p)));
const {startPushServer}=await load('push/pushServer.js');
const {executeAgentControl}=await load('agentControl/executeAgentControl.js');
const {syncSubscriptionPool,readSubscriptionPoolState}=await load('agentControl/subscriptionPoolManager.js');
const {configRevision}=await load('agentControl/ownerFence.js');
await syncSubscriptionPool({configPath,revision:3,members:[{accountId:'synthetic_a',enabled:true,credentialVersion:14,credential:{type:'oauth',provider:'openai',access:'synthetic_old',refresh:'synthetic_refresh',expires:4700000000000}}],assertRuntimeGuard:async()=>({runScopedFallbacks:true}),refreshRuntimeAuth:async()=>{}});
const effects=async()=>Number(await fs.readFile(path.join(root,'store.json.effects'),'utf8'));assert.equal(await effects(),1);
let ready=false;
const gateway={request:async method=>{if(method==='relay-channel.subscriptionGuard.status')return ready?{version:1,runScopedFallbacks:true,readOnlyAdmission:true}:{};if(method==='agents.list')return {agents:[{id:'main'}]};if(method==='models.authRefresh')return {refreshed:true};if(method==='config.get')return {valid:true,path:configPath,config,configRevisionHash:'x',appliedConfigHash:'x'};throw Error('Unexpected Gateway RPC: '+method)}};
const action={kind:'codex.auth.pool.sync',revision:4,members:[{accountId:'synthetic_a',enabled:true,credentialVersion:15,bundle:{formatVersion:1,profileId:'synthetic-profile',idToken:'synthetic-id',lastRefresh:null,email:null,accountId:null,chatgptPlanType:null,accessToken:'synthetic_new',refreshToken:'synthetic_refresh',expiresAtMs:4700000000000}}],managedRuntimeExpectedConfigRevision:configRevision(text)};
const token=randomBytes(24).toString('hex');
const server=startPushServer({port:0,path:'/relay/messages',relayToken:token,rateLimitPerSecond:1000,onMessage:async()=>{},onAgentControl:received=>executeAgentControl({configPath,action:received.input.action,gateway})});
try{
if(!server.listening)await new Promise(r=>server.once('listening',r));
const url=`http://127.0.0.1:${server.address().port}/relay/messages`;
const post=async(id,mode,fingerprint,override=action)=>{const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({messageId:id,input:{kind:'agent_control',action:mode==='status'?{kind:'config.read'}:override,durableOperation:{id,mode,...(fingerprint?{resumeFrom:fingerprint}:{})}}})});return {status:res.status,...await res.json()}};
const terminal=async id=>{for(let i=0;i<500;i++){const r=await post(id,'status');if(r.receipt?.state!=='RUNNING')return r.receipt;await new Promise(r=>setTimeout(r,10))}throw Error('terminal timeout')};
assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
assert.equal((await post('saved_revision_4','submit')).status,200);let receipt=await terminal('saved_revision_4');
assert.equal((await readSubscriptionPoolState(configPath)).revision,3);assert.equal(await effects(),1);
console.log(JSON.stringify({stage:'original_guard_refusal',state:receipt.state,code:receipt.code,relayRevision:3,targetRevision:4,targetCredentialEffects:0}));
if(mode==='baseline'){
assert.equal(receipt.state,'UNKNOWN');ready=true;
await post('saved_revision_4','reconcile',receipt.fingerprint);receipt=await terminal('saved_revision_4');
assert.equal(receipt.state,'UNKNOWN');assert.match(receipt.code,/OPENAI_POOL_RECONCILE_CONFLICT/);assert.equal(await effects(),1);
console.log('BASELINE_REPRODUCED: pre-writer refusal becomes UNKNOWN; readback cannot cross 3/4; zero target credential effects');
}else{
assert.equal(receipt.state,'REFUSED');
if(mode.startsWith('legacy')){
 const count=Number(mode.slice(6)),guard='AUTH_OPERATION_OUTCOME_UNKNOWN:OPENAI_POOL_GUARD_UPDATE_REQUIRED',conflict='AUTH_OPERATION_OUTCOME_UNKNOWN:OPENAI_POOL_RECONCILE_CONFLICT';
 const p=path.join(root,'relay-authorization-receipts/saved_revision_4.json');
 const old=JSON.parse(await fs.readFile(p,'utf8'));
 await fs.writeFile(p,JSON.stringify({...old,state:'UNKNOWN',reconcileCount:count,previousUnknownCodes:count?[guard,...Array(count-1).fill(conflict)]:[],code:count?conflict:guard}));
 await post('saved_revision_4','reconcile',receipt.fingerprint);receipt=await terminal('saved_revision_4');
 assert.equal(receipt.state,'REFUSED');assert.equal(await effects(),1);
}
// Explicit resume must still fail closed until the live guard is repaired.
await post('saved_revision_4','resume',receipt.fingerprint);receipt=await terminal('saved_revision_4');
assert.equal(receipt.state,'REFUSED');assert.equal(await effects(),1);
ready=true;await post('saved_revision_4','submit');assert.equal(await effects(),1);
assert.equal((await post('saved_revision_4','resume',receipt.fingerprint,{...action,revision:5})).status,409);
await post('saved_revision_4','resume',receipt.fingerprint);receipt=await terminal('saved_revision_4');
assert.equal(receipt.state,'SUCCEEDED');assert.equal((await readSubscriptionPoolState(configPath)).revision,4);assert.equal(await effects(),2);
await post('saved_revision_4','submit');assert.equal(await effects(),2);
console.log(JSON.stringify({stage:mode,state:receipt.state,relayRevision:4,targetRevision:4,targetCredentialEffects:1,duplicatesAdditionalEffects:0,configUnchanged:(await fs.readFile(configPath,'utf8'))===text}));
console.log('FIXED_PASS');
}
}finally{await new Promise(r=>{server.closeAllConnections();server.close(r)});await fs.rm(root,{recursive:true,force:true})}
