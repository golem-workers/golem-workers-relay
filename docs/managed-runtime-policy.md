# Managed runtime policy

## Authority and compatibility

Only backend `MANAGED_AGENT_HARNESS=openclaw|codex` and
`MANAGED_AGENT_HARNESS_POLICY_REVISION` select the managed chat harness.
Default: OpenClaw, revision 1. **First Codex activation requires revision >=2,
even on a new agent.** Every subsequent choice change needs a strictly newer
revision. Unknown schema, fields, harnesses, stale revisions and same-revision
conflicts fail closed. Roll back the *choice* using a newer revision, not an old
policy file. Do not use config text, local login, relay environment, or backups
as an alternative authority.

Relay accepts incoming policy only at authenticated backend push ingress.
Local HTTP control rejects authority fields before dispatch. Both harnesses
require matching version/digest capability before backend mutations. Old or
independently modified relays must be upgraded; their success responses cannot
prove convergence. Durable authority lives outside `.openclaw` at
`/var/lib/golem-workers/managed-runtime-policy.json`. Restore rejects archive
assets overlapping `/var/lib/golem-workers` and projects the surviving owner
high-water mark before first Gateway start.

Codex is a requirement for all main/fallback conversation models, not a hidden
fallback to OpenClaw. Eligible routes are supported conversational OpenAI GPT/o
models on exact official HTTPS Platform Responses or ChatGPT Responses with
prepared API-key or OAuth authentication respectively. Custom proxies, third
party providers, incompatible APIs, custom ports/paths, userinfo/query/hash,
non-HTTPS and deceptive hosts fail closed. Trailing-dot hostnames are deliberately
stricter than some upstream classifiers: they are rejected. Valid Fast-mode
boolean/`auto` and positive finite cutoff controls are preserved; real authored
request/provider/model/catalog/default/per-agent overrides are rejected. Empty
request metadata records do not count as overrides.

Image-understanding/PDF models may use Codex only when eligible; incompatible
auxiliary providers and embedding/audio/image-generation/video/music purposes
remain explicitly native OpenClaw. Sharing one model ref across conversational
and native-only purposes with conflicting runtime requirements rejects rather
than silently changing either purpose. Defaults, catalog/provider/model rows,
`agents.list`, `agents.entries` and inherited assignments converge together.

Harness selection never proves personal credentials or subscription billing.
Explicit API Responses routes retain API keys/URLs under either harness; explicit
ChatGPT transport retains subscription identity under either harness. OAuth
refresh/no-op auth synchronization converges stale runtime metadata and reloads
only when necessary. Fresh model verification requires matching provider, model,
and actual runtime identity before enterprise authorization/carrier activation
becomes ACTIVE. Unsupported carrier routes under Codex remain unresolved/failed.

## Writes, startup and failure behavior

Bootstrap, SSH provisioning, the common config commit, update/doctor recovery,
clone restart, relay preparation/startup, fenced/unfenced mutations, auth refresh,
and backup restoration use the same canonical policy factory. Generated pure
preflight code does not persist authority. Actual writes recheck revision and CAS
under the same owner `flock`; schema/CAS failure cannot advance authority. Authority
and config files use atomic rename/fsync. The high-water mark is committed only
after preflight/CAS/schema validation, before config activation; a crash at that
narrow point fails closed and may require convergence, never authority rollback.
Owner/model fences still protect model refs, fallback order, auth, provider route,
environment and unrelated fields. Startup normalization failure prevents Gateway
start. Existing rollback rules and intervening-writer checks remain in place.

## Canonical distribution and release gates

Canonical source: backend `packages/managed-runtime-policy/src/policy.ts`.
Generated consumers and tests must not be edited. Relay vendors an exact snapshot;
it never imports a sibling checkout at build or runtime. `managed-runtime-policy.lock.json`
is a release pin, distinct from the vendor manifest. Relay regeneration cannot
repin a changed vendor snapshot. Only backend distribution updates both artifacts.

From the backend checkout:

```sh
node scripts/managed-runtime-policy.mjs --sync-relay /path/to/relay
node scripts/managed-runtime-policy.mjs --check
node /path/to/relay/scripts/managed-runtime-policy.mjs --check \
  --verify-upstream packages/managed-runtime-policy/src/policy.ts
```

Release CI must obtain the canonical source from the exact backend release being
paired and run `--verify-upstream`, in addition to standalone `policy:check`.
Never bypass a digest mismatch or hand-edit a release pin. Release Relay first
with the matching snapshot, then backend; retain OpenClaw default until the
separately authorized rollout chooses a newer Codex revision. No live rollout is
implied by local validation.

Required final gates in **both** repositories: `npm run build`, `npm run lint`,
`npm run test`, generated factory/CJS/SSH/restore parity, both-mode auth/route and
fence sequences, authority-forgery/CAS/schema tests, then independent read-only
review. Do not run Prisma generation concurrently with backend tests sharing
node_modules. This host enables Node's environment proxy globally; unchanged HEAD
fails local HTTP/Host/SSE tests under that proxy. `NODE_USE_ENV_PROXY=0` isolates
local test servers; it is a test-process setting, not an application behavior
change. Recovery tests carry a frozen owner-fence fixture for standalone checkout
coverage; managed authority tests separately execute the current shared writers.
