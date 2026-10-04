# Same-version sync drift follow-up — 2026-10-03

Cross-component source: parent backend lifecycle audit (read-only). Changes remain relay-only; no systemd/backend overlap, deployment or live credentials.

## Exact failure

Expanded existing matrix from 30 to 36 sequences with six targeted combinations: empty migrated OpenAI generated row or nonempty Sol catalog + regenerated endpoint, each as OpenAI primary / Anthropic primary with OpenAI fallback / Anthropic primary with OpenAI PDF auxiliary. All start with real runtime SQLite OAuth, completed sync version 9, then physically remove synthetic `.codex/auth.json`. Same-version sync is repeated twice.

Before: **30 pass / 6 fail, 224 actions** (`subscription-sync-drift-before.json`). The six failures are specifically **lingering generated `models.providers.codex` alias**, not lost tokens or an unusable current selected route. Canonical OpenAI endpoint was repaired and the actual installed resolver selected the ChatGPT endpoint before reaching the failing alias assertion. The stale alias could later be migrated back by doctor; the previous sync test only asserted canonical route and missed this durable drift.

SQLite-only export and same-version recovery itself already worked: the relay reads SQLite, reconstructs CLI ChatGPT mode, reconciles canonical route, refreshes the gateway, and keeps token/account/order/schema unchanged. No claim that these were broken.

## Fix

Auth route reconciliation additionally uses the existing strict managed subscription normalizer, removing exact deployment-generated alias rows on explicit import/sync/login. Custom/extended alias rows remain untouched. Unit tests cover generated/custom/extended alias detection. No expanded blanket deletion.

## Validation assertions

The targeted tests assert real installed route **API, auth requirement and exact `https://chatgpt.com/backend-api/codex` endpoint**, with actual configured primary passed to the resolver (including Anthropic). They separately assert SQLite credential/identity/order/schema equality, canonical and alias drift absence, unchanged primary, exactly one refresh during repair and none on clean repeat, and active login/status account. Missing CLI file is explicitly asserted before sync; recovery may legitimately recreate it.

## Model correction

The previous script variable/report incorrectly called `gpt-5.4` Terra. Corrected to GPT54/GPT-5.4 throughout. Actual Terra is `gpt-5.6-terra`; this offline matrix makes **no actual Terra model support/inference claim**.

All prior offline limitations still apply: fake systemctl/RPC transport, real installed SDK/schema/resolver, synthetic credentials only, no actual service restart or network inference.

## Final evidence

- Build and lint pass (`sync-drift-build.log`, `sync-drift-lint.log`).
- Full suite: **56 files / 563 tests pass**, 35.80s, start 10:39:25 UTC (`sync-drift-tests.log`).
- Expanded full installed-runtime matrix: **36/36 pass / 230 actions** (`subscription-sync-drift-after.json`).
- After adding explicit refresh-idempotence and active-status assertions, targeted rerun: **6/6 pass / 36 actions** (`subscription-sync-drift-targeted.json`). The six original variants used 30 actions in the full run; the six extra status actions account for the targeted increase.
- Pre-fix full matrix: **30/36 pass / 224 actions** (`subscription-sync-drift-before.json`); all six added drift variants failed specifically on the stale generated alias.
- `git diff --check` passes. No push or deployment.
