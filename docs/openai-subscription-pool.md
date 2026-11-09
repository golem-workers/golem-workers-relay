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
`copyToAgents: false`. Main-agent session pins are cleared/reclassified through
the public session SDK without changing session history/activity.

A qualified explicit `openai-chatgpt-responses` route is required. Do not change
Harness/model/reasoning during auth. Reject direct provider API auth overrides,
unqualified/custom endpoints and outer-model fallbacks. Stored API keys and other
providers are preserved but cannot become candidates on this route. Empty or
exhausted pool is an error, never API/credits/provider/model fallback.

Manifest presence fences legacy provider-wide writers, even after last-member
removal. Do not delete it to bypass policy. An explicit pool-exit workflow is not
part of this draft. Local main-agent SDK storage/session preservation is tested;
active-turn/tool exactly-once, nested-agent stores and explicit Codex Harness
remain qualification gates, not inferred guarantees.

Real dev-api evidence: actual empty sync APPLIED, unchanged Harness, actual no-auth
request fails both without credentials and with a synthetic OpenAI API-key profile
available. Real A/B requests, refresh fanout and per-attempt attribution are still
pending. Public model/LLM hooks do not expose actual OAuth-profile selection, so
this draft must not invent per-account request usage from membership order.
