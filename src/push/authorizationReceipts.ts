import { logger } from "../logger.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ModelFenceBusyError } from "../agentControl/modelFence.js";
import type { AgentControlResult } from "../backend/types.js";

export type AuthorizationReceipt = {
  operationId: string;
  fingerprint: string;
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
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("AUTH_OPERATION_ID_INVALID");
    return path.join(this.directory, id + ".json");
  }
  async status(id: string): Promise<AuthorizationReceipt | { operationId: string; state: "NOT_FOUND" }> {
    try {
      const receipt = JSON.parse(await fs.readFile(this.file(id), "utf8")) as AuthorizationReceipt;
      if (receipt.state === "RUNNING" && !this.executing.has(id)) return { ...receipt, state: "UNKNOWN", code: "AUTH_OPERATION_INTERRUPTED" };
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
  async submit(id: string, action: unknown, execute: () => Promise<AgentControlResult>): Promise<AuthorizationReceipt> {
    // Serialize admission in this process; exclusive creation also excludes a
    // second process. A conflicting payload never inherits another receipt.
    const existing = this.pending.get(id);
    if (existing) { await existing; return this.submit(id, action, execute); }
    const admission = this.admit(id, action, execute);
    this.pending.set(id, admission);
    try { return await admission; } finally { this.pending.delete(id); }
  }
  private async admit(id: string, action: unknown, execute: () => Promise<AgentControlResult>): Promise<AuthorizationReceipt> {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
    const fingerprint = createHash("sha256").update(JSON.stringify(canonical(action))).digest("hex");
    const previous = await this.status(id);
    if (previous.state !== "NOT_FOUND") {
      if (previous.fingerprint !== fingerprint) throw new Error("AUTH_OPERATION_CONFLICT");
      return previous;
    }
    const receipt: AuthorizationReceipt = { operationId: id, fingerprint, state: "RUNNING" };
    this.executing.add(id);
    try { await this.persist(receipt, true); }
    catch (error) {
      this.executing.delete(id);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.admit(id, action, execute);
      throw error;
    }
    // Completion survives a closed caller connection. Only an explicit refusal
    // before work starts permits release; all other exceptions retain custody.
    void (async () => {
      logger.info({ operationId: id, state: "RUNNING", event: "authorization_operation" }, "Authorization mutation started");
      try {
        const result = await execute();
        if (!["codex.auth.clear", "codex.auth.sync"].includes(result.kind)) throw new Error("AUTH_OPERATION_RESULT_INVALID");
        await this.persist({ ...receipt, state: "SUCCEEDED", result });
        logger.info({ operationId: id, state: "SUCCEEDED", event: "authorization_operation" }, "Authorization mutation completed");
      } catch (error) {
        const refused = error instanceof ModelFenceBusyError;
        const code = refused ? "MODEL_FENCE_BUSY" : "AUTH_OPERATION_OUTCOME_UNKNOWN";
        const runtimeCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : undefined;
        await this.persist({ ...receipt, state: refused ? "REFUSED" : "UNKNOWN", code: runtimeCode && !refused ? code + ":" + runtimeCode : code });
        logger.warn({ operationId: id, state: refused ? "REFUSED" : "UNKNOWN", code, runtimeCode, event: "authorization_operation" }, "Authorization mutation requires reconciliation");
      } finally { this.executing.delete(id); }
    })().catch(() => { this.executing.delete(id); });
    return receipt;
  }
}
