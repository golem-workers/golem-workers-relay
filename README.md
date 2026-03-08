# golem-workers-relay

Relay daemon that accepts push messages from `golem-workers-backend` over HTTP and executes them via a **local**
OpenClaw Gateway over WebSocket (`ws://127.0.0.1:18789` by default).

## Prepare Agent Server

To prepare a fresh agent server directly from this public repo, run:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/main/scripts/prepare-agent-server.sh | sudo bash
```

To skip interactive OpenClaw onboarding during image preparation:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/main/scripts/prepare-agent-server.sh | sudo bash -s -- --skip-openclaw-onboard
```

The script:

- installs base Ubuntu packages, Google Chrome Stable, Go, Linuxbrew, and Node 22;
- pre-pulls and builds `golem-workers-relay`;
- installs OpenClaw plus full `playwright`;
- configures low-power OpenClaw runtime env (`NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN`, `NODE_PATH`);
- optionally runs `openclaw onboard --install-daemon`.

Execution logs are written to:

- `/var/log/golem-workers/prepare-agent-server.log`

See also:

- `docs/prepare-agent-server.md`
- `scripts/prepare-agent-server.sh`

## Local OpenClaw Gateway (Docker Compose)

This repo includes a `docker-compose.yml` that runs **only** the OpenClaw Gateway container.
The relay itself is expected to run on the host and connect to localhost.

1) Create an env file for OpenClaw:

```bash
cp openclaw.env.example openclaw.env
```

Set at least:
- `OPENROUTER_API_KEY` (now can be a non-empty stub value; real key lives in backend proxy)
- no separate STT key is required; voice transcription goes through the local OpenRouter proxy

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

Optional CLI (interactive):

```bash
npm run openclaw:cli -- channels login
```

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
- uses a mock backend to verify relay processing and backend result submission end-to-end

Run:

```bash
npm run test:e2e
```

## Cross-repo relay-messenger stand

Workspace-level relay/messenger stand (real backend + real relay + mock Telegram API + mock OpenClaw WS)
is launched from backend repo:

```bash
cd ../golem-workers-backend
npm run test:e2e:relay-messenger-stand
```

Notes:
- Requires a working Docker engine (Docker Desktop on macOS).
- The test creates a temporary env-file and uses a dummy `OPENROUTER_API_KEY`; it does not require `openclaw.env`.
- It uses `docker-compose.e2e.yml` (named volumes) and cleans up volumes on exit.

## Relay configuration

Relay reads env vars (see `.env.example`). The OpenClaw-related ones:

- `OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789`
- `OPENCLAW_GATEWAY_TOKEN=<secret>` (or `OPENCLAW_GATEWAY_PASSWORD=<secret>`)
- `OPENCLAW_SCOPES=operator.admin` (default)
- `OPENROUTER_STT_BASE_URL=http://127.0.0.1:18080/api/v1` (optional; defaults to the local relay proxy)
- `OPENROUTER_STT_MODEL=openrouter/openai/gpt-audio-mini` (optional; OpenRouter audio-capable model used for transcription)
- `STT_TIMEOUT_MS=15000` (optional, transcription timeout)

Push transport settings:
- `RELAY_PUSH_PORT=18790` (HTTP port where backend sends push messages)
- `RELAY_PUSH_PATH=/relay/messages` (HTTP path for backend push endpoint)
- `RELAY_CHAT_BATCH_DEBOUNCE_MS=1` (near-zero debounce by default; relay still supports batching, but effectively sends chats immediately unless you raise this value)
- `RELAY_OPENROUTER_PROXY_ENABLED=1` (enable local OpenRouter-compatible proxy listener)
- `RELAY_OPENROUTER_PROXY_PORT=18080` (local proxy port used by agent-side rewrite rules)
- `RELAY_OPENROUTER_PROXY_PATH_PREFIX=/api/v1` (OpenRouter-compatible incoming path prefix)
- `RELAY_OPENROUTER_BACKEND_PATH_PREFIX=/api/v1/relays/openrouter` (backend relay-auth proxy path)

Note: relay creates its own device identity on the host under `~/.openclaw` unless
`OPENCLAW_STATE_DIR` is set. This is separate from the gateway's container state.

## Unified Message Flow Logging

Enable the same structured flow logs used by backend with one key:

- `MESSAGE_FLOW_LOG=1`

When enabled, relay emits transition events for:
- backend push accepted/rejected,
- relay -> OpenClaw request/response stages,
- relay callback request/retry/success/failure to backend.

## OpenClaw event forwarding semantics

For `chat` tasks, relay always sends a callback to backend and preserves OpenClaw run events:
- `outcome=reply` when OpenClaw returned a final message.
- `outcome=no_reply` when a run completed without a user-facing message (for example technical/system finalization).
- `outcome=error` when a run failed or was aborted.
- `outcome=technical` for raw OpenClaw gateway events (for example `tick`, `connect.challenge`, `chat` event frames).

Relay includes all collected OpenClaw `chat` events (including intermediate/technical `delta` events) in
`reply.openclawEvents`, `noReply.openclawEvents`, or `error.openclawEvents`.
