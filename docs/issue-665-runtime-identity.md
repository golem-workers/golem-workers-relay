# Backend issue #665: Gateway runtime identity response

Dev OpenClaw 2026.9.8 returned this sessions.patch result on the disposable issue665 fixture:

```json
{"resolved":{"modelProvider":"openai","model":"gpt-5.4","agentRuntime":{"id":"openclaw","source":"model"},"runtimeSelectionLocked":false},"entry":{}}
```

Relay 1.0.420 model.verify typed agentRuntime as a string and compared the whole descriptor with the expected string. A correct native model therefore failed before inference with MODEL_VERIFY_MISMATCH / Runtime default model differs from selected model. The push boundary returned generic HTTP500, and the backend authorization assignment recorded RELAY_PUSH_FAILED and retained its durable pending intent. The probe session was deleted through the Gateway API.

The fix reads the descriptor id. OpenClaw 2026.9.7 and 2026.9.8 were observed returning metadata objects; no legitimate scalar-string contract was established, so scalar strings are rejected rather than treated as a compatibility fallback. Missing, malformed or wrong ids still fail closed. Provider/model identity, zero-fallback requirement, independent subscription-route/auth checks, after-inference usage harness check and session cleanup remain unchanged. No runtime policy, lease or credential bypass is introduced.

Regression tests replay the observed response shape and reject wrong/missing/nonstring/array runtime values. After-inference cases actually reach inference before rejecting runtime drift, model fallback or usage harness drift. Before the fix: 4 failed / 6 passed. After the runtime fix: complete suite 69 files / 676 tests passed, then build passed. Lint identified unnecessary async keywords in two Promise-only test mocks; after equivalent Promise.resolve corrections, both affected suites passed 15 tests and full lint/policy/diff checks passed. Full suite/build preceded that test-only correction.

Scope: this proves the reproduced authorization verification defect, not the historical fleet cause or earlier updater config.apply failure. Backend PR666 has since merged. On 2026-10-06 the isolated runtime fix was validated on checker, including an actual model reply; this is not fleet acceptance. The consolidated candidate also makes pairing inventory read-only: channelPairing.list and devicePairing.list never activate incoming policy, while authenticated authority/digest/revision checks and approval mutation guards remain enforced. Final consolidated validation is recorded separately from the historical test counts above.
