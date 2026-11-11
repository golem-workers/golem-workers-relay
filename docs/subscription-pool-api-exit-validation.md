# Subscription pool → API regression — real dev API, 2026-11-11

## Scope

Remote `https://dev-api.golemworkers.com/api/v1`, real company provisioning,
assignment-batch Connect, model-source API, Relay and unchanged official OpenClaw
2026.11.1 were exercised. Only disposable `AGENT CHECK TEST` fixtures were
modified. OAuth bundles were **synthetic** and isolated: these tests do not prove
ChatGPT login, real OAuth refresh or positive subscription inference. No existing
user authorization was reused. Production was not changed.

## Reproduced baseline

Agent `cmwbnd5980043jyoc9hfj3q03` was created from the task-owned Luna template.
Creation completed successfully, and standard Connect batch
`cmwbnhfz90057jyocxccx6kjq` succeeded with pool revision/appliedRevision 1/1.
A standard explicit `PUT .../model-source` with `source: GOLEM_CREDITS` then
failed `RELAY_PUSH_FAILED`; source activation stayed UNRESOLVED and the
subscription-only pool remained active. This is not a last-subscription removal.

## Candidate observations

- The explicit exit reserved revision 2, removed owned OAuth through the public
  SDK, restored the platform-owned OpenAI Responses proxy endpoint and per-agent
  identity, and confirmed the Gateway applied configuration. The selected
  `openai/gpt-5.6-luna` and empty model fallback list were preserved.
- Runtime receipt: `exited`, revision 2, no members or owned profile IDs. Backend:
  enabled=false, pending=false, revision/appliedRevision=2/2, no active assignments.
- Live testing caught two integration defects fixed in the candidate: masked
  Gateway key comparison could not acknowledge applied config; the old plugin
  rejected the new tombstone. New Relay advertises exit only after a live plugin
  capability acknowledgment; incomplete exits remain blocked.
- Responses-format activation checks additionally needed the same signed,
  server/model/revision-bound probe support as Chat Completions. The fixed request
  strips the capability and caller instructions/tools, with 512 output tokens.
- The first fixture's API credits permission was explicitly enabled only for
  testing, with daily/monthly limits of 1 credit. Permissions were not bypassed
  by the grant or enabled by removing subscriptions.
- The real OpenAI API request reached upstream, which returned
  `credit_balance_exhausted` / `insufficient_quota`. Therefore **positive OpenAI
  API inference and ACTIVE source activation were not established** on this
  fixture. The source correctly remained unresolved; no fallback was introduced.
- Its synthetic authorization was disabled/erased and the agent was deleted
  through supported company APIs (deletion status SUCCEEDED).

## Automated gates

Pinned Node 24.22.1, lockfile installs; build and lint passed in all three repos.
Full test results:

- Relay: 94 files, 968 passed, 5 existing skips.
- Backend: 526 files passed, 16 skipped; 5668 passed, 113 existing skips.
- Channel plugin: 9 files, 122 passed.

Regression coverage includes exact replay after auth/apply failures, stale sync
rejection, higher-revision re-entry, authored endpoint/key preservation, explicit
main-source authority (not auxiliary or ordinary OpenAI model changes), strict
loaded-plugin capability, malformed/partial exits and redacted Gateway snapshots.

## Independent successful API-source run

A second freshly provisioned agent `cmwbogeg6000t6ioc8pxoe12a` used the final
Relay, plugin and backend candidates. Standard Connect batch
`cmwbol2x9002b6iocmx9st8y3` completed SUCCESS: enabled/ready, pending=false,
revision/appliedRevision=1/1. The standard company model-source API then explicitly
selected `GOLEM_CREDITS` with model `openai/gpt-5.4-mini` (an intentional model
choice, not fallback). It returned ACTIVE with runtime model
`openrouter/openai/gpt-5.4-mini` after the real isolated response verification.
The test fixture alone opted into API credits, limited to 1 daily/monthly credit.

The pool was disabled, pending=false, revision/appliedRevision=2/2. Runtime receipt
was `exited`, with zero members/managed IDs. Read-only public auth SDK inventory
confirmed zero owned OAuth profiles. OpenAI provider remained the restored
`openai-responses` platform proxy; no model fallback was enabled.

A subsequent attempt to change this company agent back to Luna through the
personal model API was refused by its existing enterprise model fence; model and
exit receipt remained unchanged. It is not evidence of a successful company
source re-entry. Higher-revision re-entry and exact retry are covered by the
regression suite, not claimed as a positive live full round trip here.

Companion changes: [Relay #107](https://github.com/golem-workers/golem-workers-relay/pull/107),
[backend #861](https://github.com/golem-workers/golem-workers-backend/pull/861),
[plugin #13](https://github.com/golem-workers/golem-workers-openclaw-channel-plugin/pull/13).
Relay #107 is stacked on fresh-agent Connect [#106](https://github.com/golem-workers/golem-workers-relay/pull/106).
