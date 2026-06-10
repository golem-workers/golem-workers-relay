# Transport Bug Hunt

This suite is for finding transport bugs, not increasing coverage numbers.

Run it locally with:

```bash
npm run test:transport
```

## Invariants

- Every user-origin pushed message must end with exactly one terminal backend outcome: `reply`, `error`, or `no_reply`.
- Terminal outcomes must remain correlated to the original `backendMessageId`, OpenClaw `runId`, `sessionKey`, and transport target.
- Transcript-only OpenClaw success must be recoverable when the gateway final event is missing.
- SDK/plugin delivery evidence must not be guessed when more than one active message can match a session.
- System, self-nudge, cron, and technical notifications must not make an unresolved user message look healthy.
- Late, duplicate, out-of-order, empty, or disconnected gateway events must not produce silent loss or duplicate delivery.
- Relay release paths such as timeout, abort, `no_reply`, and direct delivery failure must clean up active transport correlation state.

## Known Incident Replay

The first replay target is the stale transcript-session failure:

1. Relay accepts a user chat task and calls `chat.send`.
2. Gateway returns a `runId`, but no `chat.final` event reaches relay.
3. Before `chat.send`, `sessions.json` points `agent:main:${sessionKey}` to an old transcript file.
4. OpenClaw creates or switches to a new session file after `chat.send`.
5. The assistant final appears only in the new transcript.
6. Relay must re-resolve `sessions.json`, recover the assistant reply, and send the terminal callback.

The regression test is `recovers a transcript-only reply after OpenClaw rotates the relay-backed session file` in
`src/openclaw/chatRunner.test.ts`.

## Bug-Hunt Areas

- `ChatRunner` completion matrix: missing final, empty final, late final, duplicated final, terminal error, abort, disconnect.
- Transcript recovery: stale baseline, session rotation, partial JSONL, old assistant text, multipart prompt matching.
- Delivery tracker: explicit correlation, same-session ambiguity, stale cleanup after non-reply outcomes.
- Processor/backend callback: every pushed chat message gets a bounded terminal callback.
- Transport adapters: text/media delivery, SDK-delivered evidence, direct delivery fallback, failure propagation.

## Plugin Delivery Contract

Relay treats `relay_channel_v2` user-facing delivery as one of three explicit classes:

- Gateway/plugin SDK delivery receipt: accepted only when it carries an explicit `correlationMessageId`, or when exactly one active backend message exists for the session.
- Relay direct final delivery: used when the assistant produced a user-facing final reply and no trusted SDK receipt exists.
- No user-facing output: classified as `no_reply` or `error`; assistant tool/system activity alone is not a delivered reply.

Ambiguous session-scoped SDK receipts are intentionally ignored. This can make relay send the final text directly, but it avoids marking the wrong backend message as delivered.

## Restart And Reconnect Scope

Current relay process state for an in-flight `runChatTask` is memory-resident. The supported bounded failure behavior in this repo is:

- gateway transport interruptions inside `ChatRunner` retry or return a terminal relay error in tests;
- transcript-backed in-flight waiters are retained across gateway disconnects so transcript polling can recover a reply while the gateway reconnects;
- active task timeout releases the queue and sends a terminal error callback;
- transcript-only success is recovered when the relay process remains alive.

Full process restart recovery of an already in-flight user request is not implemented in relay local state. That path needs durable backend/relay reconciliation before it can be claimed as solved end-to-end.

## Telegram Direct Delivery Rules

- Long Telegram text is split into ordered chunks before direct final delivery.
- Telegram media captions are capped separately and leftover text is sent after the media.
- Direct Telegram final sends include stable idempotency keys per backend message and chunk/media part.

When a new incident happens, add a sanitized replay fixture or table-driven test before changing production code.
