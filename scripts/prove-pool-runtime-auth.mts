// Synthetic, no inference or running Gateway. Run with the installed runtime's
// executable on PATH and tsx; every case has a separate runtime process/state.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const scenario = process.argv[2] ?? 'foreign-main';
const baseline = process.argv.includes('--baseline');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-runtime-http-'));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'openclaw.json');
process.env.OPENCLAW_AGENT_DIR = path.join(root, 'agents/main/agent');
process.env.CODEX_HOME = path.join(root, 'codex');
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const config = { agents: { ownership: 'explicit', defaults: { systemAgent: {agentId:'main'}, model: {primary:'openai/gpt-6.1-sol',fallbacks:[]} }, entries: {main:{},child:{}} }, models: {providers:{openai:{api:'openai-chatgpt-responses'}}} };
await fs.writeFile(configPath, JSON.stringify(config));
const { writeRuntimeAuth, resolveRuntimeAuthSdk } = await import('../src/agentControl/runtimeAuthWriter.js');
const { syncSubscriptionPool, readSubscriptionPoolState } = await import('../src/agentControl/subscriptionPoolManager.js');
const { startPushServer } = await import('../src/push/pushServer.js');
await writeRuntimeAuth({configPath,profileId:'anthropic:keep',credential:{type:'api_key',provider:'anthropic',key:'synthetic'}});
const sdk = await resolveRuntimeAuthSdk();
const { updateAuthProfileStoreWithLock, ensureAuthProfileStoreAsync } = await import(pathToFileURL(sdk).href);
const { setRuntimeConfigSnapshot } = await import(pathToFileURL(createRequire(sdk).resolve('openclaw/plugin-sdk/runtime-config-snapshot')).href);
setRuntimeConfigSnapshot(config);
const agentId = scenario === 'foreign-child' ? 'child' : 'main';
const agentDir = path.join(root,'agents',agentId,'agent');
if(scenario !== 'clean') await updateAuthProfileStoreWithLock({agentDir,stateDir:root,sharedStoreWrite:false,saveOptions:{syncExternalCli:false,filterExternalAuthProfiles:false},updater(store){
 const id=scenario==='shadow'?'openai:golem-a':'openai:legacy';
 store.profiles[id]={type:'oauth',provider:'openai',access:'synthetic-old',refresh:'synthetic-retained',expires:1,accountId:'unrelated'};return true;
}});
const localBefore = scenario === 'clean' ? undefined : await fs.readFile(path.join(agentDir,'openclaw-agent.sqlite'));
const members = [{accountId:'a',credentialVersion:1,enabled:true,credential:{type:'oauth' as const,provider:'openai' as const,access:'synthetic-new',refresh:'synthetic-backend',expires:4700000000000,accountId:'pool-account'}}];
const server = startPushServer({port:0,path:'/relay/messages',relayToken:'synthetic-fixture-token',onMessage:async()=>{},onAgentControl:async message=>{
 assert(message.input.kind==='agent_control' && message.input.action.kind==='codex.auth.pool.sync');
 const action=message.input.action;
 const selected=action.members.map(m=>({accountId:m.accountId,credentialVersion:m.credentialVersion,enabled:m.enabled,credential:{type:'oauth' as const,provider:'openai' as const,access:m.bundle.accessToken,refresh:m.bundle.refreshToken,expires:m.bundle.expiresAtMs,accountId:m.bundle.accountId}}));
 const state=await syncSubscriptionPool({configPath,revision:action.revision,members:selected,assertRuntimeGuard:async()=>({runScopedFallbacks:true}),refreshRuntimeAuth:async()=>{}});
 return {kind:'codex.auth.pool.sync',revision:state.revision,phase:state.phase,members:state.members};
}});
try {
 if (!server.listening) await once(server,'listening');
 const address=server.address();assert(address && typeof address!=='string');
 const response=await fetch(`http://127.0.0.1:${address.port}/relay/messages`,{method:'POST',headers:{authorization:'Bearer synthetic-fixture-token','content-type':'application/json'},body:JSON.stringify({messageId:'synthetic-runtime-proof',input:{kind:'agent_control',action:{kind:'codex.auth.pool.sync',revision:1,members:members.map(m=>({accountId:m.accountId,credentialVersion:m.credentialVersion,enabled:m.enabled,bundle:{formatVersion:1,profileId:'openai:golem-'+m.accountId,idToken:'synthetic-id',lastRefresh:null,email:null,chatgptPlanType:null,accessToken:m.credential.access,refreshToken:m.credential.refresh,expiresAtMs:m.credential.expires,accountId:m.credential.accountId}}))}}})});
 const body=await response.json() as {code?:string};
 const state=await readSubscriptionPoolState(configPath);
 const store=await ensureAuthProfileStoreAsync(agentDir,{readOnly:true,syncExternalCli:false,config});
 const foreign=Object.entries(store.profiles).filter(([id,c])=>['openai','openai-codex'].includes(c.provider)&&['oauth','token'].includes(c.type)&&id!=='openai:golem-a').length;
 const current=store.profiles['openai:golem-a'];
 const matches=current?.type==='oauth' && current.access==='synthetic-new' && !current.refresh;
 console.log(JSON.stringify({scenario,baseline,httpStatus:response.status,code:body.code,phase:state?.phase,foreignSubscriptions:foreign,managedCredentialMatches:matches}));
 if(baseline){assert.equal(state?.phase,'applied');if(scenario!=='clean')assert(foreign>0||!matches);}
 else if(scenario==='clean'){assert.equal(response.status,200);assert.equal(state?.phase,'applied');assert(matches);}
 else {assert(response.status>=400);assert.equal(state?.phase,'pending');assert(body.code?.startsWith('AUTH_POOL_WRITER_RUNTIME_STORE_'));assert.deepEqual(await fs.readFile(path.join(agentDir,'openclaw-agent.sqlite')),localBefore);}
} finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
