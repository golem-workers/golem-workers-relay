const object = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Only model assignment fields, never transport/memory/plugin fallback policy. */
export function visitSubscriptionModelFallbacks(
  config: unknown,
  visit: (assignment: Record<string, unknown>) => void,
): void {
  const walk = (value: unknown, key: string, inMedia = false): void => {
    const row = object(value);
    if (!row) {
      if (Array.isArray(value))
        for (const child of value) walk(child, key, inMedia);
      return;
    }
    if (
      key === "model" ||
      key.endsWith("Model") ||
      (inMedia && ["image", "video", "music"].includes(key)) ||
      (key === "payload" &&
        (row.kind === "agentTurn" ||
          row.model !== undefined ||
          row.fallbacks !== undefined))
    )
      visit(row);
    for (const [childKey, child] of Object.entries(row))
      walk(child, childKey, key === "mediaModels");
  };
  const root = object(config);
  walk(root?.agents, "agents");
  walk(root?.cron, "cron");
}

/** Explicit Connect policy, not generic auth/config normalization. */
export function clearSubscriptionModelFallbacks(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(config);
  visitSubscriptionModelFallbacks(next, (assignment) => {
    if (
      assignment.fallbacks !== undefined &&
      assignment.fallbacks !== null &&
      !(
        Array.isArray(assignment.fallbacks) && assignment.fallbacks.length === 0
      )
    )
      assignment.fallbacks = [];
    if (
      assignment.fallback !== undefined &&
      assignment.fallback !== null &&
      assignment.fallback !== ""
    )
      delete assignment.fallback;
  });
  return next;
}
