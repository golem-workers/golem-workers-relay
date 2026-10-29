# Active QA scope

## QA scope: WhatsApp excluded (owner decision, 2026-10-28)

WhatsApp is hidden from the product UI and is outside active QA scope. Do not run
WhatsApp-specific unit/component/browser/smoke cases, bootstrap a test client,
request a test phone, or require pairing/reconnect/inbound/edit/revoke/history-sync
or delivery evidence for acceptance, security follow-ups or releases. Excluded
cases are not passes. Historical reports remain historical, not outstanding gates.
Telegram/Discord, HTTP/WS, media and agent lifecycle checks remain in scope.
Runtime integrations, saved credentials/auth sessions and dependency security
inventory are retained; this decision does not declare dependencies fixed or safe.
Reactivation of WhatsApp QA requires a new explicit owner instruction.
