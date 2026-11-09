import { SubscriptionPoolError } from "./openAiSubscriptionPool.js";
export type SubscriptionGuardGateway = { request(method: string, params?: unknown, options?: {timeoutMs?: number}): Promise<unknown> };
/** Live loaded-plugin acknowledgement, not a package-version guess. Never installs
 * plugins or grants conversation access during an authorization operation. */
export async function assertRuntimeSubscriptionGuard(gateway: SubscriptionGuardGateway): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      gateway.request("relay-channel.subscriptionGuard.status", {}, {timeoutMs:3000}),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("guard timeout")),4000);}),
    ]) as {version?:unknown;runScopedFallbacks?:unknown;readOnlyAdmission?:unknown}|null;
    if (status?.version !== 1 || status.runScopedFallbacks !== true || status.readOnlyAdmission !== true) throw new Error("guard absent");
  } catch {
    throw new SubscriptionPoolError("OPENAI_POOL_GUARD_UPDATE_REQUIRED", "Subscription-only rotation requires the loaded Relay channel guard and explicitly provisioned hook access. Update/setup the agent separately; authorization did not install or change plugins.");
  } finally {if(timer)clearTimeout(timer);}
}
