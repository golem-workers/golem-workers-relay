# golem-workers-relay

Runtime workload discovery recognizes the managed `/usr/local/bin/openclaw` and
`/usr/bin/openclaw` Gateway launchers as well as installed OpenClaw package entry
scripts. It checks the executable/script argument position and adjacent `gateway`
command, not arbitrary shell/prompt arguments. A launcher's directly respawned
`openclaw-gateway` child remains a Gateway root rather than a busy tool; standalone
or deeper titled processes do not receive that exemption. Gateway descendants and
standalone Codex processes still report busy; an absent/unrecognized Gateway fails closed.
This compatibility check grants no config/model/owner authority or new env setting.

Managed chat harness selection and coordinated release contract: [managed runtime policy](docs/managed-runtime-policy.md). OpenClaw remains the default; authentication is independent of harness choice. Capability 2 supports backend-owned per-agent overrides through the existing token-authenticated backend ingress, without requiring `RELAY_SERVER_ID` on existing agents. Persisted policies retain their server binding and monotonic revision fences. Read-only `managedRuntime.preflight` validates proposed choices before mutation; `config.read` reports persisted policy.

Relay daemon that accepts push messages from `golem-workers-backend` over HTTP and executes them via a **local**
OpenClaw Gateway over WebSocket (`ws://127.0.0.1:18789` by default).
For messenger-backed `relay_channel_v2` transport, relay keeps only routing/context metadata and proxies
secret-dependent provider actions back to backend instead of receiving raw messenger credentials.
Relay owns final user-facing delivery for messenger-backed `relay_channel_v2` runs: OpenClaw `chat.send`
does not auto-deliver through the relay-channel plugin, and relay sends the final reply through backend
transport RPC before reporting `transportDelivered`.
When the plugin already sent during the run (for example via an explicit message tool action), relay reuses
that SDK receipt and skips duplicate delivery.

The relay also reports the current OpenClaw connectivity state back to backend:

- sends `DISCONNECTED` when startup connect fails or an established gateway connection drops
- throttles repeated disconnect reports to at most once per minute
- keeps retrying with backoff when a restarting gateway temporarily rejects a reconnect
- sends `CONNECTED` immediately after the gateway connection is restored

Model assignment writes keep a non-empty `agents.defaults.modelPolicy.allow`
list synchronized with the selected primary and fallback models. Missing or
empty allow-lists remain unrestricted.

Relay owns cron inventory synchronization. It reads all OpenClaw jobs through
the local Gateway plus supported system cron files, removes command/payload
contents, calculates a runtime-independent canonical hash, and stores one
durable pending snapshot until backend returns a matching ACK. Collection runs
every five minutes with startup jitter; unchanged configuration causes no full
push. Backend can request one address-scoped forced refresh through existing
agent control. System cron commands, OpenClaw prompt text, delivery targets,
tokens, and environment values never leave guest.

Before backend auto-hibernates an agent, `lifecycle.activeRuns` combines the
OpenClaw session view with a fail-closed local process probe. The probe reports
only sanitized process kind/id/executable metadata and treats active Codex CLI
processes or descendants of the OpenClaw gateway as runtime workload. Missing
gateway/process telemetry blocks hibernation instead of assuming the agent is
idle.

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

OpenClaw 2026.9.6 stores reply file paths in canonical SQLite transcript
`openclawDelivery.mediaUrls`, not in the public `chat.history` display projection.
On SQLite-based agents (Node 24+), relay reads the exact selected assistant event
read-only, validating its message ID, session key, and run ID before collecting
files. Identity and compressed-size failures stop delivery; display error labels
are never used to guess attachments. Legacy file-based agents keep their existing
transcript path. File containment, size, and ambiguity checks still apply.

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

The backend default snapshot refresh (`golem-workers-backend` `provider:snapshots:prepare-default`)
downloads this script from the selected relay git ref, runs it on a fresh provider
server, creates the provider snapshot from that prepared server, and stores the
resulting snapshot id as the provider account `activeSnapshotId`. Snapshot-level
runtime dependencies belong in this script, not in backend provisioning glue.

The script:

- installs base Ubuntu packages plus agent media/PDF tooling (`ffmpeg`, `poppler-utils`, `imagemagick`, `python3-pip`), Google Meet browser/audio runtime (`xvfb`, `pulseaudio`, `pulseaudio-utils`), Google Chrome Stable, Go, Linuxbrew, and Node 22;
- pre-pulls and builds `golem-workers-relay` from `release` by default, or from explicit `RELAY_GIT_REF` when exported before running the script;
- installs the relay-channel plugin from explicit `RELAY_CHANNEL_PLUGIN_GIT_REF` when exported, otherwise keeps the existing default coupling to the relay ref (`main` -> `main`, everything else -> `release`);
- applies OpenClaw plugin capability consent only when supported, explicitly confirms the trusted local relay-channel archive, and stops writing retired `plugins.installs` authored config on database-first releases, so noninteractive image preparation works across OpenClaw 2026.7.1 and 2026.8.1+;
- at runtime, relay also re-checks the installed `relay-channel` package version against the selected plugin repo ref and auto-updates the plugin before opening the relay control plane when the installed version is older;
- resolves latest OpenClaw and official `@openai/codex` versions once, installs them with npm using `/usr/local` as the global prefix and npm-owned `/usr/local/bin/openclaw` and `/usr/local/bin/codex` launchers, writes managed `~/.codex/config.toml`, `~/.codex/auth.json`, and `/usr/local/bin/golem-codex-proxy` files so Codex pins `CODEX_HOME` to `~/.codex`, uses explicit API-key login state, explicit `danger-full-access` / `never` defaults, disabled Codex hooks, and wrapper-level CLI overrides together with the local OpenAI proxy, prepares runtime dependencies (`grammy`, `@grammyjs/runner`, `@grammyjs/transformer-throttler`, `@buape/carbon`, `@larksuiteoapi/node-sdk`, `@slack/bolt` for the current OpenClaw bundled-plugin import bugs), preinstalls `relay-channel` and a compatible independently-revisioned `@openclaw/codex` package through `openclaw plugins install`, preinstalls the curated safe OpenClaw skills used by the agent creation quiz, patches the installed Codex harness default so OpenClaw native hook relay stays disabled, leaves those prepared plugins disabled until backend provisioning wires runtime config, plus full `playwright`; the relay only allows OpenAI `/v1/responses` websocket upgrades while the active OpenClaw model is `codex/*`
- selects the supported portable fs-safe implementation (`FS_SAFE_NATIVE_MODE=off` and `OPENCLAW_FS_SAFE_NATIVE_MODE=off`) for snapshot commands, login shells, and system/user services. This supports Linux 4.14 microVMs without `openat2` on new OpenClaw versions while preserving archive validation, path containment, and extraction limits; older OpenClaw versions ignore the settings. Relay startup applies the same settings for plugin updates on existing agents. No OpenClaw code patch or unvalidated archive extraction is used;
- configures OpenClaw/Node runtime env (`NODE_OPTIONS` with 2 GiB heap, `NODE_COMPILE_CACHE`, `OPENCLAW_NO_RESPAWN`, `NODE_PATH`);
- explicitly brings up root user-systemd (`loginctl enable-linger root`, `user@0.service`, `/run/user/0/bus`) before any OpenClaw daemon install work;
- pins guest DNS to the current default gateway before `apt-get upgrade`, so Ubuntu package upgrades do not drop resolver state mid-prepare on small microVMs;
- rewrites `/etc/apt/sources.list` before package installation so the prepare run uses a deterministic Ubuntu mirror set without duplicated entries;
- on Hetzner hosts it prefers `mirror.hetzner.com` (including the `ubuntu-ports` variant on `arm64`) for regular packages; security updates always use the official Ubuntu security archive (`ports.ubuntu.com` on `arm64`) to avoid third-party security indices pointing to packages that have not been mirrored yet;
- also accepts `APT_MIRROR_HINT=hetzner` so orchestration can force Hetzner mirrors even when the guest itself only sees generic KVM DMI metadata;
- optionally runs `openclaw onboard --install-daemon`, then explicitly restarts and verifies `openclaw-gateway.service` with an extended readiness window because current OpenClaw releases can come up slowly on small snapshot VMs;
- stops and verifies the onboarded gateway before changing snapshot warmup config or installing/enabling capability plugins, avoiding live-reload/resource-drain races; starts it again only for the mandatory warmup cycle;
- writes a temporary snapshot-only warmup config that activates `telegram` and `whatsapp`, performs a mandatory `start -> readiness -> channels status -> stop` cycle to force first-run plugin initialization into snapshot prep, and then seals the snapshot back to a cold config for backend-owned bootstrap;
- resolves WhatsApp from the same npm registry used by the compatibility version resolver (`npm:@openclaw/whatsapp@<version>`), while preserving `OPENCLAW_WHATSAPP_PLUGIN_SPEC` overrides. Snapshot sealing validates plugin manifests and built entrypoints across legacy install records/extensions, shared npm installs, and per-package npm projects (including WhatsApp), ignoring unfinished install-stage directories;
- leaves the image ready for backend provisioning to reuse the prepared `relay-channel` and `codex` plugin installs from the snapshot;
- performs an offline identity seal after confirming the gateway is stopped: removes gateway token/password, config backups, device/signing identity, runtime databases/sidecars, generated workspace files, histories and Go telemetry. Only neutral config, installed plugin payloads/provenance, authored skills and the Control UI asset cache remain; no OpenClaw CLI command runs after this seal in the prepare script;
- finishes image preparation by stopping and disabling `openclaw-gateway.service` so prepared images boot with OpenClaw cold and backend provisioning performs the first controlled start.

See the [snapshot identity seal contract](docs/prepare-agent-server.md#snapshot-identity-seal-contract) for the retained paths, legacy compatibility, fail-closed checks and post-seal probe restrictions.

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

### Messenger sender approvals

Backend-only channel pairing (`channelPairing.list` / `channelPairing.approve`)
uses the installed OpenClaw `pairing` CLI and the agent's config path. The runtime
owns pending-request expiry, account scoping and atomic approval, including both
legacy and SQLite-backed runtimes. Relay must not read or mutate pairing JSON
files directly. CLI failure or invalid output is an explicit control error, not
an empty approvals list; command output and approval codes are omitted from errors.
No additional environment variables are required; `openclaw` must be on Relay's PATH.

### Shared Codex authorization

Backend-only agent control also supports `config.validate`. It validates the
configured `OPENCLAW_CONFIG_PATH` with `openclaw config validate --json` and
returns success only for a valid effective config. Validation errors use the
stable `OPENCLAW_CONFIG_VALIDATE_FAILED` code with bounded output; config content
and secrets are never returned. Backend config workflows call this after atomic
`config.apply` and before gateway restart.

Agent control supports backend-only `codex.auth.export`, `codex.auth.import`, and
`codex.auth.sync` actions. Export returns one canonical ChatGPT OAuth bundle assembled from the
managed Codex cache and OpenClaw auth stores. Import validates signed-token identity and expiry,
then updates `~/.codex/auth.json`, OpenClaw config, and the canonical runtime auth store with rollback
on failure. Legacy layouts retain their compatibility `auth-profiles.json` files. When OpenClaw owns
the shared store in `~/.openclaw/state/openclaw.sqlite`, relay writes the `authProfiles.store` and
`authProfiles.state` rows there and archives retired JSON stores before live refresh. Sync adds a non-secret local version marker at
`~/.codex/golem-auth-sync.json`. Versions are monotonic within one OpenAI profile; switching to a
different profile applies even when its account-local version is lower. JSON credential writes use
mode `0600` and atomic rename. Runtime SQLite rollback snapshots only two authorization rows, so
sync does not copy or buffer the agent's potentially multi-gigabyte conversation database. Sync
also replaces older OpenAI OAuth profiles and retargets existing session auth pins to the assigned
profile. Import, sync, clear, auth-mode selection, and the final device-login persistence step stop
the OpenClaw gateway before changing auth stores and restart it only after the session pins and
credentials agree. This prevents the live gateway session cache from retaining a deleted profile or
briefly falling through to the managed relay API-key stub during a profile switch. Clear and
auth-mode selection remove OpenAI session pins as needed, so long-lived Telegram and cron sessions
can resolve the next configured auth mode instead of referencing a deleted login.

- `OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789`
- `OPENCLAW_GATEWAY_TOKEN=<secret>` (or `OPENCLAW_GATEWAY_PASSWORD=<secret>`)
- `OPENCLAW_SCOPES=operator.admin` (default)
- `RELAY_OPENCLAW_TICK_TIMEOUT_MULTIPLIER=10` (default: relay closes the gateway socket only after missing ticks for `hello.policy.tickIntervalMs * multiplier`)
- `STT_PROVIDER=openai|openrouter` (optional; defaults to `openai`)
- `OPENAI_STT_BASE_URL=http://backend.example.com/api/v1/relays/openai` (optional; defaults to the backend relay-auth proxy)
- `OPENAI_STT_MODEL=gpt-4o-transcribe` (optional; OpenAI transcription model used for voice transcription)
- `OPENROUTER_STT_BASE_URL=http://127.0.0.1:18080/provider-proxy/openrouter/api/v1` (optional; local authenticated OpenRouter proxy)
- `OPENROUTER_STT_MODEL=google/gemini-2.5-flash` (optional; OpenRouter audio-capable model)
- `STT_TIMEOUT_MS=15000` (optional, transcription timeout)

Push transport settings:
- `RELAY_CRON_INVENTORY_ENABLED=1` (enable relay-owned OpenClaw + system cron inventory)
- `RELAY_CRON_INVENTORY_INTERVAL_MS=300000` (configuration collection interval)
- `RELAY_CRON_INVENTORY_INITIAL_JITTER_MS=30000` (fleet startup jitter before first collection)
- `RELAY_CRON_INVENTORY_RETRY_BASE_MS=5000` (initial snapshot retry backoff)
- `RELAY_CRON_INVENTORY_RETRY_MAX_MS=300000` (maximum snapshot retry backoff)
- `RELAY_PUSH_PORT=18790` (HTTP port where backend sends push messages)
- `RELAY_PUSH_PATH=/relay/messages` (HTTP path for backend push endpoint)
- `RELAY_TASK_TIMEOUT_MS=43200000` (default twelve-hour sliding timeout for a chat task to produce a terminal callback; OpenClaw chat activity refreshes the timeout before relay aborts it and reports `RELAY_TASK_TIMEOUT`)
- `RELAY_SYSTEM_TASK_TIMEOUT_MS=120000` (short hard cap for low-priority system/reminder chat tasks so they cannot block newer user messages)
- `RELAY_CHAT_BATCH_DEBOUNCE_MS=500` (default 500ms debounce for chat batching; lower it to send chats closer to immediately, or raise it to batch more aggressively)
- `RELAY_LOW_DISK_ALERT_ENABLED=1` (when enabled, relay checks disk usage on every processed inbound message and reports low-space technical alerts to backend)
- `RELAY_LOW_DISK_ALERT_THRESHOLD_PERCENT=80` (send low-space alert when used disk percent is at or above this threshold)
- `RELAY_DIAGNOSTIC_NOTIFIER_ENABLED=0` (opt-in runtime diagnostics; when enabled, relay periodically scans configured local journal/log sources for whitelisted error signals and sends debounced one-line user-visible reports through the existing system-notification route)
- `RELAY_DIAGNOSTIC_NOTIFIER_INTERVAL_MS=300000` (diagnostics scan interval)
- `RELAY_DIAGNOSTIC_NOTIFIER_LOOKBACK_MS=300000` (log lookback window per scan; defaults to the scan interval)
- `RELAY_DIAGNOSTIC_NOTIFIER_THROTTLE_MS=600000` (minimum time before repeating the same diagnostics fingerprint)
- `RELAY_DIAGNOSTIC_NOTIFIER_MAX_LINES=2000` (maximum recent log lines analyzed per scan)
- `RELAY_DIAGNOSTIC_NOTIFIER_JOURNAL_USER_UNITS=openclaw-gateway.service` (comma-separated user journal units to scan)
- `RELAY_DIAGNOSTIC_NOTIFIER_JOURNAL_SYSTEM_UNITS=golem-workers-relay.service` (comma-separated system journal units to scan)
- `RELAY_DIAGNOSTIC_NOTIFIER_LOG_FILES=` (optional comma-separated extra log files to scan)
- `RELAY_DIAGNOSTIC_NOTIFIER_USER_ID=` (optional backend user id route filter; leave blank to notify the most recent user-visible conversation route)
- `RELAY_SELF_NUDGE_FINAL_NOTICE_ENABLED=0` (opt-in debug notice; when enabled, relay sends a short system notification when self-nudge analysis decides the latest user request already has a final answer)
- `RELAY_SELF_NUDGE_FINAL_NOTICE_TEXT=Final message.` (text for the opt-in self-nudge final-answer notice)
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

### Readiness after hibernation

A backend handshake performs a live gateway `health` RPC before reporting fresh `CONNECTED` readiness. This also works when a restored VM preserves its local websocket and emits no reconnect event; cached `hello-ok` alone is not liveness evidence. Failed probes do not advance readiness.

### Rolling OpenAI token usage
Authorization usage reports include `rolling24h` (`windowStart`, `windowEnd`, `totalTokens`).
A separate `sessions.usage` query uses a supported fixed UTC offset so one date covers
exactly the previous 24 hours ending at the report's current UTC minute. OpenClaw filters
individual timestamped records; no calendar-day sums are prorated. Only OpenAI provider
aliases are counted. Fresh caches are required; failures do not publish a fabricated zero.
Collection retains the configured authorization-usage interval (hourly by default); consumers
show the window end and data freshness. Deploy backend + its migration before this relay.

### Enterprise model activation fence
`model.set` optionally accepts a caller-issued UUID `fence.revision` and nullable
`fence.predecessor`. The central control handler serializes config operations with
Linux util-linux `flock` (already included by the agent preparation image), using
an inherited open descriptor so process death releases ownership. Never delete the
lock file to recover it: its inode is the coordination identity.

The adjacent `.model-fence.json` journal is atomically renamed and fsynced before
mutation. `model.fence.read` observes ownership; `model.fence.reconcile` takes the
same lock and leaves observed operations UNRESOLVED, or installs a CANCELLED
revision tombstone under predecessor CAS for undelivered requests. It never claims
runtime success. Delayed requests and duplicate revisions cannot run after that
tombstone. Once fencing is established, legacy model.set and modelAssignment.set cannot
bypass it. Whole-config operations require expectedRevision CAS and unchanged
agent/model/provider/auth/environment routing; native harness-only convergence
is allowed so existing owner/channel and managed Pi convergence remain legal. APPLIED means the config/restart handler returned a
validated result, not provider-auth/runtime verification; the backend must verify
runtime before ACTIVE. Surviving systemctl restart carries no model/config payload
and cannot restore an old config; unresolved operations still require a new fenced
activation and verification. Unsupported old relays must remain fail-closed.

`model.verify` is a real inference probe, not a catalog/readiness alias. It checks
zero fallbacks and maps stored `openai/<id>` plus native OpenClaw/Pi runtime metadata
back to the `codex/<id>` subscription wire alias. Active persisted OAuth and absence
of API-key, endpoint/environment or explicit API-transport overrides are required;
native harness metadata alone is not proof of subscription billing. A fresh session must
resolve the selected defaults, return an inference reply, and persist the same
actual provider/model and runtime. Failed probes are aborted; their sessions and
transcripts are deleted on all settled paths. Unit tests stub the gateway/runner;
no demo or test performs real provider inference.
### Authorization cold-start handling

Authorization assignment checks the latest Codex version, canonical npm entrypoint,
managed config and executable wrapper before skipping installation/restart. Explicit
runtime Update retains its repair behavior. Relay live auth refresh has a dedicated
120-second budget (independent of channel status); assignment allows 600 seconds
for refresh and possible rollback. Credential mutations are not blindly retried.
A successful Gateway health probe alone does not prove authorization readiness.

### ChatGPT authorization route reconciliation

Installing or reselecting ChatGPT authorization removes conflicting OpenAI
`baseUrl`/`apiKey` provider overrides and `OPENAI_API_KEY`/`OPENAI_BASE_URL`
from both root `env` and `env.vars`. Other providers, model metadata and TTS
settings are retained. Relay also removes legacy managed systemd API routing.
Only a stale-route repair restarts Gateway during shared-auth sync; a clean
same-version sync remains a no-op. Refresh failure restores auth, config and
service environment before reloading the previous state. API-key mode is not
subject to ChatGPT cleanup.

Enterprise assignment always invokes this idempotent reconciliation, including
for an already ACTIVE account. Before reporting ACTIVE it runs `model.verify`: an
isolated CLI session with a unique response marker, expected-model validation
and no channel delivery. A valid saved login alone is insufficient. Verification
failure is reported as FAILED (credentials may already be installed); retrying
reconciles and verifies again. Background token rotation does not run paid model
probes. Roll out the Relay action support before this backend change.

Each sync refresh phase bounds connection readiness plus auth refresh to 240
seconds (the RPC itself remains 120 seconds). Sync allows 600 seconds for
repair/restart/refresh and rollback; the isolated
model probe uses a 90-second model deadline, 120-second process deadline and
150-second backend request deadline. No new environment settings are required.

### Waiting-session reconciliation

While lifecycle runs are `WAITING`, Relay checks the local Gateway's
`sessions.list` every 30 seconds. Unchanged observations produce no backend
requests. Explicit `done`, `failed`, `timeout`, or `killed` status for the same
session, with no active run, is published through the lifecycle outbox once.
Live events continue to handle resumption and approval changes; a newer live
event wins over an in-flight poll. Polling stops on Gateway disconnect and when
no waiting runs remain, and resumes from the backend checkpoint on reconnect.

Missing sessions (including those outside the 200-row list window), unknown
status, failed requests, or active runs are not evidence of completion. Those
cases remain waiting for a subsequent observation; there is no age-based expiry.

Waiting runs are tracked independently by run identity. A later turn in the same
session does not discard an older wait; verified terminal session state closes
all retained waits. Live activity invalidates in-flight evidence for that session.
Backend checkpoint recovery also retains multiple waits from the same session.
## Managed agent harness

Model assignments and OpenAI OAuth provisioning select the native OpenClaw (Pi)
harness (`agentRuntime.id = "openclaw"`). Public `codex/` subscription model aliases
remain accepted and resolve to the same OpenAI model; they do not select Codex CLI.
Existing model parameters, credentials, and primary/fallback choices are preserved.

GPT-6.1-Sol native Pi compatibility registers model metadata missing from OpenClaw
2026.9.7. Subscription aliases keep the ChatGPT Responses transport; platform model
assignments retain OpenAI Responses. No model ID, credential or endpoint is replaced.

### Narrow Telegram owner convergence
config.read reports owner-fence version 1, disk revision and fresh Gateway effective-config acknowledgment where supported. config.apply accepts ownerFence and expectedRevision; common Relay config mutations preserve the latest numeric owner projection. A durable high-water sidecar rejects stale owner revisions; CAS rejects late rollback over a newer config. Kernel flock releases on process exit, with no permanently orphaned mkdir lock. Existing config validation semantics and model/auth/media choices are retained.

This is eventual config delivery, not a provider lifecycle protocol or continuously leased Gateway. No ExecStart wrapper, automatic wake, stop-before-grant, fleet enrollment or snapshot guarantee. An unavailable Gateway cannot certify revocation; residual wildcard/imported authority is not complete denial.

Model verification requires Gateway runtime metadata (`resolved.agentRuntime.id`) and independently checks the historical inference producer (`entry.agentHarnessId`). Pairing inventory reads do not activate or persist incoming managed policy; approval operations retain mutation fences.

### Nonsecret runtime-auth proof for shared backend Update/Sync

`config.read` accepts optional `includeRuntimeAuthContext=true`; only this
opt-in response includes `runtimeAuthContext={version:1,subscriptionAuth,apiKeyAuth}`.
The booleans come from the generated offline runtime-store reader used by
managed commits, including shared SQLite ownership; they do not come from CLI
login availability, pending login, or OAuth expiry. No credentials or profile
metadata are exported, no auth/config/service mutation is performed, and
ordinary config reads do not add this strict offline-reader probe (their existing runtime-context path can still read credential stores). Malformed stores fail closed
for opt-in reads. The backend #676 phase-1 Sync consumer requires this proof
for Codex agents; deploy a compatible Relay before that backend consumer.
No new environment variable or policy revision; existing identity/owner/model
fences and commit-time auth rechecks remain unchanged.

## Canonical Sync model fence (#676)
Fenced config apply and the final protocol-2 commit boundary normalize a cloned predecessor with the same locked managed policy and target auth context as canonical Sync. Generated Sol catalog augmentation is compared like-for-like; operational compaction/turn budgets use whole-config CAS rather than the model-selection fence. Selected models and thinking defaults, provider endpoints/auth, owner/transport fences and revision CAS remain protected. No live source rewrite or new environment switch is introduced.

### Config sync model fence

Canonical managed-runtime policy separates model routing from operational agent
settings: compaction and turn budgets use config CAS without requiring a model
selection transition. Model assignments/catalogs, request transport overrides,
provider routes and auth remain protected. Deploy with the matching backend
canonical policy digest; do not disable owner, CAS or model fences.
OAuth disconnect and startup of unchanged persisted Codex authority permit absent credentials for structural convergence only. Model/preflight activation remains credential-gated; unsupported routes and policy/owner/model fences remain enforced. Deploy with the matching backend canonical policy digest.

Managed Linux runtime uses npm only; `NODE_PATH` points at `npm root -g` for CJS, while missing companion imports use package-local links and import checks. No pnpm binary or shim is installed. Rebuild provider OpenClaw snapshots and select new `activeSnapshotId` after a coordinated backend/Relay release. Existing agents migrate through backend Reinstall (#714), preserving data/settings and rebinding native service/runtime pin. Do not run this snapshot preparation script on existing agents for migration. Hermes and desktop connector builds remain outside this migration.

Runtime config commits use managed commit protocol 2: scoped policy generation, model routing protection, captured-config CAS, and owner revocation projection under model then owner kernel locks. Model high-water marks on production agents survive `.openclaw` restore under `/var/lib/golem-workers/owner-fence`. Plain read-only diagnostics omit incoming authority and remain available under held writer locks. Explicitly supplied policy/digest must pass ingress, server binding, revision and digest checks even on diagnostics, without activation or sidecar writes; mutation/preflight peers must match the generated backend policy release. Legacy selection settlement retains a separate CAS-bound locked barrier. Doctor/config command children may inherit verified lock descriptors for the mutation interval. Rollback requires this compatible release; unmodified fdcb021/v1 writers must be drained before backend cutover. See the backend `docs/runtime-coordination.md` for the coordinated SQL/agent/backend rollout order.

Detached OAuth login persistence reacquires independent model/owner kernel custody rather than borrowing the ingress request’s asynchronous context. It rechecks policy before side effects and retains custody through credential/config writes, rollback and Gateway recovery. Unrelated diagnostics remain read-only; concurrent writers get the existing bounded busy/refusal contract.
Established model fences reject legacy/unbound credential mutations before service, network or store changes. Matching authenticated backend schema-2 authority is required for login/auth mutation; ordinary status and credential export remain read-only. This prevents a refused config projection from stranding a partially changed credential store.
