// Managed-agent reconnect regression; no standalone OpenClaw installation or Gateway spawn.
// Uses a disposable platform-created staging agent. No model requests.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
// Run only inside a disposable agent created by the Golem Workers staging API.
// Reuse its installed Gateway, configuration and provisioned Relay identity.
import 'dotenv/config';
import { readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import JSON5 from 'json5';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
assert.equal(process.env.WATCHDOG_PLATFORM_CANARY, '1', 'Set WATCHDOG_PLATFORM_CANARY=1 only inside the disposable staging agent');
const state = process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw');
await access(join(state, 'golem-workers-relay/identity/device.json'));
const config = JSON5.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH || join(state, 'openclaw.json'), 'utf8'));
const gatewayUrl = process.env.OPENCLAW_GATEWAY_WS_URL || `ws://127.0.0.1:${config.gateway?.port || 18789}`;
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(gatewayUrl).hostname), 'Gateway must be the agent-local managed Gateway');
const token = process.env.OPENCLAW_GATEWAY_TOKEN || config.gateway?.auth?.token;
const password = process.env.OPENCLAW_GATEWAY_PASSWORD || config.gateway?.auth?.password;
const { GatewayClient } = await import(process.env.WATCHDOG_CLIENT_PATH
  ? pathToFileURL(resolve(process.env.WATCHDOG_CLIENT_PATH)).href
  : '../dist/openclaw/gatewayClient.js');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
let client, proxy, active;
const peers = new Set(), timers = new Set();
let connections = 0, inject = null;
try {
  proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(proxy, 'listening');
  proxy.on('connection', downstream => {
    connections++;
    active = downstream;
    peers.add(downstream);
    const mode = inject;
    inject = null;
    const upstream = new WebSocket(gatewayUrl);
    peers.add(upstream);
    downstream.on('error', () => {});
    upstream.on('error', () => downstream.terminate());
    downstream.on('close', () => { peers.delete(downstream); upstream.terminate(); });
    upstream.on('close', () => { peers.delete(upstream); downstream.terminate(); });
    downstream.on('message', data => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
    });
    if (mode) {
      // Inject old heartbeat history; delay the actual Gateway hello, not a fixture.
      client.lastTickMs = mode === 'tick' ? Date.now() - 600000 : Date.now();
      client.lastTickWatchdogCheckMs = mode === 'pause' ? Date.now() - 600000 : Date.now();
    }
    upstream.on('message', data => {
      const frame = JSON.parse(data.toString());
      const send = () => { if (downstream.readyState === WebSocket.OPEN) downstream.send(data.toString()); };
      if (mode && frame.payload?.type === 'hello-ok') {
        const timer = setTimeout(() => { timers.delete(timer); send(); }, 1800);
        timers.add(timer);
      } else send();
    });
  });
  client = new GatewayClient({ url: `ws://127.0.0.1:${proxy.address().port}`,
    token, password, startupMaxAttempts: 2, startupRetryDelayMs: 500,
    connectReadyTimeoutMs: 10000 });
  await client.start();
  assert.equal(client.isReady(), true);
  const results = [];
  for (const mode of (process.env.WATCHDOG_MODE ? [process.env.WATCHDOG_MODE] : ['tick', 'pause'])) {
    const before = connections;
    inject = mode;
    active.terminate();
    await waitFor(() => !client.isReady(), 'disconnect observed');
    await waitFor(() => client.isReady(), `delayed real hello after stale ${mode}`, 12000);
    assert.equal(connections, before + 1, `stale ${mode} must not cause extra reconnects`);
    assert.ok(await client.request('health', {}));
    results.push({ mode, helloDelayMs: 1800, extraConnections: connections - before, ready: true, healthRpc: true });
  }
  if (process.env.WATCHDOG_RESTART_MANAGED_GATEWAY === '1') {
    const unit = process.env.WATCHDOG_GATEWAY_UNIT || 'openclaw-gateway.service';
    assert.match(unit, /^openclaw-gateway(?:-[a-zA-Z0-9_-]+)?\.service$/);
    const user = process.env.WATCHDOG_GATEWAY_USER_SERVICE !== '0';
    const run = promisify(execFile);
    await run('systemctl', [...(user ? ['--user'] : []), 'stop', unit], { timeout: 30000 });
    try {
      await waitFor(() => !client.isReady(), 'managed Gateway stopped');
      await assert.rejects(client.request('health', {}), undefined, 'RPC must exhaust its bounded reconnect attempts while Gateway is stopped');
    } finally {
      await run('systemctl', [...(user ? ['--user'] : []), 'start', unit], { timeout: 60000 });
    }
    await waitFor(() => client.isReady(), 'managed Gateway restart', 120000);
    assert.ok(await client.request('health', {}));
    results.push({ mode: 'managed-service-restart-after-rpc-exhaustion', startupMaxAttempts: 2, ready: true, healthRpc: true });
  }
  client.stop();
  assert.equal(client.isReady(), false, 'stop clears readiness');
  console.log(JSON.stringify({ pass: true, results, modelRequests: 0 }));
} finally {
  client?.stop();
  for (const timer of timers) clearTimeout(timer);
  for (const peer of peers) peer.terminate();
  if (proxy) await new Promise(r => proxy.close(r));
}
