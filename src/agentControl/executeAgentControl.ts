import { readOfflineRuntimeAuth, MANAGED_RUNTIME_SOURCE_SHA256 } from "../managed-runtime/policy.generated.js";
import { managedRuntime, withManagedRuntimePolicy, readManagedRuntimePolicy, runtimeContext, normalizeManagedConfigOnDisk, activeManagedConfigPath } from "../managed-runtime/runtime-policy.js";
import { readModelFence, writeModelFence, withModelFenceLock } from "./modelFence.js";
import { writeOwnerFencedConfig, withOwnerFenceLock, isConfigMutationPath, configRevision, type OwnerFence } from "./ownerFence.js";
import { readOwnerRuntime } from "./ownerRuntime.js";
import { normalizeManagedSubscriptionRoute } from "./managedSubscriptionRoute.js";
import { ensureNativePiModelCompatibility } from "./nativePiModelCompatibility.js";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import JSON5 from "json5";
import {
  type AgentControlAction,
  agentControlResultSchema,
  type AgentControlResult,
} from "./protocol.js";
import {
  exportCodexAuthBundle,
  clearCodexAuth,
  getCodexLoginStatus,
  hasChatGptRouteOverrides,
  hasPersistedChatGptSubscription,
  hasPersistedOpenAiApiKey,
  importCodexAuthBundle,
  setCodexAuthMode,
  startCodexLogin,
  syncCodexAuthBundle,
} from "./codexLogin.js";
import { configureGitHubAuth, getGitHubOauthStatus } from "./githubAuth.js";
import type { ChatRunResult } from "../openclaw/chatRunner.js";
import type { RelayInboundMessageRequest } from "../backend/types.js";
import {
  describeOpenClawActiveRunsPayload,
  readOpenClawActiveRuns,
} from "../agentLifecycle/reconciliation.js";
import { readRuntimeWorkloadSnapshot } from "../agentLifecycle/runtimeWorkload.js";
import { logger } from "../logger.js";

const execFile = promisify(execFileCallback);
const GATEWAY_RESTART_CHECK_ATTEMPTS = 20;
const GATEWAY_RESTART_CHECK_DELAY_MS = 500;
const CHANNELS_STATUS_TIMEOUT_MS = 15_000;
// Cold Codex startup is lazy and may outlast channel status polling.
const CODEX_AUTH_REFRESH_TIMEOUT_MS = 120_000;
// Gateway.request starts its RPC timer only after connecting. Bound cold-start
// readiness too, so a dead Gateway cannot hold the auth transaction forever.
const CODEX_AUTH_READY_AND_REFRESH_TIMEOUT_MS = 240_000;
const VALID_THINKING_DEFAULTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "adaptive"]);
let codexAuthMutationQueue: Promise<void> = Promise.resolve();

type GatewayLike = {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
};

type BackendLike = {
  submitInboundMessage(input: { body: RelayInboundMessageRequest }): Promise<unknown>;
};

type StatusNudgeRunner = {
  runChatTask(input: {
    taskId: string;
    sessionKey: string;
    messageText: string;
    deliverySystem?: "relay_channel_v2";
    timeoutMs: number;
  }): Promise<{ result: ChatRunResult; openclawMeta: Record<string, unknown> }>;
};

type ModelAssignmentPurpose = Extract<AgentControlAction, { kind: "modelAssignment.set" }>["purpose"];
type ModelSetThinkingDefault = Extract<AgentControlAction, { kind: "model.set" }>["thinkingDefault"];
type ModelSetFastMode = Extract<AgentControlAction, { kind: "model.set" }>["fastMode"];
type ModelSetFallbacks = Extract<AgentControlAction, { kind: "model.set" }>["fallbacks"];

export class AgentControlError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentControlError";
    this.code = code;
    this.details = details;
  }
}

function readThinkingDefault(value: unknown): ModelSetThinkingDefault {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return VALID_THINKING_DEFAULTS.has(normalized) ? (normalized as NonNullable<ModelSetThinkingDefault>) : null;
}

function readFastMode(value: unknown): ModelSetFastMode {
  return value === true || value === false || value === "auto" ? value : null;
}

export async function executeAgentControl(input: Parameters<typeof executeAgentControlUnfenced>[0] & { policyAuthority?: "backend" }): Promise<AgentControlResult> {
  if (input.action.managedRuntimePolicy && input.policyAuthority !== "backend") throw new AgentControlError("MANAGED_RUNTIME_POLICY_AUTHORITY_REQUIRED", "Only authenticated backend ingress may change managed harness authority");
  if (input.action.managedRuntimePolicy && !input.action.managedRuntimePolicyDigest) throw new AgentControlError("MANAGED_RUNTIME_POLICY_VERSION_MISMATCH", "Backend policy digest is required");
  // Older backends may attach authority even to pairing inventory. Validate
  // that authority below, but never activate it for a read-only list request.
  const readOnlyPolicy = ["config.read", "managedRuntime.preflight", "channelPairing.list", "devicePairing.list"].includes(input.action.kind);
  // Read config and persisted authority under the same owner lock, including CLI writers.
  const withReadLock = (operation: () => Promise<AgentControlResult>) => readOnlyPolicy || input.action.managedRuntimeExpectedConfigRevision ? withOwnerFenceLock(input.configPath, operation) : operation();
  // All ingress paths and all config writers share this lock, including legacy calls.
  return withModelFenceLock(input.configPath, () => withReadLock(() => withManagedRuntimePolicy(input.configPath, readOnlyPolicy ? undefined : input.action.managedRuntimePolicy, async () => {
    if (input.action.managedRuntimePolicyDigest && input.action.managedRuntimePolicyDigest !== MANAGED_RUNTIME_SOURCE_SHA256) throw new AgentControlError("MANAGED_RUNTIME_POLICY_VERSION_MISMATCH", "Backend and relay policy source digests differ; coordinated release required");
    const policy = await readManagedRuntimePolicy(input.configPath);
    if (input.action.managedRuntimePolicy) {
      // Ingress has already authenticated this agent's relay token. The backend
      // authors the target policy; do not require a second identity env variable.
      managedRuntime.acceptPolicy(policy, input.action.managedRuntimePolicy);
    }
    // Prepared credential/model proof is bound to this exact locked config.
    // Check before any service, environment, credential or policy mutation;
    // hold the same reentrant owner lock through the auth/config transaction.
    if (input.action.managedRuntimeExpectedConfigRevision) {
      const { configText } = await readConfigFile(input.configPath);
      if (configRevision(configText) !== input.action.managedRuntimeExpectedConfigRevision) throw new AgentControlError("CONFIG_CONFLICT", "Configuration changed since managed runtime preflight; prepare the selection again.");
    }
    const context = await runtimeContext(input.configPath);
    const complete = (result: AgentControlResult): AgentControlResult => result.kind === "config.read" ? ({ ...result, managedRuntimePolicyVersion: 2, managedRuntimePolicy: policy, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 }) : result;
    if (input.action.kind === "managedRuntime.preflight") {
      const action = input.action;
      return withOwnerFenceLock(input.configPath, async () => {
        const { config, configText } = await readConfigFile(input.configPath);
        const candidate = structuredClone(config);
        const defaults = ensureRecord(ensureRecord(candidate, "agents"), "defaults");
        if (action.model !== undefined || action.fallbacks !== undefined || action.fallback !== undefined) {
          const key = getPurposeConfigKey(action.purpose ?? "main");
          const previous = defaults[key];
          if (typeof previous === "string") defaults[key] = { primary: previous };
          const assignment = ensureRecord(defaults, key);
          if (action.model !== undefined) assignment.primary = mapStoredModelRef(action.model).modelRef;
          if (action.fallbacks !== undefined && action.fallback !== undefined) throw new AgentControlError("MANAGED_RUNTIME_PREFLIGHT_INVALID", "Specify fallbacks or fallback, not both");
          const fallbacks = action.fallbacks ?? (action.fallback !== undefined ? (action.fallback === null ? [] : [action.fallback]) : undefined);
          if (fallbacks !== undefined) assignment.fallbacks = fallbacks.map(ref => mapStoredModelRef(ref).modelRef);
        }
        const proofContext = { ...context };
        if (action.codexAuthMode === "api_key") {
          const { hasPreparedCodexApiKey } = await import("./codexLogin.js");
          proofContext.apiKeyAuth = await hasPreparedCodexApiKey(input.configPath);
          // Explicit API intent cannot borrow an OAuth credential to pass preflight.
          proofContext.subscriptionAuth = false;
          const assignment = defaults[getPurposeConfigKey(action.purpose ?? "main")];
          const primary = typeof assignment === "string" ? assignment : ensureOptionalRecord(assignment)?.primary;
          if (!proofContext.apiKeyAuth && !(typeof primary === "string" && managedRuntime.hasPreparedApiKey(candidate, primary, proofContext))) {
            throw new AgentControlError("MANAGED_CODEX_INCOMPATIBLE", "Requested API-key authentication has no prepared key value");
          }
        } else if (action.codexAuthMode === "openai_login" && !context.subscriptionAuth) {
          throw new AgentControlError("MANAGED_CODEX_INCOMPATIBLE", "Requested authentication has not been prepared in persisted auth");
        }
        try {
          managedRuntime.normalizeConfig(candidate, action.managedRuntimePolicy ?? policy, proofContext);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("MANAGED_CODEX_INCOMPATIBLE")) throw new AgentControlError("MANAGED_CODEX_INCOMPATIBLE", error.message, undefined, { cause: error });
          throw error;
        }
        return { kind: "managedRuntime.preflight", compatible: true, configRevision: configRevision(configText) };
      });
    }
    const state = await readModelFence(input.configPath);
    const action = input.action;
    if (action.kind === "model.verify" && (state || input.statusNudgeRunner)) {
      if (!input.statusNudgeRunner) throw new AgentControlError("MODEL_VERIFY_UNAVAILABLE", "Inference runner unavailable");
      const { config } = await readConfigFile(input.configPath);
      const defaults = ensureOptionalRecord(ensureOptionalRecord(config.agents)?.defaults);
      const configured = ensureOptionalRecord(defaults?.model);
      if (mapPublicModelRef(typeof configured?.primary === "string" ? configured.primary : null, defaults, managedRuntime.isSubscriptionRoute(config, typeof configured?.primary === "string" ? configured.primary : "", context)) !== action.model || readUnknownArray(configured?.fallbacks).length !== 0) {
        throw new AgentControlError("MODEL_VERIFY_MISMATCH", "Selected config or zero-fallback policy differs");
      }
      // OAuth route identity is independent of the native Pi harness. Never
      // interpret openclaw runtime metadata alone as subscription billing proof.
      if (action.model.startsWith("codex/")) {
        const auth = await getCodexLoginStatus(input.configPath);
        const providers = ensureOptionalRecord(ensureOptionalRecord(config.models)?.providers);
        const provider = ensureOptionalRecord(providers?.openai);
        const modelRow = readUnknownArray(provider?.models).map(ensureOptionalRecord).find(row => row?.id === action.model.slice("codex/".length));
        const effectiveApi = modelRow?.api ?? provider?.api;
        const environment = ensureOptionalRecord(config.env);
        const environmentVars = ensureOptionalRecord(environment?.vars);
        const hasEnvironmentRoute = [environment, environmentVars, process.env].some(env =>
          env && ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"].some(key => env[key] !== undefined));
        if ((effectiveApi !== undefined && effectiveApi !== "openai-chatgpt-responses") || hasEnvironmentRoute || auth.state !== "connected" || !auth.authModes?.openaiLogin.active ||
            !await hasPersistedChatGptSubscription(input.configPath) ||
            await hasPersistedOpenAiApiKey(input.configPath) ||
            await hasChatGptRouteOverrides(input.configPath)) {
          throw new AgentControlError("MODEL_VERIFY_MISMATCH", "Native subscription route is not active");
        }
      }
      const sessionKey = "agent:main:enterprise-model-verify:" + randomUUID();
      type ProbeResponse = { resolved?: { modelProvider?: string; model?: string; agentRuntime?: unknown }; entry?: { modelProvider?: string; model?: string; agentHarnessId?: string } };
      const identity = (provider?: string, model?: string, runtime?: unknown) => {
        const ref = provider && model ? provider + "/" + model : null;
        // sessions.patch returns selected runtime metadata { id, source }, not
        // a runtime string. Missing/malformed metadata must remain fail-closed.
        const runtimeId = ensureOptionalRecord(runtime)?.id;
        if (ref && runtimeId !== managedRuntime.expectedRuntime(config, ref, "main", policy, context)) return null;
        return mapPublicModelRef(ref, defaults, Boolean(ref && managedRuntime.isSubscriptionRoute(config, ref, context)));
      };
      let completed = false;
      try {
        // Do not override model: prove current runtime defaults and actual runtime identity.
        const before = await input.gateway.request("sessions.patch", { key: sessionKey }, { timeoutMs: 15_000 }) as ProbeResponse;
        if (identity(before.resolved?.modelProvider, before.resolved?.model, before.resolved?.agentRuntime) !== action.model) {
          throw new AgentControlError("MODEL_VERIFY_MISMATCH", "Runtime default model differs from selected model");
        }
        const { result } = await input.statusNudgeRunner.runChatTask({
          taskId: "enterprise_model_verify_" + randomUUID(), sessionKey,
          messageText: "Reply with OK only. This is a model connectivity check. Do not use tools.",
          deliverySystem: "relay_channel_v2", timeoutMs: 120_000,
        });
        if (result.outcome !== "reply") throw new AgentControlError("MODEL_VERIFY_FAILED", "Selected runtime model did not return a reply");
        // Session usage records the provider/model actually used, including fallback drift.
        const after = await input.gateway.request("sessions.patch", { key: sessionKey }, { timeoutMs: 15_000 }) as ProbeResponse;
        if (identity(after.entry?.modelProvider, after.entry?.model, after.resolved?.agentRuntime) !== action.model || (after.entry?.agentHarnessId !== managedRuntime.expectedRuntime(config, action.model.replace(/^(?:codex|openai-codex)\//, "openai/"), "main", policy, context))) {
          throw new AgentControlError("MODEL_VERIFY_MISMATCH", "Inference used another provider/model or runtime");
        }
        completed = true;
        return complete({ kind: "model.verify", model: action.model, verified: true });
      } finally {
        try {
          if (!completed) await input.gateway.request("chat.abort", { sessionKey }, { timeoutMs: 15_000 });
        } finally {
          await input.gateway.request("sessions.delete", { key: sessionKey, deleteTranscript: true }, { timeoutMs: 15_000 });
        }
      }
    }
    if (action.kind === "model.fence.read") return complete({
      kind: "model.fence.read", revision: state?.revision ?? null,
      status: state?.status ?? null, model: state?.model ?? null,
    });
    if (action.kind === "model.fence.reconcile") {
      if (state?.revision === action.revision) {
        // Lock acquisition proves no mutable handler remains alive. This is NOT success.
        const status = state.status === "CANCELLED" ? "CANCELLED" as const : "UNRESOLVED" as const;
        await writeModelFence(input.configPath, { ...state, status });
        return complete({ kind: "model.fence.reconcile", revision: state.revision, status, model: state.model });
      }
      if ((state?.revision ?? null) !== action.predecessor || state?.status === "PENDING") {
        throw new AgentControlError("MODEL_FENCE_STALE", "Fence revision changed");
      }
      // Tombstone even an undelivered operation BEFORE allowing any subsequent revision.
      await writeModelFence(input.configPath, { revision: action.revision, predecessor: action.predecessor, model: action.model, status: "CANCELLED" });
      return complete({ kind: "model.fence.reconcile", revision: action.revision, status: "CANCELLED", model: action.model });
    }
    if (action.kind === "model.set" && action.fence) {
      const fence = action.fence;
      if (state?.revision === fence.revision || (state?.revision ?? null) !== fence.predecessor || state?.status === "PENDING") {
        throw new AgentControlError("MODEL_FENCE_STALE", "Reconcile the existing operation before activation");
      }
      // Reject an incompatible choice before even persisting fenced intent.
      const { config: source } = await readConfigFile(input.configPath);
      const candidate = structuredClone(source);
      const candidateDefaults = ensureRecord(ensureRecord(candidate, "agents"), "defaults");
      const selected = mapStoredModelRef(action.model);
      const fallbacks = action.fallbacks.map(mapStoredModelRef);
      ensureRecord(candidateDefaults, "model").primary = selected.modelRef;
      ensureRecord(candidateDefaults, "model").fallbacks = fallbacks.map(row => row.modelRef);
      ensureModelRegistryEntry(candidateDefaults, selected.modelRef);
      for (const fallback of fallbacks) ensureModelRegistryEntry(candidateDefaults, fallback.modelRef);
      applyModelFastMode(candidateDefaults, selected.modelRef, action.fastMode);
      await applyNativePiModelCompatibility(candidate, input.configPath, [action.model, ...action.fallbacks]);
      managedRuntime.normalizeConfig(candidate, policy, context);
      const pending = { ...fence, status: "PENDING" as const, model: action.model };
      await writeModelFence(input.configPath, pending);
      try {
        const result = await executeAgentControlUnfenced(input);
        await writeModelFence(input.configPath, { ...pending, status: "APPLIED" });
        return complete(result);
      } catch (error) {
        await writeModelFence(input.configPath, { ...pending, status: "UNRESOLVED" });
        throw error;
      }
    }
    if (state && action.kind === "config.apply") {
      const { config } = await readConfigFile(input.configPath);
      const candidate: unknown = JSON5.parse(action.configText);
      // Backend Sync supplies a normalized candidate. Normalize a clone with the
      // same locked target policy/auth context; never rewrite the live predecessor.
      const normalizedSource = structuredClone(config);
      managedRuntime.normalizeConfig(normalizedSource, policy, context);
      const sourceRoute = managedRuntime.protectedRoute(normalizedSource) as Record<string, unknown>;
      const candidateRoute = managedRuntime.protectedRoute(candidate as Record<string, unknown>) as Record<string, unknown>;
      for (const projection of [sourceRoute, candidateRoute]) {
        const defaults = ensureOptionalRecord(ensureOptionalRecord(projection.agents)?.defaults);
        const compaction = ensureOptionalRecord(defaults?.compaction);
        // Maintenance byte budget is not model/auth/transport intent. Every
        // other compaction leaf remains fenced, including model and provider.
        if (compaction && Object.hasOwn(compaction, "maxActiveTranscriptBytes")) {
          delete compaction.maxActiveTranscriptBytes;
          if (!Object.keys(compaction).length) delete defaults!.compaction;
        }
      }
      if (!action.expectedRevision || !isDeepStrictEqual(sourceRoute, candidateRoute)) {
        throw new AgentControlError("MODEL_FENCE_REQUIRED", "Fenced configuration requires CAS and unchanged model routing");
      }
      try { managedRuntime.assertRuntimeMetadata(candidate as Record<string, unknown>, policy, context); }
      catch (error) { throw new AgentControlError("MODEL_FENCE_REQUIRED", "Configuration runtime metadata differs from authoritative managed policy", undefined, { cause: error }); }
      return complete(await executeAgentControlUnfenced(input));
    }
    if (state && ["model.set", "modelAssignment.set"].includes(action.kind)) {
      throw new AgentControlError("MODEL_FENCE_REQUIRED", "Legacy configuration mutations cannot bypass an established model fence");
    }
    return complete(await executeAgentControlUnfenced(input));
  })));
}

async function executeAgentControlUnfenced(input: {
  action: AgentControlAction;
  configPath: string;
  gateway: GatewayLike;
  backend?: BackendLike;
  relayInstanceId?: string;
  backendMessageId?: string;
  statusNudgeRunner?: StatusNudgeRunner;
}): Promise<AgentControlResult> {
  const operation = async () => {
  const result =
    input.action.kind === "config.read"
      ? await readConfig(input.configPath, input.gateway, input.action.includeRuntimeAuthContext)
      : input.action.kind === "channels.status"
        ? await readChannelsStatus(input.gateway)
      : input.action.kind === "lifecycle.activeRuns"
        ? await readLifecycleActiveRuns(input.gateway, {
            backendMessageId: input.backendMessageId,
            relayInstanceId: input.relayInstanceId,
          })
      : input.action.kind === "config.apply"
        ? await applyConfig({
            configPath: input.configPath,
            configText: input.action.configText,
            ownerFence: input.action.ownerFence,
            expectedRevision: input.action.expectedRevision,
          })
      : input.action.kind === "config.validate"
        ? await validateConfig(input.configPath)
      : input.action.kind === "gateway.restart"
        ? await restartGatewayService()
        : input.action.kind === "relay.selfNudge.set"
          ? await setRelaySelfNudgeSettings({
              configPath: input.configPath,
              settings: input.action.settings,
            })
      : input.action.kind === "devicePairing.list"
        ? await listDevicePairing(input.gateway)
            : input.action.kind === "devicePairing.approve"
              ? await approveDevicePairing(input.gateway, input.action.requestId)
            : input.action.kind === "channelPairing.list"
              ? await listChannelPairing(input.configPath, input.action.channel, input.action.accountId)
              : input.action.kind === "channelPairing.approve"
                ? await approveChannelPairing(input.configPath, input.action.channel, input.action.code, input.action.accountId)
              : input.action.kind === "whatsapp.login.start"
                ? await startWhatsAppLogin(input.gateway, input.action)
              : input.action.kind === "whatsapp.login.wait"
                ? await waitForWhatsAppLogin(input.gateway, input.action)
              : input.action.kind === "codex.login.start"
                ? await startCodexLogin(
                    input.configPath,
                    { forceRelink: input.action.forceRelink },
                    (operation) => runCodexAuthMutationWithGatewayPaused(() => withOwnerFenceLock(input.configPath, () => withCleanOpenAiGatewayEnvironment(operation))),
                  )
              : input.action.kind === "codex.login.status"
                ? await getCodexLoginStatus(input.configPath)
              : input.action.kind === "model.verify"
                ? await verifyConfiguredModel(input.configPath, input.action.model)
              : input.action.kind === "codex.auth.set"
                ? await setCodexAuthWithGatewayPaused(input.configPath, input.action)
              : input.action.kind === "codex.auth.export"
                ? await exportCodexAuthBundle(input.configPath)
              : input.action.kind === "codex.auth.import"
                ? await importCodexAuthWithGatewayPaused(input.configPath, input.action)
              : input.action.kind === "codex.auth.sync"
                ? await syncCodexAuthWithoutGatewayRestart(
                    input.configPath,
                    input.action,
                    input.gateway,
                  )
              : input.action.kind === "codex.auth.clear"
                ? await runCodexAuthMutationWithGatewayPaused(() => withOwnerFenceLock(input.configPath, () => clearCodexAuth(input.configPath)))
              : input.action.kind === "github.auth.configure"
                ? await configureGitHubAuth(input.action)
              : input.action.kind === "github.oauth.status"
                ? await getGitHubOauthStatus(input.action)
              : input.action.kind === "chat.statusNudge"
                ? await sendStatusNudge({
                    action: input.action,
                    backend: input.backend,
                    relayInstanceId: input.relayInstanceId,
                    backendMessageId: input.backendMessageId,
                    runner: input.statusNudgeRunner,
                  })
              : input.action.kind === "modelAssignments.read"
                ? await readModelAssignments(input.configPath)
              : input.action.kind === "modelAssignment.set"
                ? await setModelAssignment({
                    configPath: input.configPath,
                    purpose: input.action.purpose,
                    primary: input.action.primary,
                    fallback: input.action.fallback,
                    contextTokens: input.action.contextTokens ?? null,
                    thinkingDefault: input.action.thinkingDefault,
                    fastMode: input.action.fastMode,
                  })
                : input.action.kind === "chat.abortTask"
                  ? (() => {
                      throw new AgentControlError(
                        "CHAT_ABORT_TASK_UNSUPPORTED",
                        "chat.abortTask must be handled by relay ingress"
                      );
                    })()
                : input.action.kind === "cron.inventory.refresh"
                  ? (() => {
                      throw new AgentControlError(
                        "CRON_INVENTORY_REFRESH_UNSUPPORTED",
                        "cron.inventory.refresh must be handled by relay ingress"
                      );
                    })()
                : input.action.kind === "model.set" ? await setModel({
                    configPath: input.configPath,
                    model: input.action.model,
                    fallbacks: input.action.fallbacks,
                    contextTokens: input.action.contextTokens ?? null,
                    thinkingDefault: input.action.thinkingDefault,
                    fastMode: input.action.fastMode,
                  }) : (() => { throw new AgentControlError("MODEL_FENCE_INTERNAL", "Fence action must use central handler"); })();
  if (["codex.auth.sync", "codex.auth.import", "codex.auth.set", "codex.auth.clear"].includes(input.action.kind)) {
    if (await normalizeManagedConfigOnDisk(input.configPath)) await restartGatewayService();
  }
  return agentControlResultSchema.parse(result);
  };
  // Do not serialize unrelated chat, pairing, lifecycle or login waits behind
  // config delivery. Only config-bearing read/modify/write operations share it.
  const configActions = new Set(["config.read", "config.apply", "model.set", "modelAssignment.set", "relay.selfNudge.set"]);
  return configActions.has(input.action.kind) ? withOwnerFenceLock(input.configPath, operation) : operation();
}

async function readLifecycleActiveRuns(
  gateway: GatewayLike,
  context: {
    backendMessageId?: string;
    relayInstanceId?: string;
  },
): Promise<AgentControlResult> {
  const startedAt = Date.now();
  let payload: unknown;
  try {
    payload = await gateway.request(
      "sessions.list",
      { agentId: "main", limit: 200 },
      { timeoutMs: 5_000 },
    );
  } catch (error) {
    logger.warn(
      {
        event: "lifecycle_active_runs_observation_failed",
        backendMessageId: context.backendMessageId ?? null,
        relayInstanceId: context.relayInstanceId ?? null,
        gatewayMethod: "sessions.list",
        gatewayParams: { agentId: "main", limit: 200 },
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to read live OpenClaw sessions for hibernation safety",
    );
    throw error;
  }
  const runs = readOpenClawActiveRuns(payload);
  const runtimeWorkload = await readRuntimeWorkloadSnapshot();
  logger.info(
    {
      event: "lifecycle_active_runs_observed",
      backendMessageId: context.backendMessageId ?? null,
      relayInstanceId: context.relayInstanceId ?? null,
      gatewayMethod: "sessions.list",
      gatewayParams: { agentId: "main", limit: 200 },
      elapsedMs: Date.now() - startedAt,
      observation: describeOpenClawActiveRunsPayload(payload),
      reportedRuns: runs,
      runtimeWorkload,
    },
    "Observed live OpenClaw sessions for hibernation safety",
  );
  return {
    kind: "lifecycle.activeRuns",
    observedAt: new Date().toISOString(),
    runs,
    runtimeWorkload,
  };
}

function getChatRunResultRunId(result: ChatRunResult): string | null {
  if (result.outcome === "reply") return result.reply.runId;
  if (result.outcome === "no_reply") return result.noReply?.runId ?? null;
  return result.error.runId ?? null;
}

function buildStatusNudgeOpenclawMeta(input: {
  openclawMeta: Record<string, unknown>;
  backendMessageId: string;
  relayMessageId: string;
  relayInstanceId: string;
  runId: string | null;
  sessionKey: string;
  sourceBackendMessageId: string;
}): Record<string, unknown> {
  const base = isRecord(input.openclawMeta) ? input.openclawMeta : {};
  return {
    ...base,
    method: normalizeOptionalString(base.method) ?? "chat.status_nudge",
    runId: input.runId ?? normalizeOptionalString(base.runId) ?? undefined,
    sessionKey: input.sessionKey,
    deliverySystem: "relay_channel_v2",
    statusNudge: {
      sourceBackendMessageId: input.sourceBackendMessageId,
    },
    trace: {
      backendMessageId: input.backendMessageId,
      relayMessageId: input.relayMessageId,
      relayInstanceId: input.relayInstanceId,
      ...(input.runId ? { openclawRunId: input.runId } : {}),
    },
  };
}

async function sendStatusNudge(input: {
  action: Extract<AgentControlAction, { kind: "chat.statusNudge" }>;
  backend?: BackendLike;
  relayInstanceId?: string;
  backendMessageId?: string;
  runner?: StatusNudgeRunner;
}): Promise<Extract<AgentControlResult, { kind: "chat.statusNudge" }>> {
  if (!input.runner || !input.backend || !input.relayInstanceId || !input.backendMessageId) {
    throw new AgentControlError("STATUS_NUDGE_UNAVAILABLE", "Status nudge runtime is not available.");
  }
  const timeoutMs = input.action.timeoutMs ?? 30_000;
  const { result, openclawMeta } = await input.runner.runChatTask({
    taskId: input.backendMessageId,
    sessionKey: input.action.sessionKey,
    messageText: input.action.messageText,
    deliverySystem: "relay_channel_v2",
    timeoutMs,
  });
  const runId = getChatRunResultRunId(result);
  if (result.outcome === "reply") {
    const relayMessageId = `relay_status_nudge_${randomUUID()}`;
    await input.backend.submitInboundMessage({
      body: {
        relayInstanceId: input.relayInstanceId,
        relayMessageId,
        finishedAtMs: Date.now(),
        outcome: "reply",
        reply: result.reply,
        openclawMeta: buildStatusNudgeOpenclawMeta({
          openclawMeta,
          backendMessageId: input.backendMessageId,
          relayMessageId,
          relayInstanceId: input.relayInstanceId,
          runId,
          sessionKey: input.action.sessionKey,
          sourceBackendMessageId: input.action.sourceBackendMessageId,
        }),
      },
    });
  }
  return { kind: "chat.statusNudge", accepted: true, runId };
}

async function readConfig(configPath: string, gateway: GatewayLike, includeRuntimeAuthContext = false): Promise<AgentControlResult> {
  const { configText, config } = await readConfigFile(configPath);
  const auth = includeRuntimeAuthContext ? readOfflineRuntimeAuth(configPath) : undefined;
  return {
    kind: "config.read",
    ...(auth ? { runtimeAuthContext: { version: 1 as const, subscriptionAuth: Boolean(auth.subscriptionAuth), apiKeyAuth: Boolean(auth.apiKeyAuth) } } : {}),
    configRevision: configRevision(configText),
    ownerFenceVersion: 1,
    ownerRuntime: await readOwnerRuntime(configPath, gateway),
    configText,
    config,
  };
}

async function readChannelsStatus(gateway: GatewayLike): Promise<AgentControlResult> {
  try {
    const snapshot = await gateway.request("channels.status", {
      probe: false,
      timeoutMs: 10_000,
    }, {
      timeoutMs: CHANNELS_STATUS_TIMEOUT_MS,
    });
    if (!isRecord(snapshot)) {
      throw new AgentControlError("CHANNELS_STATUS_BAD_RESPONSE", "OpenClaw channels.status response was not an object.", {
        response: snapshot,
      });
    }
    return {
      kind: "channels.status",
      snapshot,
    };
  } catch (error) {
    if (error instanceof AgentControlError) {
      throw error;
    }
    const details =
      error && typeof error === "object"
        ? {
            code: typeof (error as { code?: unknown }).code === "string"
              ? (error as { code?: string }).code
              : null,
            message: error instanceof Error ? error.message : "Non-Error object thrown",
          }
        : { code: null, message: String(error) };
    throw new AgentControlError(
      "CHANNELS_STATUS_FAILED",
      "Failed to read OpenClaw channel runtime status.",
      details,
      { cause: error }
    );
  }
}

async function applyConfig(input: {
  configPath: string;
  configText: string;
  ownerFence?: OwnerFence;
  expectedRevision?: string;
}): Promise<AgentControlResult> {
  const parsed = parseConfigText(input.configText);
  const defaults = ensureOptionalRecord(ensureOptionalRecord(parsed.agents)?.defaults);
  const requestedModels = ["model", "imageModel", "imageGenerationModel", "videoGenerationModel", "musicGenerationModel", "pdfModel"]
    .flatMap((key) => {
      const value = defaults?.[key];
      if (typeof value === "string") return [value];
      const assignment = ensureOptionalRecord(value);
      return [assignment?.primary, ...readUnknownArray(assignment?.fallbacks)]
        .filter((ref): ref is string => typeof ref === "string");
    });
  await applyNativePiModelCompatibility(parsed, input.configPath, requestedModels);
  const committedRevision = await writeOwnerFencedConfig(input.configPath, JSON.stringify(parsed, null, 2) + "\n", input.ownerFence, { expectedRevision: input.expectedRevision });
  return {
    kind: "config.apply",
    applied: true,
    committedRevision,
    committedConfigText: await fs.readFile(input.configPath, "utf8"),
  };
}

function boundedCommandOutput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 2_000)}...[truncated]`;
}

async function validateConfig(configPath: string): Promise<Extract<AgentControlResult, { kind: "config.validate" }>> {
  await readConfigFile(configPath);
  try {
    await execFile("openclaw", ["config", "validate", "--json"], {
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
        OPENCLAW_CONFIG_PATH: configPath,
      },
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const output = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    throw new AgentControlError(
      "OPENCLAW_CONFIG_VALIDATE_FAILED",
      "OpenClaw config validation failed.",
      {
        exitCode: typeof output.code === "number" || typeof output.code === "string" ? output.code : null,
        stdout: boundedCommandOutput(output.stdout),
        stderr: boundedCommandOutput(output.stderr),
        message: typeof output.message === "string" ? output.message : null,
      },
      { cause: error },
    );
  }
  return { kind: "config.validate", valid: true };
}

async function setRelaySelfNudgeSettings(input: {
  configPath: string;
  settings: {
    enabled: boolean;
    analyzedRecentMessageCount: number;
    baseTimeoutMs: number;
    model: string | null;
    debugMessagesEnabled?: boolean;
  };
}): Promise<AgentControlResult> {
  const { settings } = input;
  const envPath = resolveRelayEnvPath();
  const current = await fs.readFile(envPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return "";
    throw error;
  });
  const next = updateDotenv(current, {
    RELAY_SELF_NUDGE_ENABLED: settings.enabled ? "1" : "0",
    RELAY_SELF_NUDGE_ANALYZED_RECENT_MESSAGE_COUNT: String(settings.analyzedRecentMessageCount),
    RELAY_SELF_NUDGE_BASE_TIMEOUT_MS: String(settings.baseTimeoutMs),
    RELAY_SELF_NUDGE_MODEL: settings.model,
    DEBUG_NUDGE: settings.debugMessagesEnabled ? "1" : "0",
  });
  await atomicWriteUtf8(envPath, next);
  await removeLegacySelfNudgeFromOpenclawConfig(input.configPath);
  scheduleRelayRestart();
  return {
    kind: "relay.selfNudge.set",
    applied: true,
    restartScheduled: true,
  };
}

async function removeLegacySelfNudgeFromOpenclawConfig(configPath: string): Promise<void> {
  const raw = await fs.readFile(configPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return "";
    throw error;
  });
  if (!raw.trim()) return;
  const parsed = parseConfigText(raw);
  let changed = false;
  if (isRecord(parsed.golemWorkers) && "selfNudge" in parsed.golemWorkers) {
    delete parsed.golemWorkers.selfNudge;
    if (Object.keys(parsed.golemWorkers).length === 0) {
      delete parsed.golemWorkers;
    }
    changed = true;
  }
  const relayChannel = isRecord(parsed.channels) && isRecord(parsed.channels["relay-channel"])
    ? parsed.channels["relay-channel"]
    : null;
  if (relayChannel && "nudge" in relayChannel) {
    delete relayChannel.nudge;
    changed = true;
  }
  if (changed) {
    await atomicWriteUtf8(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  }
}

async function listDevicePairing(gateway: GatewayLike): Promise<AgentControlResult> {
  const payload = await gateway.request("device.pair.list", {});
  const pending = readUnknownArray((payload as { pending?: unknown })?.pending);
  const paired = readUnknownArray((payload as { paired?: unknown })?.paired);
  return {
    kind: "devicePairing.list",
    pending,
    paired,
  };
}

async function approveDevicePairing(gateway: GatewayLike, requestId: string): Promise<AgentControlResult> {
  const payload = await gateway.request("device.pair.approve", { requestId });
  return {
    kind: "devicePairing.approve",
    approved: true,
    payload,
  };
}

async function startWhatsAppLogin(
  gateway: GatewayLike,
  input: Extract<AgentControlAction, { kind: "whatsapp.login.start" }>
): Promise<AgentControlResult> {
  const requestTimeoutMs = Math.max((input.timeoutMs ?? 120_000) + 5_000, 30_000);
  const payload = await gateway.request("web.login.start", {
    force: input.forceRelink === true,
    timeoutMs: input.timeoutMs,
  }, {
    timeoutMs: requestTimeoutMs,
  }) as { qrDataUrl?: unknown; message?: unknown };
  const qrDataUrl =
    typeof payload?.qrDataUrl === "string" && payload.qrDataUrl.trim().length > 0
      ? payload.qrDataUrl
      : null;
  const message =
    typeof payload?.message === "string" && payload.message.trim().length > 0
      ? payload.message
      : (qrDataUrl ? "Scan the QR in WhatsApp → Linked Devices." : "WhatsApp login started.");
  return {
    kind: "whatsapp.login.start",
    qrDataUrl,
    message,
  };
}

async function waitForWhatsAppLogin(
  gateway: GatewayLike,
  input: Extract<AgentControlAction, { kind: "whatsapp.login.wait" }>
): Promise<AgentControlResult> {
  const payload = await gateway.request("web.login.wait", {
    timeoutMs: input.timeoutMs,
  }) as { connected?: unknown; message?: unknown };
  return {
    kind: "whatsapp.login.wait",
    connected: payload?.connected === true,
    message:
      typeof payload?.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : "WhatsApp login status updated.",
  };
}

type ChannelPairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt?: string;
  meta?: Record<string, unknown>;
};

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// OpenClaw owns pairing storage, expiry, account scoping and atomic approval.
// Do not read/write credentials JSON: newer runtimes store this state in SQLite.
async function runPairingCli(configPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("openclaw", ["pairing", ...args], {
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    // Child-process errors contain argv (including the approval code) and output.
    throw new AgentControlError("CHANNEL_PAIRING_COMMAND_FAILED", "OpenClaw pairing command failed");
  }
}

async function readChannelPairingRequests(
  configPath: string,
  channel: string,
  accountId?: string,
): Promise<ChannelPairingRequest[]> {
  const account = normalizeOptionalString(accountId);
  const stdout = await runPairingCli(configPath, [
    "list", "--channel", channel, "--json", ...(account ? ["--account", account] : []),
  ]);
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new AgentControlError("CHANNEL_PAIRING_INVALID_RESPONSE", "Invalid OpenClaw pairing response");
  }
  if (!isRecord(payload) || payload.channel !== channel || !Array.isArray(payload.requests)) {
    throw new AgentControlError("CHANNEL_PAIRING_INVALID_RESPONSE", "Invalid OpenClaw pairing response");
  }
  return payload.requests.map((entry: unknown) => {
    if (!isRecord(entry) || !normalizeOptionalString(entry.id) ||
        !normalizeOptionalString(entry.code) || !normalizeOptionalString(entry.createdAt) ||
        !Number.isFinite(Date.parse(String(entry.createdAt))) ||
        (account && (!isRecord(entry.meta) || entry.meta.accountId !== account))) {
      throw new AgentControlError("CHANNEL_PAIRING_INVALID_RESPONSE", "Invalid OpenClaw pairing request");
    }
    return {
      id: String(entry.id),
      code: String(entry.code).trim().toUpperCase(),
      createdAt: String(entry.createdAt),
      ...(normalizeOptionalString(entry.lastSeenAt) ? { lastSeenAt: String(entry.lastSeenAt) } : {}),
      ...(isRecord(entry.meta) ? { meta: entry.meta } : {}),
    };
  });
}

async function listChannelPairing(configPath: string, channel: string, accountId?: string): Promise<AgentControlResult> {
  return {
    kind: "channelPairing.list",
    requests: await readChannelPairingRequests(configPath, channel, accountId),
  };
}

async function approveChannelPairing(
  configPath: string,
  channel: string,
  code: string,
  accountId?: string,
): Promise<AgentControlResult> {
  const normalizedCode = normalizeOptionalString(code)?.toUpperCase() ?? "";
  if (!normalizedCode) {
    throw new AgentControlError("CHANNEL_PAIRING_INVALID_CODE", "Invalid pairing code");
  }
  const requests = await readChannelPairingRequests(configPath, channel, accountId);
  const approved = requests.find((entry) => entry.code === normalizedCode);
  if (!approved) {
    throw new AgentControlError("CHANNEL_PAIRING_UNKNOWN_CODE", "Unknown or expired pairing code");
  }
  const account = normalizeOptionalString(accountId) ?? normalizeOptionalString(approved.meta?.accountId);
  // Revalidation and the actual mutation are atomic in the installed runtime.
  await runPairingCli(configPath, [
    "approve", "--channel", channel, ...(account ? ["--account", account] : []), normalizedCode,
  ]);
  return {
    kind: "channelPairing.approve",
    approved: true,
    payload: { id: approved.id, code: approved.code, entry: approved },
  };
}

async function applyNativePiModelCompatibility(
  config: Record<string, unknown>,
  configPath: string,
  requestedModels: string[],
): Promise<void> {
  const requestsOpenAi = requestedModels.some((ref) => /^(?:openai|codex|openai-codex)\//i.test(ref.trim()));
  const defaults = ensureOptionalRecord(ensureOptionalRecord(config.agents)?.defaults);
  const hasSol = Boolean(ensureOptionalRecord(ensureOptionalRecord(defaults?.models)?.["openai/gpt-6.1-sol"]));
  const hasSubscription = (requestsOpenAi || hasSol) && await hasPersistedChatGptSubscription(configPath);
  if (requestsOpenAi && hasSubscription && !await hasPersistedOpenAiApiKey(configPath)) {
    normalizeManagedSubscriptionRoute(config, true);
  }
  if (!hasSol) return;
  // Only a Sol subscription alias is evidence about Sol's route. A Codex
  // fallback for another model must not change its transport.
  const subscriptionRoute = requestedModels.some((ref) => /^(?:codex|openai-codex)\/gpt-6\.1-sol$/i.test(ref.trim()))
    || hasSubscription;
  ensureNativePiModelCompatibility(config, subscriptionRoute);
}

async function setModel(input: {
  configPath: string;
  model: string;
  fallbacks: ModelSetFallbacks;
  contextTokens: number | null;
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "adaptive" | null;
  fastMode?: boolean | "auto" | null;
}): Promise<AgentControlResult> {
  const fallbacks = input.fallbacks
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  const { config } = await readConfigFile(input.configPath);
  const nextConfig = structuredClone(config);
  const agentsCfg = ensureRecord(nextConfig, "agents");
  const defaultsCfg = ensureRecord(agentsCfg, "defaults");
  const modelCfg = ensureRecord(defaultsCfg, "model");
  const storedPrimaryModel = mapStoredModelRef(input.model);
  const storedFallbacks = fallbacks.map(mapStoredModelRef);
  modelCfg.primary = storedPrimaryModel.modelRef;
  modelCfg.fallbacks = storedFallbacks.map((fallback) => fallback.modelRef);
  ensureModelRegistryEntry(defaultsCfg, storedPrimaryModel.modelRef, storedPrimaryModel.agentRuntimeId);
  ensureAllowedModelEntry(defaultsCfg, storedPrimaryModel.modelRef);
  for (const fallbackModel of storedFallbacks) {
    ensureModelRegistryEntry(defaultsCfg, fallbackModel.modelRef, fallbackModel.agentRuntimeId);
    ensureAllowedModelEntry(defaultsCfg, fallbackModel.modelRef);
  }
  applyModelFastMode(defaultsCfg, storedPrimaryModel.modelRef, input.fastMode);
  if (typeof input.contextTokens === "number" && Number.isFinite(input.contextTokens) && input.contextTokens > 0) {
    defaultsCfg.contextTokens = Math.floor(input.contextTokens);
  }
  if (typeof input.thinkingDefault === "string" && input.thinkingDefault.trim()) {
    defaultsCfg.thinkingDefault = input.thinkingDefault;
  } else if (input.thinkingDefault === null) {
    delete defaultsCfg.thinkingDefault;
  }
  await applyNativePiModelCompatibility(nextConfig, input.configPath, [input.model, ...fallbacks]);
  await atomicWriteUtf8(input.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  const restart = await restartGatewayService();
  return {
    kind: "model.set",
    applied: true,
    restarted: true,
    model: input.model,
    fallbacks,
    contextTokens: input.contextTokens,
    thinkingDefault: readThinkingDefault(defaultsCfg.thinkingDefault),
    fastMode: readModelFastMode(defaultsCfg, storedPrimaryModel.modelRef),
    activeState: restart.activeState,
    subState: restart.subState,
    result: restart.result,
  };
}

function getPurposeConfigKey(purpose: ModelAssignmentPurpose): string {
  switch (purpose) {
    case "main":
      return "model";
    case "image":
      return "imageModel";
    case "imageGeneration":
      return "imageGenerationModel";
    case "videoGeneration":
      return "videoGenerationModel";
    case "musicGeneration":
      return "musicGenerationModel";
    case "pdf":
      return "pdfModel";
  }
}

function mapStoredModelRef(modelRef: string): { modelRef: string; agentRuntimeId: string | null } {
  const trimmed = modelRef.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("openai-codex/")) {
    return {
      modelRef: `openai/${trimmed.slice("openai-codex/".length)}`,
      agentRuntimeId: null,
    };
  }
  if (lower.startsWith("codex/")) {
    return {
      modelRef: `openai/${trimmed.slice("codex/".length)}`,
      agentRuntimeId: null,
    };
  }
  return { modelRef: trimmed, agentRuntimeId: null };
}

function mapPublicModelRef(
  modelRef: string | null | undefined,
  defaultsCfg?: Record<string, unknown> | null,
  subscriptionPurpose = false,
): string | null {
  const trimmed = String(modelRef ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith("openai-codex/")) {
    return `codex/${trimmed.slice("openai-codex/".length)}`;
  }
  void defaultsCfg;
  if (subscriptionPurpose && trimmed.toLowerCase().startsWith("openai/")) {
    return `codex/${trimmed.slice("openai/".length)}`;
  }
  return trimmed;
}

function ensureModelRegistryEntry(
  defaultsCfg: Record<string, unknown>,
  modelRef: string | null,
  agentRuntimeId?: string | null,
): void {
  const trimmed = String(modelRef ?? "").trim();
  if (!trimmed) return;
  const modelsCfg = ensureRecord(defaultsCfg, "models");
  const existingModel = modelsCfg[trimmed];
  const nextModel = isRecord(existingModel) ? existingModel : {};
  void agentRuntimeId; // Runtime metadata is written only by the common managed-policy boundary.
  modelsCfg[trimmed] = nextModel;
}

function ensureAllowedModelEntry(defaultsCfg: Record<string, unknown>, modelRef: string | null): void {
  const trimmed = String(modelRef ?? "").trim();
  if (!trimmed) return;
  const modelPolicy = ensureOptionalRecord(defaultsCfg.modelPolicy);
  const allow = readUnknownArray(modelPolicy?.allow)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  // A missing or empty allow-list already permits every model. Preserve that
  // semantic instead of turning a model change into a new restriction.
  if (!modelPolicy || allow.length === 0 || allow.includes(trimmed)) return;
  modelPolicy.allow = [...allow, trimmed];
}

function readModelFastMode(defaultsCfg: Record<string, unknown>, modelRef: string | null): ModelSetFastMode {
  const trimmed = String(modelRef ?? "").trim();
  if (!trimmed) return null;
  const modelsCfg = ensureOptionalRecord(defaultsCfg.models);
  const modelCfg = ensureOptionalRecord(modelsCfg?.[trimmed]);
  const paramsCfg = ensureOptionalRecord(modelCfg?.params);
  return readFastMode(paramsCfg?.fastMode ?? paramsCfg?.fast_mode);
}

function applyModelFastMode(
  defaultsCfg: Record<string, unknown>,
  modelRef: string | null,
  fastMode: boolean | "auto" | null | undefined,
): void {
  const trimmed = String(modelRef ?? "").trim();
  if (!trimmed || fastMode === undefined) return;
  ensureModelRegistryEntry(defaultsCfg, trimmed);
  const modelsCfg = ensureRecord(defaultsCfg, "models");
  const modelCfg = ensureRecord(modelsCfg, trimmed);
  const paramsCfg = ensureRecord(modelCfg, "params");
  delete paramsCfg.fast_mode;
  if (fastMode === null) {
    delete paramsCfg.fastMode;
  } else {
    paramsCfg.fastMode = fastMode;
  }
  if (Object.keys(paramsCfg).length === 0) {
    delete modelCfg.params;
  }
}

async function readModelAssignments(configPath: string): Promise<AgentControlResult> {
  const { config } = await readConfigFile(configPath);
  const context = await runtimeContext(configPath);
  const agentsCfg = ensureOptionalRecord(config.agents);
  const defaultsCfg = ensureOptionalRecord(agentsCfg?.defaults);
  const assignments = ([
    "main",
    "image",
    "imageGeneration",
    "videoGeneration",
    "musicGeneration",
    "pdf",
  ] as const).map((purpose) => {
    const entry = ensureOptionalRecord(defaultsCfg?.[getPurposeConfigKey(purpose)]);
    const fallbackValues = readUnknownArray(entry?.fallbacks)
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return {
      kind: "assignment" as const,
      purpose,
      primary: mapPublicModelRef(typeof entry?.primary === "string" ? entry.primary : null, defaultsCfg, !purpose.endsWith("Generation") && managedRuntime.isSubscriptionRoute(config, typeof entry?.primary === "string" ? entry.primary : "", context)),
      fallback: mapPublicModelRef(fallbackValues[0] ?? null, defaultsCfg, !purpose.endsWith("Generation") && managedRuntime.isSubscriptionRoute(config, String(fallbackValues[0] ?? ""), context)),
      thinkingDefault: purpose === "main" ? readThinkingDefault(defaultsCfg?.thinkingDefault) : null,
      fastMode: purpose === "main"
        ? readModelFastMode(defaultsCfg ?? {}, typeof entry?.primary === "string" ? entry.primary : null)
        : null,
    };
  });
  return {
    kind: "modelAssignments.read",
    assignments: assignments.map(({ purpose, primary, fallback, thinkingDefault, fastMode }) => ({
      purpose,
      primary,
      fallback,
      thinkingDefault,
      ...(fastMode !== null ? { fastMode } : {}),
    })),
  };
}

async function setModelAssignment(input: {
  configPath: string;
  purpose: ModelAssignmentPurpose;
  primary: string;
  fallback: string | null;
  contextTokens: number | null;
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "adaptive" | null;
  fastMode?: boolean | "auto" | null;
}): Promise<AgentControlResult> {
  const { config } = await readConfigFile(input.configPath);
  const nextConfig = structuredClone(config);
  const agentsCfg = ensureRecord(nextConfig, "agents");
  const defaultsCfg = ensureRecord(agentsCfg, "defaults");
  const modelCfg = ensureRecord(defaultsCfg, getPurposeConfigKey(input.purpose));
  const storedPrimaryModel = mapStoredModelRef(input.primary);
  const storedFallback = input.fallback ? mapStoredModelRef(input.fallback) : null;
  modelCfg.primary = storedPrimaryModel.modelRef;
  modelCfg.fallbacks = storedFallback ? [storedFallback.modelRef] : [];
  ensureModelRegistryEntry(defaultsCfg, storedPrimaryModel.modelRef, storedPrimaryModel.agentRuntimeId);
  ensureAllowedModelEntry(defaultsCfg, storedPrimaryModel.modelRef);
  if (storedFallback) {
    ensureModelRegistryEntry(defaultsCfg, storedFallback.modelRef, storedFallback.agentRuntimeId);
    ensureAllowedModelEntry(defaultsCfg, storedFallback.modelRef);
  }
  if (input.purpose === "main") {
    applyModelFastMode(defaultsCfg, storedPrimaryModel.modelRef, input.fastMode);
  }
  if (input.purpose === "main" && typeof input.contextTokens === "number" && Number.isFinite(input.contextTokens) && input.contextTokens > 0) {
    defaultsCfg.contextTokens = Math.floor(input.contextTokens);
  }
  if (input.purpose === "main" && typeof input.thinkingDefault === "string" && input.thinkingDefault.trim()) {
    defaultsCfg.thinkingDefault = input.thinkingDefault;
  } else if (input.purpose === "main" && input.thinkingDefault === null) {
    delete defaultsCfg.thinkingDefault;
  }
  await applyNativePiModelCompatibility(nextConfig, input.configPath, [input.primary, input.fallback ?? ""]);
  await atomicWriteUtf8(input.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  const restart = await restartGatewayService();
  return {
    kind: "modelAssignment.set",
    applied: true,
    restarted: true,
    purpose: input.purpose,
    primary: input.primary,
    fallback: input.fallback,
    contextTokens: input.contextTokens,
    thinkingDefault: input.purpose === "main" ? readThinkingDefault(defaultsCfg.thinkingDefault) : null,
    fastMode: input.purpose === "main"
      ? readModelFastMode(defaultsCfg, storedPrimaryModel.modelRef)
      : null,
    activeState: restart.activeState,
    subState: restart.subState,
    result: restart.result,
  };
}

async function verifyConfiguredModel(configPath: string, model: string): Promise<AgentControlResult> {
  const { config } = await readConfigFile(configPath);
  const agents = isRecord(config.agents) ? config.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const configured = isRecord(defaults.model) ? defaults.model.primary : defaults.model;
  const expected = mapStoredModelRef(model);
  if (configured !== expected.modelRef) {
    throw new AgentControlError("MODEL_VERIFY_MISMATCH", "Configured model changed before authorization verification.");
  }
  const policy = await readManagedRuntimePolicy(configPath);
  const context = await runtimeContext(configPath);
  const expectedHarness = managedRuntime.expectedRuntime(config, expected.modelRef, "main", policy, context);
  const marker = `AUTH_CHECK_${randomUUID().replaceAll("-", "")}`;
  try {
    // A fresh session, no --deliver: never publish diagnostic text to a customer
    // channel, reuse their conversation or accept mere authStatus as success.
    const { stdout } = await execFile("openclaw", [
      "agent", "--agent", "main", "--session-id", `authorization-check-${randomUUID()}`,
      "--session-key", `agent:main:authorization-check:${randomUUID()}`,
      "--message", `Reply exactly ${marker}. Do not use tools.`,
      "--json", "--timeout", "90",
    ], {
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    const response: unknown = JSON.parse(stdout);
    const result = isRecord(response) && isRecord(response.result) ? response.result : null;
    const meta = result && isRecord(result.meta) ? result.meta : null;
    const agentMeta = meta && isRecord(meta.agentMeta) ? meta.agentMeta : null;
    const expectedModel = expected.modelRef.slice(expected.modelRef.indexOf("/") + 1);
    const payloads = result && Array.isArray(result.payloads) ? result.payloads : [];
    if (!isRecord(response) || response.status !== "ok"
      || agentMeta?.provider !== expected.modelRef.slice(0, expected.modelRef.indexOf("/"))
      || agentMeta?.agentHarnessId !== expectedHarness
      || agentMeta?.model !== expectedModel
      || !payloads.some((payload: unknown) => isRecord(payload) && typeof payload.text === "string" && payload.text.trim() === marker)) {
      throw new Error("Model response did not pass authorization verification.");
    }
    return { kind: "model.verify", model, verified: true };
  } catch {
    // CLI output may contain private runtime data. Do not return it to the UI.
    throw new AgentControlError("MODEL_VERIFY_FAILED", "Authorization was saved, but the selected model did not pass an isolated response check. Retry after checking model availability and routing.");
  }
}

async function restartGatewayService(): Promise<Extract<AgentControlResult, { kind: "gateway.restart" }>> {
  const configPath = activeManagedConfigPath();
  if (configPath) await normalizeManagedConfigOnDisk(configPath);
  await execSystemctl(["--user", "restart", "openclaw-gateway.service"]);
  for (let attempt = 0; attempt < GATEWAY_RESTART_CHECK_ATTEMPTS; attempt += 1) {
    const state = await readGatewayState();
    if (state.activeState === "active" && state.subState === "running") {
      return {
        kind: "gateway.restart",
        restarted: true,
        activeState: state.activeState,
        subState: state.subState,
        result: state.result,
      };
    }
    await sleep(GATEWAY_RESTART_CHECK_DELAY_MS);
  }
  const state = await readGatewayState();
  throw new AgentControlError("GATEWAY_RESTART_FAILED", "OpenClaw gateway did not become healthy after restart", state);
}

function runCodexAuthMutationWithGatewayPaused<T>(operation: () => Promise<T>): Promise<T> {
  return enqueueCodexAuthMutation(() => runCodexAuthMutationWithGatewayPausedNow(operation));
}

function enqueueCodexAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = codexAuthMutationQueue.then(
    operation,
    operation,
  );
  codexAuthMutationQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function importCodexAuthWithGatewayPaused(
  configPath: string,
  action: Extract<AgentControlAction, { kind: "codex.auth.import" }>,
): Promise<AgentControlResult> {
  return await runCodexAuthMutationWithGatewayPaused(() => withOwnerFenceLock(configPath, () => withCleanOpenAiGatewayEnvironment(() => importCodexAuthBundle(configPath, action.bundle))));
}

async function setCodexAuthWithGatewayPaused(
  configPath: string,
  action: Extract<AgentControlAction, { kind: "codex.auth.set" }>,
): Promise<AgentControlResult> {
  return await runCodexAuthMutationWithGatewayPaused(() => withOwnerFenceLock(configPath, () => action.mode === "openai_login"
    ? withCleanOpenAiGatewayEnvironment(() => setCodexAuthMode(configPath, action.mode))
    : setCodexAuthMode(configPath, action.mode)));
}

function removeOpenAiEnvironmentLines(contents: string): string {
  return contents.split(/\r?\n/).flatMap((line) => {
    if (/^\s*EnvironmentFile=-?["']?\/root\/\.openclaw\/openai-relay\.env["']?\s*$/.test(line)) return [];
    const match = /^(\s*Environment=)(.*)$/.exec(line);
    if (!match) return [line];
    // systemd permits several quoted assignments on one Environment= line.
    // Remove only the OpenAI route tokens, never a neighbouring TTS/other key.
    const tokens = match[2].match(/(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g) ?? [];
    const retained = tokens.filter((token) => !/^["']?(?:OPENAI_API_KEY|OPENAI_BASE_URL)=/.test(token));
    if (retained.length === tokens.length) return [line];
    return retained.length ? [`${match[1]}${retained.join(" ")}`] : [];
  }).join("\n");
}

type GatewayEnvironmentEdit = { filePath: string; current: string; next: string };

async function planOpenAiGatewayEnvironmentCleanup(): Promise<GatewayEnvironmentEdit[]> {
  const edits: GatewayEnvironmentEdit[] = [];
  const unitPath = process.env.OPENCLAW_GATEWAY_UNIT_PATH?.trim()
    || "/root/.config/systemd/user/openclaw-gateway.service";
  const dropInDir = process.env.OPENCLAW_GATEWAY_DROP_IN_DIR?.trim()
    || `${unitPath}.d`;
  const paths = [unitPath];
  try {
    const entries = await fs.readdir(dropInDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".conf")) {
        paths.push(path.join(dropInDir, entry.name));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  for (const filePath of paths) {
    let current: string;
    try {
      current = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const next = removeOpenAiEnvironmentLines(current);
    if (next !== current) {
      edits.push({ filePath, current, next });
    }
  }
  return edits;
}

async function writeGatewayEnvironment(edits: GatewayEnvironmentEdit[], rollback = false): Promise<void> {
  for (const edit of edits) await atomicWriteUtf8(edit.filePath, rollback ? edit.current : edit.next);
  if (edits.length) await execSystemctl(["--user", "daemon-reload"]);
}

async function withCleanOpenAiGatewayEnvironment<T>(operation: () => Promise<T>): Promise<T> {
  const edits = await planOpenAiGatewayEnvironmentCleanup();
  try {
    await writeGatewayEnvironment(edits);
    return await operation();
  } catch (error) {
    await writeGatewayEnvironment(edits, true);
    throw error;
  }
}

async function refreshCodexRuntimeAuth(gateway: GatewayLike): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gateway.request("models.authStatus", { refresh: true }, { timeoutMs: CODEX_AUTH_REFRESH_TIMEOUT_MS }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Gateway did not become ready for authorization refresh.")), CODEX_AUTH_READY_AND_REFRESH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function syncCodexAuthWithoutGatewayRestart(
  configPath: string,
  action: Extract<AgentControlAction, { kind: "codex.auth.sync" }>,
  gateway: GatewayLike,
): Promise<AgentControlResult> {
  return await enqueueCodexAuthMutation(() => withOwnerFenceLock(configPath, async () => {
    const edits = await planOpenAiGatewayEnvironmentCleanup();
    const restartNeeded = edits.length > 0 || await hasChatGptRouteOverrides(configPath);
    // Only legacy route repairs need a restart. Ordinary credential rotation
    // still refreshes live, without interrupting active runs.
    if (restartNeeded) await execSystemctl(["--user", "stop", "openclaw-gateway.service"]);
    let refreshCalls = 0;
    try {
      await writeGatewayEnvironment(edits);
      return await syncCodexAuthBundle(configPath, action.bundleVersion, action.bundle, {
        forceRuntimeRefresh: restartNeeded,
        refreshRuntimeAuth: async () => {
          refreshCalls += 1;
          // The auth transaction restores credentials/config before its second
          // callback. Restore service environment before loading that rollback.
          if (refreshCalls > 1) await writeGatewayEnvironment(edits, true);
          if (restartNeeded) await restartGatewayService();
          await refreshCodexRuntimeAuth(gateway);
        },
      });
    } catch (error) {
      if (refreshCalls === 0) {
        await writeGatewayEnvironment(edits, true);
        if (restartNeeded) await restartGatewayService();
      }
      throw error;
    }
  }));
}

function describeUnknownError(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return null;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  return "Non-Error value thrown";
}

async function runCodexAuthMutationWithGatewayPausedNow<T>(operation: () => Promise<T>): Promise<T> {
  await execSystemctl(["--user", "stop", "openclaw-gateway.service"]);
  let operationResult!: T;
  let operationError: unknown;
  try {
    operationResult = await operation();
  } catch (error) {
    operationError = error;
  }

  try {
    await restartGatewayService();
  } catch (restartError) {
    throw new AgentControlError(
      "CODEX_AUTH_GATEWAY_RECOVERY_FAILED",
      "OpenClaw gateway did not recover after the Codex authorization update.",
      {
        operationError: describeUnknownError(operationError),
        restartError: describeUnknownError(restartError),
      },
      { cause: restartError },
    );
  }

  if (operationError) {
    if (operationError instanceof Error) {
      throw operationError;
    }
    throw new AgentControlError(
      "CODEX_AUTH_MUTATION_FAILED",
      "Codex authorization update failed.",
      { operationError: describeUnknownError(operationError) },
    );
  }
  return operationResult;
}

async function readGatewayState(): Promise<{ activeState: string; subState: string; result: string | null }> {
  const [activeState, subState, result] = await Promise.all([
    execSystemctl(["--user", "show", "openclaw-gateway.service", "-p", "ActiveState", "--value"]),
    execSystemctl(["--user", "show", "openclaw-gateway.service", "-p", "SubState", "--value"]),
    execSystemctl(["--user", "show", "openclaw-gateway.service", "-p", "Result", "--value"]),
  ]);
  return {
    activeState: activeState.trim() || "unknown",
    subState: subState.trim() || "unknown",
    result: result.trim() || null,
  };
}

async function execSystemctl(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("systemctl", args, {
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0",
      },
    });
    return stdout;
  } catch (error) {
    throw new AgentControlError(
      "SYSTEMCTL_FAILED",
      `systemctl ${args.join(" ")} failed`,
      {
        args,
        message: error instanceof Error ? error.message : String(error),
      },
      { cause: error }
    );
  }
}

function resolveRelayEnvPath(): string {
  const explicit = process.env.RELAY_ENV_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(process.cwd(), ".env");
}

function updateDotenv(current: string, updates: Record<string, string | null>): string {
  const seen = new Set<string>();
  const lines = current.split(/\r?\n/);
  const nextLines = lines
    .filter((line, index) => index < lines.length - 1 || line.length > 0)
    .flatMap((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!match) return [line];
      const key = match[1];
      if (!(key in updates)) return [line];
      seen.add(key);
      const value = updates[key];
      return value === null ? [] : [`${key}=${dotenvValue(value)}`];
    });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key) && value !== null) {
      nextLines.push(`${key}=${dotenvValue(value)}`);
    }
  }
  return `${nextLines.join("\n")}\n`;
}

function dotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

function scheduleRelayRestart(): void {
  setTimeout(() => {
    const child = spawn("systemctl", ["restart", "golem-workers-relay"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
      },
    });
    child.unref();
  }, 1_000).unref();
}

async function readConfigFile(configPath: string): Promise<{ configText: string; config: Record<string, unknown> }> {
  let configText = "";
  try {
    configText = await fs.readFile(configPath, "utf8");
  } catch (error) {
    throw new AgentControlError(
      "CONFIG_READ_FAILED",
      `Failed to read OpenClaw config at ${configPath}`,
      {
        configPath,
        message: error instanceof Error ? error.message : String(error),
      },
      { cause: error }
    );
  }
  return {
    configText,
    config: parseConfigText(configText),
  };
}

function parseConfigText(configText: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(configText);
  } catch (error) {
    throw new AgentControlError(
      "CONFIG_PARSE_FAILED",
      "Failed to parse OpenClaw config JSON",
      {
        message: error instanceof Error ? error.message : String(error),
      },
      { cause: error }
    );
  }
  if (!isRecord(parsed)) {
    throw new AgentControlError("CONFIG_PARSE_FAILED", "OpenClaw config root must be an object");
  }
  return parsed;
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
  if (isConfigMutationPath(filePath)) { await writeOwnerFencedConfig(filePath, content); return; }
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.gwtmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (isRecord(existing)) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function ensureOptionalRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
