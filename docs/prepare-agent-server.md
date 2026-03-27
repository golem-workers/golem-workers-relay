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
- creates swap early so low-memory agents can unpack large packages like Chrome;
- installs Google Chrome Stable;
- configures journald, swap, and DNS;
- installs Go and Linuxbrew;
- installs Node 22 separately (Linuxbrew is not used to install Node);
- pre-pulls and builds `golem-workers-relay` from `release` by default;
- installs the latest OpenClaw, `@lancedb/lancedb`, plus full `playwright`;
- applies a temporary upstream-compat workaround for the current OpenClaw npm bundle layout by writing a dedicated `dist/package.json` runtime manifest for `memory-lancedb`, without changing the package root that `openclaw onboard` uses to find bundled docs/templates on provisioned Linux agents;
- fails the install immediately if the workaround did not make `memory-lancedb` resolvable after install, so broken OpenClaw package layouts are caught during image prep instead of surfacing later at runtime;
- configures OpenClaw/Node runtime env (`NODE_OPTIONS` with 2 GiB heap, `NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN`, `NODE_PATH`) for current shell, future login shells, and systemd managers;
- explicitly enables and starts the root user-systemd manager before OpenClaw daemon install (`loginctl enable-linger root`, `systemctl start user@0.service`, `XDG_RUNTIME_DIR=/run/user/0`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`);
- optionally runs `OPENCLAW_SKIP_CANVAS_HOST=1 OPENCLAW_LOG_LEVEL=debug systemctl --user import-environment OPENCLAW_SKIP_CANVAS_HOST OPENCLAW_LOG_LEVEL && openclaw onboard --install-daemon --non-interactive --accept-risk`; the script exports `NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps` before this so one-shot OpenClaw/Node commands also inherit the larger heap;
- finishes by stopping, disabling, and resetting `openclaw-gateway.service` so the snapshot stays cold and backend provisioning owns the first gateway start.

Provisioning warning for 256 MiB snapshots:

- The warm snapshot must stay cold: `openclaw-gateway.service` is expected to be stopped/disabled in the image, and backend provisioning performs the first controlled start.
- Backend bootstrap intentionally does not restore the full bundled OpenClaw plugin set during that first start. On real `256 MiB` snapshot-debug e2e runs, enabling bundled self-hosted provider plugins before the gateway bound its port caused pre-listen hangs/readiness failures.
- Current bootstrap policy is: allow `device-pair` plus `memory-lancedb` during the first gateway start, explicitly deny heavy/problematic plugins (`ollama`, `sglang`, `vllm`, `phone-control`, `talk-voice`, `telegram`), then continue with relay provisioning after readiness succeeds.
- Backend provisioning configures both `memory-lancedb` and `agents.defaults.memorySearch` to use the local OpenRouter-compatible embeddings proxy (`OPENROUTER_BASE_URL=http://127.0.0.1:18080/api/v1`) with `text-embedding-3-large`; `memory-lancedb` keeps `autoCapture=true` and `autoRecall=true`, while `memorySearch` uses the OpenAI-compatible remote embeddings path instead of the previous local GGUF model.
- Backend bootstrap now also installs `openclaw-device-pair-auto-approve.service` plus `openclaw-device-pair-auto-approve.timer` on the agent. The timer polls every 5 seconds and approves all pending OpenClaw device-pair requests after provisioning starts the gateway, so the base image should not ship a conflicting pre-baked auto-approve unit.
- `telegram` is explicitly denied even though Telegram channel config may exist, because OpenClaw doctor/auto-fix can auto-enable that plugin from config and silently break the bootstrap assumptions.
- Do not "clean this up" by restoring bundled-default plugins in bootstrap unless a fresh real `256 MiB` snapshot replay (`npm run test:e2e:golem-snapshot-debug`) passes end-to-end.

Logs:

- file: `/var/log/golem-workers/prepare-agent-server.log`
- backend-provisioned auto-approve worker: `/var/log/golem-workers/openclaw-device-pair-auto-approve.log`

Runtime verification after backend provisioning:

```bash
HOME=/root XDG_RUNTIME_DIR=/run/user/0 systemctl --user status openclaw-device-pair-auto-approve.timer openclaw-device-pair-auto-approve.service --no-pager -l
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
export OPENROUTER_BASE_URL="http://127.0.0.1:18080/api/v1"
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