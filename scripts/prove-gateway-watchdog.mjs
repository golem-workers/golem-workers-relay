// Opt-in real Gateway acceptance: built Relay + GATEWAY_CLI=openclaw.mjs.
// Private temporary state, ephemeral loopback listeners, no model requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
assert.ok(process.env.GATEWAY_CLI, 'Set GATEWAY_CLI to installed openclaw.mjs');
const root = await mkdtemp(join(tmpdir(), 'relay-watchdog-'));
const previousState = process.env.OPENCLAW_STATE_DIR;
process.env.OPENCLAW_STATE_DIR = join(root, 'relay');
const { GatewayClient } = await import(process.env.WATCHDOG_CLIENT_PATH
  ? pathToFileURL(resolve(process.env.WATCHDOG_CLIENT_PATH)).href
  : '../dist/openclaw/gatewayClient.js');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const config = join(root, 'openclaw.json');
await writeFile(config, JSON.stringify({ gateway: {
  mode: 'local', bind: 'loopback', port,
  auth: { mode: 'token', token: 'isolated-watchdog-acceptance' },
} }));
const log = await open(join(root, 'gateway.log'), 'a');
let gateway, client, proxy, active;
const peers = new Set(), timers = new Set();
async function startGateway() {
  gateway = spawn(process.execPath, [resolve(process.env.GATEWAY_CLI), 'gateway', 'run',
    '--allow-unconfigured', '--bind', 'loopback', '--port', String(port)], {
    env: { ...process.env, OPENCLAW_STATE_DIR: join(root, 'gateway'),
      OPENCLAW_CONFIG_PATH: config, OPENCLAW_SKIP_CHANNELS: '1' },
    stdio: ['ignore', log.fd, log.fd],
  });
  await waitFor(async () => {
    if (gateway.exitCode !== null) throw new Error(`Gateway exited ${gateway.exitCode}; ${root}`);
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    return new Promise(r => {
      socket.once('error', () => r(false));
      socket.once('open', () => { socket.close(); r(true); });
    });
  }, 'real Gateway listener', 60000);
}
async function stopGateway() {
  if (!gateway || gateway.exitCode !== null) return;
  const child = gateway, exit = once(child, 'exit');
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { await exit; } finally { clearTimeout(kill); }
}
let connections = 0, inject = null;
try {
  await startGateway();
  proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(proxy, 'listening');
  proxy.on('connection', downstream => {
    connections++;
    active = downstream;
    peers.add(downstream);
    const mode = inject;
    inject = null;
    const upstream = new WebSocket(`ws://127.0.0.1:${port}`);
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
    token: 'isolated-watchdog-acceptance', startupMaxAttempts: 20, startupRetryDelayMs: 500,
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
  await stopGateway();
  await waitFor(() => !client.isReady(), 'Gateway stopped');
  await startGateway();
  await waitFor(() => client.isReady(), 'reconnect after real Gateway restart');
  assert.ok(await client.request('health', {}));
  results.push({ mode: 'real-process-restart', ready: true, healthRpc: true });
  client.stop();
  assert.equal(client.isReady(), false, 'stop clears readiness');
  console.log(JSON.stringify({ pass: true, results, modelRequests: 0 }));
} finally {
  client?.stop();
  for (const timer of timers) clearTimeout(timer);
  for (const peer of peers) peer.terminate();
  if (proxy) await new Promise(r => proxy.close(r));
  await stopGateway();
  await log.close();
  if (previousState === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = previousState;
  if (process.env.WATCHDOG_KEEP_STATE === '1') console.error(`Private diagnostics: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
