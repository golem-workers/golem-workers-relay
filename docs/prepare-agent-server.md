# Prepare Agent Server

Run directly from the public repo:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/release/scripts/prepare-agent-server.sh | sudo bash
```

If you want to skip interactive OpenClaw onboarding during base image preparation:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/release/scripts/prepare-agent-server.sh | sudo bash -s -- --skip-openclaw-onboard
```

What it does:

- installs base Ubuntu packages plus agent media/PDF tooling (`ffmpeg`, `poppler-utils`, `imagemagick`, `python3-pip`);
- pins guest DNS to the current default gateway before `apt-get upgrade`, so package upgrades do not lose resolver state mid-prepare on small microVMs;
- rewrites `/etc/apt/sources.list` before package installation so the run uses a deterministic Ubuntu mirror set instead of appending duplicate archive entries across repeated prepares;
- on Hetzner hosts it prefers `mirror.hetzner.com` (including `ubuntu-ports` on `arm64`) to reduce large package download time during snapshot image preparation;
- accepts `APT_MIRROR_HINT=hetzner` so caller-side orchestration can force the same mirror choice when the guest DMI no longer exposes the provider host vendor;
- creates swap early so low-memory agents can unpack large packages like Chrome;
- installs Google Chrome Stable;
- configures journald, swap, and DNS;
- installs Go and Linuxbrew;
- installs an OpenClaw-compatible Node runtime (24.16+ on 24.x, or accepts
  26.1+; Node 25 is rejected) separately from Linuxbrew;
- pre-pulls and builds `golem-workers-relay` from `release` by default, or from explicit `RELAY_GIT_REF` when exported before running the script;
- resolves latest OpenClaw and official `@openai/codex` versions once, installs them with npm using `/usr/local` as the global prefix and npm-owned `/usr/local/bin/openclaw` and `/usr/local/bin/codex` launchers, writes managed `~/.codex/config.toml`, `~/.codex/auth.json`, and `/usr/local/bin/golem-codex-proxy` files so Codex pins `CODEX_HOME` to `~/.codex`, uses explicit API-key login state, explicit `danger-full-access` / `never` defaults, disabled Codex hooks, and wrapper-level CLI overrides together with the local OpenAI proxy, prepares runtime dependencies (`grammy`, `@grammyjs/runner`, `@grammyjs/transformer-throttler`, `@buape/carbon`, `@larksuiteoapi/node-sdk`, `@slack/bolt` for the current OpenClaw bundled-plugin import bugs), preinstalls `relay-channel` and `@openclaw/codex` through `openclaw plugins install`, preinstalls the curated safe OpenClaw skills used by the agent creation quiz, patches the installed Codex harness default so OpenClaw native hook relay stays disabled, leaves those prepared plugins disabled until backend provisioning wires their runtime config, and installs full `playwright`;
- clones/builds `golem-workers-openclaw-channel-plugin` during image prep and installs the generated agent bundle through the OpenClaw plugin CLI, using explicit `RELAY_CHANNEL_PLUGIN_GIT_REF` when exported (otherwise defaulting to the existing relay-ref coupling), so future `RELAY_CHANNEL_V2` provisioning can reuse the prepared plugin install from the snapshot;
- detects whether the installed OpenClaw plugin CLI supports capability consent and passes `--accept-capabilities` only on those releases; official Moonshot and Perplexity provider plugins use exact compatible versions from their npm source so snapshot preparation does not depend on ClawHub publication lag; local relay-channel archives also use explicit `--force`; database-first releases keep install metadata in OpenClaw's plugin index instead of the retired authored `plugins.installs` config, while legacy releases retain their existing config records;
- normalizes the generated snapshot gateway unit to a 768 MiB V8 heap before manual readiness recovery, avoiding the 2026.8.1 low-memory auto-sizing stall while the preparation VM has swap available;
- when the relay service later starts on the prepared host, it re-syncs the selected plugin repo ref, compares the repo package version with the installed OpenClaw `relay-channel` package version, and automatically reinstalls the plugin if the installed version is older;
- fails the install immediately if `relay-channel` or `codex` is missing or the OpenClaw install record is malformed, so broken snapshot images are caught during image prep instead of surfacing later at runtime;
- configures OpenClaw/Node runtime env (`NODE_OPTIONS` with 2 GiB heap, `NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN`, `NODE_PATH`) for current shell, future login shells, and systemd managers;
- explicitly enables and starts the root user-systemd manager before OpenClaw daemon install (`loginctl enable-linger root`, `systemctl start user@0.service`, `XDG_RUNTIME_DIR=/run/user/0`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`);
- optionally runs `OPENCLAW_SKIP_CANVAS_HOST=1 OPENCLAW_LOG_LEVEL=debug systemctl --user import-environment OPENCLAW_SKIP_CANVAS_HOST OPENCLAW_LOG_LEVEL && openclaw onboard --install-daemon --non-interactive --accept-risk`; on current OpenClaw releases this step may return before its own gateway probe stabilizes on small snapshot VMs, so the script explicitly restarts `openclaw-gateway.service` and waits longer for port `18789` after onboarding instead of trusting the raw `onboard` exit code alone; the script exports `NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps` before this so one-shot OpenClaw/Node commands also inherit the larger heap;
- writes a temporary snapshot-only OpenClaw warmup config that activates `telegram` and `whatsapp` surfaces just enough for plugin auto-enable / first-run initialization, then performs a mandatory `gateway start -> readiness wait -> channels status -> stop` cycle during snapshot preparation;
- seals the final snapshot config back to a cold baseline by removing temporary Telegram/relay-channel configuration and leaving backend-owned plugins disabled; the prepared WhatsApp plugin and its neutral configuration remain;
- after confirmed gateway shutdown, performs an offline identity seal that removes credentials, backups, device/signing identity and runtime state while preserving validated plugin provenance and payloads;
- finishes by stopping, disabling, and resetting `openclaw-gateway.service` so the snapshot stays cold and backend provisioning owns the first gateway start.

## Snapshot identity seal contract

The final seal is for **fresh disposable bake servers only**, never existing agents.
For modern SQLite-backed OpenClaw it reconstructs a new database from the installed
schema and retains only the `primary` global schema metadata and the sanitized
`config_machine_state` row `plugins.installedIndex`. Plugin install records
(including package integrity/provenance) remain; source-admission inode receipts,
diagnostics, workspace binding and generated timestamps are cleared. All other
tables are empty, including device keys, config signing keys, cron and session
runtime. Known `startup-migrations` and `state-migrations` metadata checkpoints
(format 3, global role, no agent identity) are validated and discarded so a new
instance reruns migrations. Unknown checkpoint keys/versions and agent-bound
metadata fail closed. SQLite virtual-table shadows are recreated by SQLite, not copied. The
runtime may regenerate instance-local state only during provisioning/startup.

Supported legacy no-database releases retain canonical `plugins.installs` and,
when present, only `plugins/installs.json` install records. A missing modern DB,
missing required plugin provenance, unfamiliar schema metadata, corrupt DB,
unsupported SQLite schema/features, unexpected retained-path symlinks or any
fsync failure aborts the bake; there is no silent legacy fallback. SQLite-backed
sealing requires Python's SQLite 3.37+ (including the schema's extension support).
Required plugin installs must resolve within the retained `npm/` or
`extensions/` trees. The config/database are staged, checked and fsynced before
replacement; an interrupted/failed seal must not be snapshotted or promoted.
This is logical filesystem/database sanitization, **not forensic erasure of freed
disk blocks**, swap or arbitrary build/package caches outside this allowlist.

The snapshot caller must preserve the seal: do not start the gateway or run
stateful OpenClaw commands between sealing and poweroff. The backend currently
runs a cold probe afterward; its gateway check is `systemctl --user status`,
not `openclaw gateway status`, but its version probe still invokes
`openclaw --version` (with `openclaw version` fallback). For a version-independent
no-regeneration guarantee, use package metadata for that cold version check or
perform a final offline seal/audit after all probes. Changing that backend
pipeline is outside this relay script. Before promoting an image, independently
audit a raw unprovisioned clone and exercise provisioning/startup.

Focused regression command:
`npx vitest run src/scripts/snapshotIdentitySeal.test.ts src/scripts/snapshotConfigSeal.test.ts`

Provisioning warning for 256 MiB snapshots:

- The warm snapshot must stay cold: `openclaw-gateway.service` is expected to be stopped/disabled in the image, and backend provisioning performs the first controlled start.
- Backend bootstrap intentionally does not restore the full bundled OpenClaw plugin set during that first start. On real `256 MiB` snapshot-debug e2e runs, enabling bundled self-hosted provider plugins before the gateway bound its port caused pre-listen hangs/readiness failures.
- Current bootstrap policy is: allow `device-pair` during the first gateway start, explicitly deny heavy/problematic plugins (`ollama`, `sglang`, `vllm`, `phone-control`, `talk-voice`, `telegram`, `whatsapp`), then continue with relay provisioning after readiness succeeds.
- `agents.defaults.memorySearch` keeps using the local OpenRouter-compatible embeddings proxy (`OPENROUTER_BASE_URL=http://127.0.0.1:18080/provider-proxy/openrouter/api/v1`) with `text-embedding-3-large`.
- Backend provisioning now also injects `OPENAI_API_KEY=GOLEM_OPENAI_STUB` and `OPENAI_BASE_URL=http://127.0.0.1:18084/provider-proxy/openai/v1`, so Codex app-server and other OpenAI-compatible clients run through the local relay OpenAI proxy instead of calling OpenAI directly. The relay accepts OpenAI `/v1/responses` websocket upgrades only while the active OpenClaw model is `codex/*`.
- Backend provisioning now also rewrites `models.providers.moonshot.baseUrl` to the dedicated local Moonshot relay path `http://127.0.0.1:18083/provider-proxy/moonshot/v1` instead of routing Moonshot through the OpenRouter proxy.
- Internal OpenClaw device pairing is auto-approved by the running `golem-workers-relay.service` process after it connects to the local gateway. That includes the relay backend identity and the local OpenClaw CLI operator identity used by native commands such as `openclaw cron add`. There is no separate agent-side `openclaw-device-pair-auto-approve.service` or timer anymore.
- Local OpenClaw exec approvals are also auto-approved by relay with `allow-once` when the approval targets the local host (`host=sandbox` or `host=gateway`) rather than a remote node. This is intentional for dedicated agent servers so bootstrap/runtime helper commands do not block on `/approve`.
- `telegram` and `whatsapp` are explicitly denied during the first backend-owned bootstrap start even though the snapshot-prep warmup temporarily activated them earlier; this is intentional because the warmed snapshot should preserve on-disk runtime artifacts, not force those channels to stay enabled during the first cold boot.
- Do not "clean this up" by restoring bundled-default plugins in bootstrap unless a fresh real `256 MiB` snapshot replay (`npm run test:e2e:golem-snapshot-debug`) passes end-to-end.

Logs:

- file: `/var/log/golem-workers/prepare-agent-server.log`
- relay logs: `journalctl -u golem-workers-relay --no-pager`

Runtime verification after backend provisioning:

```bash
journalctl -u golem-workers-relay -n 100 --no-pager | rg 'device_pair_auto_approve|exec_approval_auto_approve|pair'
openclaw devices list --json
```

Warmup checkpoints during snapshot preparation:

- In `/var/log/golem-workers/prepare-agent-server.log`, confirm these step markers appear in order: `openclaw_onboard`, `openclaw_snapshot_channels_warmup_config`, `openclaw_snapshot_channels_warmup_start`, `openclaw_snapshot_channels_warmup_status`, `openclaw_snapshot_shutdown`, `openclaw_snapshot_config_seal`, `openclaw_snapshot_identity_seal`, `done`.
- The timestamp gap from `openclaw_snapshot_channels_warmup_start` to `openclaw_snapshot_shutdown` is the one-time warmup cost that should move out of future live server creation.
- The `openclaw channels status --json` output in that log should show both `telegram` and `whatsapp` surfaces present during warmup, even if they are not fully linked to real external credentials yet.

Validation after switching backend provisioning to the warmed snapshot:

- Compare fresh server creation runs before/after the warmed snapshot and focus on backend progress stages `bootstrap_execute`, `openclaw_start`, and `ready_probe`.
- The success criterion is that the first real agent on a fresh server no longer pays the long first-run Telegram/WhatsApp initialization cost inside `openclaw_start`.
- No new heavy server-creation stage should appear; the speedup must come from the warmed snapshot artifacts plus the snapshot-time start/stop cycle above.

Script source:

- `scripts/prepare-agent-server.sh`

After provisioning (not between sealing and snapshot creation), manual onboarding examples follow. Running these commands invalidates the cold identity seal:

Default non-interactive run used by the script:

```bash
source /root/.bashrc
export OPENCLAW_SKIP_CANVAS_HOST=1
export OPENCLAW_LOG_LEVEL=debug
systemctl --user import-environment OPENCLAW_SKIP_CANVAS_HOST OPENCLAW_LOG_LEVEL

  openclaw onboard --install-daemon --non-interactive --accept-risk
```

Interactive alternative:

```bash
source /root/.bashrc
openclaw onboard --install-daemon
```

Non-interactive OpenRouter-through-local-proxy setup closest to backend provisioning:

```bash
source /root/.bashrc
export OPENROUTER_API_KEY="<openrouter-api-key>"
export OPENROUTER_BASE_URL="http://127.0.0.1:18080/provider-proxy/openrouter/api/v1"
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"

openclaw onboard \
  --install-daemon \
  --non-interactive \
  --accept-risk \
  --auth-choice openrouter-api-key \
  --openrouter-api-key "$OPENROUTER_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind lan \
  --gateway-auth token \
  --gateway-token "$OPENCLAW_GATEWAY_TOKEN" \
  --node-manager npm
```

Notes:

- `openclaw onboard` has no dedicated `--openrouter-base-url` flag, so the custom OpenRouter endpoint must be provided via `OPENROUTER_BASE_URL`.
- This gets the onboarding step close to the expected server shape (`openrouter` auth, LAN bind, port `18789`, token auth, daemon install), but backend provisioning still applies the remaining server-specific config such as `env.OPENROUTER_BASE_URL`, extra tool/browser settings, Telegram defaults, and Control UI allowed origins.

Root user npm config persists the `/usr/local` prefix across non-interactive/login shells. Managed Linux runtime uses npm only; `NODE_PATH` points at `npm root -g` for CJS, while missing companion imports use package-local links and import checks. No pnpm binary or shim is installed. Rebuild provider OpenClaw snapshots and select new `activeSnapshotId` after a coordinated backend/Relay release. Existing agents migrate through backend Reinstall (#714), preserving data/settings and rebinding native service/runtime pin. Do not run this snapshot preparation script on existing agents for migration. Hermes and desktop connector builds remain outside this migration.
