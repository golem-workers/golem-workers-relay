# Watchdog staging verification

Use the Golem Workers staging control plane and its provisioned agents, not a
standalone OpenClaw installation on the dev-api host.

## Procedure

1. With existing authorized staging credentials, discover the company workspace,
   its active agent templates and `launch-readiness`. Do not bypass admission or
   alter another test's company settings. Create one disposable agent through
   `POST /api/v1/company/organizations/:organizationId/agents`, using an explicit
   template version and stable idempotency key. Wait for its creation task's
   `SUCCESS` before lifecycle operations.
2. Download only that agent's scoped `access-key`. Keep the private key in a
   mode-0600 temporary file. Install the built candidate Relay on that agent
   only; verify dependency-lock equality before reusing its node_modules, and
   record the compiled GatewayClient checksum. Keep its provisioned configuration,
   Gateway installation, Relay identity and service units.
3. From the candidate Relay directory, run the README's managed-agent probe.
   Require stale tick and stale pause to yield exactly one replacement connection
   and successful `health` RPC. Repeat with the original compiled GatewayClient
   selected by `WATCHDOG_CLIENT_PATH`; both modes must fail that assertion.
4. Opt into `WATCHDOG_RESTART_MANAGED_GATEWAY=1` only on this disposable agent.
   Require managed service restart/reconnect and successful health RPC. Separately
   require the actual candidate Relay daemon's `/ready` at port 18790 to report
   `ready: true`, and confirm its loaded artifact matches the candidate checksum.
5. Invoke the standard `POST /api/v1/servers/:id/openclaw/update` and read its
   action to a terminal result. Preserve failures; do not equate API acceptance
   with completion. Record whether Update replaced the candidate Relay; do not
   attribute results to the candidate if its compiled artifact changed. Record
   independent updater blockers separately from the watchdog result.
6. Collect sanitized evidence, delete only this disposable agent through the
   company `deletion-preview` and `delete` APIs, verify terminal deletion, and
   remove its temporary access key. Never silently leave a failed disposable VM.

## Verification on 2026-11-16

- Company: existing Enterprise Development Canary; existing Runtime Update E2E
  template v4. No company settings changed.
- Agent: `cmwji2xnk000fhjoccdzcfdl6`; creation task
  `cmwji2xtf000jhjockhjaxthk`: SUCCESS at 16:54:49 UTC.
- Native image runtime: OpenClaw 2026.11.3, Node 24.22.3. No standalone runtime
  installed on the control-plane host for this verification.
- Product candidate source: PR head `86b58b17f1d255ac428d36c411d2ffc1098c06c8`;
  compiled GatewayClient SHA256
  `40d068c7818e192ada26dc05a5cba77b9605f8e6657f73eb409bbba877eb9af8`.
  That was the initial watchdog-only candidate; the additional product fix is recorded below.
- Installed candidate Relay dependency lock exactly matched the provisioned
  agent. Both delayed real-Gateway hello cases passed (1800ms, one replacement,
  real health RPC). Original-main negative controls both exited 1 because they
  opened an extra replacement connection (actual 3 vs expected 2).
- Restart of the provisioned user `openclaw-gateway.service` passed; candidate
  daemon returned `ready: true` with the same compiled GatewayClient checksum.
  Probe issued zero model requests. This does not claim model/chat acceptance.
- The first Update was inadvertently requested before creation completed. It
  failed its pre-install capacity guard: UPDATE_INSUFFICIENT_DISK (required
  6,310,608,210 bytes; free 5,962,866,688). It is not a clean post-create Update
  result. Only apt package cache was cleaned on this disposable agent; no
  capacity guard was bypassed. A post-create Update was requested separately.

Standalone-host component checks previously labeled dev-api acceptance were the
wrong setup. Their isolated `/root/pr99-devapi-20261116` directory (including its
standalone OpenClaw) was removed from dev-api; `gwb` remained active. Those checks
are component evidence only, not this platform-agent verification.

## Standard Update result

Post-create action `cmwjiat1z001ghjocb2ok09ej` passed capacity preflight,
installed 2026.11.4, completed offline migrations/canonical activation and passed
Gateway health. Its terminal status was FAILED at the model smoke gate:
`OpenClaw default model authentication/route is unavailable: openai/gpt-5.6-sol`.
The existing Runtime Update E2E template has no usable authentication/route for
that model. No credentials or company settings were altered to suppress this
failure. This is not successful full Update acceptance.

An additional probe was mistakenly attempted during config_sync before Update
settled; it failed with a closed/unavailable Gateway while the native lifecycle
was still restarting it. It is retained as a premature probe attempt, not as a
terminal candidate result. Post-terminal evidence is recorded separately below.

## Additional defect found by the managed-agent Update

After the failed model smoke, Gateway was healthy and a new candidate client
connected, but the existing Relay daemon remained not-ready. Its log exhausted
90 reconnect attempts and then stopped attempting. A concurrent RPC's bounded
`runStartLoop` called `stop()` on exhaustion, canceling background recovery even
though the client had connected successfully before.

Added a real-WebSocket regression that exhausts an RPC's two configured attempts
while Gateway is unavailable, then requires automatic background recovery without
a fresh request, start call or service restart. It failed before the additional
fix (connected count remained 1 instead of 2). The fix retains bounded request
failure and initial-startup teardown, but schedules background recovery after a
prior successful connection instead of stopping the client. Explicit stop remains
respected. No production environment switch is added.

The final product GatewayClient compiled SHA256 is
`5639cd8b6f3235d930690d9af0fdc759799e5b130a9991cab5be0e810844019d`.
The native restart probe now uses two bounded RPC attempts while the real
Gateway is stopped, then checks automatic recovery after starting its existing
service. This distinguishes initial watchdog-only evidence from the final fix.

Final candidate live result on the same platform-created agent (2026.11.4):
stale tick PASS, stale pause PASS, and native service restart after the probe's
RPC retry exhaustion PASS. Recovery required no fresh client start/request.
The actual patched Relay daemon returned `ready: true` with the final compiled
checksum above. The updater's missing model authorization result remains FAILED;
this reconnect success does not relabel that broader operation.

## Final gates and cleanup

Final build and lint passed. Full frozen-source test run:
`NODE_USE_ENV_PROXY=0 npm test -- --maxWorkers=1`: 99 files passed,
1050 tests passed / 5 skipped, exit 0, 214.17 seconds. GatewayClient now has
13 passing regressions, including RPC-exhaustion recovery; the new regression
was observed failing before its fix.

Company deletion returned request SUCCEEDED and the exact test agent DELETED;
a subsequent GET /servers/:id returned 404 SERVER_NOT_FOUND. No other agent,
company profile, template or credentials were changed. Temporary access material
and control-plane test artifacts were removed. No merge or production rollout.
