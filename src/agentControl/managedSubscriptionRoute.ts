import { isDeepStrictEqual } from "node:util";
import { ensureNativePiModelCompatibility } from "./nativePiModelCompatibility.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

/** Match the backend's generated direct route, not a URL substring or a list
 * of public hosts. BACKEND_BASE_URL is relay deployment authority. Historical
 * endpoints after a deployment move are deliberately not guessed. */
function managedBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.BACKEND_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    const url = new URL(base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    return `${base}/api/v1/relays/openai/v1`;
  } catch { return; }
}

// Reuse the generator as a strict fingerprint: arbitrary nonempty catalogs and
// authored model/provider fields must remain authoritative.
function isGeneratedSolCatalog(provider: RecordValue): boolean {
  const expected: RecordValue = { agents: { defaults: { models: { "openai/gpt-6.1-sol": {} } } } };
  ensureNativePiModelCompatibility(expected, true, {});
  const catalog = record(record(expected.models)?.providers)?.openai;
  const withoutEndpoint = { ...provider };
  delete withoutEndpoint.baseUrl;
  return isDeepStrictEqual(withoutEndpoint, catalog);
}

/** Remove ONLY exact generated rows/routes after runtime subscription proof.
 * Any extension (even an unknown field), credential, header or explicit API
 * makes ownership ambiguous: preserve the whole row. Both names are checked
 * so a later OpenClaw doctor alias migration cannot resurrect the override.
 * Environment routes and API-key intent are never rewritten by model.set. */
export function normalizeManagedSubscriptionRoute(
  config: RecordValue,
  hasSubscription: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!hasSubscription) return false;
  const endpoint = managedBaseUrl(env);
  if (!endpoint) return false;
  const configEnv = record(config.env);
  if ([configEnv, record(configEnv?.vars), env].some((entry) =>
    entry && ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"].some((key) => entry[key] !== undefined))) return false;
  const profiles = record(record(config.auth)?.profiles);
  if (profiles && Object.values(profiles).some((value) => {
    const profile = record(value);
    return ["openai", "openai-codex", "codex"].includes(String(profile?.provider)) && profile?.mode === "api_key";
  })) return false;
  const providers = record(record(config.models)?.providers);
  if (!providers) return false;
  let changed = false;
  for (const name of ["openai", "codex"]) {
    const provider = record(providers[name]);
    if (!provider || provider.baseUrl !== endpoint || !Array.isArray(provider.models)) continue;
    if (provider.models.length === 0 && Object.keys(provider).every((key) => key === "baseUrl" || key === "models")) {
      delete providers[name];
      changed = true;
    } else if (name === "openai" && isGeneratedSolCatalog(provider)) {
      // Provisioning can reinsert baseUrl after Sol has populated the catalog.
      // Keep that catalog, removing only the exact generated endpoint.
      delete provider.baseUrl;
      changed = true;
    }
  }
  return changed;
}
