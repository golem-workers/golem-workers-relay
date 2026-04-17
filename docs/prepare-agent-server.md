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
- installs Node 22 separately (Linuxbrew is not used to install Node);
- pre-pulls and builds `golem-workers-relay` from `release` by default, or from explicit `RELAY_GIT_REF` when exported before running the script;
- installs `pnpm`, installs the latest OpenClaw and official `@openai/codex` CLI through a hoisted pnpm global package tree, adds stable `/usr/local/bin/openclaw` and `/usr/local/bin/codex` symlinks, writes a managed `~/.codex/config.toml` plus `/usr/local/bin/golem-codex-proxy` wrapper so Codex uses the local OpenAI proxy with API-key auth, prepares runtime dependencies (`grammy`, `@grammyjs/runner`, `@grammyjs/transformer-throttler`, `@buape/carbon`, `@larksuiteoapi/node-sdk`, `@slack/bolt` for the current OpenClaw bundled-plugin import bugs), preinstalls `relay-channel` through `openclaw plugins install`, leaves `relay-channel` disabled until backend provisioning wires the account config, and installs full `playwright`;
- clones/builds `golem-workers-openclaw-channel-plugin` during image prep and installs the generated agent bundle through the OpenClaw plugin CLI, using explicit `RELAY_CHANNEL_PLUGIN_GIT_REF` when exported (otherwise defaulting to the existing relay-ref coupling), so future `RELAY_CHANNEL_V2` provisioning can reuse the prepared plugin install from the snapshot;
- fails the install immediately if `relay-channel` is missing or the OpenClaw install record is malformed, so broken snapshot images are caught during image prep instead of surfacing later at runtime;
- configures OpenClaw/Node runtime env (`NODE_OPTIONS` with 2 GiB heap, `NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN`, `PNPM_HOME`, `NODE_PATH`) for current shell, future login shells, and systemd managers;
- explicitly enables and starts the root user-systemd manager before OpenClaw daemon install (`loginctl enable-linger root`, `systemctl start user@0.service`, `XDG_RUNTIME_DIR=/run/user/0`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`);
- optionally runs `OPENCLAW_SKIP_CANVAS_HOST=1 OPENCLAW_LOG_LEVEL=debug systemctl --user import-environment OPENCLAW_SKIP_CANVAS_HOST OPENCLAW_LOG_LEVEL && openclaw onboard --install-daemon --non-interactive --accept-risk`; on current OpenClaw releases this step may return before its own gateway probe stabilizes on small snapshot VMs, so the script explicitly restarts `openclaw-gateway.service` and waits longer for port `18789` after onboarding instead of trusting the raw `onboard` exit code alone; the script exports `NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps` before this so one-shot OpenClaw/Node commands also inherit the larger heap;
- finishes by stopping, disabling, and resetting `openclaw-gateway.service` so the snapshot stays cold and backend provisioning owns the first gateway start.

Provisioning warning for 256 MiB snapshots:

- The warm snapshot must stay cold: `openclaw-gateway.service` is expected to be stopped/disabled in the image, and backend provisioning performs the first controlled start.
- Backend bootstrap intentionally does not restore the full bundled OpenClaw plugin set during that first start. On real `256 MiB` snapshot-debug e2e runs, enabling bundled self-hosted provider plugins before the gateway bound its port caused pre-listen hangs/readiness failures.
- Current bootstrap policy is: allow `device-pair` during the first gateway start, explicitly deny heavy/problematic plugins (`ollama`, `sglang`, `vllm`, `phone-control`, `talk-voice`, `telegram`), then continue with relay provisioning after readiness succeeds.
- `agents.defaults.memorySearch` keeps using the local OpenRouter-compatible embeddings proxy (`OPENROUTER_BASE_URL=http://127.0.0.1:18080/provider-proxy/openrouter/api/v1`) with `text-embedding-3-large`.
- Backend provisioning now also injects `OPENAI_API_KEY=GOLEM_OPENAI_STUB` and `OPENAI_BASE_URL=http://127.0.0.1:18084/provider-proxy/openai/v1`, so Codex app-server and other OpenAI-compatible clients run through the local relay OpenAI proxy instead of calling OpenAI directly.
- Backend provisioning now also rewrites `models.providers.moonshot.baseUrl` to the dedicated local Moonshot relay path `http://127.0.0.1:18083/provider-proxy/moonshot/v1` instead of routing Moonshot through the OpenRouter proxy.
- Internal OpenClaw device pairing is auto-approved by the running `golem-workers-relay.service` process after it connects to the local gateway. That includes the relay backend identity and the local OpenClaw CLI operator identity used by native commands such as `openclaw cron add`. There is no separate agent-side `openclaw-device-pair-auto-approve.service` or timer anymore.
- Local OpenClaw exec approvals are also auto-approved by relay with `allow-once` when the approval targets the local host (`host=sandbox` or `host=gateway`) rather than a remote node. This is intentional for dedicated agent servers so bootstrap/runtime helper commands do not block on `/approve`.
- `telegram` is explicitly denied even though Telegram channel config may exist, because OpenClaw doctor/auto-fix can auto-enable that plugin from config and silently break the bootstrap assumptions.
- Do not "clean this up" by restoring bundled-default plugins in bootstrap unless a fresh real `256 MiB` snapshot replay (`npm run test:e2e:golem-snapshot-debug`) passes end-to-end.

Logs:

- file: `/var/log/golem-workers/prepare-agent-server.log`
- relay logs: `journalctl -u golem-workers-relay --no-pager`

Runtime verification after backend provisioning:

```bash
journalctl -u golem-workers-relay -n 100 --no-pager | rg 'device_pair_auto_approve|exec_approval_auto_approve|pair'
openclaw devices list --json
```

Script source:

- `scripts/prepare-agent-server.sh`

After script execution without onboard use:

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
  --node-manager pnpm
```

Notes:

- `openclaw onboard` has no dedicated `--openrouter-base-url` flag, so the custom OpenRouter endpoint must be provided via `OPENROUTER_BASE_URL`.
- This gets the onboarding step close to the expected server shape (`openrouter` auth, LAN bind, port `18789`, token auth, daemon install), but backend provisioning still applies the remaining server-specific config such as `env.OPENROUTER_BASE_URL`, extra tool/browser settings, Telegram defaults, and Control UI allowed origins.