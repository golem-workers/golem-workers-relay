# Orphaned RUNNING/WAITING — disposable dev API acceptance

Base: Relay main `f4d93f1` (release 1.0.530). Target: a newly created disposable
agent in the existing synthetic dev organization, OpenClaw 2026.11.6, Node
24.22.3. No customer state or production service was modified. Backend dev
service was not replaced; candidate modules ran only on the disposable agent.

## Reproduce

1. Create a disposable agent through
   `POST https://dev-api.golemworkers.com/api/v1/company/organizations/<synthetic-org>/agents`
   using an existing dev template and a unique idempotency key. Wait for ACTIVE.
2. On that agent (via dev API `/servers/<id>/commands`), run
   `ORPHAN_TEST_SERVER_ID=<id> node scripts/prove-orphan-lifecycle-dev.mjs seed`.
   The script refuses a non-dev backend and uses only its local Relay credential,
   never printing it. It seeds synthetic RUNNING and WAITING lifecycle starts,
   deletes/recreates only the named synthetic Gateway sessions, verifies changed
   session IDs, and starts the ordinary Relay. This deliberately emulates a
   missed terminal notification; it does not claim a live model turn was run.
3. Run `inspect` and read the backend lifecycle API after more than two normal
   30-second polls. Baseline: old run IDs remain active while the complete
   Gateway inventory contains only replacement session IDs. There is no matched
   terminal row, so the ordinary terminal-only poll cannot close them.
4. Run `keep-wait` to add a matched WAITING control session without deleting it.
   This leaves Relay stopped for candidate activation. Activate the candidate on
   this disposable agent only, preserving its other modules/config, then start
   Relay. Compare hashes of the loaded modules with the build artifacts.
5. After two complete polls, repeat `inspect` and independently read the backend
   per-run/event projections. Require orphan runs CANCELLED with
   `origin=RECONCILIATION`, `reasonCode=runtime_run_disappeared`; retained control
   WAITING with no finishedAt; unchanged Gateway session IDs.
6. Save sanitized receipts, delete the exact task-owned agent through its dev
   company deletion-preview/delete APIs, verify deletion and retain existing
   org/template. Do not run this against production.

Important precision: simple `sessions.reset` on the tested 11.6 build retained
sessionId. Deletion/recreation demonstrably replaced it. Therefore this proves
session disappearance/replacement, not that every ordinary reset changes IDs.

## Observed baseline and candidate

- Baseline module hash:
  `321321bf20b0f10f32af58a8086bad73be948dd6a7197d510a4fbc79eb967954`.
  RUNNING/WAITING remained active after replacement; fresh lifecycle API read
  still reported RUNNING/active=true before candidate activation.
- Candidate Relay module hash:
  `5b48121958c8e0e13ef5a5527e7afe1caa8d567758319c0530251c3d663d1097`.
  Candidate started at 03:16:13 UTC; its source registered 03:16:14 UTC.
  At 03:17:14 UTC all three synthetic orphan runs (including one retained from
  an initial setup attempt) became CANCELLED through ordinary outbox ingestion.
- Independent backend read confirmed three matching cancellation events with
  reason `runtime_run_disappeared`. The matched WAITING control remained WAITING
  and `finishedAt=null`; no false COMPLETED event was created for any orphan.
- At 03:17:42 UTC `inspect` found only the WAITING control in backend activeRuns,
  all four Gateway sessions inactive and unchanged, Relay active, expected
  candidate hash loaded. This confirms the actual packaged Relay/backend path,
  not only a helper predicate.

## Regression and validation

New regressions on unchanged base: 3 failed, 28 passed. Candidate lifecycle tests:
79 passed, including both orphan statuses, retained waits, concurrent replacement
run, read errors, full pagination, archived/global scope, duplicates and changing
inventory rejection. Existing live-event race and terminal guards retained.
Build and lint passed. Full Vitest and wrapper/cleanup results are recorded below.

No production deployment or merge is implied by this dev acceptance.

Final code validation (same TypeScript/module content as commit `5006905`):
- `npm run build`: exit 0; `npm run lint`: exit 0.
- `npx vitest run`: 102 files passed; 1098 tests passed, 5 skipped;
  136.52 seconds. Lifecycle subset: 79 passed.
- `npm test` wrapper was attempted separately: build-script tests passed;
  spreadsheet stage could not complete on this host because system LibreOffice
  Python UNO is unavailable (initially openpyxl/xlwt were also missing; those
  were supplied in a task-private PYTHONPATH). This wrapper is **not** reported
  green. No spreadsheet/product code or system Python installation was changed.
- Disposable deletion request settled SUCCEEDED at 03:19:27 UTC. Fresh dev
  backend GET returned 404/SERVER_NOT_FOUND, and provider inventory returned no
  matching VM. Existing synthetic organization/template were preserved.
