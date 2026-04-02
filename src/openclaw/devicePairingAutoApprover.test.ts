import { describe, expect, it, vi } from "vitest";
import {
  createDevicePairingAutoApprover,
  isEligibleInternalPairingRequest,
} from "./devicePairingAutoApprover.js";

describe("devicePairingAutoApprover", () => {
  it("matches only internal relay/backend or local cli operator requests", () => {
    expect(
      isEligibleInternalPairingRequest({
        requestId: "req_internal_1",
        deviceId: "dev_1",
        clientId: "gateway-client",
        clientMode: "backend",
        role: "operator",
        scopes: ["operator.read", "operator.approvals"],
      })
    ).toBe(true);

    expect(
      isEligibleInternalPairingRequest({
        requestId: "req_internal_cli_1",
        deviceId: "dev_cli_1",
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        scopes: ["operator.read", "operator.approvals"],
      })
    ).toBe(true);

    expect(
      isEligibleInternalPairingRequest({
        requestId: "req_external_1",
        deviceId: "dev_2",
        clientId: "mobile-app",
        clientMode: "device",
        role: "operator",
        scopes: ["operator.approvals"],
      })
    ).toBe(false);

    expect(
      isEligibleInternalPairingRequest({
        requestId: "req_bad_scope_1",
        deviceId: "dev_3",
        clientId: "gateway-client",
        clientMode: "backend",
        role: "operator",
        scopes: ["admin.root"],
      })
    ).toBe(false);
  });

  it("approves only eligible internal pending requests", async () => {
    const gateway = {
      isReady: vi.fn(() => true),
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "device.pair.list") {
          return Promise.resolve({
            pending: [
              {
                requestId: "req_internal_1",
                deviceId: "dev_internal_1",
                clientId: "gateway-client",
                clientMode: "backend",
                role: "operator",
                scopes: ["operator.read", "operator.approvals"],
              },
              {
                requestId: "req_external_1",
                deviceId: "dev_external_1",
                clientId: "mobile-app",
                clientMode: "device",
                role: "operator",
                scopes: ["operator.approvals"],
              },
              {
                requestId: "req_internal_cli_1",
                deviceId: "dev_cli_1",
                clientId: "cli",
                clientMode: "cli",
                role: "operator",
                scopes: ["operator.read", "operator.approvals"],
              },
            ],
          });
        }
        if (method === "device.pair.approve") {
          return Promise.resolve({ status: "approved", params });
        }
        return Promise.reject(new Error(`unexpected method: ${method}`));
      }),
    };

    const autoApprover = createDevicePairingAutoApprover({ gateway });
    await autoApprover.sweepNow();

    expect(gateway.request).toHaveBeenCalledWith("device.pair.list", {});
    expect(gateway.request).toHaveBeenCalledWith("device.pair.approve", { requestId: "req_internal_1" });
    expect(gateway.request).toHaveBeenCalledWith("device.pair.approve", { requestId: "req_internal_cli_1" });
    expect(gateway.request).not.toHaveBeenCalledWith("device.pair.approve", { requestId: "req_external_1" });
  });

  it("disables itself when gateway lacks device pairing methods", async () => {
    const gateway = {
      isReady: vi.fn(() => true),
      request: vi.fn(() => Promise.resolve({ pending: [] })),
    };

    const autoApprover = createDevicePairingAutoApprover({ gateway });
    autoApprover.handleHello({
      type: "hello-ok",
      protocol: 3,
      policy: { tickIntervalMs: 5_000 },
      features: { methods: ["chat.send"], events: [] },
    });
    await autoApprover.sweepNow();

    expect(gateway.request).not.toHaveBeenCalled();
  });
});
