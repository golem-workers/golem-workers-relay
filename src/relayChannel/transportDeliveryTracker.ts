export type RelayChannelTransportDeliveryReceipt = {
  transportChannelId: "telegram" | "whatsapp_personal";
  transportMessageId?: string;
};

export type RelayChannelTransportDeliveryTracker = {
  begin(input: { correlationMessageId: string; sessionKey?: string }): void;
  recordSdkDelivery(input: {
    correlationMessageId?: string;
    sessionKey?: string;
    transportChannelId: "telegram" | "whatsapp_personal";
    transportMessageId?: string;
    allowUnscopedActiveFallback?: boolean;
  }): void;
  getSdkDelivery(input: {
    correlationMessageId?: string;
    sessionKey?: string;
  }): RelayChannelTransportDeliveryReceipt | null;
  clear(input: { correlationMessageId?: string; sessionKey?: string }): void;
};

export function createRelayChannelTransportDeliveryTracker(): RelayChannelTransportDeliveryTracker {
  const deliveriesByCorrelationId = new Map<string, RelayChannelTransportDeliveryReceipt>();
  const deliveriesBySessionKey = new Map<string, RelayChannelTransportDeliveryReceipt>();
  const activeCorrelationIdsBySessionKey = new Map<string, Set<string>>();

  const getSoleActiveCorrelationId = (sessionKey: string): string | undefined => {
    const active = activeCorrelationIdsBySessionKey.get(sessionKey);
    if (!active || active.size !== 1) {
      return undefined;
    }
    return active.values().next().value;
  };

  return {
    begin(input) {
      const correlationMessageId = input.correlationMessageId.trim();
      const sessionKey = input.sessionKey?.trim();
      if (correlationMessageId && sessionKey) {
        const active = activeCorrelationIdsBySessionKey.get(sessionKey) ?? new Set<string>();
        active.add(correlationMessageId);
        activeCorrelationIdsBySessionKey.set(sessionKey, active);
      }
    },
    recordSdkDelivery(input) {
      const receipt = {
        transportChannelId: input.transportChannelId,
        ...(input.transportMessageId ? { transportMessageId: input.transportMessageId } : {}),
      };
      const sessionKey = input.sessionKey?.trim();
      const activeCorrelationMessageId = sessionKey ? getSoleActiveCorrelationId(sessionKey) : undefined;
      const activeEntries = [...activeCorrelationIdsBySessionKey.entries()].filter(([, active]) => active.size === 1);
      const soleActiveEntry =
        input.allowUnscopedActiveFallback === true &&
        !input.correlationMessageId?.trim() &&
        !sessionKey &&
        activeEntries.length === 1
          ? ([activeEntries[0]?.[0], activeEntries[0]?.[1].values().next().value] as const)
          : null;
      const explicitCorrelationMessageId = input.correlationMessageId?.trim();
      const correlationMessageId = explicitCorrelationMessageId || activeCorrelationMessageId || soleActiveEntry?.[1];
      const effectiveSessionKey = sessionKey || soleActiveEntry?.[0];
      if (correlationMessageId) {
        const isFallbackCorrelation = !explicitCorrelationMessageId;
        if (!isFallbackCorrelation || !deliveriesByCorrelationId.has(correlationMessageId)) {
          deliveriesByCorrelationId.set(correlationMessageId, receipt);
          if (effectiveSessionKey) {
            deliveriesBySessionKey.set(effectiveSessionKey, receipt);
          }
        }
      }
    },
    getSdkDelivery(input) {
      const correlationMessageId = input.correlationMessageId?.trim();
      if (correlationMessageId) {
        const byCorrelationId = deliveriesByCorrelationId.get(correlationMessageId);
        if (byCorrelationId) {
          return byCorrelationId;
        }
      }
      const sessionKey = input.sessionKey?.trim();
      return sessionKey ? (deliveriesBySessionKey.get(sessionKey) ?? null) : null;
    },
    clear(input) {
      const correlationMessageId = input.correlationMessageId?.trim();
      if (correlationMessageId) {
        deliveriesByCorrelationId.delete(correlationMessageId);
      }
      const sessionKey = input.sessionKey?.trim();
      if (sessionKey) {
        deliveriesBySessionKey.delete(sessionKey);
        if (correlationMessageId) {
          const active = activeCorrelationIdsBySessionKey.get(sessionKey);
          active?.delete(correlationMessageId);
          if (!active || active.size === 0) {
            activeCorrelationIdsBySessionKey.delete(sessionKey);
          }
        } else {
          activeCorrelationIdsBySessionKey.delete(sessionKey);
        }
      }
    },
  };
}

export function readTransportDeliveryCorrelationId(openclawContext: unknown): string | null {
  if (!openclawContext || typeof openclawContext !== "object" || Array.isArray(openclawContext)) {
    return null;
  }
  const context = openclawContext as Record<string, unknown>;
  const correlationMessageId =
    typeof context.correlationMessageId === "string" ? context.correlationMessageId.trim() : "";
  if (correlationMessageId.length > 0) {
    return correlationMessageId;
  }
  const backendMessageId = typeof context.backendMessageId === "string" ? context.backendMessageId.trim() : "";
  return backendMessageId.length > 0 ? backendMessageId : null;
}

export function readTransportDeliverySessionKey(openclawContext: unknown): string | null {
  if (!openclawContext || typeof openclawContext !== "object" || Array.isArray(openclawContext)) {
    return null;
  }
  const context = openclawContext as Record<string, unknown>;
  const sessionKey = typeof context.sessionKey === "string" ? context.sessionKey.trim() : "";
  return sessionKey.length > 0 ? sessionKey : null;
}

export function readTransportDeliveryKind(openclawContext: unknown): "tool" | "block" | "final" | null {
  if (!openclawContext || typeof openclawContext !== "object" || Array.isArray(openclawContext)) {
    return null;
  }
  const deliveryKind = (openclawContext as Record<string, unknown>).deliveryKind;
  return deliveryKind === "tool" || deliveryKind === "block" || deliveryKind === "final" ? deliveryKind : null;
}
