export type BuildDeviceAuthPayloadInput = {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce?: string;
};

function normalizeScopes(scopes: string[]): string {
  const out = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out].sort().join(",");
}

export function buildDeviceAuthPayload(input: BuildDeviceAuthPayloadInput): string {
  // Mirrors OpenClaw v2 format:
  // v2|deviceId|clientId|clientMode|role|scope1,scope2|signedAtMs|token|nonce
  const scopes = normalizeScopes(input.scopes);
  const token = input.token ?? "";
  const nonce = input.nonce ?? "";
  return [
    "v2",
    input.deviceId,
    input.clientId,
    input.clientMode,
    input.role,
    scopes,
    String(input.signedAtMs),
    token,
    nonce,
  ].join("|");
}

