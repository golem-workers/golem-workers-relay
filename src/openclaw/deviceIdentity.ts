import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function resolveDefaultIdentityPath(env: NodeJS.ProcessEnv): string {
  // Keep it separate from OpenClaw's own identity by default, but allow override via OPENCLAW_STATE_DIR.
  const base =
    (env.OPENCLAW_STATE_DIR?.trim() && path.resolve(env.OPENCLAW_STATE_DIR.trim())) ||
    path.join(os.homedir(), ".openclaw");
  return path.join(base, "golem-workers-relay", "identity", "device.json");
}

function loadStoredIdentity(filePath: string): StoredIdentity | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Partial<StoredIdentity>;
    if (
      obj.version !== 1 ||
      typeof obj.deviceId !== "string" ||
      typeof obj.publicKeyPem !== "string" ||
      typeof obj.privateKeyPem !== "string"
    ) {
      return null;
    }
    return obj as StoredIdentity;
  } catch {
    return null;
  }
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

export function loadOrCreateDeviceIdentity(env: NodeJS.ProcessEnv): DeviceIdentity {
  const filePath = resolveDefaultIdentityPath(env);
  const stored = loadStoredIdentity(filePath);
  if (stored) {
    // Self-heal deviceId if stored value drifted.
    const derived = fingerprintPublicKey(stored.publicKeyPem);
    if (derived && derived !== stored.deviceId) {
      const next: StoredIdentity = { ...stored, deviceId: derived };
      ensureDir(filePath);
      fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // best-effort
      }
      return { deviceId: derived, publicKeyPem: stored.publicKeyPem, privateKeyPem: stored.privateKeyPem };
    }
    return { deviceId: stored.deviceId, publicKeyPem: stored.publicKeyPem, privateKeyPem: stored.privateKeyPem };
  }

  const identity = generateIdentity();
  const next: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
  return identity;
}

