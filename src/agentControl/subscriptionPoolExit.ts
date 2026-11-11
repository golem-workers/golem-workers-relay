import fs from "node:fs/promises";
import JSON5 from "json5";
import { isDeepStrictEqual } from "node:util";
import { managedOpenAiRelayBaseUrl, isGeneratedSolCatalog } from "./managedSubscriptionRoute.js";
import { prepareSubscriptionPool, SubscriptionPoolError } from "./openAiSubscriptionPool.js";
import { readSubscriptionPoolState, writeSubscriptionPoolState } from "./subscriptionPoolManager.js";
import { writeRuntimeAuthPool } from "./runtimeAuthWriter.js";
import { withOwnerFenceLock, writeOwnerFencedConfig } from "./ownerFence.js";
import { withAuthorizationConfig } from "../managed-runtime/runtime-policy.js";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Gateway config.get redacts credentials. Verify public effective routing here;
 * the locked saved bytes and matching saved/applied hashes prove secret config. */
export function assertSubscriptionPoolApiRoute(config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  const endpoint = managedOpenAiRelayBaseUrl(env), provider = object(object(object(config.models).providers).openai);
  if (!endpoint || provider.api !== "openai-responses" || provider.baseUrl !== endpoint) throw new SubscriptionPoolError("OPENAI_POOL_API_ROUTE_NOT_APPLIED", "Managed API route is not applied.");
  const agents = object(config.agents), defaults = object(agents.defaults);
  for (const scope of [defaults, ...(Array.isArray(agents.list) ? agents.list.map(object) : []), ...Object.values(object(agents.entries)).map(object)]) {
    const assignment = scope.model ?? defaults.model, ref = typeof assignment === "string" ? assignment : object(assignment).primary;
    if (typeof ref !== "string" || !ref.startsWith("openai/")) continue;
    const model = (Array.isArray(provider.models) ? provider.models : []).map(object).find(row => row.id === ref.slice(7)) ?? {};
    const route = { ...provider, ...model, ...object(object(defaults.models)[ref]), ...object(object(scope.models)[ref]) };
    if (route.api !== "openai-responses" || route.baseUrl !== endpoint) throw new SubscriptionPoolError("OPENAI_POOL_API_ROUTE_UNSUPPORTED", "Authored model routing prevents managed API source selection.");
  }
}

/** Explicit source selection only. Rebuild the exact platform-owned route; never
 * restore a stale saved whole config or turn an authored endpoint into our proxy. */
export function prepareSubscriptionPoolExitConfig(config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const endpoint = managedOpenAiRelayBaseUrl(env), token = env.RELAY_TOKEN?.trim();
  if (!endpoint || !token) throw new SubscriptionPoolError("OPENAI_POOL_API_ROUTE_UNAVAILABLE", "Platform API routing identity is unavailable.");
  const next = structuredClone(config);
  const providers = object(object(next.models).providers), provider = object(providers.openai);
  const solCatalog = { ...provider }; delete solCatalog.api;
  const generatedSol = (provider.api === undefined || (provider.api === "openai-chatgpt-responses" || provider.api === "openai-responses")) &&
    (isGeneratedSolCatalog(solCatalog, true) || isGeneratedSolCatalog(solCatalog, false));
  const alreadyApi = provider.api === "openai-responses" && provider.baseUrl === endpoint;
  const direct = (provider.api === "openai-chatgpt-responses" || generatedSol) && (!provider.baseUrl || provider.baseUrl === "https://chatgpt.com/backend-api/codex");
  if ((!direct && !alreadyApi) || !Array.isArray(provider.models) || (provider.models.length && !generatedSol) ||
      Object.keys(provider).some(k => !["api", "baseUrl", "models", "agentRuntime", "pickerRuntimes"].includes(k)) ||
      (provider.agentRuntime !== undefined && !isDeepStrictEqual(provider.agentRuntime, { id: "openclaw" })) ||
      (provider.pickerRuntimes !== undefined && !isDeepStrictEqual(provider.pickerRuntimes, ["openclaw"])))
    throw new SubscriptionPoolError("OPENAI_POOL_API_ROUTE_UNSUPPORTED", "Explicit API selection cannot replace an authored subscription provider/catalog.");
  const envRoot = object(next.env), vars = object(envRoot.vars);
  for (const row of [envRoot, vars]) {
    if ((row.OPENAI_API_KEY !== undefined && row.OPENAI_API_KEY !== token) ||
        (row.OPENAI_BASE_URL !== undefined && row.OPENAI_BASE_URL !== endpoint) || row.CODEX_API_KEY !== undefined)
      throw new SubscriptionPoolError("OPENAI_POOL_API_ROUTE_UNSUPPORTED", "Preserve authored API environment settings; select their route explicitly.");
  }
  next.env = envRoot; envRoot.vars = vars;
  // Keep unrelated environment and provider metadata intact.
  vars.OPENAI_API_KEY = token; vars.OPENAI_BASE_URL = endpoint;
  provider.api = "openai-responses"; provider.baseUrl = endpoint;
  if (generatedSol) for (const model of provider.models as Record<string, unknown>[]) model.api = "openai-responses";
  assertSubscriptionPoolApiRoute(next, env);
  return next;
}

/** A revisioned tombstone fences delayed pool syncs after exit. Interrupted exits
 * stay fail-closed and can only replay that exact revision before source apply. */
export async function exitSubscriptionPool(input: {
  configPath: string; revision: number;
  refreshRuntimeAuth: () => Promise<void>;
  waitForConfigApplied: (text: string) => Promise<void>;
}) {
  return withOwnerFenceLock(input.configPath, async () => {
    const previous = await readSubscriptionPoolState(input.configPath);
    if (!previous) throw new SubscriptionPoolError("OPENAI_POOL_REVISION_CONFLICT", "No pool exists for this exit revision.");
    const replay = ["exiting", "exited"].includes(previous.phase) && previous.revision === input.revision;
    if (!replay && (previous.phase !== "applied" || input.revision !== previous.revision + 1))
      throw new SubscriptionPoolError("OPENAI_POOL_REVISION_CONFLICT", "Reconcile the exact applied pool before exiting.");
    const text = await fs.readFile(input.configPath, "utf8");
    const config = JSON5.parse<Record<string, unknown>>(text);
    const candidate = prepareSubscriptionPoolExitConfig(config);
    if (previous.phase === "exited" && replay) return previous;
    const exiting = replay ? previous : { ...prepareSubscriptionPool(previous, input.revision, []), phase: "exiting" as const };
    await writeSubscriptionPoolState(input.configPath, exiting);
    // Remove only pool-owned OAuth profiles using the public runtime SDK.
    await writeRuntimeAuthPool({ configPath: input.configPath, state: exiting, members: [] });
    await input.refreshRuntimeAuth();
    if (!isDeepStrictEqual(candidate, config)) await withAuthorizationConfig(input.configPath, () => writeOwnerFencedConfig(input.configPath, JSON.stringify(candidate, null, 2) + "\n", undefined, {
      expectedConfigText: text, subscriptionPoolExitRevision: input.revision,
    }));
    const appliedText = await fs.readFile(input.configPath, "utf8");
    await input.waitForConfigApplied(appliedText);
    if (await fs.readFile(input.configPath, "utf8") !== appliedText) throw new Error("CONFIG_CONFLICT");
    const exited = { ...exiting, phase: "exited" as const, managedProfileIds: [] };
    await writeSubscriptionPoolState(input.configPath, exited);
    return exited;
  });
}
