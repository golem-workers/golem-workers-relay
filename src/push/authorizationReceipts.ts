import { withAuthorizationReadbackOnly } from "../agentControl/authorizationReconcileContext.js";
import { logger } from "../logger.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { SubscriptionPoolError } from "../agentControl/openAiSubscriptionPool.js";
import { withIndependentModelFenceLock, ModelFenceBusyError } from "../agentControl/modelFence.js";
import type { AgentControlResult } from "../backend/types.js";

export class AuthorizationReceiptAdmissionError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type AuthorizationReceipt = {
  operationId: string;
  fingerprint: string;
  intentFingerprint?: string;
  resumeCount?: number;
  reconcileCount?: number;
  previousUnknownCodes?: string[];
  previousRefusals?: string[];
  state: "RUNNING" | "SUCCEEDED" | "REFUSED" | "UNKNOWN";
  code?: string;
  result?: AgentControlResult;
};

/** Receipts contain hashes and nonsecret auth results only, never request bundles.
 * An interrupted RUNNING receipt stays UNKNOWN: elapsed time is not completion. */
export class AuthorizationReceipts {
  private readonly executing = new Set<string>();
  private readonly pending = new Map<string, Promise<AuthorizationReceipt>>();
  constructor(private readonly directory: string) {}
  private file(id: string) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_ID_INVALID");
    return path.join(this.directory, id + ".json");
  }
  async status(id: string): Promise<AuthorizationReceipt | { operationId: string; state: "NOT_FOUND" }> {
    try {
      const receipt = JSON.parse(await fs.readFile(this.file(id), "utf8")) as AuthorizationReceipt;
      if (receipt.state === "RUNNING" && !this.executing.has(id)) {
        // Completion can atomically replace the file while this read is in
        // flight, then remove executing before the old read resumes. Re-read
        // before classifying a live completion as an interrupted operation.
        const current = JSON.parse(await fs.readFile(this.file(id), "utf8")) as AuthorizationReceipt;
        return current.state === "RUNNING" ? { ...current, state: "UNKNOWN", code: "AUTH_OPERATION_INTERRUPTED" } : current;
      }
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { operationId: id, state: "NOT_FOUND" };
      throw error;
    }
  }
  private async persist(receipt: AuthorizationReceipt, exclusive = false) {
    const target = this.file(receipt.operationId);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = exclusive ? target : target + "." + randomUUID();
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
    if (!exclusive) await fs.rename(temporary, target);
    const directory = await fs.open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async submit(id: string, action: unknown, execute: () => Promise<AgentControlResult>, resumeFrom?: string, reconcileOnly = false): Promise<AuthorizationReceipt> {
    // Serialize admission in this process; exclusive creation also excludes a
    // second process. A conflicting payload never inherits another receipt.
    const existing = this.pending.get(id);
    if (existing) { await existing; return this.submit(id, action, execute, resumeFrom, reconcileOnly); }
    const admission = resumeFrom ? withIndependentModelFenceLock(this.file(id) + ".resume-admission", () => this.admit(id, action, execute, resumeFrom, reconcileOnly), 1) : this.admit(id, action, execute);
    this.pending.set(id, admission);
    try { return await admission; } finally { this.pending.delete(id); }
  }
  async resume(id: string, action: unknown, fingerprint: string, execute: () => Promise<AgentControlResult>): Promise<AuthorizationReceipt> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_RESUME_INVALID");
    return this.submit(id, action, execute, fingerprint);
  }
  async reconcile(id: string, action: unknown, fingerprint: string, execute: () => Promise<AgentControlResult>): Promise<AuthorizationReceipt> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_RESUME_INVALID");
    return this.submit(id, action, execute, fingerprint, true);
  }
  private async admit(id: string, action: unknown, execute: () => Promise<AgentControlResult>, resumeFrom?: string, reconcileOnly = false): Promise<AuthorizationReceipt> {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
    const fingerprint = createHash("sha256").update(JSON.stringify(canonical(action))).digest("hex");
    // These two fields are current dispatch authority, not credential intent.
    // Everything else (including policy, account generations and bundles) stays bound.
    const intent = action && typeof action === "object" && !Array.isArray(action) ? Object.fromEntries(Object.entries(action).filter(([key]) => !["managedRuntimeExpectedConfigRevision", "runtimeInstallActionId"].includes(key))) : action;
    const intentFingerprint = createHash("sha256").update(JSON.stringify(canonical(intent))).digest("hex");
    const previous = await this.status(id);
    if (resumeFrom) {
      if (previous.state === "NOT_FOUND") throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_RESUME_INVALID");
      const sameIntent = previous.intentFingerprint ? previous.intentFingerprint === intentFingerprint : previous.fingerprint === fingerprint;
      if (!sameIntent) throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_CONFLICT");
      if (previous.state === "SUCCEEDED") return previous;
      if (reconcileOnly) {
        if (previous.state !== "UNKNOWN" || !action || typeof action !== "object" || !("kind" in action) || action.kind !== "codex.auth.pool.sync") throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_RECONCILE_UNSAFE");
        if ((previous.reconcileCount ?? 0) >= 3) throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_RECONCILE_LIMIT");
      } else if (previous.state !== "REFUSED" || !["OPENAI_POOL_CONFIG_RUNTIME_PENDING", "MODEL_FENCE_BUSY"].includes(previous.code ?? "")) throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_RESUME_UNSAFE");
      if (previous.fingerprint !== resumeFrom) throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_RESUME_STALE");
      if (!reconcileOnly && (previous.resumeCount ?? 0) >= 3) throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_RESUME_LIMIT");
    } else if (previous.state !== "NOT_FOUND") {
      if (previous.fingerprint !== fingerprint) throw new AuthorizationReceiptAdmissionError("AUTH_OPERATION_CONFLICT");
      return previous;
    }
    const receipt: AuthorizationReceipt = { operationId: id, fingerprint, intentFingerprint, state: "RUNNING", ...(reconcileOnly && previous.state !== "NOT_FOUND" ? { reconcileCount: (previous.reconcileCount ?? 0) + 1, previousUnknownCodes: [...(previous.previousUnknownCodes ?? []), previous.code ?? "AUTH_OPERATION_INTERRUPTED"].slice(-3) } : {}), ...(resumeFrom && !reconcileOnly && previous.state !== "NOT_FOUND" ? { resumeCount: (previous.resumeCount ?? 0) + 1, previousRefusals: [...(previous.previousRefusals ?? []), previous.code ?? "REFUSED"].slice(-3) } : {}) };
    this.executing.add(id);
    try { await this.persist(receipt, !resumeFrom); }
    catch (error) {
      this.executing.delete(id);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.admit(id, action, execute, resumeFrom, reconcileOnly);
      throw error;
    }
    // Completion survives a closed caller connection. Only an explicit refusal
    // before work starts permits release; all other exceptions retain custody.
    void (async () => {
      logger.info({ operationId: id, mode: reconcileOnly ? "reconcile" : "mutate", state: "RUNNING", event: "authorization_operation" }, "Authorization mutation started");
      try {
        const result = await (reconcileOnly ? withAuthorizationReadbackOnly(execute) : execute());
        if (!["codex.auth.clear", "codex.auth.sync", "codex.auth.pool.sync"].includes(result.kind)) throw new Error("AUTH_OPERATION_RESULT_INVALID");
        await this.persist({ ...receipt, state: "SUCCEEDED", result });
        logger.info({ operationId: id, mode: reconcileOnly ? "reconcile" : "mutate", state: "SUCCEEDED", event: "authorization_operation" }, "Authorization mutation completed");
      } catch (error) {
        const configPending = error instanceof SubscriptionPoolError && error.code === "OPENAI_POOL_CONFIG_RUNTIME_PENDING";
        const refused = !reconcileOnly && (error instanceof ModelFenceBusyError || configPending);
        const code = configPending && !reconcileOnly ? "OPENAI_POOL_CONFIG_RUNTIME_PENDING" : refused ? "MODEL_FENCE_BUSY" : "AUTH_OPERATION_OUTCOME_UNKNOWN";
        const runtimeCode = error instanceof ModelFenceBusyError ? "MODEL_FENCE_BUSY" : error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : undefined;
        await this.persist({ ...receipt, state: refused ? "REFUSED" : "UNKNOWN", code: runtimeCode && !refused ? code + ":" + runtimeCode : code });
        logger.warn({ operationId: id, mode: reconcileOnly ? "reconcile" : "mutate", state: refused ? "REFUSED" : "UNKNOWN", code, runtimeCode, event: "authorization_operation" }, "Authorization mutation requires reconciliation");
      } finally { this.executing.delete(id); }
    })().catch(() => { this.executing.delete(id); });
    return receipt;
  }
}
