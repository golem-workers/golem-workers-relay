# Initial subscription bootstrap: model-fence contention

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
