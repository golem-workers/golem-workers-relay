# golem-workers-relay

Relay daemon that accepts push messages from `golem-workers-backend` over HTTP and executes them via a **local**
OpenClaw Gateway over WebSocket (`ws://127.0.0.1:18789` by default).

The relay also reports the current OpenClaw connectivity state back to backend:

- sends `DISCONNECTED` when startup connect fails or an established gateway connection drops
- throttles repeated disconnect reports to at most once per minute
- sends `CONNECTED` immediately after the gateway connection is restored

For `relay_channel_v2` agents, the relay now advertises provider-aware control
plane capability profiles on the local control plane. The top-level hello frame
keeps legacy aggregate capability maps for migration compatibility, while
`providerProfiles` and normalized `providerFeatures` describe the actual
provider/channel surfaces currently wired behind the relay. The currently wired
action surface includes:

- `message.send`, including parse mode, single media, media groups, and
  `file_id` reuse
- `file.download.request` with a local download-token data plane

The relay push ingress also accepts normalized `transport_event` payloads from
backend. In the current Telegram Bot API architecture, polling/webhook ownership
stays on backend, and relay consumes backend-produced update families such as
`transport.delivery.receipt` without introducing
a second Telegram ingress on the agent. Those transport events are now
handle-first on the wire
(`conversation.handle`, `thread.handle`), while legacy `targetScope` and
`transportConversationId` remain optional compatibility fields.

Legacy `MEDIA:` artifact recovery remains only for `legacy_push_v1`.

## Git Line Endings

- This repository enforces `LF` line endings for all text files via `.gitattributes`.
- On Windows, keep Windows Git and WSL Git aligned to avoid CRLF-only dirty worktrees around image-prep and release flows.

## Prepare Agent Server

To prepare a fresh agent server directly from this public repo, run:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/release/scripts/prepare-agent-server.sh | sudo bash
```

To skip interactive OpenClaw onboarding during image preparation:

```bash
curl -fsSL https://raw.githubusercontent.com/golem-workers/golem-workers-relay/release/scripts/prepare-agent-server.sh | sudo bash -s -- --skip-openclaw-onboard
```

The script:

- installs base Ubuntu packages plus agent media/PDF tooling (`ffmpeg`, `poppler-utils`, `imagemagick`, `python3-pip`), Google Chrome Stable, Go, Linuxbrew, and Node 22;
- pre-pulls and builds `golem-workers-relay` from `release` by default;
- installs the latest OpenClaw, prepares runtime dependencies (`memory-lancedb-pro@beta`, `grammy`), preinstalls `relay-channel` into the OpenClaw workspace plugin directory, plus full `playwright`;
- configures OpenClaw/Node runtime env (`NODE_OPTIONS` with 2 GiB heap, `NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN`, `NODE_PATH`);
- explicitly brings up root user-systemd (`loginctl enable-linger root`, `user@0.service`, `/run/user/0/bus`) before any OpenClaw daemon install work;
- optionally runs `openclaw onboard --install-daemon`;
- leaves the image ready for backend provisioning to enable `memory-lancedb-pro` and reuse the prepared `relay-channel` files from the snapshot plugin path;
- finishes image preparation by stopping and disabling `openclaw-gateway.service` so prepared images boot with OpenClaw cold and backend provisioning performs the first controlled start.

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
- `OPENAI_STT_BASE_URL=http://backend.example.com/api/v1/relays/openai` (optional; defaults to the backend relay-auth proxy)
- `OPENAI_STT_MODEL=gpt-4o-transcribe` (optional; OpenAI transcription model used for voice transcription)
- `STT_TIMEOUT_MS=15000` (optional, transcription timeout)

Push transport settings:
- `RELAY_PUSH_PORT=18790` (HTTP port where backend sends push messages)
- `RELAY_PUSH_PATH=/relay/messages` (HTTP path for backend push endpoint)
- `RELAY_CHAT_BATCH_DEBOUNCE_MS=500` (default 500ms debounce for chat batching; lower it to send chats closer to immediately, or raise it to batch more aggressively)
- `RELAY_LOW_DISK_ALERT_ENABLED=1` (when enabled, relay checks disk usage on every processed inbound message and reports low-space technical alerts to backend)
- `RELAY_LOW_DISK_ALERT_THRESHOLD_PERCENT=80` (send low-space alert when used disk percent is at or above this threshold)
- `RELAY_OPENROUTER_PROXY_ENABLED=1` (enable local OpenRouter-compatible proxy listener)
- `RELAY_OPENROUTER_PROXY_PORT=18080` (local proxy port used by agent-side rewrite rules; binds to `127.0.0.1` by default)
- `RELAY_OPENROUTER_PROXY_PATH_PREFIX=/api/v1` (OpenRouter-compatible incoming path prefix)
- `RELAY_OPENROUTER_BACKEND_PATH_PREFIX=/api/v1/relays/openrouter` (backend relay-auth proxy path)
- `RELAY_JINA_PROXY_ENABLED=1` (enable local Jina-compatible proxy listener for `memory-lancedb-pro`)
- `RELAY_JINA_PROXY_PORT=18082` (local proxy port used by Jina embeddings/rerank calls; binds to `127.0.0.1` by default)
- `RELAY_JINA_PROXY_PATH_PREFIX=/v1` (Jina-compatible incoming path prefix)
- `RELAY_JINA_BACKEND_PATH_PREFIX=/api/v1/relays/jina` (backend relay-auth proxy path)
- `RELAY_GOOGLE_AI_PROXY_ENABLED=1` (enable local Google AI-compatible proxy listener)
- `RELAY_GOOGLE_AI_PROXY_PORT=18081` (local plain-HTTP proxy port used by the agent-side TLS interceptor for Gemini web search; binds to `127.0.0.1` by default)
- `RELAY_GOOGLE_AI_PROXY_PATH_PREFIX=/` (forward all Google AI request paths from the local interceptor)
- `RELAY_GOOGLE_AI_BACKEND_PATH_PREFIX=/api/v1/relays/google-ai` (backend relay-auth proxy path)
- `RELAY_OPENCLAW_FORWARD_FINAL_ONLY=1` (default: only forward compact `delta` typing signals; disable with `0` to forward all raw OpenClaw gateway events)

Note: relay creates its own device identity on the host under `~/.openclaw` unless
`OPENCLAW_STATE_DIR` is set. This is separate from the gateway's container state.

Relay also performs internal local auto-approve passes via the same root-run relay process:
- it auto-approves pending requests where `role=operator`, every requested scope starts with `operator.`, and the client identity is either `clientId=gateway-client` with `clientMode=backend` or the local OpenClaw CLI identity `clientId=cli` with `clientMode=cli`;
- this is intended to unblock local bootstrap/runtime calls such as agent-side `exec` and native `openclaw cron` commands without approving unrelated external device requests.
- it also auto-approves local OpenClaw exec approvals with `allow-once` when the request targets the local host (`host=sandbox` or `host=gateway`) instead of a remote node. This keeps dedicated agent hosts non-interactive for bootstrap/runtime helper commands while leaving node-host approvals untouched.

Provisioned agents use both local listeners together:
- OpenClaw model traffic still goes through `OPENROUTER_BASE_URL=http://127.0.0.1:18080/api/v1`.
- `memory-lancedb-pro` Jina embedding/rerank traffic goes through `http://127.0.0.1:18082/v1` with a stub `JINA_API_KEY`; relay replaces it with the real backend-side key.
- Gemini web-search traffic is intercepted transparently by the backend bootstrap via local TLS/hosts rewrites for `generativelanguage.googleapis.com` and then forwarded through relay to backend `/api/v1/relays/google-ai/*`.
- All relay proxy listeners are local-only by default and bind to `127.0.0.1`, so they are not exposed on external interfaces unless the code is changed intentionally.

## Unified Message Flow Logging

Enable the same structured flow logs used by backend with one key:

- `MESSAGE_FLOW_LOG=1`

When enabled, relay emits transition events for:
- backend push accepted/rejected,
- relay -> OpenClaw request/response stages,
- relay callback request/retry/success/failure to backend.

For chat media:
- `audio` is transcribed before `chat.send`.
- `image` is normalized to `640x480` with aggressive PNG palette compression on relay and then forwarded to OpenClaw as multimodal `image_url` content parts using base64 `data:` URLs.
- `video` is accepted too, and relay now saves the original uploaded video into the OpenClaw workspace so the agent/runtime can inspect the full file instead of a preview frame.
- If the connected gateway rejects the structured multimodal payload, relay retries once using uploaded workspace files so the turn still reaches the agent with file references.
- For Telegram-connected `legacy_push_v1` sessions, relay injects a delivery hint for generated artifacts: when the agent wants to return a real file to the user, it should save the artifact in the OpenClaw workspace and include a final `[[media:relative/path.ext]]` directive so relay can attach that file in `reply.media`.
- For Telegram-connected `relay_channel_v2` sessions, relay uses the same native OpenClaw channel directive form: `[[media:relative/path.ext]]`. Those sends are executed directly on the relay control plane and are not re-delivered through backend Telegram outbound workers.
- Relay still parses legacy `MEDIA: relative/path.ext` replies from older transcripts and agents for backward compatibility, but new prompts and skills should emit `[[media:...]]`.
- `reply.media` now carries relay-side file references (`path`, `fileName`, `contentType`, `sizeBytes`) instead of embedding `dataB64`; backend downloads those files from relay only when it needs to deliver them to Telegram.

## OpenClaw event forwarding semantics

For `chat` tasks, relay always sends a callback to backend and preserves OpenClaw run events:
- `outcome=reply` when OpenClaw returned a final message.
- `outcome=reply_chunk` for each streamed assistant text chunk extracted from intermediate `chat.delta` events.
- `outcome=no_reply` when a run completed without a user-facing message (for example technical/system finalization).
- `outcome=error` when a run failed or was aborted.
- `outcome=technical` for gateway-side signals.

Relay includes all collected OpenClaw `chat` events (including intermediate/technical `delta` events) in
`reply.openclawEvents`, `noReply.openclawEvents`, or `error.openclawEvents`.

By default (`RELAY_OPENCLAW_FORWARD_FINAL_ONLY=1`) relay does not forward raw `tick`, `connect.challenge`, or raw
terminal `chat` frames to backend. Instead it sends only compact `technical.event=chat.delta_signal` callbacks for
intermediate `delta` events so backend/messenger integrations can surface "agent is typing". In the same mode relay now
also extracts plain assistant text from `chat.delta` payloads and forwards that text as `outcome=reply_chunk`
callbacks so backend can batch and deliver those chunks to the messenger after a short inactivity window.

When `RELAY_OPENCLAW_FORWARD_FINAL_ONLY=0`, relay keeps the legacy behavior and forwards all raw gateway events as
`outcome=technical`, while still sending `outcome=reply_chunk` for plain assistant text chunks.
