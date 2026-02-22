# golem-workers-relay

Relay daemon that pulls tasks from `golem-workers-backend` and executes them via a **local**
OpenClaw Gateway over WebSocket (`ws://127.0.0.1:18789` by default).

## Local OpenClaw Gateway (Docker Compose)

This repo includes a `docker-compose.yml` that runs **only** the OpenClaw Gateway container.
The relay itself is expected to run on the host and connect to localhost.

1) Create an env file for OpenClaw:

```bash
cp openclaw.env.example openclaw.env
```

Set at least:
- `OPENCLAW_GATEWAY_TOKEN` (must match relay `OPENCLAW_GATEWAY_TOKEN`)
- `OPENROUTER_API_KEY` (LLM provider key)
- `DEEPGRAM_API_KEY` (required for Telegram voice transcription)

2) One-command setup (build image, run `openclaw onboard`, start gateway):

```bash
npm run openclaw:setup
```

If you only want to (re)start the container:

```bash
npm run openclaw:up
```

Logs:

```bash
npm run openclaw:logs
```

Control UI:

- Open `http://127.0.0.1:18789/`
- First relay connect may require approving a device pairing request (you'll see `NOT_PAIRED` in relay logs).

Note: the pairing prompt is a side-effect of Docker networking. If you install OpenClaw as a host daemon
(`onboard-host.sh`), relay connects from true localhost and pairing is auto-approved (silent).

Optional CLI (interactive):

```bash
npm run openclaw:cli -- channels login
```

## OpenClaw as a host daemon (recommended for real servers)

If you want a proper daemon/service (launchd on macOS, systemd user service on Linux), run OpenClaw on the host:

```bash
cp openclaw.env.example openclaw.env
# fill OPENCLAW_GATEWAY_TOKEN + OPENROUTER_API_KEY
bash scripts/openclaw/onboard-host.sh openclaw.env
```

After that, you typically do not need Docker for OpenClaw: the daemon keeps the gateway running and relay can use:
`OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789`.

## Reset / wipe (Docker variant)

Stop containers:

```bash
npm run openclaw:down
```

Full reset (stops containers + deletes local OpenClaw state under `./.openclaw` and `./openclaw-workspace`):

```bash
npm run openclaw:reset
```

## E2E test (relay + Docker gateway)

This repo includes an end-to-end test that:
- starts a real OpenClaw Gateway via Docker Compose
- starts the relay on the host (Node process)
- uses a mock backend to verify `pull -> submitResult` works end-to-end

Run:

```bash
npm run test:e2e
```

Notes:
- Requires a working Docker engine (Docker Desktop on macOS).
- The test creates a temporary env-file and uses a dummy `OPENROUTER_API_KEY`; it does not require `openclaw.env`.
- It uses `docker-compose.e2e.yml` (named volumes) and cleans up volumes on exit.

## Relay configuration

Relay reads env vars (see `.env.example`). The OpenClaw-related ones:

- `OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789`
- `OPENCLAW_GATEWAY_TOKEN=<same as in openclaw.env>`
- `OPENCLAW_GATEWAY_PASSWORD=` (optional; token is the baseline)
- `OPENCLAW_SCOPES=operator.admin` (default)
- `DEEPGRAM_API_KEY=` (optional; enables audio transcription when relay receives audio payload)
- `STT_TIMEOUT_MS=15000` (optional, transcription timeout)

Note: relay creates its own device identity on the host under `~/.openclaw` unless
`OPENCLAW_STATE_DIR` is set. This is separate from the gateway's container state.
