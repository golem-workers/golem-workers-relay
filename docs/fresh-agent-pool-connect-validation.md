# Fresh-agent pool Connect regression — dev API, 2026-11-11

## Scope and fixtures

Real remote `https://dev-api.golemworkers.com/api/v1` provisioning, assignment-batch
Connect, pool API, Relay and Gateway were exercised. Production was not changed.
A task-owned Luna template created agent `cmwbmc37u001jjyocylamp3d1` through the
company API; its creation task completed successfully. A separate OpenRouter
fixture was also created while establishing the baseline. Both are disposable.

The authorization was an isolated **synthetic OAuth bundle**. This validates
credential-store and Connect orchestration, not OAuth sign-in, token refresh
against OpenAI, ChatGPT inference, exhaustion behavior or real billing.
No existing user's authorization was reused.

## Observed baseline

- Fresh model: `openai/gpt-5.6-luna`, no configured model fallbacks.
- Generated OpenAI/Codex backend proxy providers included canonical
  `agentRuntime: {id: "openclaw"}`; config env contained this agent's generated
  Relay proxy credential/endpoint pair. Gateway reload mode was `off`.
- Relay 1.0.493, OpenClaw 2026.11.1, subscription guard v2.
- Assignment batch `cmwbmcwxy001ujyock2ye3eqd` completed with a failed item:
  `Subscription-only rotation requires a qualified ChatGPT route without model fallback. Update model settings explicitly before connecting the pool.`

## Candidate and proof

Only the six compiled Relay modules affected by this patch were staged onto the
isolated test agent. No OpenClaw source or installed plugin was modified.

- Standard Connect batch `cmwbmky1j0034jyocp04wzgn9`: item **SUCCESS**.
- Pool: enabled/ready, not pending; member ACTIVE; revision/appliedRevision 1/1;
  credentialVersion/appliedCredentialVersion 1/1.
- Gateway `config.get`: valid, saved/applied configuration hashes equal;
  explicit ChatGPT Responses route applied; model reference unchanged.
- A repeated assignment batch was a backend no-op, so it was **not** counted as
  proof of runtime idempotency. Actual public pool PUT syncs were then exercised.
- A replay exposed discarded canonical runtime metadata causing an unnecessary
  Gateway restart. The final patch preserves it and has a regression test.
- Final-candidate actual sync reached revision/appliedRevision **3/3**, ready=true,
  pending=false. Complete config objects were deeply equal before/after; Gateway
  PID remained **5089**. The loaded guard was still v2 and saved/applied hashes
  still matched. This proves no restart/config drift for that observed replay.

## Automated gates

Lockfile-faithful isolated dependencies, Node 24.22.1:

- `npm run build`: passed.
- `npm run lint`: passed.
- `npm test`: **93 files passed; 956 tests passed, 5 skipped**.

The test command removed inherited HTTP(S)/ALL proxy variables and
`NODE_USE_ENV_PROXY`; those interfere with the suite's loopback HTTP fixtures.
No application behavior was changed to accommodate the test environment.

Tests cover exact generated-row/env eligibility and foreign/custom negatives,
read-only admission, v1/v2 fallback semantics, CAS/model fences, pending-before-
credentials ordering, applied-config/guard proof and reload-off activation.

## Fixture cleanup

The standard pool API removed the test member at revision 4, and the standard
authorization-delete API disabled the synthetic account and cleared its encrypted
credential payload. The company-scoped audited deletion workflow returned
`SUCCEEDED` for both task-created agents; subsequent read-only inventory confirmed
both `DELETED` with deletion timestamps. The task-created Luna template is
`ARCHIVED`; the shared QA template and existing real accounts were not modified.
The temporary tunnel SSH key was removed.
