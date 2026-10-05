import { createManagedRuntimePolicy } from "../managed-runtime/policy.generated.js";
export function ensureNativePiModelCompatibility(config: Record<string, unknown>, subscriptionRoute = false, processEnv: NodeJS.ProcessEnv = process.env): void {
  createManagedRuntimePolicy().ensureSolCompatibility(config, subscriptionRoute, { env: processEnv });
}
