import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);

/** Await the producer-owned CLI result, not a presentation-only chat final. */
export async function runIsolatedModelProbe(input: {
  configPath: string; sessionId: string; sessionKey: string; messageText: string;
}) : Promise<unknown> {
  const { stdout } = await execFile("openclaw", [
    "agent", "--agent", "main", "--session-id", input.sessionId,
    "--session-key", input.sessionKey, "--message", input.messageText,
    "--json", "--timeout", "180",
  ], {
    env: { ...process.env, OPENCLAW_CONFIG_PATH: input.configPath },
    timeout: 210_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}
