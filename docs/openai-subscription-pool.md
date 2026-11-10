# Subscription-only OAuth pools (draft, epic backend #841)

`config.read` advertises `subscriptionPoolVersion: 1` and the current
`subscriptionPoolCompatibility` predicate. The backend must require both before
recording membership intent. Older runtimes fail closed; no legacy singleton
writer fallback is permitted.

`codex.auth.pool.sync` is a full ordered membership snapshot, not an add-then-clear
sequence. Account IDs map to stable `openai:golem-<accountId>` profile IDs. Revision
and per-account credential version/digest fence stale writes. The durable manifest
contains metadata/digests only; plaintext credentials are never stored there.
Pending manifest precedes SDK writes and is retried exactly after an ambiguous
failure. An applied result follows successful Gateway auth refresh.

Runtime SQLite is owned by the **installed public OpenClaw SDK** resolved from the
active executable, not an invented auth-only DB. The SDK transaction preserves
unrelated keys/providers and cooldown/usage metadata. Equivalent legacy OAuth
aliases are adopted, not copied into two independently refreshed profiles;
unassigned unknown OAuth identities reject the operation before mutation.
Disabled/removed subscriptions are absent from the active auth store. Only the
backend holds the shared refresh token; runtime copies are access-only and
`copyToAgents: true` so the shared machine store is visible to main/nested native
agent scopes. Refresh material never leaves backend custody. Main-agent session pins are cleared/reclassified through
the public session SDK without changing session history/activity.

A qualified explicit `openai-chatgpt-responses` route is required. Do not change
Harness/model/reasoning during auth. Reject direct provider API auth overrides,
unqualified/custom endpoints and outer-model fallbacks. Stored API keys and other
providers are preserved but cannot become candidates on this route. Empty or
exhausted pool is an error, never API/credits/provider/model fallback.

Manifest presence fences legacy provider-wide writers, even after last-member
removal. Do not delete it to bypass policy. An explicit pool-exit workflow is not
part of this draft. Public-SDK local store/session preservation and fresh nested
store inheritance are tested. Attended dev-api qualification additionally proved
real native/Codex A/B, shared refresh/fanout, refresh racing removal, tool-effect
exactly-once, controlled exhaustion before dispatch and lossless flag-off reconcile.
See the backend's `docs/architecture/openai-subscription-pool-attended.md` in PR #852.

These controlled observed windows are not guaranteed per-attempt usage telemetry.
Nested inference, native/cron/external completeness and the broader provider
lifecycle matrix remain release gates. Public model/LLM hooks do not expose actual
OAuth-profile selection; never infer it from preferred membership order.

## Observed token journal and automatic-pin recovery

`ChatRunner` inspects only managed main-agent automatic pins before dispatch. An
unavailable/removed/disabled pin is cleared through the installed public SDK under
session-ID/profile/source CAS. Explicit user pins, foreign profiles and healthy
pins are not touched. Session identity, activity and transcript remain intact;
OpenClaw still chooses the next eligible subscription. Its session-init conflict
can require the existing bounded retry (before model execution); no history reset,
model/Harness change, blind tool replay or new API/credit fallback is added.

Before/after public session/transcript observations feed a durable mode-0600
`golem-subscription-usage.json` journal under the OpenClaw state directory. It stores
only bounded metadata/counters, never prompts or OAuth credentials. Delivery uses
`POST /api/v1/relays/authorization-usage-events`; backend migration must land first.
Normal completion flushes immediately; the existing enabled authorization reporter
also retries the outbox. Existing `RELAY_AUTHORIZATION_USAGE_ENABLED=false` disables
both this production collector and the aggregate reporter; reenabling it allows
the durable outbox to replay. Eligibility/pin safety is independent of usage opt-out.
Backend failures do not change the chat outcome.

The method is `SESSION_WINDOW`, not guaranteed per-dispatch billing attribution.
Only one new assistant usage row in a successful, nonoverlapping observed window
receives its final session profile. Ambiguous/failed/recovered windows are UNKNOWN.
Stable transcript message IDs deduplicate all retries, including acknowledgments
lost after backend commit. In-flight membership changes cannot relabel an old
reply from current pool order. External/native/cron requests outside `ChatRunner`
and pre-collector history are not claimed as covered. Long/unreadable transcripts
or unavailable SDKs fail observation explicitly; they never invent zero usage.
The exact dispatched-profile telemetry contract remains a separate upstream need.


Before dispatch Relay also requires at least one enabled, managed OpenAI OAuth
profile without a model-applicable cooldown/disable/block. API-key profiles do not
satisfy this condition, even if substituted under a managed profile name. If every
subscription is unavailable, `OPENAI_SUBSCRIPTIONS_EXHAUSTED` is raised before
`chat.send`. This deliberately prevents the installed runtime's least-cooled
probe behavior; it is not an API/model fallback or an auth-store rewrite.


## Codex progress is not turn completion

Standalone Codex commentary records may contain text and `stopReason: stop` while
an app-server tool is still running. Transcript and Gateway-history recovery
exclude explicitly marked commentary (including Codex mirror identity metadata).
Only a final assistant reply can release the queue or trigger transcript-completion
cleanup; progress text must never cause a running tool to be aborted/replayed.


## Official >=2026.9.8 continuous compatibility

The loaded plugin, not a version string inferred by Relay, supplies the live
capability. Existing v1 means `runScopedFallbacks: true` and
`readOnlyAdmission: true` (qualified official >=2026.11.2 with async SDK). The
strict adapter (>=2026.9.8 and <2026.11.2, or newer sync-only SDK) uses
v2 with `runScopedFallbacks: false`, `configuredFallbacksForbidden: true` and
`readOnlyAdmission: true`. Relay accepts only these exact policy shapes; old
Relay rejects v2 rather than activating an unguarded pool.

For v2, `config.read` plans against a cleared clone without mutating configuration.
Explicit `codex.auth.pool.sync` (Connect) clears model-assignment fallback lists,
including nested/subagent/cron assignments, under the ordinary owner/model lock
and config CAS. This narrowly authorized exception does not change primary,
Harness, reasoning, catalogs, credentials or unrelated memory/transport/Harness
fallback policies. Pending intent is persisted before cleanup; credentials are
written only after `config.get` confirms matching source/applied Gateway hashes
and an empty model fallback configuration. Pool writes then call the public
`models.authRefresh {operation:"update",agentId}` for each live `agents.list`
entry and require `refreshed:true` before acknowledgment. This invalidates shared
auth ownership as well as auth caches; `models.authStatus {refresh:true}` alone
can miss newly created shared-store ownership on a running host. No implicit
runtime update, general normalization or restart is performed. Failed/disabled hot reload leaves the
receipt pending with no credential effect or success acknowledgment; retry the
same revision after applying the saved configuration. Stale/conflicting pool
snapshots refuse before cleanup, and a failed operation never restores an unsafe
fallback chain. Empty lists are not rewritten. Modern v1 retains authored lists
and suppresses them per run.
A fallback introduced later is blocked by the channel plugin at run admission.
Injected cron/session fallback candidates must also match the agent's saved
primary model, so unsupported overrides cannot escape into another model/API.

The post-mutation refresh RPC exists in all 18 audited stable packages from
2026.9.8 through 2026.11.2, as do the applied config hash fields in `config.get`.
The plugin prefers the async reader when available, otherwise the synchronous
public auth SDK, with `readOnly: true`,
`syncExternalCli: false`, `allowKeychainPrompt: false`. It emits explicit
`pass`/`block` decisions in both modes. Strict mode does not
claim suppression of the outer fallback chain. No OpenClaw code changes are
needed. The plugin admits continuous >=2026.9.8, with no upper version cutoff;
unknown versions or missing required SDK/hooks still fail closed. This is not a
guarantee against future upstream SDK/hook incompatibilities. Real installed
9.8 SDK tests cover pool A/B,
unrelated key/provider and session metadata preservation; the plugin's isolated
Gateway qualification covers synthetic A/429-to-B native dispatch and exhaustion.
Synthetic transport is not a claim of real OAuth native/Codex acceptance.
