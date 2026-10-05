# Backend issue #665: Gateway runtime identity response

Dev OpenClaw 2026.9.8 returned this sessions.patch result on the disposable issue665 fixture:

```json
{"resolved":{"modelProvider":"openai","model":"gpt-5.4","agentRuntime":{"id":"openclaw","source":"model"},"runtimeSelectionLocked":false},"entry":{}}
```

Relay 1.0.420 model.verify typed agentRuntime as a string and compared the whole descriptor with the expected string. A correct native model therefore failed before inference with MODEL_VERIFY_MISMATCH / Runtime default model differs from selected model. The push boundary returned generic HTTP500, and the backend authorization assignment recorded RELAY_PUSH_FAILED and retained its durable pending intent. The probe session was deleted through the Gateway API.

The fix reads the descriptor id, retaining legacy string compatibility. Missing, malformed or wrong ids still fail closed. Provider/model identity, zero-fallback requirement, independent subscription-route/auth checks, after-inference usage harness check and session cleanup remain unchanged. No runtime policy, lease or credential bypass is introduced.

Regression tests replay the observed response shape and reject wrong/missing/nonstring/array runtime values. After-inference cases actually reach inference before rejecting runtime drift, model fallback or usage harness drift. Before the fix: 4 failed / 6 passed. After the runtime fix: complete suite 69 files / 676 tests passed, then build passed. Lint identified unnecessary async keywords in two Promise-only test mocks; after equivalent Promise.resolve corrections, both affected suites passed 15 tests and full lint/policy/diff checks passed. Full suite/build preceded that test-only correction.

Scope: this proves the newly reproduced authorization verification defect. It does not establish the historical fleet cause or explain the earlier complete updater config.apply failure. Backend issue665 and draft PR666 remain open. The patch is being checked only on one disposable dev fixture with original-module backup and exact before/after SHA256 guards; no production or main deployment.
