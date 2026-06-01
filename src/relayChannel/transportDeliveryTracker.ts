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
  const activeCorrelationIdBySessionKey = new Map<string, string>();

  return {
    begin(input) {
      const correlationMessageId = input.correlationMessageId.trim();
      const sessionKey = input.sessionKey?.trim();
      if (correlationMessageId && sessionKey) {
        activeCorrelationIdBySessionKey.set(sessionKey, correlationMessageId);
      }
    },
    recordSdkDelivery(input) {
      const receipt = {
        transportChannelId: input.transportChannelId,
        ...(input.transportMessageId ? { transportMessageId: input.transportMessageId } : {}),
      };
      const sessionKey = input.sessionKey?.trim();
      const activeCorrelationMessageId = sessionKey
        ? activeCorrelationIdBySessionKey.get(sessionKey)
        : undefined;
      const correlationMessageId = input.correlationMessageId?.trim() || activeCorrelationMessageId;
      if (correlationMessageId) {
        deliveriesByCorrelationId.set(correlationMessageId, receipt);
      }
      if (sessionKey && activeCorrelationMessageId) {
        deliveriesBySessionKey.set(sessionKey, receipt);
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
        activeCorrelationIdBySessionKey.delete(sessionKey);
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
