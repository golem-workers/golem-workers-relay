// Offline synthetic-only action matrix. Build first. Only service/RPC transport is fake.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveRuntimeAuthSdk, writeRuntimeAuth } from '../dist/agentControl/runtimeAuthWriter.js';
import { executeAgentControl } from '../dist/agentControl/executeAgentControl.js';
import { agentControlActionSchema } from '../dist/agentControl/protocol.js';
const sdk = await resolveRuntimeAuthSdk();
const dist = path.dirname(path.dirname(sdk));
const runtimeVersion = JSON.parse(await fs.readFile(path.join(dist, '../package.json'), 'utf8')).version;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'subscription-sequences-'));
const originalPath = process.env.PATH;
const results = [];
let actions = 0;
const token = (email, account) => [Buffer.from('{"alg":"none"}').toString('base64url'), Buffer.from(JSON.stringify({ exp: 4700000000, 'https://api.openai.com/profile': { email }, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'plus' } })).toString('base64url'), 'synthetic'].join('.');
const bundleFor = name => ({ formatVersion: 1, profileId: 'openai:'+name+'@example.test', accessToken: token(name+'@example.test', 'acct-'+name), idToken: token(name+'@example.test', 'acct-'+name), refreshToken: 'synthetic-refresh-'+name, expiresAtMs: 4700000000000, lastRefresh: '2026-10-01T00:00:00.000Z', email: name+'@example.test', accountId: 'acct-'+name, chatgptPlanType: 'plus' });
const endpoint = 'https://dev-api.golemworkers.com/api/v1/relays/openai/v1';
const row = () => ({ baseUrl: endpoint, models: [] });
const SOL = 'gpt-6.1-sol', TERRA = 'gpt-5.4';
async function runtimeFunction(prefix, name) {
  const candidates = [];
  for (const file of await fs.readdir(dist)) {
    if (!file.startsWith(prefix) || !file.endsWith('.mjs')) continue;
    const text = await fs.readFile(path.join(dist, file), 'utf8');
    if (text.includes('function ' + name + '(')) candidates.push({ file, text });
  }
  assert.equal(candidates.length, 1, 'Unambiguous runtime export '+name);
  const { file, text } = candidates[0];
  const entry = text.slice(text.lastIndexOf('export {') + 8).split('}')[0].split(',').map(s => s.trim()).find(s => s.split(' as ')[0] === name);
  assert.ok(entry, 'Exported '+name);
  return (await import(pathToFileURL(path.join(dist, file))))[entry.split(' as ')[1] || name];
}
function activate(f) {
  Object.assign(process.env, { HOME: f.root, OPENCLAW_STATE_DIR: f.root, OPENCLAW_CONFIG_PATH: f.configPath, OPENCLAW_AGENT_DIR: path.join(f.root, 'agents/main/agent'), CODEX_HOME: path.join(f.root, 'codex'), BACKEND_BASE_URL: 'https://dev-api.golemworkers.com', OPENCLAW_GATEWAY_UNIT_PATH: path.join(f.root, 'gateway.service'), OPENCLAW_GATEWAY_DROP_IN_DIR: path.join(f.root, 'gateway.service.d') });
}
async function fixture(name, ownership = 'shared', expired = false) {
  const dir = path.join(root, name); await fs.mkdir(dir);
  const f = { root: dir, configPath: path.join(dir, 'openclaw.json'), bundle: bundleFor(name), ownership };
  activate(f);
  await fs.writeFile(f.configPath, JSON.stringify({ agents: { defaults: { model: { primary: 'openai/'+TERRA }, thinkingDefault: 'high' } }, auth: { order: { openai: [f.bundle.profileId] } }, models: { providers: { openai: row(), codex: row(), anthropic: { baseUrl: 'https://keep.example.test', models: [] } } } }));
  if (ownership === 'agent') {
    await fs.mkdir(process.env.OPENCLAW_AGENT_DIR, { recursive: true });
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', "const {updateAuthProfileStoreWithLock}=await import(process.argv[1]); const r=await updateAuthProfileStoreWithLock({agentDir:process.env.OPENCLAW_AGENT_DIR,saveOptions:{syncExternalCli:false},updater:s=>{s.profiles['anthropic:keep']={type:'api_key',provider:'anthropic',key:'synthetic'}; return true;}}); process.exit(r?0:1);", pathToFileURL(sdk).href], { env: process.env });
  }
  const credential = { type: 'oauth', provider: 'openai', access: f.bundle.accessToken, refresh: f.bundle.refreshToken, expires: expired ? 1 : f.bundle.expiresAtMs, email: f.bundle.email, accountId: f.bundle.accountId };
  if (ownership === 'legacy') {
    f.authPath = path.join(dir, 'auth-profiles.json');
    await fs.writeFile(f.authPath, JSON.stringify({ version: 1, profiles: { [f.bundle.profileId]: credential }, order: { openai: [f.bundle.profileId] }, lastGood: { openai: f.bundle.profileId } }));
  } else {
    await writeRuntimeAuth({ configPath: f.configPath, profileId: f.bundle.profileId, credential });
    f.authPath = path.join(dir, ownership === 'agent' ? 'agents/main/agent/openclaw-agent.sqlite' : 'state/openclaw.sqlite');
  }
  return f;
}
async function snapshot(f) {
  if (f.ownership === 'legacy') {
    const store = JSON.parse(await fs.readFile(f.authPath, 'utf8'));
    return { store, state: { order: store.order, lastGood: store.lastGood }, schema: 'legacy-json', integrity: 'ok' };
  }
  const db = new DatabaseSync(f.authPath, { readOnly: true });
  try {
    const agent = f.ownership === 'agent';
    const read = (sql, key) => JSON.parse(db.prepare(sql).get(key)?.value ?? 'null');
    return { store: read(agent ? 'SELECT store_json AS value FROM auth_profile_store WHERE store_key=?' : 'SELECT value_json AS value FROM config_machine_state WHERE state_key=?', agent ? 'primary' : 'authProfiles.store'), state: read(agent ? 'SELECT state_json AS value FROM auth_profile_state WHERE state_key=?' : 'SELECT value_json AS value FROM config_machine_state WHERE state_key=?', agent ? 'primary' : 'authProfiles.state'), schema: { meta: db.prepare('SELECT * FROM schema_meta').all(), version: db.prepare('PRAGMA user_version').get(), definitions: db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), owner: agent ? null : read('SELECT value_json AS value FROM config_machine_state WHERE state_key=?', 'auth.sharedStore') }, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check };
  } finally { db.close(); }
}
const config = async f => JSON.parse(await fs.readFile(f.configPath, 'utf8'));
const save = async (f, cfg) => fs.writeFile(f.configPath, JSON.stringify(cfg));
async function run(f, action, gateway = { request() { throw Error('Unexpected gateway RPC'); } }) {
  activate(f); actions++;
  return executeAgentControl({ configPath: f.configPath, action: agentControlActionSchema.parse(action), gateway });
}
const modelAction = (kind, id, thinking, fallback = null) => ({ kind, ...(kind === 'model.set' ? { model: id, fallbacks: fallback ? [fallback] : [] } : { purpose: 'main', primary: id, fallback }), ...(thinking !== undefined ? { thinkingDefault: thinking } : {}) });
async function check(name, fn) {
  try { const detail = await fn(); results.push({ name, status: 'PASS', ...detail }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.message }); }
  console.log(JSON.stringify(results.at(-1)));
}
try {
  activate({ root, configPath: path.join(root, 'openclaw.json') });
  for (const key of Object.keys(process.env)) if (/^(OPENAI|CODEX|ANTHROPIC|GOOGLE|GEMINI|AWS|AZURE|OPENROUTER|XAI|MISTRAL|GROQ)_/.test(key) && key !== 'CODEX_HOME') delete process.env[key];
  globalThis.fetch = () => { throw Error('Network forbidden in offline proof'); };
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'systemctl'), `#!/bin/sh
if [ "$2" = "restart" ] && [ "$MATRIX_FAIL_RESTART" = "1" ]; then exit 43; fi
if [ "$2" = "show" ]; then case "$5" in ActiveState) echo active;; SubState) echo running;; Result) echo success;; esac; fi
exit 0
`, { mode: 0o700 });
  process.env.PATH = bin + path.delimiter + originalPath;
  const resolve = await runtimeFunction('openai-model-routes-', 'resolveOpenAIModelRoutes');
  const select = await runtimeFunction('provider-model-route-auth-', 'selectProviderModelRouteAuth');
  const plan = await runtimeFunction('provider-model-route-auth-', 'buildProviderModelAuthSourcePlan');
  async function route(f, id, readiness = 'ready') {
    const cfg = await config(f), auth = await snapshot(f);
    const model = cfg.models?.providers?.openai?.models?.find(m => m.id === id);
    const resolution = resolve({ config: cfg, provider: 'openai', modelId: id, api: model?.api, baseUrl: model?.baseUrl, agentId: 'main', primaryModel: { provider: 'openai', model: id }, env: {}, resolveProfileAuthMode: key => auth.store.profiles[key]?.type, resolveProfileAuthFlow: key => auth.store.profiles[key]?.authFlow });
    const order = cfg.auth?.order?.openai ?? auth.state?.order?.openai ?? [];
    return { resolution, selected: select({ provider: 'openai', resolution, sourcePlan: plan({ explicitOrder: true, profiles: order.map(profileId => ({ profileId, mode: auth.store.profiles[profileId]?.type, readiness, cooldown: 'clear' })) }) }) };
  }
  async function subscription(f, id) {
    const r = await route(f, id);
    assert.equal(r.selected.kind, 'selected', JSON.stringify(r.selected));
    assert.equal(r.selected.selection.route.authRequirement, 'subscription');
    assert.equal(r.selected.selection.route.api, 'openai-chatgpt-responses');
    return r;
  }
  for (const owner of ['shared', 'agent', 'legacy']) for (const kind of ['model.set', 'modelAssignment.set']) {
    await check(owner+'/'+kind+'/roundtrip-reasoning-fallback-idempotence', async () => {
      const f = await fixture(owner+'-'+kind, owner), before = await snapshot(f);
      let preservedThinking = 'high';
      for (const [id, thinking, fallback] of [[TERRA,'off'],[SOL,'low'],[TERRA,'high'],[SOL,undefined],[SOL,null],[SOL,'high','codex/'+TERRA],[TERRA,undefined,'openai/'+SOL],[SOL,undefined],[TERRA,undefined]]) {
        const action = modelAction(kind, 'openai/'+id, thinking, fallback);
        await run(f, action); await subscription(f,id);
        const cfg = await config(f);
        if (thinking !== undefined) preservedThinking = thinking;
        assert.equal(cfg.agents.defaults.thinkingDefault ?? null, preservedThinking);
        assert.equal(cfg.agents.defaults.model.primary,'openai/'+id);
        assert.deepEqual(cfg.agents.defaults.model.fallbacks,fallback ? [fallback.replace(/^(codex|openai-codex)\//,'openai/')] : []);
        assert.deepEqual(await snapshot(f), before, 'tokens/order/identity/schema unchanged');
        assert.equal(cfg.models.providers.codex, undefined);
        await run(f, action); assert.deepEqual(await config(f), cfg, 'idempotent config');
        assert.deepEqual(await snapshot(f), before); await subscription(f,id);
      }
      await run(f, modelAction(kind, 'anthropic/claude-sonnet-4-5', 'low'));
      assert.equal((await config(f)).agents.defaults.model.primary, 'anthropic/claude-sonnet-4-5');
      assert.deepEqual(await snapshot(f), before);
      await run(f, modelAction(kind, 'openai/'+SOL, undefined)); await subscription(f,SOL);
      assert.deepEqual(await snapshot(f), before);
      return { steps: 20, ownership: owner, authUnchanged: true };
    });
  }
  for (const kind of ['model.set','modelAssignment.set','config.apply']) await check('generated-proxy-reintroduced/nonempty-sol/'+kind, async () => {
    const f = await fixture('reintro-'+kind);
    await run(f, modelAction('model.set', 'openai/'+SOL, 'high'));
    const before = await snapshot(f), cfg = await config(f);
    cfg.models.providers.openai.baseUrl = endpoint; cfg.models.providers.codex = row();
    if (kind === 'config.apply') await run(f, { kind, configText: JSON.stringify(cfg) });
    else { await save(f,cfg); await run(f, modelAction(kind,'openai/'+SOL,'low')); }
    assert.deepEqual(await snapshot(f), before);
    await subscription(f,SOL);
    assert.equal((await config(f)).models.providers.openai.baseUrl, undefined);
    assert.equal((await config(f)).models.providers.codex, undefined);
    return { authUnchanged: true };
  });
  await check('config.apply/empty-generated-route-and-read-modify-apply', async () => {
    const f = await fixture('config-apply'), before = await snapshot(f);
    const cfg = await config(f); cfg.agents.defaults.model.primary = 'openai/'+SOL;
    cfg.agents.defaults.models = { ['openai/'+SOL]: { agentRuntime: { id: 'openclaw' } } };
    await run(f,{kind:'config.apply',configText:JSON.stringify(cfg)}); await subscription(f,SOL);
    const read = await run(f,{kind:'config.read'}); read.config.agents.defaults.thinkingDefault = 'off';
    await run(f,{kind:'config.apply',configText:JSON.stringify(read.config)}); await subscription(f,SOL);
    assert.deepEqual(await snapshot(f),before);
    assert.equal(agentControlActionSchema.safeParse({kind:'config.patch',patch:{}}).success,false);
    const contents = await fs.readFile(f.configPath,'utf8');
    await assert.rejects(run(f,{kind:'config.apply',configText:'{ broken'}), /config|JSON|parse/i);
    assert.equal(await fs.readFile(f.configPath,'utf8'),contents); assert.deepEqual(await snapshot(f),before);
    return { patchPath: 'config.read + caller merge + config.apply; config.patch unsupported' };
  });
  for (const id of [TERRA,SOL]) await check('model-aliases/'+id,async()=>{
    const f=await fixture('aliases-'+id), before=await snapshot(f);
    for(const alias of ['codex','openai-codex','openai']) {
      await run(f,modelAction('model.set',alias+'/'+id,'high'));
      assert.equal((await config(f)).agents.defaults.model.primary,'openai/'+id);
      await subscription(f,id); assert.deepEqual(await snapshot(f),before);
    }
    return { aliases:['codex','openai-codex','openai'] };
  });
  for(const purpose of ['image','imageGeneration','videoGeneration','musicGeneration','pdf']) await check('non-main-assignment/'+purpose,async()=>{
    const f=await fixture('purpose-'+purpose), before=await snapshot(f);
    await run(f,{kind:'modelAssignment.set',purpose,primary:'openai/'+SOL,fallback:'codex/'+TERRA,thinkingDefault:'off'});
    assert.equal((await config(f)).agents.defaults.thinkingDefault,'high');
    await subscription(f,SOL); assert.deepEqual(await snapshot(f),before);
    return { mainReasoningPreserved:true };
  });
  await check('two-independent-fixtures/dashboard-equivalent-bulk',async()=>{
    const a = await fixture('bulk-a'), b = await fixture('bulk-b');
    const sa=await snapshot(a), sb=await snapshot(b);
    for (const id of [SOL,TERRA,SOL]) {
      for(const f of [a,b]) await run(f,modelAction('model.set','openai/'+id,'high'));
      await subscription(a,id); await subscription(b,id);
      assert.deepEqual(await snapshot(a),sa); assert.deepEqual(await snapshot(b),sb);
    }
    assert.notEqual(sa.store.profiles[a.bundle.profileId].refresh,sb.store.profiles[b.bundle.profileId].refresh);
    return { bulkTargets: 2, independentIdentities: true };
  });
  await check('expired-profile/route-identity-not-readiness',async()=>{
    const f=await fixture('expired','shared',true), before=await snapshot(f);
    await run(f,modelAction('model.set','openai/'+SOL,'high'));
    const ready=await subscription(f,SOL), unavailable=await route(f,SOL,'unavailable');
    assert.equal(ready.selected.selection.route.authRequirement,'subscription');
    assert.notEqual(unavailable.selected.kind,'selected'); assert.deepEqual(await snapshot(f),before);
    const status=await run(f,{kind:'codex.login.status'});
    assert.equal(status.state,'failed'); assert.equal(status.lastError,'expired_oauth_token');
    return { selectionWithUnavailableProfile: unavailable.selected.kind, refreshAndInference: 'not attempted' };
  });
  for (const owner of ['shared','agent']) await check(owner+'/auth-import-reimport-export-status-and-failed-sync-rollback', async()=>{
    const f=await fixture('auth-'+owner,owner);
    await run(f,{kind:'codex.auth.import',bundle:f.bundle});
    const before=await snapshot(f);
    assert.equal(before.integrity,'ok');
    assert.equal(before.schema.meta[0].role,owner==='agent'?'agent':'global');
    assert.ok(before.schema.version.user_version>0);
    const out=await run(f,{kind:'codex.auth.export'}); assert.deepEqual(out.bundle,f.bundle);
    const status=await run(f,{kind:'codex.login.status'}); assert.equal(status.state,'connected'); assert.equal(status.profileId,f.bundle.profileId);
    await run(f,modelAction('model.set','openai/'+SOL,'low')); await subscription(f,SOL);
    await run(f,{kind:'codex.auth.import',bundle:f.bundle}); await subscription(f,SOL);
    assert.deepEqual(await snapshot(f),before,'reimport credential/order/schema semantics');
    assert.deepEqual((await run(f,{kind:'codex.auth.export'})).bundle,f.bundle);
    const cfgBefore=await fs.readFile(f.configPath,'utf8'); const cliBefore=await fs.readFile(path.join(f.root,'codex/auth.json'),'utf8');
    const changed={...f.bundle,refreshToken:'synthetic-rotation-failing'}; let calls=0;
    await assert.rejects(run(f,{kind:'codex.auth.sync',bundleVersion:2,bundle:changed},{async request(method){assert.equal(method,'models.authStatus'); if(++calls===1) throw Error('synthetic refresh rejection'); return {};}}),/synthetic refresh rejection/);
    assert.equal(calls,2,'refresh then rollback refresh');
    assert.equal(await fs.readFile(f.configPath,'utf8'),cfgBefore); assert.equal(await fs.readFile(path.join(f.root,'codex/auth.json'),'utf8'),cliBefore);
    assert.deepEqual(await snapshot(f),before); await subscription(f,SOL);
    await assert.rejects(run(f,{kind:'codex.auth.import',bundle:{...f.bundle,expiresAtMs:1}}),/expired/);
    await assert.rejects(run(f,{kind:'codex.auth.import',bundle:{...f.bundle,profileId:'openai:wrong@example.test'}}),/identity/);
    assert.deepEqual(await snapshot(f),before); await subscription(f,SOL);
    return { rollback: 'config + tokens + order + identity + schema + CLI; explicit rejection required' };
  });
  for (const owner of ['shared','agent']) await check(owner+'/sync-version-order-and-mode-roundtrip',async()=>{
    const f=await fixture('versions-'+owner,owner);
    await run(f,{kind:'codex.auth.import',bundle:f.bundle});
    await run(f,modelAction('model.set','openai/'+SOL,'high'));
    const gateway={async request(method){assert.equal(method,'models.authStatus'); return {};}};
    assert.equal((await run(f,{kind:'codex.auth.sync',bundleVersion:2,bundle:f.bundle},gateway)).applied,true);
    const before=await snapshot(f);
    for(const version of [2,1]) {
      const stale={...f.bundle,refreshToken:'synthetic-stale-do-not-save'};
      const result=await run(f,{kind:'codex.auth.sync',bundleVersion:version,bundle:stale},gateway);
      assert.equal(result.reason,'up_to_date'); assert.equal(result.bundleVersion,2);
      assert.deepEqual(await snapshot(f),before); await subscription(f,SOL);
    }
    const rotated={...f.bundle,refreshToken:'synthetic-newer-refresh'};
    assert.equal((await run(f,{kind:'codex.auth.sync',bundleVersion:3,bundle:rotated},gateway)).applied,true);
    assert.deepEqual((await run(f,{kind:'codex.auth.export'})).bundle,rotated);
    const rotatedState=await snapshot(f); assert.deepEqual(rotatedState.schema,before.schema);
    assert.deepEqual(rotatedState.state,before.state); await subscription(f,SOL);
    // Older version repair may remove a regenerated route, never restore stale tokens.
    const cfg=await config(f); cfg.models.providers.openai.baseUrl=endpoint; cfg.models.providers.codex=row(); await save(f,cfg);
    assert.equal((await run(f,{kind:'codex.auth.sync',bundleVersion:1,bundle:f.bundle},gateway)).reason,'up_to_date');
    assert.deepEqual(await snapshot(f),rotatedState); await subscription(f,SOL);
    process.env.OPENAI_API_KEY='synthetic-api-mode';
    try {
      const api=await run(f,{kind:'codex.auth.set',mode:'api_key'});
      assert.equal(api.authModes.openaiLogin.available,true); assert.equal(api.authModes.apiKey.active,true);
    } finally { delete process.env.OPENAI_API_KEY; }
    const login=await run(f,{kind:'codex.auth.set',mode:'openai_login'});
    assert.equal(login.authModes.openaiLogin.active,true); assert.deepEqual(await snapshot(f),rotatedState); await subscription(f,SOL);
    return { staleVersions:[2,1], rotatedVersion:3, modeSwitch:'explicit API mode preserves saved OAuth; login restores subscription' };
  });
  for (const override of ['custom-base','explicit-api','provider-api-key','persisted-api-key','custom-model','environment-route']) await check('authored-override/'+override+'/intentionally-authoritative',async()=>{
    const f=await fixture('override-'+override);
    let cfg=await config(f);
    if(override==='custom-base') cfg.models.providers.openai.baseUrl='https://custom.example.test/v1';
    if(override==='explicit-api') cfg.models.providers.openai.api='openai-responses';
    if(override==='provider-api-key') cfg.models.providers.openai.apiKey='synthetic-key';
    if(override==='custom-model') cfg.models.providers.openai.models=[{id:SOL,name:'Authored Sol',api:'openai-responses',contextWindow:12345}];
    if(override==='environment-route') cfg.env={vars:{OPENAI_BASE_URL:'https://custom.example.test/v1'}};
    if(override==='persisted-api-key') await writeRuntimeAuth({configPath:f.configPath,profileId:'openai:key',credential:{type:'api_key',provider:'openai',key:'synthetic-key'}});
    await save(f,cfg); const before=await snapshot(f);
    await run(f,modelAction('model.set','openai/'+SOL,'high','codex/'+TERRA));
    const after=await config(f); assert.equal(after.models.providers.openai.baseUrl,cfg.models.providers.openai.baseUrl);
    for(const key of ['api','apiKey']) assert.equal(after.models.providers.openai[key],cfg.models.providers.openai[key]);
    if(override==='custom-model') for(const [k,v] of Object.entries(cfg.models.providers.openai.models[0])) assert.deepEqual(after.models.providers.openai.models[0][k],v);
    assert.deepEqual(await snapshot(f),before);
    await run(f,{kind:'config.apply',configText:JSON.stringify(after)});
    assert.deepEqual(await config(f),after,'config.apply preserves authored route');
    assert.deepEqual(await snapshot(f),before);
    const r=await route(f,SOL); assert.ok(r.selected.kind!=='selected'||r.selected.selection.route.authRequirement!=='subscription');
    return { category:'intentional override, NOT subscription-loss pass', routeSelection:r.selected.kind };
  });
  await check('model-mutation/restart-failure-contract',async()=>{
    const f=await fixture('restart-failure'), before=await snapshot(f);
    process.env.MATRIX_FAIL_RESTART='1';
    try { await assert.rejects(run(f,modelAction('model.set','openai/'+SOL,'off')), /systemctl|Command failed/); }
    finally {delete process.env.MATRIX_FAIL_RESTART;}
    assert.deepEqual(await snapshot(f),before); await subscription(f,SOL);
    assert.equal((await config(f)).agents.defaults.model.primary,'openai/'+SOL);
    return { limitation:'model.set writes config before restart; no rollback contract. Error explicitly required; auth untouched.' };
  });
} finally { await fs.rm(root,{recursive:true,force:true}); }
const summary={runtimeVersion,checks:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,actions,results,limitations:['Offline route selection is not live inference/token refresh','Fake systemctl; no actual gateway restart or service edits','Dashboard-equivalent per-target relay actions, not backend bulk endpoint','Legacy JSON route source inspected directly; runtime migration not invoked','Private route exports used only in this diagnostic; public SDK handles auth persistence']};
if(process.env.MATRIX_REPORT) await fs.writeFile(process.env.MATRIX_REPORT,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({runtimeVersion,checks:summary.checks,passed:summary.passed,failed:summary.failed,actions}));
if(summary.failed) process.exitCode=1;
