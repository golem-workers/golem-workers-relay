# Prepare Agent Server

Run directly from the public repo:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/main/scripts/prepare-agent-server.sh | sudo bash
```

If you want to skip interactive OpenClaw onboarding during base image preparation:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/main/scripts/prepare-agent-server.sh | sudo bash -s -- --skip-openclaw-onboard
```

What it does:

- installs base Ubuntu packages;
- installs `ffmpeg` for relay voice transcription/conversion;
- creates swap early so low-memory agents can unpack large packages like Chrome;
- installs Google Chrome Stable;
- configures journald, swap, and DNS;
- installs Go and Linuxbrew;
- installs Node 22 separately (Linuxbrew is not used to install Node);
- pre-pulls and builds `golem-workers-relay`;
- installs the latest OpenClaw plus full `playwright`;
- configures OpenClaw/Node runtime env (`NODE_OPTIONS` with 2 GiB heap, `NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN`, `NODE_PATH`) for current shell, future login shells, and systemd managers;
- explicitly enables and starts the root user-systemd manager before OpenClaw daemon install (`loginctl enable-linger root`, `systemctl start user@0.service`, `XDG_RUNTIME_DIR=/run/user/0`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`);
- installs and starts `gw-warm-quiesce-helper.service` on port `18555` for provider warm-image freeze/thaw orchestration;
- optionally runs `OPENCLAW_SKIP_CANVAS_HOST=1 OPENCLAW_LOG_LEVEL=debug systemctl --user import-environment OPENCLAW_SKIP_CANVAS_HOST OPENCLAW_LOG_LEVEL && openclaw onboard --install-daemon --non-interactive --accept-risk`; the script exports `NODE_OPTIONS=--max-old-space-size=2024 --enable-source-maps` before this so one-shot OpenClaw/Node commands also inherit the larger heap;
- finishes by stopping, disabling, and resetting `openclaw-gateway.service` so the snapshot stays cold and backend provisioning owns the first gateway start.

Provisioning warning for 256 MiB snapshots:

- The warm snapshot must stay cold: `openclaw-gateway.service` is expected to be stopped/disabled in the image, and backend provisioning performs the first controlled start.
- Backend bootstrap intentionally does not restore the full bundled OpenClaw plugin set during that first start. On real `256 MiB` snapshot-debug e2e runs, enabling bundled self-hosted provider plugins before the gateway bound its port caused pre-listen hangs/readiness failures.
- Current bootstrap policy is: allow only `device-pair` during the first gateway start, explicitly deny heavy/problematic plugins (`ollama`, `sglang`, `vllm`, `phone-control`, `talk-voice`, `telegram`), then continue with relay provisioning after readiness succeeds.
- `telegram` is explicitly denied even though Telegram channel config may exist, because OpenClaw doctor/auto-fix can auto-enable that plugin from config and silently break the bootstrap assumptions.
- Do not "clean this up" by restoring bundled-default plugins in bootstrap unless a fresh real `256 MiB` snapshot replay (`npm run test:e2e:golem-snapshot-debug`) passes end-to-end.

Warm-image note:

- When a provider clones a Firecracker `warm_image`, backend bootstrap is still expected to run on the new server.
- Provider-side warm clones now restore inside per-clone Linux network namespaces so multiple clones can coexist with the source VM on one host.
- The clone keeps the guest-internal network identity from snapshot memory; provider/bastion access is exposed through a separate provider-assigned access IP.
- Warm-image cloning replaces SSH access material on the cloned overlay and backend provisioning reapplies relay/OpenClaw runtime config for the new agent identity.
- Strict warm-image creation now depends on the in-guest quiesce helper, which freezes `/` before capture and thaws it after resume/restore.

Logs:

- file: `/var/log/golem-workers/prepare-agent-server.log`

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