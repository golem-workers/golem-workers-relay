import { describe, expect, it } from "vitest";
import { createRelayChannelTransportDeliveryTracker } from "./transportDeliveryTracker.js";

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) {
    throw new Error("Cannot pick from an empty list");
  }
  return item;
}

describe("transport state-machine fuzz", () => {
  it("does not assign session-scoped SDK deliveries to the wrong active backend message", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const rng = mulberry32(seed);
      const tracker = createRelayChannelTransportDeliveryTracker();
      const activeBySession = new Map<string, Set<string>>();
      const expectedDeliveries = new Map<string, string>();
      const sessions = ["tg:1:srv", "tg:2:srv"];
      const messages = Array.from({ length: 8 }, (_, index) => `msg_${seed}_${index}`);

      for (let step = 0; step < 80; step += 1) {
        const sessionKey = pick(rng, sessions);
        const messageId = pick(rng, messages);
        const action = pick(rng, ["begin", "explicitDelivery", "sessionDelivery", "clear"] as const);

        if (action === "begin") {
          tracker.begin({ correlationMessageId: messageId, sessionKey });
          const active = activeBySession.get(sessionKey) ?? new Set<string>();
          active.add(messageId);
          activeBySession.set(sessionKey, active);
          continue;
        }

        if (action === "explicitDelivery") {
          const transportMessageId = `tg-explicit-${seed}-${step}`;
          tracker.recordSdkDelivery({
            correlationMessageId: messageId,
            sessionKey,
            transportChannelId: "telegram",
            transportMessageId,
          });
          expectedDeliveries.set(messageId, transportMessageId);
          continue;
        }

        if (action === "sessionDelivery") {
          const beforeActive = new Set(activeBySession.get(sessionKey) ?? []);
          const transportMessageId = `tg-session-${seed}-${step}`;
          tracker.recordSdkDelivery({
            sessionKey,
            transportChannelId: "telegram",
            transportMessageId,
            allowUnscopedActiveFallback: true,
          });
          if (beforeActive.size === 1) {
            const activeMessageId = beforeActive.values().next().value;
            if (!expectedDeliveries.has(activeMessageId)) {
              expectedDeliveries.set(activeMessageId, transportMessageId);
            }
          }
          for (const candidate of messages) {
            const delivery = tracker.getSdkDelivery({ correlationMessageId: candidate });
            const expectedTransportMessageId = expectedDeliveries.get(candidate);
            if (expectedTransportMessageId) {
              expect(delivery?.transportMessageId, `seed=${seed} step=${step}`).toBe(expectedTransportMessageId);
            } else {
              expect(delivery, `seed=${seed} step=${step} candidate=${candidate}`).toBeNull();
            }
          }
          continue;
        }

        tracker.clear({ correlationMessageId: messageId, sessionKey });
        expectedDeliveries.delete(messageId);
        const active = activeBySession.get(sessionKey);
        active?.delete(messageId);
        if (!active || active.size === 0) {
          activeBySession.delete(sessionKey);
        }
      }
    }
  });
});
