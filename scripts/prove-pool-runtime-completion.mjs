/** Isolated dev-api acceptance: real Relay HTTP/receipts, installed public SDK,
 * real Gateway. Synthetic OAuth by default; optional protected dev-only QA
 * bundle enables inference. Never use production state or accounts.
 * A response-delay adapter simulates the incident's late acknowledgement.
 * Usage: PATH=<installed-openclaw-bin>:$PATH node scripts/prove-pool-runtime-completion.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-completion-proof-'));
const configPath = path.join(root, 'openclaw.json');
Object.assign(process.env, { OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_AGENT_DIR: path.join(root,'agents/main/agent'), CODEX_HOME: path.join(root,'codex'), NODE_USE_ENV_PROXY:'0', NO_PROXY:'127.0.0.1,localhost,::1' });
for(const key of ['OPENAI_API_KEY','OPENAI_BASE_URL','OPENROUTER_API_KEY']) delete process.env[key];
const model=process.env.POOL_PROOF_MODEL??'openai/gpt-5.6-luna';
const qaBundle=process.env.POOL_PROOF_BUNDLE?JSON.parse(await fs.readFile(process.env.POOL_PROOF_BUNDLE,"utf8")):null;
const token = randomBytes(24).toString('hex');
const portServer=net.createServer(); await new Promise(r=>portServer.listen(0,'127.0.0.1',r)); const port=portServer.address().port; await new Promise(r=>portServer.close(r));
const config={gateway:{mode:'local',bind:'loopback',port,auth:{mode:'token',token},controlUi:{enabled:false}},agents:{ownership:'explicit',defaults:{systemAgent:{agentId:'main'},workspace:path.join(root,'workspace'),model:{primary:model,fallbacks:[]},models:{[model]:{params:{maxTokens:128}}}},entries:{main:{}}},models:{providers:{openai:{api:'openai-chatgpt-responses'}}}};
await fs.writeFile(configPath,JSON.stringify(config)); await fs.mkdir(path.join(root,'workspace'));
const log=await fs.open(path.join(root,'gateway.log'),'w');
let child=spawn('openclaw',['gateway','run','--port',String(port),'--bind','loopback'],{env:process.env,stdio:['ignore',log.fd,log.fd]});
const {GatewayClient}=await import('../dist/openclaw/gatewayClient.js');
const {syncSubscriptionPool,readSubscriptionPoolState}=await import('../dist/agentControl/subscriptionPoolManager.js');
const {refreshSubscriptionPoolAuth}=await import('../dist/agentControl/subscriptionPoolRuntime.js');
const {isAuthorizationReadbackOnly}=await import('../dist/agentControl/authorizationReconcileContext.js');
const {startPushServer}=await import('../dist/push/pushServer.js');
const chatEvents=[];
const gateway=new GatewayClient({onEvent:event=>{if(event.event==='chat')chatEvents.push(event.payload)},url:`ws://127.0.0.1:${port}`,token,startupMaxAttempts:40,startupRetryDelayMs:500,connectReadyTimeoutMs:3000});
const waitReady=async()=>{const end=Date.now()+60000;while(Date.now()<end){if(gateway.isReady()){try{await gateway.request('health',{}, {timeoutMs:3000});return;}catch{ /* wait for a stable post-restart connection */ }}await new Promise(r=>setTimeout(r,250));}throw Error('Gateway readiness deadline');};
let server, delayMs=0, legacy=false, dropAck=false; const metrics=[];
const adapter={request:async(method,params,options)=>{
 const started=performance.now(); const result=await gateway.request(method,params,options);
 metrics.push({method,actualMs:Math.round(performance.now()-started)});
 if(method==='models.authRefresh'&&dropAck){dropAck=false;throw Error('injected acknowledgement loss');}
 if(method==='models.authRefresh'&&delayMs){const delay=delayMs; delayMs=0; const budget=legacy?10000:options.timeoutMs;
  if(delay>budget){await new Promise(r=>setTimeout(r,budget));throw Error('injected late acknowledgement');}
  await new Promise(r=>setTimeout(r,delay));
 }
 return result;
}};
const member=(v)=>({accountId:'fixture-a',credentialVersion:v,enabled:true,bundle:{formatVersion:1,profileId:'openai:golem-fixture-a',idToken:'synthetic-id',lastRefresh:null,email:null,chatgptPlanType:null,accessToken:'synthetic-access-'+v,refreshToken:'synthetic-refresh',expiresAtMs:4700000000000,accountId:'fixture-account'}});
const action=(v)=>({kind:'codex.auth.pool.sync',revision:v,members:[qaBundle?{...member(v),bundle:qaBundle}:member(v)]});
const {resolveRuntimeAuthSdk}=await import('../dist/agentControl/runtimeAuthWriter.js');
const sdk=await resolveRuntimeAuthSdk();
const {ensureAuthProfileStoreAsync}=await import(pathToFileURL(sdk));
const {setRuntimeConfigSnapshot}=await import(pathToFileURL(createRequire(sdk).resolve('openclaw/plugin-sdk/runtime-config-snapshot')));
setRuntimeConfigSnapshot(config);
const hash=async()=>{const store=await ensureAuthProfileStoreAsync(process.env.OPENCLAW_AGENT_DIR,{readOnly:true,syncExternalCli:false,config});return createHash('sha256').update(JSON.stringify({profiles:store.profiles,order:store.order})).digest('hex')};
const startHttp=()=>startPushServer({port:0,path:'/relay/messages',relayToken:token,rateLimitPerSecond:1000,onMessage:async()=>{},onAgentControl:async message=>{
 const a=message.input.action; assert.equal(a.kind,'codex.auth.pool.sync');
 const state=await syncSubscriptionPool({configPath,revision:a.revision,members:a.members.map(m=>({accountId:m.accountId,credentialVersion:m.credentialVersion,enabled:m.enabled,credential:{type:'oauth',provider:'openai',access:m.bundle.accessToken,refresh:m.bundle.refreshToken,expires:m.bundle.expiresAtMs,accountId:m.bundle.accountId}})),...(isAuthorizationReadbackOnly()?{reconcileOnly:true}:{}),assertRuntimeGuard:async()=>({runScopedFallbacks:true}),refreshRuntimeAuth:()=>refreshSubscriptionPoolAuth(adapter)});
 return {kind:a.kind,revision:state.revision,phase:state.phase,members:state.members};
}});
try{
 await gateway.start(); console.log(JSON.stringify({stage:'gateway_ready',root,pid:child.pid}));
 server=startHttp();if(!server.listening)await once(server,'listening');
 const post=async(id,mode,a,fingerprint)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/relay/messages`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({messageId:id,input:{kind:'agent_control',action:a??{kind:'config.read'},durableOperation:{id,mode,...(fingerprint?{resumeFrom:fingerprint}:{})}}})});return {status:res.status,...await res.json()}};
 const terminal=async id=>{const end=Date.now()+180000;while(Date.now()<end){const r=await post(id,'status');if(r.receipt?.state!=='RUNNING')return r.receipt;await new Promise(r=>setTimeout(r,100));}throw Error('receipt deadline')};
 legacy=true;delayMs=99000;await post('saved-r1','submit',action(1));let receipt=await terminal('saved-r1');
 assert.equal(receipt.state,'UNKNOWN');assert.match(receipt.code,/OPENAI_POOL_AUTH_RUNTIME_PENDING/);assert.equal((await readSubscriptionPoolState(configPath)).completionStage,'credentials_verified');
 console.log(JSON.stringify({stage:'ten_second_failure_reproduced',receipt:receipt.state,phase:(await readSubscriptionPoolState(configPath)).phase}));
 const before=await hash();legacy=false;
 await new Promise(r=>{server.closeAllConnections();server.close(r)});server=startHttp();if(!server.listening)await once(server,'listening');
 // Simulate an interrupted receipt and pre-upgrade state (no completionStage).
 const receiptPath=path.join(root,'relay-authorization-receipts/saved-r1.json');
 await fs.writeFile(receiptPath,JSON.stringify({...receipt,state:'RUNNING'}));
 const poolPath=configPath+'.golem-openai-pool.json', oldState=JSON.parse(await fs.readFile(poolPath,'utf8'));delete oldState.completionStage;await fs.writeFile(poolPath,JSON.stringify(oldState));
 if(process.env.POOL_PROOF_WORKER){
  const row={harnessTransitionId:'saved-r1',harnessTransition:{request:{kind:'enterprise.authorization.pool',revision:1,members:[{accountId:'fixture-a',enabled:true}]}},selectionRecoveryStatus:'NEEDS_ATTENTION',selectionRecoveryAttempts:5,selectionRecoveryNextAt:null,selectionRecoveryError:'OPENAI_POOL_OUTCOME_PENDING',owner:{googleSub:'fixture'}};
  let readbacks=0;
  globalThis.__poolWorkerFixture={AppError:class extends Error{},logger:{warn(){},error(){}},withOperationExecutionLock:async(_id,_kind,run)=>run(()=>{}),prisma:{server:{findMany:async()=>row.harnessTransitionId?[{id:'fixture'}]:[],findFirst:async()=>({...row}),updateMany:async({where,data})=>{if(where.harnessTransitionId!==row.harnessTransitionId)return {count:0};Object.assign(row,data);return {count:1}}}},recoverAgentSelection:async(_owner,_id,options)=>{
   assert.deepEqual(options.reconcilePartialAuthorization,row.harnessTransition.request.members?{revision:1,members:row.harnessTransition.request.members}:null);readbacks++;
   await post('saved-r1','reconcile',action(1),receipt.fingerprint);const completed=await terminal('saved-r1');assert.equal(completed.state,'SUCCEEDED');row.harnessTransitionId=null;return {recovered:true};
  }};
  const worker=await import(pathToFileURL(process.env.POOL_PROOF_WORKER));assert.equal((await worker.recoverAgentSelectionsOnce()).recovered,1);worker.stopAgentSelectionRecoveryWorker();assert.equal(readbacks,1);assert.equal(row.selectionRecoveryAttempts,6);
  console.log(JSON.stringify({stage:'actual_backend_worker',readbacks,attempts:row.selectionRecoveryAttempts,boundary:'synthetic database/selection adapter; actual worker and Relay HTTP'}));
 }else await post('saved-r1','reconcile',action(1),receipt.fingerprint);
 receipt=await terminal('saved-r1');assert.equal(receipt.state,'SUCCEEDED');assert.equal(await hash(),before);
 await post('saved-r1','submit',action(1));assert.equal(await hash(),before);
 assert.equal((await post('saved-r1','reconcile',action(2),receipt.fingerprint)).status,409);
 console.log(JSON.stringify({stage:'restart_readback_and_duplicate',receipt:receipt.state,credentialSnapshotUnchanged:true,changedIntentRefused:true}));
 delayMs=process.env.POOL_PROOF_QUICK?100:99000;const started=Date.now();await post('saved-r2','submit',action(2));receipt=await terminal('saved-r2');assert.equal(receipt.state,'SUCCEEDED');
 assert.equal((await readSubscriptionPoolState(configPath)).completionStage,'runtime_acknowledged');
 console.log(JSON.stringify({stage:'fixed_delayed_refresh',injectedDelayMs:process.env.POOL_PROOF_QUICK?100:99000,receipt:receipt.state,elapsedMs:Date.now()-started}));
 if(qaBundle){
  const key='agent:main:pool-completion-'+randomBytes(6).toString('hex');
  const sent=await gateway.request('chat.send',{sessionKey:key,message:'Reply exactly POOL_COMPLETION_MODEL_OK. Do not use tools.',idempotencyKey:randomBytes(16).toString('hex'),timeoutMs:120000},{timeoutMs:15000});
  const end=Date.now()+150000;let final;while(Date.now()<end){final=chatEvents.find(e=>e.runId===sent.runId&&['final','error','aborted'].includes(e.state));if(final)break;await new Promise(r=>setTimeout(r,100));}
  assert(final,'model completion timed out');assert.equal(final.state,'final',final.errorMessage);
  assert(JSON.stringify(final.message).includes('POOL_COMPLETION_MODEL_OK'),'unexpected model answer');
  console.log(JSON.stringify({stage:'real_qa_model_inference',state:final.state,model,expectedAnswer:true,fallbackConfigured:false}));
 }
 if(process.env.POOL_PROOF_SESSION_COUNT){
  const count=Number(process.env.POOL_PROOF_SESSION_COUNT);assert(Number.isSafeInteger(count)&&count>0&&count<=128);
  const {upsertSessionEntry}=await import(pathToFileURL(createRequire(sdk).resolve('openclaw/plugin-sdk/session-store-runtime')));
  const label='synthetic-load-'.padEnd(512*1024,'x');const started=Date.now();
  for(let i=0;i<count;i++){await upsertSessionEntry({agentId:'main',sessionKey:'agent:main:load-'+i,entry:{sessionId:randomBytes(16).toString('hex'),updatedAt:Date.now(),label}});if((i+1)%32===0)console.log(JSON.stringify({stage:'synthetic_sessions_seeded',count:i+1,total:count}));}
  const refreshStarted=Date.now();await refreshSubscriptionPoolAuth(adapter);
  console.log(JSON.stringify({stage:'loaded_gateway_refresh',sessions:count,metadataBytes:count*label.length,seedMs:refreshStarted-started,refreshMs:Date.now()-refreshStarted}));
 }
 // A lost acknowledgement across a real Gateway restart must converge by readback.
 dropAck=true;await post('saved-r3','submit',action(3));receipt=await terminal('saved-r3');assert.equal(receipt.state,'UNKNOWN');const restartBefore=await hash();
 gateway.stop();child.kill('SIGTERM');await once(child,'exit');child=spawn('openclaw',['gateway','run','--port',String(port),'--bind','loopback'],{env:process.env,stdio:['ignore',log.fd,log.fd]});await gateway.start();await waitReady();
 await post('saved-r3','reconcile',action(3),receipt.fingerprint);receipt=await terminal('saved-r3');assert.equal(receipt.state,'SUCCEEDED');assert.equal(await hash(),restartBefore);
 console.log(JSON.stringify({stage:'gateway_process_restart',receipt:receipt.state,credentialSnapshotUnchanged:true}));
 // Diverged runtime credentials are never silently repaired or acknowledged.
 dropAck=true;await post('saved-r4','submit',action(4));receipt=await terminal('saved-r4');assert.equal(receipt.state,'UNKNOWN');
 const {updateAuthProfileStoreWithLock}=await import(pathToFileURL(sdk));
 await updateAuthProfileStoreWithLock({agentDir:process.env.OPENCLAW_AGENT_DIR,stateDir:root,sharedStoreWrite:true,saveOptions:{syncExternalCli:false,filterExternalAuthProfiles:false},updater:store=>{store.profiles['openai:golem-fixture-a'].access='synthetic-divergence';return true}});
 const diverged=await hash();await post('saved-r4','reconcile',action(4),receipt.fingerprint);receipt=await terminal('saved-r4');assert.equal(receipt.state,'UNKNOWN');assert.match(receipt.code,/READBACK_MISMATCH/);assert.equal(await hash(),diverged);assert.equal((await readSubscriptionPoolState(configPath)).phase,'pending');assert.deepEqual(JSON.parse(await fs.readFile(configPath,'utf8')),config);
 console.log(JSON.stringify({stage:'diverged_credentials_refused',receipt:receipt.state,noCredentialRepair:true,configUnchanged:true}));
 console.log(JSON.stringify({stage:'gateway_timings',metrics,boundary:'real HTTP/receipts/public SDK/Gateway; injected response delay; admission guard synthetic; optional QA inference'}));
 console.log('PASS');
} catch(error){console.error('PROOF_FAILED',error);console.error((await fs.readFile(path.join(root,'gateway.log'),'utf8')).slice(-8000));process.exitCode=1;}
finally{gateway.stop();if(server)await new Promise(r=>{server.closeAllConnections();server.close(r)});child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null)child.kill('SIGKILL');await log.close();if(qaBundle)await fs.rm(root,{recursive:true,force:true});console.log('Evidence directory:',qaBundle?'removed protected QA runtime state':root);}
