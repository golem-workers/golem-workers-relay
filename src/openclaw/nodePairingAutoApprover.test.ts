import { describe, expect, it, vi } from "vitest";

import {
  createNodePairingAutoApprover,
  isEligibleConnectorNodePairingRequest,
} from "./nodePairingAutoApprover.js";

describe("nodePairingAutoApprover", () => {
  it("matches desktop connector nodes that advertise browser.proxy", () => {
    expect(
      isEligibleConnectorNodePairingRequest({
        requestId: "req_connector_1",
        nodeId: "node_1",
        platform: "macos",
        caps: ["system", "browser"],
        commands: ["system.run", "browser.proxy"],
      }),
    ).toBe(true);

    expect(
      isEligibleConnectorNodePairingRequest({
        requestId: "req_android_1",
        nodeId: "node_2",
        platform: "android",
        caps: ["browser"],
        commands: ["browser.proxy"],
      }),
    ).toBe(false);

    expect(
      isEligibleConnectorNodePairingRequest({
        requestId: "req_missing_browser_1",
        nodeId: "node_3",
        platform: "macos",
        caps: ["system"],
        commands: ["system.run"],
      }),
    ).toBe(false);
  });

  it("approves only eligible connector node pairing requests", async () => {
    const gateway = {
      isReady: vi.fn(() => true),
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "node.pair.list") {
          return Promise.resolve({
            pending: [
              {
                requestId: "req_connector_1",
                nodeId: "node_1",
                platform: "macos",
                caps: ["system", "browser"],
                commands: ["system.run", "browser.proxy"],
              },
              {
                requestId: "req_android_1",
                nodeId: "node_2",
                platform: "android",
                caps: ["browser"],
                commands: ["browser.proxy"],
              },
            ],
          });
        }
        if (method === "node.pair.approve") {
          return Promise.resolve({ ok: true, params });
        }
        return Promise.reject(new Error(`unexpected method ${method}`));
      }),
    };

    const autoApprover = createNodePairingAutoApprover({ gateway });
    autoApprover.handleHello({
      features: { methods: ["node.pair.list", "node.pair.approve"] },
    } as never);
    await autoApprover.sweepNow();

    expect(gateway.request).toHaveBeenCalledWith("node.pair.approve", { requestId: "req_connector_1" });
    expect(gateway.request).not.toHaveBeenCalledWith("node.pair.approve", { requestId: "req_android_1" });
  });
});
