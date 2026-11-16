import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";
import { resolveOpenclawConfigPath } from "../common/utils/paths.js";
import { resolveRuntimeAuthSdk } from "../agentControl/runtimeAuthWriter.js";
import { readSubscriptionPoolState } from "../agentControl/subscriptionPoolManager.js";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const subscriptionSnapshotSchema = z.object({
  observedAtMs: counter,
  sessionId: z.string().optional(),
  profileId: z.string().optional(),
  source: z.string().optional(),
  activeRunId: z.string().optional(),
  clearedAutoPin: z.boolean(),
  revision: counter,
  rows: z
    .array(
      z.object({
        messageId: z.string(),
        at: z.string().datetime(),
        model: z.string(),
        input: counter,
        output: counter,
        cacheRead: counter,
        cacheWrite: counter,
        total: counter,
        stopReason: z.string().optional(),
      }),
    )
    .max(2000),
});
export type SubscriptionSnapshot = z.infer<typeof subscriptionSnapshotSchema>;

// Isolate runtime caches. Only whitelisted metadata crosses stdout; never auth/config.
const reader = String.raw`
let stage="input";
try {
 let raw=""; for await(const chunk of process.stdin) raw+=chunk;
 const input=JSON.parse(raw);
 const auth=await import(process.argv[1]); const sdk=await import(process.argv[2]);
 const {setRuntimeConfigSnapshot}=await import(process.argv[3]);
 setRuntimeConfigSnapshot(input.config);
 const scope={agentId:"main",env:process.env,sessionKey:input.sessionKey,readConsistency:"latest"};
 const read=()=>sdk.getSessionEntryAsync ? sdk.getSessionEntryAsync(scope) : sdk.getSessionEntry(scope);
 stage="session-read"; let entry=await read(); let clearedAutoPin=false;
 if(input.prepare) {
  stage="auth-read"; const store=auth.ensureAuthProfileStoreAsync
   ? await auth.ensureAuthProfileStoreAsync(process.env.OPENCLAW_AGENT_DIR,{readOnly:true,syncExternalCli:false,allowKeychainPrompt:false})
   : auth.ensureAuthProfileStore(process.env.OPENCLAW_AGENT_DIR,{readOnly:true,syncExternalCli:false,allowKeychainPrompt:false});
  const now=Date.now();
  const model=entry?.modelOverride??entry?.model??String(input.config.agents?.defaults?.model?.primary??"").split("/").slice(1).join("/");
  const blocked=id=>{
   const stats=store.usageStats?.[id];
   const otherModel=stats?.cooldownModel && stats.cooldownModel!==model && ["rate_limit","timeout"].includes(stats.cooldownReason);
   return stats?.blockedUntil>now || stats?.disabledUntil>now || (!otherModel && stats?.cooldownUntil>now);
  };
  const eligible=input.pool.members.some(m=>m.enabled && store.profiles[m.profileId]?.type==="oauth" &&
   ["openai","openai-codex"].includes(store.profiles[m.profileId]?.provider) && !blocked(m.profileId));
  // OpenClaw can probe the least-cooled profile when all candidates are blocked.
  // Pool policy deliberately refuses that probe instead of forwarding the request.
  if(!eligible) { stage="all-exhausted"; throw new Error(); }
  const id=entry?.authProfileOverride;
  const member=input.pool.members.find(m=>m.profileId===id);
  const managed=input.pool.managedProfileIds.includes(id);
  if(entry?.authProfileOverrideSource==="auto" && managed && (!member?.enabled || !store.profiles[id] || blocked(id))) {
   const expected=entry;
   stage="session-patch"; await sdk.patchSessionEntry({...scope,preserveActivity:true,requireWriteSuccess:true,update:current=>
    current.sessionId===expected.sessionId && current.authProfileOverride===id && current.authProfileOverrideSource==="auto"
     ? {authProfileOverride:undefined,authProfileOverrideSource:undefined,authProfileOverrideCompactionCount:undefined} : null});
   entry=await read(); clearedAutoPin=entry?.authProfileOverride!==id;
  }
 }
 stage="transcript"; const events=!input.prepare && entry?.sessionId ? sdk.loadTranscriptEventsSync({...scope,sessionId:entry.sessionId}) : [];
 const rows=[];
 for(const e of events) {
  const m=e.message; const u=m?.usage;
  if(m?.role!=="assistant" || !["openai","openai-codex","codex","codex-cli"].includes(m.provider) || !u || !e.id || u.usageReport?.state==="unavailable" || typeof u.totalTokens!=="number") continue;
  rows.push({messageId:e.id,at:e.timestamp,model:m.model??"unknown",input:u.input??u.inputTokens??0,output:u.output??u.outputTokens??0,
   cacheRead:u.cacheRead??u.cacheReadTokens??0,cacheWrite:u.cacheWrite??u.cacheWriteTokens??0,total:u.totalTokens,stopReason:m.stopReason});
 }
 if(rows.length>2000) throw new Error("SUBSCRIPTION_TRANSCRIPT_LIMIT");
 const profileId=input.pool.managedProfileIds.includes(entry?.authProfileOverride) ? entry.authProfileOverride : undefined;
 console.log("SUBSCRIPTION_SNAPSHOT "+JSON.stringify({observedAtMs:Date.now(),sessionId:entry?.sessionId,profileId,source:entry?.authProfileOverrideSource,
  activeRunId:entry?.activeWriterRunId,clearedAutoPin,revision:input.pool.revision,rows}));
 process.exit(0);
} catch { console.log("SUBSCRIPTION_SNAPSHOT "+JSON.stringify({stage})); process.exit(1); }
`;

export async function readSubscriptionRuntime(input: {
  sessionKey: string;
  prepare?: boolean;
  configPath?: string;
}): Promise<SubscriptionSnapshot | null> {
  const configPath = input.configPath ?? resolveOpenclawConfigPath();
  const pool = await readSubscriptionPoolState(configPath);
  if (!pool || pool.phase === "exited" || /^agent:(?!main:)/i.test(input.sessionKey)) return null;
  const sdkPath = await resolveRuntimeAuthSdk();
  const require = createRequire(sdkPath);
  const sessionSdk =
    require.resolve("openclaw/plugin-sdk/session-store-runtime");
  const snapshotSdk =
    require.resolve("openclaw/plugin-sdk/runtime-config-snapshot");
  const { default: JSON5 } = await import("json5");
  const config: unknown = JSON5.parse(await fs.readFile(configPath, "utf8"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        reader,
        ...[sdkPath, sessionSdk, snapshotSdk].map((p) => pathToFileURL(p).href),
      ],
      {
        env: {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.dirname(configPath),
          OPENCLAW_AGENT_DIR: path.join(
            path.dirname(configPath),
            "agents/main/agent",
          ),
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 2_000_000) child.kill("SIGKILL");
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("SUBSCRIPTION_RUNTIME_READER_FAILED"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        output =
          output
            .split("\n")
            .reverse()
            .find((line) => line.startsWith("SUBSCRIPTION_SNAPSHOT "))
            ?.slice(22) ?? "";
        if (code !== 0) {
          const stage = z.object({stage:z.string()}).parse(JSON.parse(output) as unknown).stage;
          throw new Error(stage === "all-exhausted" ? "OPENAI_SUBSCRIPTIONS_EXHAUSTED" : "SUBSCRIPTION_RUNTIME_" + stage);
        }
        resolve(subscriptionSnapshotSchema.parse(JSON.parse(output)));
      } catch (error) {
        reject(
          error instanceof Error &&
            /^(SUBSCRIPTION_RUNTIME_[a-z-]+|OPENAI_SUBSCRIPTIONS_EXHAUSTED)$/.test(error.message)
            ? error
            : new Error("SUBSCRIPTION_RUNTIME_READER_FAILED"),
        );
      }
    });
    child.stdin.on("error", () => {
      /* sanitized close result owns errors */
    });
    child.stdin.end(JSON.stringify({ ...input, pool, config }));
  });
}
