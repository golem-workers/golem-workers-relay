import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// Resolve only the public SDK export. Provisioned services set NODE_PATH; also
// support ordinary global installs whose executable is a symlink on PATH.
export async function resolveRuntimeAuthSdk(): Promise<string> {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("openclaw/plugin-sdk/provider-auth");
  } catch { /* Try the installed executable, not hashed private dist modules. */ }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      const executable = await fs.realpath(path.join(directory, "openclaw"));
      const installedRequire = createRequire(executable);
      return installedRequire.resolve("openclaw/plugin-sdk/provider-auth");
    } catch { /* A wrapper or unrelated PATH entry is not a package root. */ }
  }
  throw new Error("Installed OpenClaw public provider-auth SDK is unavailable; refusing to create an auth database.");
}

// A separate process isolates runtime caches and state-root environment from the
// relay. Credentials travel on stdin, never argv, environment, or diagnostic logs.
const writer = String.raw`
try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const { updateAuthProfileStoreWithLock } = await import(process.argv[1]);
  if (typeof updateAuthProfileStoreWithLock !== "function") process.exit(2);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: process.env.OPENCLAW_AGENT_DIR,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    sharedStoreWrite: true,
    saveOptions: { syncExternalCli: false, filterExternalAuthProfiles: false },
    updater: (store) => {
      store.profiles = Object.fromEntries(Object.entries(store.profiles).filter(([, value]) =>
        !(value.type === "oauth" && (value.provider === "openai" || value.provider === "openai-codex"))));
      store.profiles[input.profileId] = input.credential;
      store.order = { ...store.order, openai: [input.profileId] };
      store.lastGood = { ...store.lastGood, openai: input.profileId };
      return true;
    },
  });
  process.exit(updated ? 0 : 3);
} catch { process.exit(1); }
`;

export async function writeRuntimeAuth(input: {
  configPath: string;
  profileId: string;
  credential: Record<string, unknown>;
}): Promise<void> {
  const sdk = await resolveRuntimeAuthSdk();
  const configPath = path.resolve(input.configPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", writer, pathToFileURL(sdk).href], {
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: path.dirname(configPath),
        OPENCLAW_AGENT_DIR: path.join(path.dirname(configPath), "agents", "main", "agent"),
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Unable to start OpenClaw auth writer."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("OpenClaw auth writer refused the update; inspect runtime schema ownership and SDK compatibility."));
    });
    child.stdin.on("error", () => { /* close/error above reports a sanitized failure */ });
    child.stdin.end(JSON.stringify(input));
  });
}
