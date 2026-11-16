import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveOpenclawConfigPath } from '../common/utils/paths.js';
import { resolveRuntimeAuthSdk } from '../agentControl/runtimeAuthWriter.js';
import { readSubscriptionPoolState } from '../agentControl/subscriptionPoolManager.js';
import { subscriptionSnapshotSchema } from './subscriptionRuntime.js';

export const subscriptionInventorySchema = z.array(z.object({
  sessionKey: z.string(), snapshot: subscriptionSnapshotSchema,
})).max(500);
export type SubscriptionInventory = z.infer<typeof subscriptionInventorySchema>;

// Only public, read-only SDK APIs. Prompts, configuration and credentials never
// leave the child. Session pins are intentionally not used for native attribution.
const reader = String.raw`
try {
 let raw='';for await(const chunk of process.stdin)raw+=chunk;
 const input=JSON.parse(raw);const sdk=await import(process.argv[1]);
 const {setRuntimeConfigSnapshot}=await import(process.argv[2]);setRuntimeConfigSnapshot(input.config);
 const ids=new Set(['main',...(input.config.agents?.list??[]).map(a=>a.id).filter(id=>typeof id==='string'&&/^[a-zA-Z0-9_-]+$/.test(id))]);
 const result=[];let listed=0,totalRows=0;
 for(const agentId of ids){
  const scope={agentId,env:process.env,readConsistency:'latest'};
  const entries=await sdk.listSessionEntriesAsync(scope);listed+=entries.length;if(listed>500)throw Error();
  for(const {sessionKey,entry} of entries){
   if(!entry?.sessionId||entry.activeWriterRunId)continue;
   const sinceMs=Math.max(input.sinceMs,input.after?.["session:"+entry.sessionId]??input.sinceMs);
   if(entry.updatedAt<sinceMs)continue;
   const events=await sdk.loadTranscriptEvents({...scope,sessionKey,sessionId:entry.sessionId});
   const after=await sdk.getSessionEntryAsync({...scope,sessionKey});
   if(!after||after.activeWriterRunId||after.sessionId!==entry.sessionId||after.updatedAt!==entry.updatedAt)continue;
   const rows=[];
   for(const e of events){
    const m=e.message,u=m?.usage;
    if(m?.role!=='assistant'||!['openai','openai-codex','codex','codex-cli'].includes(m.provider)||!u||!e.id||u.usageReport?.state==='unavailable'||typeof u.totalTokens!=='number'||Date.parse(e.timestamp)<sinceMs)continue;
    rows.push({messageId:e.id,at:e.timestamp,model:m.model??'unknown',input:u.input??u.inputTokens??0,output:u.output??u.outputTokens??0,cacheRead:u.cacheRead??u.cacheReadTokens??0,cacheWrite:u.cacheWrite??u.cacheWriteTokens??0,total:u.totalTokens,stopReason:m.stopReason});
   }
   totalRows+=rows.length;if(totalRows>2000)throw Error();
   if(rows.length)result.push({sessionKey,snapshot:{observedAtMs:Date.now(),sessionId:entry.sessionId,clearedAutoPin:false,revision:input.revision,rows}});
  }
 }
 console.log('SUBSCRIPTION_INVENTORY '+JSON.stringify(result));process.exit(0);
}catch{process.exit(1);}
`;

/** Settled transcripts since collector activation, including non-Relay entry points.
 * This is message observation, never dispatch-attempt or account proof. */
export async function readSubscriptionInventory(input: {
  sinceMs: number; configPath?: string; after?: Record<string, number>;
}): Promise<SubscriptionInventory> {
  const configPath = input.configPath ?? resolveOpenclawConfigPath();
  const pool = await readSubscriptionPoolState(configPath);
  if (!pool || pool.phase === "exited") return [];
  const require = createRequire(await resolveRuntimeAuthSdk());
  const sdk = require.resolve('openclaw/plugin-sdk/session-store-runtime');
  const configSdk = require.resolve('openclaw/plugin-sdk/runtime-config-snapshot');
  const { default: JSON5 } = await import('json5');
  const config: unknown = JSON5.parse(await fs.readFile(configPath, 'utf8'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', reader,
      pathToFileURL(sdk).href, pathToFileURL(configSdk).href], {
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: path.dirname(configPath) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 2_000_000) child.kill('SIGKILL'); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('SUBSCRIPTION_INVENTORY_READ_FAILED')); });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error();
        const line = output.split('\n').find(line => line.startsWith('SUBSCRIPTION_INVENTORY '));
        resolve(subscriptionInventorySchema.parse(JSON.parse(line?.slice(23) ?? '')));
      } catch { reject(new Error('SUBSCRIPTION_INVENTORY_READ_FAILED')); }
    });
    child.stdin.on('error', () => { /* sanitized close owns failure */ });
    child.stdin.end(JSON.stringify({ ...input, revision: pool.revision, config }));
  });
}
