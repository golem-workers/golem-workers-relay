# Initial subscription bootstrap: model-fence contention

> Follow-up status: Canary billing is repaired. Component regressions and full
> code suites pass; full original Sol/Codex creation remains **not passed**.
> See the final follow-up outcome for the exact account/model and runtime limits.

## Defect and scope

The initial company OpenAI route uses authenticated `model.set` with
`subscriptionBootstrap: true`, an explicit model fence/predecessor, and config CAS.
Unlike pool sync, this action previously attempted the kernel model lock with
zero wait. A short competing config transaction therefore stopped provisioning
with `MODEL_FENCE_BUSY` before any route or credentials were written.

The incident's saved template-bootstrap receipt was UNRESOLVED and its main
model remained the initial provisioning model. The original VM was subsequently
deleted; the identity of that historical lock holder is **not established**.
The controlled contention below reproduces the failing condition, not the
identity of the historical writer or a proven self-deadlock.

## Change

Only authenticated, fenced initial subscription bootstrap joins the existing
30-second pool-sync admission bound. Authorization checks run before waiting;
config CAS and predecessor checks run after acquisition. A config change still
fails closed, persistent contention still refuses, and ordinary model/config
writes retain fail-fast behavior. No lock is deleted, stolen or bypassed; no
unknown mutation is automatically replayed.

## Component regression and complete checks

- Base Relay `41b5c0636ac882338c28663dedc5c6caa711b49c`.
- Actual kernel holder releases after 150 ms: unmodified ingress gives one
  passing uncontended case and one failing contended case (`MODEL_FENCE_BUSY`).
- Candidate: both cases pass, including the complete config projection.
- Additional tests: config CAS changes during wait, persistent 30-second
  contention with unchanged config, and ordinary model fail-fast behavior.
- `NODE_USE_ENV_PROXY=0 npm run test`: **1071 passed, 5 skipped**, 99 files passed.
- `npm run build` and `npm run lint`: exit 0.
- Candidate compiled `agentControl/executeAgentControl.js` SHA256:
  `d675cfb200fa8c12e2f511d034c033189a84488b876cd7477a73433d5855bb56`.

## Real staging proof — 2026-11-20 UTC

- Actual dev-api backend, real provisioned agent/Relay/Gateway, no mocked HTTP
  responses and no standalone OpenClaw on the control-plane host.
- Disposable `cmwohjagl0001lloc2l46t146`, task
  `cmwohjap90006llocdgvpem9m`: terminal **SUCCESS** before fault injection.
  This normal creation used an existing credit-funded test template, not the
  original OpenAI template.
- Provider setup installed Relay base `41b5c06`, Node 24.22.3. Candidate dependency
  lock exactly matched the provisioned agent before artifact activation.
- Controlled competitor held the canonical kernel model fence for 3 seconds.
  Backend issued the same initial OpenAI bootstrap action under its real durable
  Harness mutation and config CAS. Baseline: **REFUSED / MODEL_FENCE_BUSY**.
- A candidate immutable generation was activated only on this disposable.
  Repeated the exact saved revision/predecessor/request under identical contention:
  **SUCCESS in 5517 ms**, `subscriptionBootstrap: true`.
- Independent backend read-back: exact revision
  `269ec816-5248-44de-ab45-7a8b05e4e02d`, **APPLIED**, selected model preserved,
  main fallback null, thinking high, fast mode false, Harness transition cleared.
  No inference/auth-success claim: this intentionally tests route preparation
  before subscription credentials exist.

## Explicit limitations

Full initial creation with the original OpenAI template was **blocked**, not
passed: Enterprise Development Canary had two overdue test invoices and billing
admission returned `ENTERPRISE_ACCOUNT_DELINQUENT`. Those invoices, organization
billing settings and credentials were not changed. A task-only template was
created there and retired; no VM was provisioned by the blocked attempt.

The real staging result establishes the defective bootstrap stage and its fix,
not end-to-end account assignment, final Codex selection, Telegram bot/group
creation or production rollout. Existing unrelated staging agents and canonical
backend runtime were not replaced. Production was read-only.

Candidate packaging initially archived only the `dist` symlink. Its missing-file
check stopped activation before restart. The original symlink was restored;
actual generated files were then staged as an immutable generation and switched
atomically. The daemon's installed module checksum matched the tested candidate.
This failed packaging attempt is not counted as a successful activation.

## Fixture retirement

After preserving the independent read-back, the task-owned disposable was
retired through the company deletion service with verified native backup:
request **SUCCEEDED**, provider delete success, backend **DELETED** at
2026-11-20 04:42:08 UTC. The blocked Canary draft had already been soft-deleted
before any VM provision, and its task-only template is **ARCHIVED**. No task VM
or candidate daemon remains running. The normal deletion-notification attempt
failed after the disposable Relay forward was gone; this did not change the
independently confirmed deletion outcome.


## Authorized Canary fixture recovery (2026-11-20 follow-up)

The earlier billing limitation above is historical, not an outstanding user
prerequisite. At the user's explicit request, the two dev-api-only synthetic
Canary invoices were settled with the supported manual settlement service,
clearly labelled `SYNTHETIC DEV TEST — NO REAL PAYMENT`, stable idempotency keys
and audit metadata. No external funds moved and no production invoice changed.
Independent read-back confirmed both invoices PAID with zero remainder. The
supported administrative account recovery then restored ACTIVE; effective
creation admission returned allowed. These changes intentionally remain in the
test fixture.

A fresh complete OpenAI server-creation task was admitted after this repair:
`cmwoitxrg0007c9ocvw2r8akm`, disposable server
`cmwoitxj10002c9oclfsdf8sk`. Its attended worker used a separate initially-empty
Redis database; canonical dev-api backend and shared queue were unchanged.
The snapshot initially retained the baseline Relay despite the requested branch;
this was detected by module checksum, not counted as candidate proof.

The first fresh task ended FAILED with `RELAY_HANDSHAKE_FAILED` at
2026-11-20 05:15:00 UTC. Candidate activation overlapped the authenticated
handshake; its service restart exceeded the 30-second command timeout. This
instrumented run is **not** counted as a successful full candidate acceptance.
Its server was retired through the official deletion service: SUCCEEDED,
backend DELETED at 05:17:03 UTC. The next run installs the checksum-verified
artifact cold during role-template synchronization, before Relay startup.

A second attempt (`cmwoj23180006rtocb9gxviw5`) proved the initial cold
artifact placement was overwritten by bootstrap's own rebuild. Its final
OpenAI pool receipt was UNKNOWN (`AUTH_OPERATION_OUTCOME_UNKNOWN:CONFIG_CONFLICT`),
not a successful candidate acceptance; it was read without replaying credentials.
The pool did not converge and the failed disposable is being retired.

Investigation identified an independent bootstrap ref-wiring bug: Relay's Git
fetch/clone/checkout incorrectly used `RELAY_CHANNEL_PLUGIN_GIT_REF`. Thus an
explicit plugin `main` pin overrode the requested candidate Relay branch. The
backend correction passes Relay and plugin refs separately and preserves the
plugin environment pin. A regression covers distinct custom refs. This
correction is needed to make isolated candidate provisioning truthful; it is
not claimed as the original historical MODEL_FENCE_BUSY cause.

The corrected-ref attempt is `cmwoja5ee00062poc6ki02izc`, server
`cmwoja56900012poc6peidqff`. An isolated copy of the existing dev backend
compiled modules contains only the corrected bootstrap module; the attended
worker retains canonical credentials/configuration and separate queue state.
Its first initialization found a missing static model catalog; the catalog and
read-only source/assets were made available before reservation, then creation
was admitted. No failed catalog initialization provisioned a server.

Independent SSH read-back during startup confirmed actual Relay head
`49d28987baccc8eb539a6980c70bcb4f53e05b49`, service ACTIVE and module checksum
`d675cfb200fa8c12e2f511d034c033189a84488b876cd7477a73433d5855bb56`.
The previous baseline-overwritten server was officially deleted at
2026-11-20 05:23:50 UTC, request SUCCEEDED.

After the bootstrap-ref correction: focused bootstrap/client tests 69 passed;
complete backend suite 6241 passed / 165 skipped, 550 files passed / 22 skipped;
build and lint passed. No application code changed after these checks.

The third admitted task finished **FAILED**, `MODEL_VERIFY_FAILED`, at
2026-11-20 05:30:49 UTC; it is not a full acceptance pass. Independent state
confirmed its selected account assignment ACTIVE at credential version 8 and
pool revision/appliedRevision 1/1, with no pool error. A private no-delivery
probe returned the actual provider error: `The 'gpt-6.1-sol' model is not
supported when using Codex with a ChatGPT account.` The advertised Codex model
catalog nevertheless listed Sol as default. No fallback or different account
was substituted into that immutable creation. Read-back after failure found
the normal dev Relay base again; the exact replacement timing is not counted
as continuous candidate attestation.

Subsequent attended runs isolate only the creation queue key in a copied queue
module, keeping shared Redis application state. Selection execution locks are
PostgreSQL-backed, not Redis-backed; no claim is made that Redis DB isolation
caused the earlier model or config errors.

## Final follow-up outcome (2026-11-20)

- Synthetic billing repaired through audited admin mechanisms: both invoices
  PAID, zero overdue, account ACTIVE, creation admission allowed. No real
  payment or production invoice change.
- Fourth task `cmwojnn610006fsoc26ww3cr5` (server
  `cmwojnmvq0001fsocn3wufs2x`) also ended FAILED / MODEL_VERIFY_FAILED at
  05:41:36 UTC. Selected subscription installed at credential version 8 and
  pool revision/appliedRevision 1/1. Config read-back remained Sol/high/fast
  false/no fallback, but the requested Codex selection did not commit.
- The only CONNECTED OpenAI authorization listed on dev-api was the Canary
  `Runtime Update E2E` fixture, reporting plan `free`. Sol appeared in model/list
  but the actual private Codex probe rejected it as unsupported with a
  ChatGPT account. Diagnostic Astra/5.5 native attempts timed out; neither is
  claimed as a supported substitute. A legacy single-login export was not
  usable for this pool; no auth reconnect or account-plan spoof was attempted.
- No full original Sol/Codex creation acceptance is claimed. The kernel-lock
  reproduction/fix and the independent-ref regression remain valid component
  evidence. Continuous candidate installation through final selection was not
  proven: later read-back showed the normal dev base again. The reason/timing
  of that replacement remains unproven. PostgreSQL, not Redis, owns selection
  execution locks; separate Redis was not proven to cause those outcomes.
- The four follow-up task servers were deleted through supported company
  deletion with verified native backup and SUCCEEDED requests. Last deletion:
  05:43:25 UTC. The task-only template is ARCHIVED (version 4). Ephemeral
  credential probe directories were removed; no credential values entered
  documentation or logs. Billing recovery intentionally remains in place.
- Canonical dev-api backend was not replaced; production stayed unchanged.
  Both PRs remain draft pending full target-model acceptance with a suitable
  dev authorization and continuously attested candidate runtime.
