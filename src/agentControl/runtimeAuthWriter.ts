import fs from "node:fs/promises";
import JSON5 from "json5";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// Cold admission can perform full integrity checks for both shared and agent DBs.
// Keep a bounded budget, but do not kill a healthy SDK midway through admission.
const AUTH_WRITER_TIMEOUT_MS = 120_000;

export class RuntimeAuthWriterError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "RuntimeAuthWriterError"; }
}

function writerFailureStage(code: number | null): string {
  return ({ 2: "EXPORT_MISSING", 3: "STORE_REFUSED", 4: "SDK_IMPORT_FAILED", 5: "SESSION_SDK_IMPORT_FAILED", 6: "SNAPSHOT_SDK_IMPORT_FAILED", 7: "AGENT_SDK_IMPORT_FAILED", 8: "STORE_UPDATE_FAILED", 9: "SESSION_REFRESH_FAILED", 10: "RUNTIME_SNAPSHOT_FAILED", 11: "STORE_LOCK_BUSY", 12: "STORE_LOCKED", 13: "MIGRATION_REQUIRED", 14: "STORE_UNREADABLE", 15: "OWNERSHIP_INVALID" } as Record<number, string>)[code ?? -1] ?? "CALLBACK_FAILED";
}
// Only fixed exit integers cross the subprocess boundary. Never forward exception
// messages, stderr, paths, input bundles or arbitrary runtime error codes.
const sanitizedWriterCatch = `catch (error) {
  const known = { SQLITE_BUSY: 11, SQLITE_LOCKED: 12, AUTH_PROFILE_MIGRATION_REQUIRED: 13, AUTH_PROFILE_STORE_UNREADABLE: 14, INVALID_SHARED_AUTH_STORE_OWNERSHIP: 15 };
  const code = error && typeof error === "object" && typeof error.code === "string" && Object.hasOwn(known, error.code) ? known[error.code] : failureExit;
  process.exit(code);
}`;

// Resolve the public SDK from the active executable first. NODE_PATH can still
// point at an obsolete pnpm global root after an update (backend issue #656).
// Loading that SDK against the current runtime database can reject its schema.
export async function resolveRuntimeAuthSdk(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    let executable: string;
    try {
      executable = await fs.realpath(path.join(directory, "openclaw"));
      const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(executable), "package.json"), "utf8")) as { name?: string };
      if (pkg.name !== "openclaw") continue;
    } catch { continue; /* A wrapper or unrelated PATH entry is not a package root. */ }
    try {
      return createRequire(executable).resolve("openclaw/plugin-sdk/provider-auth");
    } catch {
      // Never silently substitute an older module installation for a known runtime.
      throw new RuntimeAuthWriterError("AUTH_WRITER_SDK_UNAVAILABLE", "Active OpenClaw public provider-auth SDK is unavailable; refusing stale SDK fallback.");
    }
  }
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("openclaw/plugin-sdk/provider-auth");
  } catch { /* No resolvable executable or module installation. */ }
  throw new RuntimeAuthWriterError("AUTH_WRITER_SDK_UNAVAILABLE", "Installed OpenClaw public provider-auth SDK is unavailable; refusing to create an auth database.");
}

// A separate process isolates runtime caches and state-root environment from the
// relay. Credentials travel on stdin, never argv, environment, or diagnostic logs.
const writer = String.raw`
let failureExit = 4;
try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const { updateAuthProfileStoreWithLock } = await import(process.argv[1]);
  if (typeof updateAuthProfileStoreWithLock !== "function") process.exit(2);
  failureExit = 8;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: process.env.OPENCLAW_AGENT_DIR,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    sharedStoreWrite: true,
    saveOptions: { syncExternalCli: false, filterExternalAuthProfiles: false },
    updater: (store) => {
      store.profiles = Object.fromEntries(Object.entries(store.profiles).filter(([, value]) =>
        !(value.type === "oauth" && (value.provider === "openai" || value.provider === "openai-codex"))));
      store.profiles[input.profileId] = input.credential;
      store.order = { ...store.order, openai: [input.profileId] };
      store.lastGood = { ...store.lastGood, openai: input.profileId };
      return true;
    },
  });
  process.exit(updated ? 0 : 3);
} ${sanitizedWriterCatch}
`;

export async function writeRuntimeAuth(input: {
  configPath: string;
  profileId: string;
  credential: Record<string, unknown>;
}): Promise<void> {
  const sdk = await resolveRuntimeAuthSdk();
  const configPath = path.resolve(input.configPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", writer, pathToFileURL(sdk).href], {
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: path.dirname(configPath),
        OPENCLAW_AGENT_DIR: path.join(path.dirname(configPath), "agents", "main", "agent"),
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, AUTH_WRITER_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new RuntimeAuthWriterError("AUTH_WRITER_SPAWN_FAILED", "Unable to start OpenClaw auth writer."));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else {
        const stage = timedOut ? "TIMEOUT" : writerFailureStage(code);
        const diagnostic = `AUTH_WRITER_${stage}_EXIT_${code ?? "NONE"}_${signal ?? "NONE"}`;
        reject(new RuntimeAuthWriterError(diagnostic, `OpenClaw auth writer refused the update (${diagnostic}); inspect runtime schema ownership and SDK compatibility.`));
      }
    });
    child.stdin.on("error", () => { /* close/error above reports a sanitized failure */ });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Pool updates preserve all non-pool credentials; the SDK owns SQLite schema/locks. */
export async function writeRuntimeAuthPool(input: {
  configPath: string;
  state: import("./openAiSubscriptionPool.js").SubscriptionPoolState;
  members: import("./openAiSubscriptionPool.js").SubscriptionPoolMember[];
}): Promise<void> {
  const { updateSubscriptionPoolStore } = await import("./openAiSubscriptionPool.js");
  const sdk = await resolveRuntimeAuthSdk();
  const configPath = path.resolve(input.configPath);
  const sessionSdk = createRequire(sdk).resolve("openclaw/plugin-sdk/session-store-runtime");
  const snapshotSdk = createRequire(sdk).resolve("openclaw/plugin-sdk/runtime-config-snapshot");
  const agentScopeSdk = createRequire(sdk).resolve("openclaw/plugin-sdk/agent-scope-runtime");
  const runtimeConfig: unknown = JSON5.parse(await fs.readFile(configPath, "utf8"));
  const body = `
let failureExit = 4;
try {
 let raw = ""; for await (const chunk of process.stdin) raw += chunk;
 const input = JSON.parse(raw);
 const { updateAuthProfileStoreWithLock } = await import(process.argv[1]);
 failureExit = 5;
 const { listSessionEntries, patchSessionEntry } = await import(process.argv[2]);
 failureExit = 6;
 const { setRuntimeConfigSnapshot } = await import(process.argv[3]);
 failureExit = 7;
 const { listAgentIds } = await import(process.argv[4]);
 failureExit = 10;
 setRuntimeConfigSnapshot(input.runtimeConfig);
 if (typeof listSessionEntries !== "function" || typeof patchSessionEntry !== "function" || typeof listAgentIds !== "function") process.exit(2);
 const openAiProfiles = new Set(input.state.managedProfileIds);
 if (typeof updateAuthProfileStoreWithLock !== "function") process.exit(2);
 failureExit = 8;
 const updated = await updateAuthProfileStoreWithLock({
  agentDir: process.env.OPENCLAW_AGENT_DIR, stateDir: process.env.OPENCLAW_STATE_DIR,
  sharedStoreWrite: true,
  saveOptions: { syncExternalCli: false, filterExternalAuthProfiles: false },
  updater: store => {
   for (const [id, value] of Object.entries(store.profiles)) if (["openai", "openai-codex"].includes(value.provider)) openAiProfiles.add(id);
   (${updateSubscriptionPoolStore.toString()})(store, input.state, input.members); return true;
  },
 });
 if (!updated) process.exit(3);
 failureExit = 9;
 const enabled = new Set(input.state.members.filter(m => m.enabled).map(m => m.profileId));
 for (const agentId of listAgentIds(input.runtimeConfig)) for (const { sessionKey } of listSessionEntries({ agentId, env: process.env, readConsistency: "latest" })) {
  await patchSessionEntry({ agentId, env: process.env, sessionKey, preserveActivity: true, requireWriteSuccess: true, update: entry => {
   const id = entry.authProfileOverride;
   if (!id || !openAiProfiles.has(id) && !/^openai(?:-codex)?:/.test(id)) return null;
   return { authProfileOverride: enabled.has(id) ? id : undefined, authProfileOverrideSource: enabled.has(id) ? "auto" : undefined, authProfileOverrideCompactionCount: undefined };
  } });
 }
 process.exit(0);
} ${sanitizedWriterCatch}
`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", body, pathToFileURL(sdk).href, pathToFileURL(sessionSdk).href, pathToFileURL(snapshotSdk).href, pathToFileURL(agentScopeSdk).href], {
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: path.dirname(configPath), OPENCLAW_AGENT_DIR: path.join(path.dirname(configPath), "agents", "main", "agent") },
      stdio: ["pipe", "ignore", "ignore"],
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, AUTH_WRITER_TIMEOUT_MS);
    child.once("error", () => { clearTimeout(timer); reject(new RuntimeAuthWriterError("AUTH_POOL_WRITER_SPAWN_FAILED", "Unable to start runtime subscription writer.")); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else {
        const stage = timedOut ? "TIMEOUT" : writerFailureStage(code);
        const diagnostic = `AUTH_POOL_WRITER_${stage}_EXIT_${code ?? "NONE"}_${signal ?? "NONE"}`;
        reject(new RuntimeAuthWriterError(diagnostic, `Runtime subscription writer refused the update (${diagnostic}); no success acknowledgement was recorded.`));
      }
    });
    child.stdin.on("error", () => { /* sanitized close result owns failure */ });
    child.stdin.end(JSON.stringify({ ...input, runtimeConfig }));
  });
}
