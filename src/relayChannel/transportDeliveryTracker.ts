export type RelayChannelTransportDeliveryReceipt = {
  transportChannelId: "telegram" | "whatsapp_personal";
  transportMessageId?: string;
};

export type RelayChannelTransportDeliveryTracker = {
  recordSdkDelivery(input: {
    correlationMessageId: string;
    transportChannelId: "telegram" | "whatsapp_personal";
    transportMessageId?: string;
  }): void;
  getSdkDelivery(correlationMessageId: string): RelayChannelTransportDeliveryReceipt | null;
  clear(correlationMessageId: string): void;
};

export function createRelayChannelTransportDeliveryTracker(): RelayChannelTransportDeliveryTracker {
  const deliveries = new Map<string, RelayChannelTransportDeliveryReceipt>();

  return {
    recordSdkDelivery(input) {
      deliveries.set(input.correlationMessageId, {
        transportChannelId: input.transportChannelId,
        ...(input.transportMessageId ? { transportMessageId: input.transportMessageId } : {}),
      });
    },
    getSdkDelivery(correlationMessageId) {
      return deliveries.get(correlationMessageId) ?? null;
    },
    clear(correlationMessageId) {
      deliveries.delete(correlationMessageId);
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
