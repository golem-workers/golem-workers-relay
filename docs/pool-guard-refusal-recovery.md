# Pre-writer subscription guard refusal recovery

## Defect and fix

A failed live `relay-channel.subscriptionGuard.status` check throws
`OPENAI_POOL_GUARD_UPDATE_REQUIRED` before the pool credential writer. Older
Relay receipts incorrectly recorded this as UNKNOWN. An explicit readback then
failed with `OPENAI_POOL_RECONCILE_CONFLICT` because the local durable pool
remained at revision 3 while the saved backend request targeted revision 4.

Pool-sync guard failures now remain REFUSED, not UNKNOWN. Ordinary duplicate
submissions do not retry. An explicit exact-intent resume, bound to the receipt
fingerprint and current dispatch authority, rechecks the live guard before any
credential effect. The backend counterpart must recognize this refusal code.

Legacy recovery is deliberately narrow: an explicit exact-intent reconciliation
can reclassify the original guard failure, or a complete untruncated chain of
that failure followed only by up to three reconciliation conflicts. It executes
no callback or credential effect. A subsequent separately authorized resume is
required. Generic UNKNOWN, interrupted work, later readback guard failures,
incomplete/truncated histories and stale fingerprints remain blocked. No revision
file reset, token replay or credential-generation substitution is introduced.

## Dev API host acceptance (2026-11-16)

Baseline: Relay main `cca50e9` (only its compiled receipt module substituted into
an otherwise identical isolated candidate). Authenticated loopback HTTP on
`dev-api.golemworkers.com`, Node 24.22.1, runs the production push server,
executeAgentControl, durable receipt files, Linux model/owner locks, pool manager,
revision files and auth-writer subprocess. The SDK storage adapter and Gateway
RPC responses are synthetic. No production credentials are used.

- Baseline: guard refusal becomes UNKNOWN; target revision 4 remains local 3;
  exact reconciliation remains UNKNOWN/RECONCILE_CONFLICT. No target write.
- Fixed: guard refusal stays REFUSED. Explicit resume while guard is absent also
  refuses with zero effects. After guard recovery the same operation reaches
  applied revision 4 exactly once. Duplicates produce zero additional effects.
- Legacy receipt histories with 0, 2 and 3 prior conflicts reclassify without
  effects and then complete through the same explicit resume path.
- Changed revision is rejected with HTTP 409. Missing HTTP bearer is rejected.
  Authored config remains byte-for-byte unchanged.

Reproduce in a disposable checkout with isolated dependencies and built `dist`:

```sh
NODE_USE_ENV_PROXY=0 NO_PROXY=127.0.0.1,localhost,::1 \
  node scripts/prove-pool-guard-recovery.mjs "$PWD" fixed
# Repeat with legacy0, legacy2, legacy3.
```

For the baseline, use its `authorizationReceipts.js` in a separate compiled tree
and pass `baseline`. Do not swap modules in a running Relay. Each run creates and
removes its own temporary state/SDK and random HTTP token. The supplied candidate
path must be absolute.

This is a real Relay HTTP reproduction on the dev API host, not acceptance
through the deployed backend public API, a live Gateway, real OAuth, or a model
turn. The dev `gwb` service and existing agents are unchanged. Operational repair
of affected production agents remains a separate deployment and verification.
