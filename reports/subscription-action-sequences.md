# Offline subscription action sequence regression — 2026-10-03

Scope: relay only, based on `afd1c00`; no backend edits, push, deployment, live credential reads, network inference, gateway/service changes. All auth and config are temporary synthetic fixtures. Public installed provider-auth SDK creates real runtime-owned SQLite schemas; diagnostic-only installed resolver exports select actual auth routes. Runtime: OpenClaw 2026.9.7.

Terra is actually `gpt-5.6-terra`; the original matrix used `gpt-5.4`, not Terra. Labels below are corrected.

## Reproduce

`MATRIX_REPORT=reports/subscription-sequences-after.json npm run test:subscription-sequences`

The script fails nonzero on *any* unexpected action error/assertion. Negative cases require explicit rejection. It does not silently count errors as successful preservation. Unit/full-suite coverage additionally exercises ordinary contracts without depending on private runtime exports.

## Findings before fixes

`reports/subscription-sequences-before.json`: **23 sequences, 19 pass / 4 fail, 179 actions**.

1. Exact backend-generated proxy `baseUrl` reintroduced after Sol populated its nonempty native compatibility catalog was retained by both `model.set` and `modelAssignment.set`. The narrow empty-row guard missed it. Tokens/order/schema stayed intact. With Sol’s explicit ChatGPT API the installed selector still chose subscription despite the lingering endpoint, so this is accurately a **stale endpoint regression**, not a proven live authentication rejection.
2. `config.apply` bypassed route normalization entirely. Nonempty reintroduction persisted; an empty generated row produced the actual installed resolver rejection: `Explicit auth order for openai has no usable profiles.`

An initial harness run also found that null `lastRefresh` is intentionally materialized as current time; the synthetic bundle was corrected to use a fixed timestamp before the recorded baseline. This was not a product defect.

## Fixes

- Recognize only the exact generated Sol subscription catalog plus exact current deployment proxy URL. Strip only `baseUrl`, preserving the catalog. Any unknown/modified model/provider field, extra model, explicit API/credential/environment route, or persisted API-key intent stays authoritative. The generated fingerprint is reused from the compatibility helper, not a broad nonempty-catalog exemption.
- `config.apply` now performs the same scoped persisted-subscription-aware route reconciliation as model actions, considering primary/fallback assignments. It still does not restart services.
- Added strict generated-vs-authored catalog unit tests and actual `executeAgentControl(config.apply)` tests for main/PDF/image-generation assignments.

## After fixes

`reports/subscription-sequences-after.json`: **30/30 sequences pass, 200 real relay actions**, zero unexpected errors. The original 23 sequences now all pass; seven extra alias/non-main sequences and six authored config.apply checks broaden the final run.

## Exact expanded matrix

- Six 20-action sequences: `model.set` and `modelAssignment.set(main)` × shared runtime SQLite, agent-owned runtime SQLite, legacy JSON. GPT-5.4 (`gpt-5.4`) → Sol → GPT-5.4 → Sol; reasoning off/low/high/omitted/null; unrelated Codex GPT-5.4 fallback, Sol fallback, clear fallbacks; immediate identical repeats; switch Anthropic then return. Assertions cover selected subscription API independently of tokens, refresh token, identity, order/lastGood, schema metadata/SQL/user_version/integrity, primary/fallback values and reasoning.
- Three nonempty Sol catalog proxy-reintroduction sequences: model.set, modelAssignment.set, config.apply; lingering codex provider row included.
- Config read/merge/apply and empty generated route; malformed apply must reject and preserve config/auth. `config.patch` is not a relay protocol action; patch-equivalent path is read/merge/apply.
- Two model-alias sequences: codex/openai-codex/openai for GPT-5.4 and Sol.
- Five non-main purposes: image, imageGeneration, videoGeneration, musicGeneration, pdf; must not change main reasoning. This tests routing/persistence, not whether Sol supports those generation tasks.
- Two independent fixture targets with different synthetic identities, each Sol → GPT-5.4 → Sol (dashboard-equivalent per-agent bulk actions, not backend bulk endpoint).
- Expired profile: subscription *route identity* survives; unavailable readiness rejects selection; login status explicitly failed/expired, no refresh or inference claimed.
- Shared and agent-owned import/reimport/export/status sequences; failed sync refresh explicitly rejects and restores auth/config/CLI/schema; expired and identity-mismatched imports reject.
- Shared and agent-owned sync ordering: version 2 apply, same/older version with stale refresh token ignored, version 3 rotation accepted, older-version route repair keeps rotated token/account; explicit API mode then login mode preserves OAuth and returns to subscription.
- Six authored-override cases: custom endpoint, explicit API, provider API key, persisted API-key intent, custom model fields, environment endpoint. Both model.set and config.apply preserve them. These are **intentional authoritative overrides, not subscription-loss passes**.
- Model action restart failure: explicit error required; persisted auth unchanged. Config remains written because model.set has no restart-failure rollback contract.

## Limitations

Explicit `codex.auth.clear`/force relink intentionally destroys/replaces authorization and is outside this survival matrix. No live inference, token validity/refresh, actual gateway restart, dashboard/browser flow, backend lifecycle repair, remote update, network reconnection or service environment reload was attempted. Legacy JSON is read as legacy source, not migrated via runtime. Private installed exports are diagnostic-only and deliberately fail if discovery is ambiguous. A deliberately authored row byte-for-byte identical to the generated catalog plus generated deployment endpoint is indistinguishable without provenance; all observable deviations fail closed.

## Validation

- `npm run build`: pass (`sequence-build.log`).
- `npm run lint`: pass (`sequence-lint.log`).
- `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost npm test`: **56 files / 560 tests pass**, 38.87s, start 10:34:03 UTC (`sequence-full-tests-final.log`). Loopback bypass is required by this host’s proxy environment, not a code workaround.
- `npm run test:subscription-sequences`: **30 sequences / 200 actions pass** (`sequence-after.log` and committed JSON).
- Existing `prove-managed-subscription-route.mjs`: both GPT-5.4 and Sol pass (`sequence-baseline-proof.log`).
- `git diff --check` and script syntax check pass.

Machine-readable before/after reports are committed alongside this document; raw logs remain local, untracked by repository policy.
