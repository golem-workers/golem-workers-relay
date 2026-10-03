# Fresh OAuth writer fix — 2026-10-03

## Change

Removed relay-created auth-only SQLite schemas. The relay resolves installed public `openclaw/plugin-sdk/provider-auth` and calls `updateAuthProfileStoreWithLock` in a bounded, state-root-isolated subprocess. Credentials use stdin only; output is suppressed and failures sanitized. No private hashed imports, schema metadata fabrication, runtime source edits, guest mutations or deployments.

Passes explicit main agent directory and modern stateDir/sharedStoreWrite options; OpenClaw selects the owner and initializes fresh shared storage. Legacy JSON is not created before runtime admission (doing so suppresses fresh shared initialization). Existing agent-owned runtimes retain JSON compatibility mirrors after successful persistence. Unrelated OAuth and API-key profiles survive.

Rollback follows fresh agent-to-shared ownership transitions, removing auth rows while preserving runtime-owned schema/ownership. No schema table drops or whole database unlink. Existing subscription routing and explicit overrides are unchanged.

## Runtime evidence

- Installed local OpenClaw is **2026.9.7**, global schema19, agent schema24. This is not local execution proof for 2026.9.8.
- Public export verified in package.json and dist/plugin-sdk/provider-auth.js; docs/plugins/sdk-subpaths.md documents provider-auth.
- Read-only installed sqlite-DA9VtFP1.mjs: initializeFreshSharedAuthStore checks legacy files/rows before committing auth.sharedStore; explicit main is admitted with sharedStoreWrite=true.
- store-vsKwB1ol.mjs updateAuthProfileStoreWithLock runs owned transaction and postcommit publication.
- Read-only 2026.6.11 checkout exports same API accepting agentDir/saveOptions/updater. Older-version coverage is boundary-contract regression, not execution of installed 2026.6.11.

Five real installed-SDK regressions, synthetic credentials and isolated roots:
1. Real global DB with auth marker removed: initializes shared ownership; schema_meta/version19/integrity preserved; no agent DB/legacy JSON created.
2. Existing shared owner and unrelated provider profiles preserved.
3. Runtime-initialized agent schema24/main ownership preserved across writes.
4. Existing malformed two-table/version0 DB rejected without changing bytes or forging ownership.
5. Failed fresh sync removes OAuth while preserving valid shared schema.

Three additional boundary tests cover old/new callback contracts and fail-closed missing SDK. Existing orchestration tests use an explicitly named legacy fixture, not a schema compatibility proof.

## Validation

- npm run build: pass.
- npm run lint: pass.
- Full suite requires NO_PROXY=127.0.0.1,localhost in this proxied host. Unadjusted loopback tests fail UND_ERR_SOCKET (pre-existing environment issue).
- Final loopback-adjusted run: **55 files / 515 tests passed** (09:47:38 UTC, 38.90s), including 5 installed-runtime and 3 compatibility regressions. Log: writer-full-tests-verified.log.

## Recovery / independent route conflict

Never forge schema_meta or repeat doctor against unchanged malformed DB. Offline: verify exact auth-only shape, preserve protected consistent backup including sidecars, quarantine only malformed artifact, then let official doctor/schema owner initialize and import retained credentials. Verify ownership, integrity, credential hashes and runtime auth before restart. Parent reports A recovery succeeded; this child touched neither A nor B.

Parent separately observed doctor-transferred managed proxy baseUrl in models.providers.openai with explicit-auth-order failure. This writer fix does not resolve that routing conflict or authorize overwriting custom routes. Establish managed-route provenance and handle narrowly before claiming inference success.
