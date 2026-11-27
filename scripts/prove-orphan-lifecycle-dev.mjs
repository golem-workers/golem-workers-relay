import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire('/root/golem-workers-relay/package.json');
require('dotenv').config({path:'/root/golem-workers-relay/.env',quiet:true});
const base=process.env.BACKEND_BASE_URL;
if(base!=='https://dev-api.golemworkers.com')throw Error('NOT_DEV_BACKEND');
const sid=process.env.ORPHAN_TEST_SERVER_ID;
if(!sid)throw Error('ORPHAN_TEST_SERVER_ID_REQUIRED');
function rpc(method,params){return JSON.parse(execFileSync('openclaw',['gateway','call',method,'--params',JSON.stringify(params),'--json'],{encoding:'utf8',timeout:40000}));}
async function post(path,body){const r=await fetch(base+'/api/v1/relays/agent-lifecycle/'+path,{method:'POST',headers:{authorization:'Bearer '+process.env.RELAY_TOKEN,'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error('API_'+r.status+'_'+d.code);return d;}
const mode=process.argv[2];const path='/tmp/orphan-lifecycle-fixture.json';
if(mode==='seed'){
 execFileSync('systemctl',['stop','golem-workers-relay.service']);
 const sourceGeneration=randomUUID();const registration=await post('generations',{sourceGeneration});
 const runs=[];let sequence=0;
 for(const status of ['RUNNING','WAITING']){
  const key='agent:main:explicit:orphan-lifecycle-'+status.toLowerCase();
  const before=rpc('sessions.reset',{key});const sessionId=before.entry.sessionId;const runId='orphan-test-'+randomUUID();
  const event={schemaVersion:1,eventType:'agent.lifecycle.changed',eventId:`lifecycle:${sourceGeneration}:${++sequence}`,serverId:sid,provider:'openclaw',agentId:'main',sessionId,runId,sourceGeneration,sequence,status,occurredAt:new Date().toISOString(),origin:'RECONCILIATION',diagnostics:{reasonCode:'synthetic_lost_terminal_fixture'}};
  await post('events',event);
  rpc('sessions.delete',{key});
  const after=rpc('sessions.reset',{key});if(after.entry.sessionId===sessionId)throw Error('RECREATE_DID_NOT_REPLACE');
  runs.push({key,sessionId,replacementSessionId:after.entry.sessionId,runId,status});
 }
 fs.writeFileSync(path,JSON.stringify({runs}));console.log(JSON.stringify({seeded:runs}));
 execFileSync('systemctl',['start','golem-workers-relay.service']);
}else if(mode==='keep-wait'){
 execFileSync('systemctl',['stop','golem-workers-relay.service']);
 const key='agent:main:explicit:orphan-lifecycle-retained-wait';
 const sessionId=rpc('sessions.reset',{key}).entry.sessionId;
 const sourceGeneration=randomUUID();await post('generations',{sourceGeneration});
 const runId='retained-wait-'+randomUUID();
 await post('events',{schemaVersion:1,eventType:'agent.lifecycle.changed',eventId:`lifecycle:${sourceGeneration}:1`,serverId:sid,provider:'openclaw',agentId:'main',sessionId,runId,sourceGeneration,sequence:1,status:'WAITING',occurredAt:new Date().toISOString(),origin:'RECONCILIATION',diagnostics:{reasonCode:'synthetic_retained_pause_fixture'}});
 const fixture=JSON.parse(fs.readFileSync(path));fixture.retainedWait={key,sessionId,runId};fs.writeFileSync(path,JSON.stringify(fixture));console.log(JSON.stringify({retainedWait:fixture.retainedWait}));
}else if(mode==='inspect'){
 const fixture=JSON.parse(fs.readFileSync(path));
 const source=JSON.parse(fs.readFileSync('/root/.openclaw/relay/agent-lifecycle-source/current.json'));
 const current=await post('generations',{sourceGeneration:source.sourceGeneration});
 const sessions=rpc('sessions.list',{limit:200,archived:'all',includeGlobal:true,includeUnknown:true});
 console.log(JSON.stringify({checkedAt:new Date().toISOString(),fixture,source,activeRuns:current.activeRuns,sessions:{totalCount:sessions.totalCount,hasMore:sessions.hasMore,rows:sessions.sessions.map(s=>({key:s.key,sessionId:s.sessionId,status:s.status,hasActiveRun:s.hasActiveRun,activeRunIds:s.activeRunIds}))},relayActive:execFileSync('systemctl',['is-active','golem-workers-relay.service'],{encoding:'utf8'}).trim(),relayModuleHash:createHash('sha256').update(fs.readFileSync('/root/golem-workers-relay/dist/agentLifecycle/relay.js')).digest('hex')}));
}
