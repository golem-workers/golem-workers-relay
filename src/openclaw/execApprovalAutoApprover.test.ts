import { describe, expect, it, vi } from "vitest";
import {
  createExecApprovalAutoApprover,
  isEligibleLocalExecApprovalRequest,
} from "./execApprovalAutoApprover.js";

describe("execApprovalAutoApprover", () => {
  it("matches only local sandbox or gateway exec approvals", () => {
    expect(
      isEligibleLocalExecApprovalRequest({
        id: "apr_local_sandbox",
        request: {
          command: "cd /root/.openclaw/workspace && git status --short",
          cwd: "/root/.openclaw/workspace",
          host: "sandbox",
          nodeId: null,
          agentId: "main",
          security: "allowlist",
          ask: "on-miss",
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      })
    ).toBe(true);

    expect(
      isEligibleLocalExecApprovalRequest({
        id: "apr_local_gateway",
        request: {
          command: "uptime",
          cwd: "/root",
          host: "gateway",
          nodeId: null,
          agentId: "main",
          security: "full",
          ask: "always",
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      })
    ).toBe(true);

    expect(
      isEligibleLocalExecApprovalRequest({
        id: "apr_node",
        request: {
          command: "uptime",
          cwd: "/root",
          host: "node",
          nodeId: "node_1",
          agentId: "main",
          security: "allowlist",
          ask: "on-miss",
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      })
    ).toBe(false);

    expect(
      isEligibleLocalExecApprovalRequest({
        id: "apr_missing_host",
        request: {
          command: "uptime",
          cwd: "/root",
          host: null,
          nodeId: null,
          agentId: "main",
          security: "allowlist",
          ask: "on-miss",
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      })
    ).toBe(false);
  });

  it("auto-approves only eligible local exec approvals", async () => {
    const gateway = {
      isReady: vi.fn(() => true),
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "exec.approval.resolve") {
          return Promise.resolve({ ok: true, params });
        }
        return Promise.reject(new Error(`unexpected method: ${method}`));
      }),
    };

    const autoApprover = createExecApprovalAutoApprover({ gateway });

    autoApprover.handleEvent({
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "apr_local_1",
        request: {
          command: "cd /root/.openclaw/workspace && git status --short",
          cwd: "/root/.openclaw/workspace",
          host: "sandbox",
          agentId: "main",
          security: "allowlist",
          ask: "on-miss",
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      },
    });

    autoApprover.handleEvent({
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "apr_remote_node_1",
        request: {
          command: "uptime",
          cwd: "/root",
          host: "node",
          nodeId: "node_1",
          agentId: "main",
          security: "allowlist",
          ask: "on-miss",
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(gateway.request).toHaveBeenCalledTimes(1);
    expect(gateway.request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "apr_local_1",
      decision: "allow-once",
    });
  });

  it("disables itself when gateway lacks exec approval resolve", async () => {
    const gateway = {
      isReady: vi.fn(() => true),
      request: vi.fn(() => Promise.resolve({ ok: true })),
    };

    const autoApprover = createExecApprovalAutoApprover({ gateway });
    autoApprover.handleHello({
      type: "hello-ok",
      protocol: 3,
      policy: { tickIntervalMs: 5_000 },
      features: { methods: ["chat.send"], events: ["exec.approval.requested"] },
    });

    autoApprover.handleEvent({
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "apr_local_1",
        request: {
          command: "uptime",
          host: "sandbox",
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(gateway.request).not.toHaveBeenCalled();
  });
});
