# Post-write subscription runtime completion

## Scope and incident

Companion backend change: `fix/pool-runtime-completion-20261117`.
Relay base: `0148bd1404c07c69bb6a7ee80a5076a4170f7d18`.

The failed operation had desired pool revision 5 and applied revision 4. The
credential writer reached runtime refresh, but `models.authRefresh` had a nested
10-second timeout. The corresponding Gateway response succeeded after 99.186s;
an 84.963s main-thread stall was recorded in that interval. The Relay's UNKNOWN
receipt did not converge: backend recovery recognized writer timeout codes but
not the resulting generic pool outcome pending code.

Previous fixes increased the SDK writer budget to 600s and backend wait to 900s,
and handled pre-write guard/lock refusals. Those changes are prerequisites, not
solutions to this post-write timeout branch.

## Contract

- Persist intent before credential effects; after SDK write/readback persist
  `completionStage: credentials_verified` with phase pending.
- Mark applied / `runtime_acknowledged` only after all live agents acknowledge.
  Old metadata without completionStage remains readable; the field is never
  sufficient authority to skip SDK verification.
- Roster and all post-mutation RPCs share one 120s deadline, including an
  independent timer if a transport ignores its timeout option. The budget is
  not multiplied by the number of agents. Config readiness is bounded at 60s;
  SDK write/readback at 600s; backend acknowledgement at 900s.
- Preserve sanitized `OPENAI_POOL_AUTH_RUNTIME_PENDING` in UNKNOWN receipts.
- Existing durable execution survives a closed HTTP caller. A response within
  the budget completes that same receipt. A timeout/disconnect is not success;
  subsequent exact readback-only reconciliation verifies the SDK store before
  refreshing and completing the saved operation. It never replays credentials.
- Existing operation/intent fingerprints, revision high-water marks, ordered
  members and credential generations remain the admission boundary. Changed
  credentials, config or intent fail closed. No fallback or agent model changes.
- No endless retry, bypass of integrity checks, or forced ACTIVE. Backend's
  bounded final readback and Relay's reconciliation limit remain in force.

## Reproduction and acceptance

`node scripts/prove-pool-runtime-completion.mjs` requires a supported Node 24
runtime, built candidate (`npm ci; npm run build`), and an installed OpenClaw
executable on PATH. It starts a loopback-only disposable Gateway with independent
config, auth database, receipt directory and workspace. No services are installed.
All default credentials are synthetic. The script stops its Gateway on exit.

The proof's delay adapter waits *after a real Gateway acknowledgement*; it does
not claim to reproduce the original CPU stall. Guard admission is synthetic.
The optional actual compiled backend worker has synthetic DB and selection
adapters; worker logic and its Relay HTTP interaction are real. This is not a
full deployed backend API/Prisma integration proof.

Optional fixtures:

- `POOL_PROOF_WORKER=/absolute/fixed-worker.mjs`: compile the companion backend
  source with `scripts/qualification/prepare-subscription-pool-worker.mjs`.
- `POOL_PROOF_BUNDLE=/protected/dev-qa-bundle.json`: explicitly dev-only OAuth
  test bundle, read from mode-0600 storage; never production. Enables a single
  short real model turn, with no fallback and capped output. Runtime auth state
  is removed afterwards. No bundle is printed or committed.
- `POOL_PROOF_MODEL`: model verified in that test subscription's live catalog.
- `POOL_PROOF_QUICK=1`: 100ms positive delay instead of 99s (not 99s evidence).
- `POOL_PROOF_SESSION_COUNT=128`: public-SDK synthetic metadata load fixture,
  at most 128 entries with 512KiB labels; reports seed/refresh durations.

| Scenario | Evidence boundary / expected result |
| --- | --- |
| Old 10s nested timeout vs 99s response | Baseline runtime unit regression fails; dev HTTP proof yields UNKNOWN after credentials verified |
| 99s positive delay | Real HTTP/SDK/Gateway receipt SUCCEEDED; credentials not acknowledged early |
| Hung roster / refresh | Fake-clock tests exhaust shared 120s budget and clear timer |
| Shared multi-agent budget | Unit test verifies remaining budget decreases; no per-agent multiplication |
| Restarted receipt; old metadata | New HTTP server/receipt instance reads interrupted RUNNING; exact reconciliation succeeds without changing credential snapshot |
| Parked generic UNKNOWN | Actual compiled backend worker enables one readback; synthetic row attempts 5→6 |
| Duplicate / changed intent | Duplicate submit unchanged; changed intent HTTP 409 |
| Lost ack + actual Gateway process restart | Same operation reconciles successfully; auth snapshot unchanged |
| Diverged runtime credential | SDK readback mismatch; UNKNOWN/pending retained, no repair or false ACTIVE |
| Real model | Protected dev QA bundle; expected answer and no configured fallback |
| Competing/newer revision, credential versions, custody, missing receipt | Existing full manager/receipt/backend tests; not all are separate live dev API scenarios |

Validation results and measured latency are recorded below after terminal checks.

## Remaining runtime latency defect

The exact workload behind the incident's 84.963s main-thread stall has not been
attributed. Raising the acknowledgement budget and making UNKNOWN recoverable
addresses the state-machine failure, not the original stall. Small clean-Gateway
measurements and synthetic metadata-load measurements cannot prove behavior on
the incident's multi-GiB database. Treat that runtime performance investigation
as a separate open defect; no OpenClaw source/bundle patch is part of these PRs.

## Release boundary

Proposal only: ordinary linked PRs. No merge, production deployment, dev9 repair,
production credential mutation or production agent restart was performed.

Latency follow-up: https://github.com/golem-workers/golem-workers-relay/issues/119

## Measured dev-api results (2026-11-17)

All proof processes were monitored to terminal completion; no task was handed to
a detached agent or scheduler. Tested runtime: OpenClaw 2026.11.4 (d843d6a),
Node 24.22.1, independent temporary state on the dev-api host.

- Final matching built modules:
  `subscriptionPoolRuntime.js` SHA256
  `d68dc00653619cea1eddc5dc17dd8b8b8d4eccc446f11829507a0a0ee8c1f7a2`;
  `subscriptionPoolManager.js` SHA256
  `673b809ce2f9af3afd4401d3aae447749277c148a900661f5eaa80490b3245bc`.
- Full final QA run: 99,000ms injected delay → same-operation SUCCEEDED after
  **104,730ms** including SDK work; exact real model answer on a protected dev QA
  subscription, with fallback disabled. Actual Gateway restart/readback and
  divergent-credential refusal both passed. QA runtime and copied OAuth bundle
  were removed after completion; original account DB rows were not changed.
- Load fixture: 128 synthetic session entries / 64 MiB input metadata, measured
  agent SQLite approximately **258 MiB**. Refresh **271ms**, repeat **1080ms**
  while other isolated tests were active; neither reproduces the incident stall.
- A first loaded restart proof attempted reconciliation while the client was
  still reconnecting and safely stayed UNKNOWN. The portable script now waits
  for observed Gateway health, not merely completion of `start()`. The complete
  readiness-gated loaded restart/divergence run passed.
- A first QA model choice was unsupported by the provider. It was not counted
  as successful inference; the successful run used a model from the QA account's
  live catalog. No production model/config was changed.

Companion backend full suite: **6077 passed, 154 skipped**. See companion PR for
its independent build/lint and worker/service test results.

Companion backend proposal: https://github.com/golem-workers/golem-workers-backend/pull/897

## Final local checks

- Build: exit 0; lint: exit 0; policy canonical hash unchanged.
- Final complete Relay run, alone after backend terminal completion:
  **99 files passed; 1055 tests passed, 5 skipped**, exit 0 (298.70s).
- A preceding full run had one unchanged installed-SDK test hit its existing
  60s limit; it passed in isolation in 33.40s. The final whole-suite run passed
  all 13 installed-SDK tests without widening timeouts or skipping the SDK.
- Intermediate runs that overlapped code/test edits are not final evidence.
  The two unresponsive-transport regressions and every completion-stage check
  passed in the final frozen-code run.
