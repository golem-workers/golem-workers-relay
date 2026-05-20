# golem-workers-relay

Relay daemon that accepts push messages from `golem-workers-backend` over HTTP and executes them via a **local**
OpenClaw Gateway over WebSocket (`ws://127.0.0.1:18789` by default).
For messenger-backed `relay_channel_v2` transport, relay keeps only routing/context metadata and proxies
secret-dependent provider actions back to backend instead of receiving raw messenger credentials.

The relay also reports the current OpenClaw connectivity state back to backend:

- sends `DISCONNECTED` when startup connect fails or an established gateway connection drops
- throttles repeated disconnect reports to at most once per minute
- sends `CONNECTED` immediately after the gateway connection is restored

For `relay_channel_v2`, relay startup also checks the installed `relay-channel`
plugin version against the current plugin repo ref and automatically rebuilds /
reinstalls the plugin when the installed version is behind.

For `relay_channel_v2` agents, the relay now advertises provider-aware control
plane capability profiles on the local control plane. The top-level hello frame
keeps legacy aggregate capability maps for migration compatibility, while
`providerProfiles` and normalized `providerFeatures` describe the actual
provider/channel surfaces currently wired behind the relay. The currently wired
action surface includes:

- `message.send`, including parse mode, single media, `mediaUrls` batches
  converted to media groups, and `file_id` reuse
- `typing.set`
- `file.download.request` with a local download-token data plane

Relay control-plane transport is now localhost HTTP:

- plugin -> relay: `POST /hello` and synchronous `POST /actions`
- relay -> plugin: local HTTP push into plugin-owned ingress endpoints
- backend->relay inbound delivery only requires the relay control plane to be
  listening; `relayChannelConnected` remains a plugin-link diagnostic and may
  lag briefly while the plugin is re-running `/hello` after a relay restart
- plain text inbound retries are coalesced before delivery with explicit merged boundaries
- typing/account-status/capability updates are latest-wins

The relay push ingress also accepts normalized `transport_event` payloads from
backend. In the current Telegram Bot API architecture, polling/webhook ownership
stays on backend, and relay consumes backend-produced update families such as
`transport.delivery.receipt` and `transport.typing.updated` without introducing
a second Telegram ingress on the agent. Those transport events are now
handle-first on the wire
(`conversation.handle`, `thread.handle`), while legacy `targetScope` and
`transportConversationId` remain optional compatibility fields.

User chat pushes are processed concurrently by default. `RELAY_CONCURRENCY`
defaults to `RELAY_PUSH_MAX_CONCURRENT_REQUESTS` (100 when unset), so relay
does not serialize chat turns globally; OpenClaw is responsible for resolving
ordering for concurrent messages in the same session. Set `RELAY_CONCURRENCY=1`
only when reproducing legacy FIFO behavior.

Generated artifact delivery uses the native relay channel directive form,
`[[media:relative/path.ext]]`.

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
- pre-pulls and builds `golem-workers-relay` from `release` by default, or from explicit `RELAY_GIT_REF` when exported before running the script;
- installs the relay-channel plugin from explicit `RELAY_CHANNEL_PLUGIN_GIT_REF` when exported, otherwise keeps the existing default coupling to the relay ref (`main` -> `main`, everything else -> `release`);
- at runtime, relay also re-checks the installed `relay-channel` package version against the selected plugin repo ref and auto-updates the plugin before opening the relay control plane when the installed version is older;
- installs `pnpm`, installs the latest OpenClaw and official `@openai/codex` CLI through a hoisted pnpm global package tree, adds stable `/usr/local/bin/openclaw` and `/usr/local/bin/codex` symlinks, writes managed `~/.codex/config.toml`, `~/.codex/auth.json`, and `/usr/local/bin/golem-codex-proxy` files so Codex uses explicit API-key login state, explicit `danger-full-access` / `never` defaults, and wrapper-level CLI overrides together with the local OpenAI proxy, prepares runtime dependencies (`grammy`, `@grammyjs/runner`, `@grammyjs/transformer-throttler`, `@buape/carbon`, `@larksuiteoapi/node-sdk`, `@slack/bolt` for the current OpenClaw bundled-plugin import bugs), preinstalls `relay-channel` and `@openclaw/codex` through `openclaw plugins install`, leaves those prepared plugins disabled until backend provisioning wires runtime config, plus full `playwright`; the relay only allows OpenAI `/v1/responses` websocket upgrades while the active OpenClaw model is `codex/*`, and when the agent already has a saved `openai-codex` OAuth profile the relay rewrites `codex/*` model selections to direct `openai-codex/*` execution instead of the websocket proxy path
- configures OpenClaw/Node runtime env (`NODE_OPTIONS` with 2 GiB heap, `NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN`, `PNPM_HOME`, `NODE_PATH`);
- explicitly brings up root user-systemd (`loginctl enable-linger root`, `user@0.service`, `/run/user/0/bus`) before any OpenClaw daemon install work;
- pins guest DNS to the current default gateway before `apt-get upgrade`, so Ubuntu package upgrades do not drop resolver state mid-prepare on small microVMs;
- rewrites `/etc/apt/sources.list` before package installation so the prepare run uses a deterministic Ubuntu mirror set without duplicated entries;
- on Hetzner hosts it prefers `mirror.hetzner.com` (including the `ubuntu-ports` variant on `arm64`) to speed up large Ubuntu package installs during snapshot preparation;
- also accepts `APT_MIRROR_HINT=hetzner` so orchestration can force Hetzner mirrors even when the guest itself only sees generic KVM DMI metadata;
- optionally runs `openclaw onboard --install-daemon`, then explicitly restarts and verifies `openclaw-gateway.service` with an extended readiness window because current OpenClaw releases can come up slowly on small snapshot VMs;
- writes a temporary snapshot-only warmup config that activates `telegram` and `whatsapp`, performs a mandatory `start -> readiness -> channels status -> stop` cycle to force first-run plugin initialization into snapshot prep, and then seals the snapshot back to a cold config for backend-owned bootstrap;
- leaves the image ready for backend provisioning to reuse the prepared `relay-channel` and `codex` plugin installs from the snapshot;
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
- `RELAY_OPENCLAW_TICK_TIMEOUT_MULTIPLIER=10` (default: relay closes the gateway socket only after missing ticks for `hello.policy.tickIntervalMs * multiplier`)
- `OPENAI_STT_BASE_URL=http://backend.example.com/api/v1/relays/openai` (optional; defaults to the backend relay-auth proxy)
- `OPENAI_STT_MODEL=gpt-4o-transcribe` (optional; OpenAI transcription model used for voice transcription)
- `STT_TIMEOUT_MS=15000` (optional, transcription timeout)

Push transport settings:
- `RELAY_PUSH_PORT=18790` (HTTP port where backend sends push messages)
- `RELAY_PUSH_PATH=/relay/messages` (HTTP path for backend push endpoint)
- `RELAY_TASK_TIMEOUT_MS=43200000` (default twelve-hour sliding timeout for a chat task to produce a terminal callback; OpenClaw chat activity refreshes the timeout before relay aborts it and reports `RELAY_TASK_TIMEOUT`)
- `RELAY_SYSTEM_TASK_TIMEOUT_MS=120000` (short hard cap for low-priority system/reminder chat tasks so they cannot block newer user messages)
- `RELAY_CHAT_BATCH_DEBOUNCE_MS=500` (default 500ms debounce for chat batching; lower it to send chats closer to immediately, or raise it to batch more aggressively)
- `RELAY_LOW_DISK_ALERT_ENABLED=1` (when enabled, relay checks disk usage on every processed inbound message and reports low-space technical alerts to backend)
- `RELAY_LOW_DISK_ALERT_THRESHOLD_PERCENT=80` (send low-space alert when used disk percent is at or above this threshold)
- `RELAY_OPENROUTER_PROXY_ENABLED=1` (enable local OpenRouter-compatible proxy listener)
- `RELAY_OPENROUTER_PROXY_PORT=18080` (local proxy port used by agent-side rewrite rules; binds to `127.0.0.1` by default)
- `RELAY_OPENROUTER_PROXY_PATH_PREFIX=/provider-proxy/openrouter` (primary local OpenClaw -> relay OpenRouter path prefix; legacy `/api/v1` stays supported)
- `RELAY_OPENROUTER_BACKEND_PATH_PREFIX=/api/v1/relays/openrouter` (backend relay-auth proxy path)
- `RELAY_JINA_PROXY_ENABLED=1` (enable local Jina-compatible proxy listener for optional backend-side Jina relay traffic)
- `RELAY_JINA_PROXY_PORT=18082` (local proxy port used by Jina embeddings/rerank calls; binds to `127.0.0.1` by default)
- `RELAY_JINA_PROXY_PATH_PREFIX=/provider-proxy/jina` (primary local OpenClaw/client -> relay Jina path prefix; legacy `/v1` stays supported)
- `RELAY_JINA_BACKEND_PATH_PREFIX=/api/v1/relays/jina` (backend relay-auth proxy path)
- `RELAY_GOOGLE_AI_PROXY_ENABLED=1` (enable local Google AI-compatible proxy listener)
- `RELAY_GOOGLE_AI_PROXY_PORT=18081` (local plain-HTTP proxy port used by provisioned OpenClaw configs via `models.providers.google.baseUrl`; binds to `127.0.0.1` by default)
- `RELAY_GOOGLE_AI_PROXY_PATH_PREFIX=/provider-proxy/google-ai` (primary local OpenClaw/client -> relay Google AI path prefix; legacy `/` stays supported)
- `RELAY_GOOGLE_AI_BACKEND_PATH_PREFIX=/api/v1/relays/google-ai` (backend relay-auth proxy path)
- `RELAY_ELEVENLABS_PROXY_ENABLED=1` (enable local ElevenLabs-compatible proxy listener)
- `RELAY_ELEVENLABS_PROXY_PORT=18086` (local plain-HTTP proxy port used by provisioned ElevenLabs helper tools; binds to `127.0.0.1` by default)
- `RELAY_ELEVENLABS_PROXY_PATH_PREFIX=/provider-proxy/elevenlabs` (primary local client -> relay ElevenLabs path prefix; legacy `/v1` stays supported)
- `RELAY_ELEVENLABS_BACKEND_PATH_PREFIX=/api/v1/relays/elevenlabs` (backend relay-auth proxy path)
- `RELAY_FAL_PROXY_ENABLED=1` (enable local fal-compatible proxy listener)
- `RELAY_FAL_PROXY_PORT=18087` (local plain-HTTP proxy port used by provisioned Fal helper tools; binds to `127.0.0.1` by default)
- `RELAY_FAL_PROXY_PATH_PREFIX=/provider-proxy/fal` (primary local client -> relay fal path prefix)
- `RELAY_FAL_BACKEND_PATH_PREFIX=/api/v1/relays/fal` (backend relay-auth proxy path)
- `RELAY_RUNWAY_PROXY_ENABLED=1` (enable local Runway-compatible proxy listener)
- `RELAY_RUNWAY_PROXY_PORT=18085` (local plain-HTTP proxy port used by provisioned Runway helper tools; binds to `127.0.0.1` by default)
- `RELAY_RUNWAY_PROXY_PATH_PREFIX=/provider-proxy/runway` (primary local client -> relay Runway path prefix; legacy `/v1` stays supported)
- `RELAY_RUNWAY_BACKEND_PATH_PREFIX=/api/v1/relays/runway` (backend relay-auth proxy path)
- `RELAY_MOONSHOT_PROXY_ENABLED=1` (enable local Moonshot-compatible proxy listener)
- `RELAY_MOONSHOT_PROXY_PORT=18083` (local plain-HTTP proxy port used by provisioned OpenClaw configs via `models.providers.moonshot.baseUrl`; binds to `127.0.0.1` by default)
- `RELAY_MOONSHOT_PROXY_PATH_PREFIX=/provider-proxy/moonshot` (primary local OpenClaw/client -> relay Moonshot path prefix)
- `RELAY_MOONSHOT_BACKEND_PATH_PREFIX=/api/v1/relays/moonshot` (backend relay-auth proxy path)
- `RELAY_OPENCLAW_FORWARD_FINAL_ONLY=1` (default: only forward compact `delta` typing signals; disable with `0` to forward all raw OpenClaw gateway events)

Note: relay creates its own device identity on the host under `~/.openclaw` unless
`OPENCLAW_STATE_DIR` is set. This is separate from the gateway's container state.

Relay also performs internal local auto-approve passes via the same root-run relay process:
- it auto-approves pending requests where `role=operator`, every requested scope starts with `operator.`, and the client identity is either `clientId=gateway-client` with `clientMode=backend` or the local OpenClaw CLI identity `clientId=cli` with `clientMode=cli`;
- this is intended to unblock local bootstrap/runtime calls such as agent-side `exec` and native `openclaw cron` commands without approving unrelated external device requests.
- it also auto-approves local OpenClaw exec approvals with `allow-once` when the request targets the local host (`host=sandbox` or `host=gateway`) instead of a remote node. This keeps dedicated agent hosts non-interactive for bootstrap/runtime helper commands while leaving node-host approvals untouched.

Provisioned agents use both local listeners together:
- OpenClaw model traffic now goes through `OPENROUTER_BASE_URL=http://127.0.0.1:18080/provider-proxy/openrouter/api/v1`, while legacy local `/api/v1/*` stays supported.
- Optional Jina relay traffic now goes through `http://127.0.0.1:18082/provider-proxy/jina/v1`, while legacy local `/v1/*` stays supported; backend-side credentials stay on the backend and are proxied through relay.
- Gemini web-search traffic goes directly to `http://127.0.0.1:18081/provider-proxy/google-ai/v1beta` via `models.providers.google.baseUrl`, while legacy local root-based URLs stay supported; relay forwards it to backend `/api/v1/relays/google-ai/*`.
- Provisioned ElevenLabs helper tools go directly to `http://127.0.0.1:18086/provider-proxy/elevenlabs/v1`, while legacy local `/v1/*` stays supported; relay forwards it to backend `/api/v1/relays/elevenlabs/*`.
- Provisioned Fal helper tools go directly to `http://127.0.0.1:18087/provider-proxy/fal`; relay forwards them to backend `/api/v1/relays/fal` and the backend route then calls `queue.fal.run`.
- Provisioned Runway helper tools go directly to `http://127.0.0.1:18085/provider-proxy/runway/v1`, while legacy local `/v1/*` stays supported; relay forwards it to backend `/api/v1/relays/runway/*`.
- Moonshot traffic goes directly to `http://127.0.0.1:18083/provider-proxy/moonshot/v1` via `models.providers.moonshot.baseUrl`; relay forwards it to backend `/api/v1/relays/moonshot/*`.
- All relay proxy listeners are local-only by default and bind to `127.0.0.1`, so they are not exposed on external interfaces unless the code is changed intentionally.
- Every proxied HTTP provider request is logged at info level with method, local URL, upstream URL, status, body size, and a whitespace-normalized truncated body preview.
- OpenAI websocket proxy traffic is also logged at info level for successful upgrades, proxied frames, and closes; text frames include the same truncated preview while binary frames log size only.

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
- For Telegram-connected sessions, relay uses the native OpenClaw channel directive form: `[[media:relative/path.ext]]`. Relay resolves local/HTTP media into bytes when needed, then proxies the transport action to backend; backend is the only component that decrypts Telegram credentials and talks to Bot API.
- `reply.media` now carries relay-side file references (`path`, `fileName`, `contentType`, `sizeBytes`) instead of embedding `dataB64`; relay can stream/encode those files for backend transport RPC, and backend still remains the only Telegram API caller.

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
terminal `chat` frames to backend. Instead it sends compact `technical.event=chat.delta_signal` callbacks for
intermediate `delta` events so backend/messenger integrations can surface "agent is typing". Successful transport
delivery is not a hard lock: relay keeps the run state for a bounded quiet-retention window, de-duplicates by
`runId`/`seq`, and continues accepting later same-run user-facing text.

After the primary reply has completed, late user-facing text is delivered through
`technical.event=chat.user_facing_recovery` callbacks. Terminal/final user-facing messages are delivered when they are
distinct from already delivered text. Late `delta` text is buffered by `runId`/`sessionKey` and flushed only after a
short quiet window (or when no terminal ever arrives), so cumulative streams produce one recovery callback instead of a
message per token/chunk.

An OpenClaw `chat.final` event without a `message` is treated as a provisional empty final, not as immediate user
delivery completion. Relay keeps the run correlation open for a short grace window so context-overflow
auto-compaction/retry continuations on the same run/session can still produce a final reply. During that window,
late `delta` events after the empty final are still forwarded and de-duplicated by `runId`/`seq`; `NO_MESSAGE` is
reported only if no user-facing continuation appears before the grace window or the task timeout expires.

When `RELAY_OPENCLAW_FORWARD_FINAL_ONLY=0`, relay keeps the legacy behavior and forwards all raw gateway events as
`outcome=technical`, while still applying the same bounded recovery path for late user-facing assistant text.
