'use strict';

/**
 * test-providers.js — desktop provider-management APIs (Agent C / CONTRACT.md section 4).
 *
 * Covers: /api/bridge/providers CRUD + masking, /api/bridge/models/:id PATCH,
 * /api/bridge/discover (+ module-level discovery), /api/bridge/discover/models,
 * /api/bridge/logs ring buffer and /api/bridge/usage counters.
 *
 * No framework: run with `npm run test:providers`.
 *
 * IMPORTANT: uses a temporary config via ACCIO_BRIDGE_CONFIG so the real
 * config.json is never touched, and never binds port 8080.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const crypto = require('node:crypto');

// Point the module-level CONFIG_PATH at a scratch file BEFORE requiring server.js.
const TMP_CONFIG = path.join(os.tmpdir(), `accio-providers-config-${process.pid}-${Date.now()}.json`);
fs.writeFileSync(TMP_CONFIG, '{}\n', 'utf8');
process.env.ACCIO_BRIDGE_CONFIG = TMP_CONFIG;

const { createServer, normalizeConfig } = require('../src/server');
const { startMockOpenAI } = require('./mock-openai');
const discovery = require('../src/discovery');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  totalTests++;
  const start = Date.now();
  try {
    await fn();
    passedTests++;
    console.log(`  [PASS] ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    failedTests++;
    console.error(`  [FAIL] ${name} (${Date.now() - start}ms)\n         Error: ${err.message}`);
  }
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
    server.on('error', reject);
  });
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  return { status: res.status, text, json };
}

async function runSuite() {
  console.log('\n============================================================');
  console.log('        ACCIO BRIDGE — PROVIDER / DISCOVER TEST SUITE       ');
  console.log('============================================================\n');

  const mockOpenAI = await startMockOpenAI(0);
  const mockBase = `${mockOpenAI.url}/v1`;

  // Fake Ollama instance.
  const fakeOllama = await listen((req, res) => {
    if (req.url.startsWith('/api/tags')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'llama3' }, { name: 'deepseek-r1:14b' }] }));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });

  // Fake OpenAI-compatible instance (/v1/models).
  const fakeOpenaiCompat = await listen((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-x' }, { id: 'qwen2' }] }));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });

  // Fake KoboldCpp instance (/api/v1/model).
  const fakeKobold = await listen((req, res) => {
    if (req.url.startsWith('/api/v1/model')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'koboldcpp/kc-1' }));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });

  // Server with an unexpected shape (must never be reported as a service).
  const notAService = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  // HTML server (must never be reported as a service).
  const htmlServer = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>hello</body></html>');
  });

  // 401 server for listModelsFor.
  const authFail = await listen((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
  });

  // Slow server for listModelsFor timeout.
  const slowServer = await listen((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    }, 2000);
  });

  // Broken-stream server: promises more bytes than it sends, then destroys the socket.
  const brokenStream = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': '1000' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    setTimeout(() => {
      if (res.socket) res.socket.destroy();
    }, 20);
  });

  // Auth-capturing server.
  const capturedAuth = [];
  const authCapture = await listen((req, res) => {
    capturedAuth.push(req.headers.authorization || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'authed-model' }] }));
  });

  const SECRET_KEY = 'sk-super-secret-1234567890';
  const MOCK_KEY = 'sk-mock-key-1234567890';

  const config = normalizeConfig({
    server: { host: '127.0.0.1', port: 0, logLevel: 'info', cors: true, maxBodyBytes: 4096 },
    upstream: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 },
    catalog: { enabled: true, providerName: 'custom', fetchOfficial: false },
    disableDiskSave: false,
    models: [
      { id: 'ollama-a', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', upstreamModel: 'llama3', enabled: true },
      { id: 'ollama-b', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', upstreamModel: 'deepseek-r1:14b', enabled: false },
      { id: 'qwen:7b', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', upstreamModel: 'qwen:7b', enabled: true },
      { id: 'acme/llama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', upstreamModel: 'acme/llama', enabled: true },
      {
        id: 'deepseek-chat',
        provider: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: SECRET_KEY,
        upstreamModel: 'deepseek-chat',
        enabled: true,
        isDefault: false,
      },
      { id: 'lm-local', provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', upstreamModel: 'qwen', enabled: true },
      { id: 'mock-openai', provider: 'openai', baseUrl: mockBase, apiKey: MOCK_KEY, upstreamModel: 'mock-custom-model', enabled: true },
      { id: 'usage-stream', provider: 'openai', baseUrl: mockBase, apiKey: '', upstreamModel: 'mock-custom-model', enabled: true },
      { id: 'usage-dead', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', upstreamModel: 'nope', enabled: true },
      { id: 'broken-stream', provider: 'openai', baseUrl: `${brokenStream.url}/v1`, apiKey: '', upstreamModel: 'x', enabled: true },
    ],
  });

  const server = createServer(config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bridgeUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`[setup] bridge on ${bridgeUrl}, mock openai on ${mockOpenAI.url}\n`);

  const findGroup = (providers, predicate) => providers.find(predicate);

  const expectedDeepseekId = `p_${crypto
    .createHash('sha1')
    .update(`openai|https://api.deepseek.com/v1|${SECRET_KEY}`)
    .digest('hex')
    .slice(0, 8)}`;

  // -------------------------------------------------------------------------
  // Grouping + masking
  // -------------------------------------------------------------------------
  let providersSnapshot = [];

  await test('GET /api/bridge/providers groups by provider+baseUrl+apiKey and masks keys', async () => {
    const res = await api(`${bridgeUrl}/api/bridge/providers`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    providersSnapshot = res.json.providers;
    assert.strictEqual(providersSnapshot.length, 7, `expected 7 groups, got ${providersSnapshot.length}`);

    // Order follows first appearance in config.models.
    assert.strictEqual(providersSnapshot[0].provider, 'ollama');
    assert.strictEqual(providersSnapshot[0].name, 'Ollama');
    assert.strictEqual(providersSnapshot[0].local, true);
    assert.strictEqual(providersSnapshot[0].modelCount, 4);
    assert.strictEqual(providersSnapshot[0].enabledCount, 3);
    assert.strictEqual(providersSnapshot[0].enabled, true);
    assert.strictEqual(providersSnapshot[0].hasKey, false);
    assert.strictEqual(providersSnapshot[0].apiKeyMasked, '');

    const ds = findGroup(providersSnapshot, (p) => p.provider === 'openai' && p.baseUrl === 'https://api.deepseek.com/v1');
    assert.ok(ds, 'DeepSeek group present');
    assert.strictEqual(ds.name, 'DeepSeek');
    assert.strictEqual(ds.local, false);
    assert.strictEqual(ds.hasKey, true);
    assert.strictEqual(ds.apiKeyMasked, 'sk-s…7890');
    assert.strictEqual(ds.id, expectedDeepseekId);

    const lm = findGroup(providersSnapshot, (p) => p.baseUrl === 'http://127.0.0.1:1234/v1');
    assert.ok(lm, 'LM Studio group present');
    assert.strictEqual(lm.name, 'LM Studio');
    assert.strictEqual(lm.hasKey, false);

    // No plaintext key anywhere in the serialized response.
    assert.ok(!res.text.includes(SECRET_KEY), 'response must not contain plaintext key');
    assert.ok(!res.text.includes(MOCK_KEY), 'response must not contain mock plaintext key');
    assert.ok(res.text.includes('sk-s…7890'), 'masked key must be present');
    // Models expose masked apiKey + usage.
    assert.strictEqual(ds.models[0].apiKey, 'sk-s…7890');
    assert.ok(ds.models[0].usage, 'model has usage object');
  });

  await test('provider group ids are stable across calls', async () => {
    const a = await api(`${bridgeUrl}/api/bridge/providers`);
    const b = await api(`${bridgeUrl}/api/bridge/providers`);
    assert.deepStrictEqual(a.json.providers.map((p) => p.id), b.json.providers.map((p) => p.id));
    for (const p of a.json.providers) assert.match(p.id, /^p_[0-9a-f]{8}$/);
  });

  // -------------------------------------------------------------------------
  // POST /api/bridge/providers
  // -------------------------------------------------------------------------
  await test('POST /api/bridge/providers rejects invalid provider / url / empty models with 400', async () => {
    const badProvider = await api(`${bridgeUrl}/api/bridge/providers`, {
      method: 'POST',
      body: { provider: 'foo', baseUrl: 'https://x.example/v1', models: [{ id: 'm' }] },
    });
    assert.strictEqual(badProvider.status, 400);
    assert.strictEqual(badProvider.json.ok, false);

    const badUrl = await api(`${bridgeUrl}/api/bridge/providers`, {
      method: 'POST',
      body: { provider: 'openai', baseUrl: 'ftp://nope', models: [{ id: 'm' }] },
    });
    assert.strictEqual(badUrl.status, 400);

    const emptyModels = await api(`${bridgeUrl}/api/bridge/providers`, {
      method: 'POST',
      body: { provider: 'openai', baseUrl: 'https://x.example/v1', models: [] },
    });
    assert.strictEqual(emptyModels.status, 400);

    const badModelId = await api(`${bridgeUrl}/api/bridge/providers`, {
      method: 'POST',
      body: { provider: 'openai', baseUrl: 'https://x.example/v1', models: [{ id: '   ' }] },
    });
    assert.strictEqual(badModelId.status, 400);

    const badJson = await api(`${bridgeUrl}/api/bridge/providers`, { method: 'POST', body: '{nope' });
    assert.strictEqual(badJson.status, 400);
  });

  await test('POST /api/bridge/providers creates a provider and persists to config', async () => {
    const res = await api(`${bridgeUrl}/api/bridge/providers`, {
      method: 'POST',
      body: {
        provider: 'openai',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: 'sk-sf-key-123456',
        models: [
          { id: 'sf-qwen', upstreamModel: 'Qwen/Qwen2.5-7B', displayName: 'SF Qwen', contextWindow: 32000, multimodal: false },
        ],
      },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(res.json.provider.name, '硅基流动');
    assert.strictEqual(res.json.provider.models.length, 1);
    assert.strictEqual(res.json.providers.length, 8);

    // Persisted (saveConfigToFile wrote to ACCIO_BRIDGE_CONFIG).
    const persisted = JSON.parse(fs.readFileSync(TMP_CONFIG, 'utf8'));
    assert.ok(Array.isArray(persisted.models));
    assert.ok(persisted.models.some((m) => m.id === 'sf-qwen' && m.provider === 'openai'));

    // visible/enabled/locked/freeUse forced.
    const modelsRes = await api(`${bridgeUrl}/api/bridge/models`);
    const created = modelsRes.json.models.find((m) => m.id === 'sf-qwen');
    assert.strictEqual(created.locked, false);
    assert.strictEqual(created.freeUse, true);
    assert.strictEqual(created.enabled, true);
    assert.strictEqual(created.visible, true);
  });

  await test('POST /api/bridge/providers forces locked:false/freeUse:true and preserves isDefault on upsert', async () => {
    const res = await api(`${bridgeUrl}/api/bridge/providers`, {
      method: 'POST',
      body: {
        provider: 'openai',
        baseUrl: mockBase,
        apiKey: MOCK_KEY,
        models: [{ id: 'mock-openai', upstreamModel: 'mock-custom-model', locked: true, freeUse: false, enabled: false }],
      },
    });
    assert.strictEqual(res.status, 200);
    const updated = res.json.providers.find((p) => p.baseUrl === mockBase && p.apiKeyMasked === 'sk-m…7890');
    const model = updated.models.find((m) => m.id === 'mock-openai');
    assert.strictEqual(model.locked, false);
    assert.strictEqual(model.freeUse, true);
    assert.strictEqual(model.enabled, true);
  });

  // -------------------------------------------------------------------------
  // PATCH / DELETE /api/bridge/providers/:id
  // -------------------------------------------------------------------------
  await test('PATCH /api/bridge/providers/:id toggles enabled and rewrites baseUrl/apiKey (id changes)', async () => {
    const before = await api(`${bridgeUrl}/api/bridge/providers`);
    const sf = before.json.providers.find((p) => p.name === '硅基流动');
    const oldId = sf.id;

    const disabled = await api(`${bridgeUrl}/api/bridge/providers/${oldId}`, { method: 'PATCH', body: { enabled: false } });
    assert.strictEqual(disabled.status, 200);
    assert.strictEqual(disabled.json.provider.enabled, false);
    assert.strictEqual(disabled.json.provider.id, oldId);

    const rekeyed = await api(`${bridgeUrl}/api/bridge/providers/${oldId}`, {
      method: 'PATCH',
      body: { apiKey: 'sk-sf-key-new-9999' },
    });
    assert.strictEqual(rekeyed.status, 200);
    assert.notStrictEqual(rekeyed.json.provider.id, oldId, 'group id must change after apiKey rewrite');
    assert.strictEqual(rekeyed.json.provider.apiKeyMasked, 'sk-s…9999');

    const missing = await api(`${bridgeUrl}/api/bridge/providers/${oldId}`, { method: 'PATCH', body: { enabled: true } });
    assert.strictEqual(missing.status, 404);

    const badType = await api(`${bridgeUrl}/api/bridge/providers/${rekeyed.json.provider.id}`, {
      method: 'PATCH',
      body: { enabled: 'yes' },
    });
    assert.strictEqual(badType.status, 400);

    const badUrl = await api(`${bridgeUrl}/api/bridge/providers/${rekeyed.json.provider.id}`, {
      method: 'PATCH',
      body: { baseUrl: 'not-a-url' },
    });
    assert.strictEqual(badUrl.status, 400);
  });

  await test('DELETE /api/bridge/providers/:id removes all models in the group', async () => {
    const before = await api(`${bridgeUrl}/api/bridge/providers`);
    const sf = before.json.providers.find((p) => p.name === '硅基流动');
    assert.ok(sf, 'siliconflow group still present');

    const del = await api(`${bridgeUrl}/api/bridge/providers/${sf.id}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(del.json.deleted, ['sf-qwen']);
    assert.ok(!del.json.providers.some((p) => p.name === '硅基流动'));

    const after = await api(`${bridgeUrl}/api/bridge/providers`);
    assert.ok(!after.json.providers.some((p) => p.models.some((m) => m.id === 'sf-qwen')));

    const again = await api(`${bridgeUrl}/api/bridge/providers/${sf.id}`, { method: 'DELETE' });
    assert.strictEqual(again.status, 404);
  });

  // -------------------------------------------------------------------------
  // POST /api/bridge/providers/:id/models  (v1.1)
  // -------------------------------------------------------------------------
  const GROUP_KEY = 'sk-group-key-9999';
  const groupCtx = { id: null };

  await test('POST /api/bridge/providers/:id/models appends models reusing the group key', async () => {
    const created = await api(`${bridgeUrl}/api/bridge/providers`, {
      method: 'POST',
      body: {
        provider: 'openai',
        baseUrl: authCapture.url,
        apiKey: GROUP_KEY,
        models: [{ id: 'group-seed', upstreamModel: 'seed' }],
      },
    });
    assert.strictEqual(created.status, 200);
    const seedGroup = created.json.providers.find((p) => p.models.some((m) => m.id === 'group-seed'));
    assert.ok(seedGroup, 'seed group created');
    groupCtx.id = seedGroup.id;
    const beforeCount = seedGroup.modelCount;

    const res = await api(`${bridgeUrl}/api/bridge/providers/${groupCtx.id}/models`, {
      method: 'POST',
      body: {
        models: [
          { id: 'group-added', upstreamModel: 'added-1', displayName: 'Added One', contextWindow: 8192, multimodal: true },
          { id: 'group-added2' },
        ],
      },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(res.json.provider.id, groupCtx.id, 'group id must stay stable');
    assert.strictEqual(res.json.provider.modelCount, beforeCount + 2);
    assert.strictEqual(res.json.provider.apiKeyMasked, 'sk-g…9999');
    const ids = res.json.provider.models.map((m) => m.id);
    assert.ok(ids.includes('group-added') && ids.includes('group-added2'));
    assert.ok(!res.text.includes(GROUP_KEY), 'response must not leak plaintext key');

    // Persisted to the temp config, reusing the group provider/baseUrl/apiKey.
    const persisted = JSON.parse(fs.readFileSync(TMP_CONFIG, 'utf8'));
    const added = persisted.models.find((m) => m.id === 'group-added');
    assert.ok(added, 'added model persisted');
    assert.strictEqual(added.apiKey, GROUP_KEY);
    assert.strictEqual(added.baseUrl, authCapture.url);
    assert.strictEqual(added.provider, 'openai');
    assert.strictEqual(added.locked, false);
    assert.strictEqual(added.freeUse, true);
    assert.strictEqual(added.enabled, true);
    assert.strictEqual(added.visible, true);
  });

  await test('POST /api/bridge/providers/:id/models upserts an existing model without changing the group', async () => {
    const res = await api(`${bridgeUrl}/api/bridge/providers/${groupCtx.id}/models`, {
      method: 'POST',
      body: { models: [{ id: 'group-added', displayName: 'Renamed', upstreamModel: 'added-2' }] },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.provider.id, groupCtx.id);
    assert.strictEqual(res.json.provider.modelCount, 3);
    const model = res.json.provider.models.find((m) => m.id === 'group-added');
    assert.strictEqual(model.displayName, 'Renamed');
    assert.strictEqual(model.upstreamModel, 'added-2');
  });

  await test('POST /api/bridge/providers/:id/models validates group and models', async () => {
    const notFound = await api(`${bridgeUrl}/api/bridge/providers/p_00000000/models`, {
      method: 'POST',
      body: { models: [{ id: 'x' }] },
    });
    assert.strictEqual(notFound.status, 404);
    assert.strictEqual(notFound.json.ok, false);

    const empty = await api(`${bridgeUrl}/api/bridge/providers/${groupCtx.id}/models`, { method: 'POST', body: { models: [] } });
    assert.strictEqual(empty.status, 400);

    const badId = await api(`${bridgeUrl}/api/bridge/providers/${groupCtx.id}/models`, {
      method: 'POST',
      body: { models: [{ id: '  ' }] },
    });
    assert.strictEqual(badId.status, 400);

    const badJson = await api(`${bridgeUrl}/api/bridge/providers/${groupCtx.id}/models`, { method: 'POST', body: '{nope' });
    assert.strictEqual(badJson.status, 400);
  });

  await test('POST /api/bridge/discover/models resolves providerId to the stored group key', async () => {
    // Original {provider, baseUrl, apiKey} behaviour still works.
    const byUrl = await api(`${bridgeUrl}/api/bridge/discover/models`, {
      method: 'POST',
      body: { provider: 'openai', baseUrl: authCapture.url, apiKey: 'sk-inline-key-1234' },
    });
    assert.strictEqual(byUrl.status, 200);
    assert.strictEqual(byUrl.json.ok, true);
    assert.ok(byUrl.json.models.includes('authed-model'));
    assert.strictEqual(capturedAuth.at(-1), 'Bearer sk-inline-key-1234');

    // providerId uses the persisted group's provider/baseUrl/apiKey.
    const byId = await api(`${bridgeUrl}/api/bridge/discover/models`, {
      method: 'POST',
      body: { providerId: groupCtx.id },
    });
    assert.strictEqual(byId.status, 200);
    assert.strictEqual(byId.json.ok, true);
    assert.ok(byId.json.models.includes('authed-model'));
    assert.strictEqual(capturedAuth.at(-1), `Bearer ${GROUP_KEY}`, 'must send the stored group key');
    assert.ok(!byId.text.includes(GROUP_KEY), 'response must not leak the key');

    const unknown = await api(`${bridgeUrl}/api/bridge/discover/models`, {
      method: 'POST',
      body: { providerId: 'p_ffffffff' },
    });
    assert.strictEqual(unknown.status, 200);
    assert.strictEqual(unknown.json.ok, false);
    assert.deepStrictEqual(unknown.json.models, []);
    assert.ok(typeof unknown.json.error === 'string');
  });

  // -------------------------------------------------------------------------
  // PATCH /api/bridge/models/:id
  // -------------------------------------------------------------------------
  await test('PATCH /api/bridge/models/:id updates fields, enforces types and ignores locked/freeUse', async () => {
    const ok = await api(`${bridgeUrl}/api/bridge/models/deepseek-chat`, {
      method: 'PATCH',
      body: { displayName: 'DeepSeek Chat v2', upstreamModel: 'deepseek-v3', contextWindow: 64000, stream: false, visible: true },
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.model.displayName, 'DeepSeek Chat v2');
    assert.strictEqual(ok.json.model.upstreamModel, 'deepseek-v3');
    assert.strictEqual(ok.json.model.contextWindow, 64000);
    assert.strictEqual(ok.json.model.stream, false);
    assert.ok(!ok.text.includes(SECRET_KEY), 'PATCH model response must not leak apiKey');
    assert.strictEqual(ok.json.model.apiKey, 'sk-s…7890');

    const ignored = await api(`${bridgeUrl}/api/bridge/models/deepseek-chat`, {
      method: 'PATCH',
      body: { locked: true, freeUse: false },
    });
    assert.strictEqual(ignored.status, 200);
    assert.strictEqual(ignored.json.model.locked, false);
    assert.strictEqual(ignored.json.model.freeUse, true);

    const badBool = await api(`${bridgeUrl}/api/bridge/models/deepseek-chat`, { method: 'PATCH', body: { enabled: 'yes' } });
    assert.strictEqual(badBool.status, 400);
    const badNum = await api(`${bridgeUrl}/api/bridge/models/deepseek-chat`, { method: 'PATCH', body: { contextWindow: 'abc' } });
    assert.strictEqual(badNum.status, 400);
    const badStr = await api(`${bridgeUrl}/api/bridge/models/deepseek-chat`, { method: 'PATCH', body: { displayName: 5 } });
    assert.strictEqual(badStr.status, 400);
    const notFound = await api(`${bridgeUrl}/api/bridge/models/does-not-exist`, { method: 'PATCH', body: { enabled: false } });
    assert.strictEqual(notFound.status, 404);
  });

  await test('PATCH /api/bridge/models/:id makes isDefault mutually exclusive', async () => {
    const res = await api(`${bridgeUrl}/api/bridge/models/deepseek-chat`, { method: 'PATCH', body: { isDefault: true } });
    assert.strictEqual(res.status, 200);
    const models = (await api(`${bridgeUrl}/api/bridge/models`)).json.models;
    assert.strictEqual(models.filter((m) => m.isDefault).length, 1);
    assert.strictEqual(models.find((m) => m.id === 'deepseek-chat').isDefault, true);
    assert.strictEqual(models.find((m) => m.id === 'ollama-a').isDefault, false);
  });

  await test('PATCH /api/bridge/models/:id handles ids containing ":" and "/"', async () => {
    const colon = await api(`${bridgeUrl}/api/bridge/models/${encodeURIComponent('qwen:7b')}`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    assert.strictEqual(colon.status, 200);
    assert.strictEqual(colon.json.model.id, 'qwen:7b');
    assert.strictEqual(colon.json.model.enabled, false);

    const slash = await api(`${bridgeUrl}/api/bridge/models/${encodeURIComponent('acme/llama')}`, {
      method: 'PATCH',
      body: { visible: false },
    });
    assert.strictEqual(slash.status, 200);
    assert.strictEqual(slash.json.model.id, 'acme/llama');
    assert.strictEqual(slash.json.model.visible, false);
  });

  // -------------------------------------------------------------------------
  // Catalog reflects config
  // -------------------------------------------------------------------------
  await test('POST /api/llm/config/v2 reflects provider add/remove and disable', async () => {
    const res = await api(`${bridgeUrl}/api/llm/config/v2`, { method: 'POST', body: { token: 't' } });
    assert.strictEqual(res.status, 200);
    const custom = res.json.data.find((p) => p.provider === 'custom');
    assert.ok(custom, 'custom provider present');
    const codes = custom.modelList.map((m) => m.modelCode);
    assert.ok(codes.includes('deepseek-chat'));
    assert.ok(!codes.includes('qwen:7b'), 'disabled model must be excluded');
    assert.ok(!codes.includes('sf-qwen'), 'deleted model must be excluded');
    assert.ok(!codes.includes('ollama-b'), 'disabled ollama model must be excluded');
  });

  await test('disabling the default model does not break the catalog', async () => {
    const res = await api(`${bridgeUrl}/api/bridge/models/${encodeURIComponent('deepseek-chat')}`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    assert.strictEqual(res.status, 200);
    const catalog = await api(`${bridgeUrl}/api/llm/config/v2`, { method: 'POST', body: { token: 't' } });
    assert.strictEqual(catalog.status, 200);
    const health = await api(`${bridgeUrl}/healthz`);
    assert.strictEqual(health.status, 200);
    assert.ok(Array.isArray(health.json.models));
  });

  // -------------------------------------------------------------------------
  // discovery module
  // -------------------------------------------------------------------------
  await test('discovery.discover detects Ollama / OpenAI-compat / KoboldCpp and ignores unexpected shapes', async () => {
    const result = await discovery.discover({
      timeoutMs: 400,
      probes: [
        { host: '127.0.0.1', port: fakeOllama.port, kind: 'ollama', name: 'Ollama', provider: 'ollama', path: '/api/tags', baseUrl: `http://127.0.0.1:${fakeOllama.port}` },
        { host: '127.0.0.1', port: fakeOpenaiCompat.port, kind: 'lmstudio', name: 'LM Studio', provider: 'openai', path: '/v1/models', baseUrl: `http://127.0.0.1:${fakeOpenaiCompat.port}/v1` },
        { host: '127.0.0.1', port: fakeKobold.port, kind: 'koboldcpp', name: 'KoboldCpp', provider: 'openai', path: '/api/v1/model', baseUrl: `http://127.0.0.1:${fakeKobold.port}/v1` },
        { host: '127.0.0.1', port: notAService.port, kind: 'openai', name: 'Bad', provider: 'openai', path: '/v1/models', baseUrl: `http://127.0.0.1:${notAService.port}/v1` },
        { host: '127.0.0.1', port: htmlServer.port, kind: 'openai', name: 'Html', provider: 'openai', path: '/v1/models', baseUrl: `http://127.0.0.1:${htmlServer.port}/v1` },
      ],
    });
    assert.ok(typeof result.scannedAt === 'string');
    const byKind = Object.fromEntries(result.services.map((s) => [s.kind, s]));
    assert.deepStrictEqual(Object.keys(byKind).sort(), ['koboldcpp', 'lmstudio', 'ollama']);
    assert.deepStrictEqual(byKind.ollama.models, ['llama3', 'deepseek-r1:14b']);
    assert.deepStrictEqual(byKind.lmstudio.models, ['gpt-x', 'qwen2']);
    assert.deepStrictEqual(byKind.koboldcpp.models, ['kc-1']);
    assert.strictEqual(byKind.ollama.alreadyAdded.length, 0);
    assert.ok(result.services.every((s) => s.id && typeof s.latencyMs === 'number'));
  });

  await test('discovery.discover honours skipPorts', async () => {
    const result = await discovery.discover({
      timeoutMs: 400,
      skipPorts: [fakeOllama.port],
      probes: [
        { host: '127.0.0.1', port: fakeOllama.port, kind: 'ollama', name: 'Ollama', provider: 'ollama', path: '/api/tags', baseUrl: `http://127.0.0.1:${fakeOllama.port}` },
        { host: '127.0.0.1', port: fakeOpenaiCompat.port, kind: 'lmstudio', name: 'LM Studio', provider: 'openai', path: '/v1/models', baseUrl: `http://127.0.0.1:${fakeOpenaiCompat.port}/v1` },
      ],
    });
    assert.ok(!result.services.some((s) => s.kind === 'ollama'), 'skipped port must not be reported');
    assert.ok(result.services.some((s) => s.kind === 'lmstudio'));
  });

  await test('discovery.discover dedups host:port preferring the specific kind', async () => {
    const result = await discovery.discover({
      timeoutMs: 400,
      probes: [
        { host: '127.0.0.1', port: fakeOpenaiCompat.port, kind: 'openai', name: 'Generic', provider: 'openai', path: '/v1/models', baseUrl: `http://127.0.0.1:${fakeOpenaiCompat.port}/v1` },
        { host: '127.0.0.1', port: fakeOpenaiCompat.port, kind: 'vllm', name: 'vLLM', provider: 'openai', path: '/v1/models', baseUrl: `http://127.0.0.1:${fakeOpenaiCompat.port}/v1` },
      ],
    });
    assert.strictEqual(result.services.length, 1);
    assert.strictEqual(result.services[0].kind, 'vllm');
  });

  await test('discovery.discover computes alreadyAdded from existing config models', async () => {
    const result = await discovery.discover({
      timeoutMs: 400,
      models: [
        { id: 'x', provider: 'ollama', baseUrl: `http://127.0.0.1:${fakeOllama.port}`, upstreamModel: 'llama3' },
      ],
      probes: [
        { host: '127.0.0.1', port: fakeOllama.port, kind: 'ollama', name: 'Ollama', provider: 'ollama', path: '/api/tags', baseUrl: `http://127.0.0.1:${fakeOllama.port}` },
      ],
    });
    assert.deepStrictEqual(result.services[0].alreadyAdded, ['llama3']);
  });

  // -------------------------------------------------------------------------
  // listModelsFor
  // -------------------------------------------------------------------------
  await test('listModelsFor lists Ollama and OpenAI-compatible models', async () => {
    const ollamaModels = await discovery.listModelsFor({ provider: 'ollama', baseUrl: fakeOllama.url }, 2000);
    assert.deepStrictEqual(ollamaModels, ['llama3', 'deepseek-r1:14b']);

    const openaiModels = await discovery.listModelsFor({ provider: 'openai', baseUrl: `${mockOpenAI.url}/v1/` }, 2000);
    assert.ok(openaiModels.includes('mock-custom-model'));
  });

  await test('listModelsFor sends Authorization only when a key is present', async () => {
    await discovery.listModelsFor({ provider: 'openai', baseUrl: authCapture.url, apiKey: 'sk-abc-123' }, 2000);
    assert.strictEqual(capturedAuth.at(-1), 'Bearer sk-abc-123');
    await discovery.listModelsFor({ provider: 'openai', baseUrl: `${authCapture.url}` }, 2000);
    assert.strictEqual(capturedAuth.at(-1), '');
  });

  await test('listModelsFor surfaces 401 with status and never leaks apiKey', async () => {
    let err;
    try {
      await discovery.listModelsFor({ provider: 'openai', baseUrl: authFail.url, apiKey: 'sk-leaky-key-000' }, 2000);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must throw on 401');
    assert.strictEqual(err.status, 401);
    assert.ok(!err.message.includes('sk-leaky-key-000'), 'error message must not contain apiKey');
  });

  await test('listModelsFor times out on a slow upstream without leaking key', async () => {
    let err;
    try {
      await discovery.listModelsFor({ provider: 'openai', baseUrl: `${slowServer.url}`, apiKey: 'sk-timeout-key' }, 150);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must throw on timeout');
    assert.match(err.message, /timed out/i);
    assert.ok(!err.message.includes('sk-timeout-key'));
  });

  await test('listModelsFor rejects non-http(s) baseUrl', async () => {
    let err;
    try {
      await discovery.listModelsFor({ provider: 'openai', baseUrl: 'file:///etc/passwd' }, 500);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'must throw for file://');
  });

  // -------------------------------------------------------------------------
  // discover HTTP route
  // -------------------------------------------------------------------------
  await test('GET /api/bridge/discover returns services, caches, and honours force', async () => {
    const first = await api(`${bridgeUrl}/api/bridge/discover`);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.json.ok, true);
    assert.strictEqual(first.json.cached, false);
    assert.ok(Array.isArray(first.json.services));
    assert.ok(typeof first.json.scannedAt === 'string');

    const second = await api(`${bridgeUrl}/api/bridge/discover`);
    assert.strictEqual(second.json.cached, true);

    const forced = await api(`${bridgeUrl}/api/bridge/discover?force=true`);
    assert.strictEqual(forced.json.cached, false);
  });

  await test('POST /api/bridge/discover/models lists models and rejects file://', async () => {
    const ok = await api(`${bridgeUrl}/api/bridge/discover/models`, {
      method: 'POST',
      body: { provider: 'ollama', baseUrl: fakeOllama.url },
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.ok, true);
    assert.deepStrictEqual(ok.json.models, ['llama3', 'deepseek-r1:14b']);

    const fail = await api(`${bridgeUrl}/api/bridge/discover/models`, {
      method: 'POST',
      body: { provider: 'openai', baseUrl: authFail.url, apiKey: 'sk-leak-check-1234' },
    });
    assert.strictEqual(fail.status, 200);
    assert.strictEqual(fail.json.ok, false);
    assert.deepStrictEqual(fail.json.models, []);
    assert.ok(!fail.text.includes('sk-leak-check-1234'), 'responses must not leak apiKey');

    const bad = await api(`${bridgeUrl}/api/bridge/discover/models`, {
      method: 'POST',
      body: { provider: 'openai', baseUrl: 'file:///etc/passwd' },
    });
    assert.strictEqual(bad.status, 400);
  });

  // -------------------------------------------------------------------------
  // logs
  // -------------------------------------------------------------------------
  await test('GET /api/bridge/logs returns a ring buffer with level filtering and lines limit', async () => {
    // Produce a warn-level log: the upstream stream is truncated mid-flight.
    const brokenReq = await fetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'broken-stream', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    await brokenReq.text().catch(() => '');

    const all = await api(`${bridgeUrl}/api/bridge/logs`);
    assert.strictEqual(all.status, 200);
    assert.strictEqual(all.json.ok, true);
    assert.ok(all.json.lines.length > 0);
    assert.ok(all.json.lines.length <= 1000);
    for (const entry of all.json.lines) {
      assert.ok(!Number.isNaN(Date.parse(entry.ts)), 'ts must be ISO');
      assert.ok(['debug', 'info', 'warn', 'error'].includes(entry.level));
      assert.strictEqual(typeof entry.msg, 'string');
    }
    // Logger threshold is info, so no debug lines are buffered.
    assert.ok(!all.json.lines.some((e) => e.level === 'debug'));

    const warns = await api(`${bridgeUrl}/api/bridge/logs?level=warn`);
    assert.ok(warns.json.lines.length >= 1, 'truncated stream must yield a warn log');
    assert.ok(warns.json.lines.every((e) => e.level === 'warn' || e.level === 'error'));

    const infoOnly = await api(`${bridgeUrl}/api/bridge/logs?level=info`);
    assert.ok(infoOnly.json.lines.length >= all.json.lines.length);
    assert.ok(infoOnly.json.lines.every((e) => e.level === 'info' || e.level === 'warn' || e.level === 'error'));

    const oneLine = await api(`${bridgeUrl}/api/bridge/logs?lines=1`);
    assert.strictEqual(oneLine.json.lines.length, 1);

    const clamped = await api(`${bridgeUrl}/api/bridge/logs?lines=99999`);
    assert.ok(clamped.json.lines.length <= 1000);
    assert.strictEqual(clamped.json.total, clamped.json.lines.length);
  });

  // -------------------------------------------------------------------------
  // usage
  // -------------------------------------------------------------------------
  await test('usage counters track streaming, non-streaming and failed requests', async () => {
    // Streaming request.
    const streamRes = await api(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      body: { model: 'usage-stream', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    });
    assert.strictEqual(streamRes.status, 200);

    // Non-streaming request.
    const plainRes = await api(`${bridgeUrl}/api/adk/llm`, {
      method: 'POST',
      body: { model: 'usage-stream', stream: false, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    });
    assert.strictEqual(plainRes.status, 200);

    // Upstream failure (unreachable port).
    const deadRes = await api(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      body: { model: 'usage-dead', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    });
    assert.strictEqual(deadRes.status, 200);
    assert.match(deadRes.text, /"error"/);

    const usageRes = await api(`${bridgeUrl}/api/bridge/usage`);
    assert.strictEqual(usageRes.status, 200);
    assert.strictEqual(usageRes.json.ok, true);
    assert.ok(typeof usageRes.json.since === 'string');
    const usage = usageRes.json.usage;
    assert.strictEqual(usage['usage-stream'].requests, 2, 'stream + non-stream counted exactly once each');
    assert.strictEqual(usage['usage-stream'].errors, 0);
    assert.ok(typeof usage['usage-stream'].lastLatencyMs === 'number');
    assert.ok(!Number.isNaN(Date.parse(usage['usage-stream'].lastUsedAt)));
    assert.strictEqual(usage['usage-dead'].requests, 1);
    assert.strictEqual(usage['usage-dead'].errors, 1);
  });

  await test('GET /api/bridge/providers merges usage into each model', async () => {
    const res = await api(`${bridgeUrl}/api/bridge/providers`);
    const group = res.json.providers.find((p) => p.models.some((m) => m.id === 'usage-stream'));
    const model = group.models.find((m) => m.id === 'usage-stream');
    assert.strictEqual(model.usage.requests, 2);
    assert.strictEqual(model.usage.errors, 0);
    assert.ok(typeof model.usage.lastLatencyMs === 'number');
  });

  // -------------------------------------------------------------------------
  // existing POST /api/bridge/test still works
  // -------------------------------------------------------------------------
  await test('POST /api/bridge/test still streams GenAI frames', async () => {
    const res = await api(`${bridgeUrl}/api/bridge/test`, { method: 'POST', body: { model: 'mock-openai', prompt: 'hi' } });
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /text\/event-stream|"content"/);
    assert.ok(res.text.includes('Mock ') || res.text.includes('Mock OpenAI response!'), 'mock response text present');
  });

  // Accio >= 0.37 sends gzip-compressed LLM bodies (regression: "invalid JSON body: Unexpected token '\u001f'").
  await test('POST /api/adk/llm/generateContent accepts gzip-compressed bodies', async () => {
    const zlib = require('node:zlib');
    const payload = { model: 'mock-openai', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
    for (const headers of [{ 'content-encoding': 'gzip' }, {}]) {
      const res = await fetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: gz,
      });
      const text = await res.text();
      assert.strictEqual(res.status, 200, text);
      assert.ok(text.includes('Mock'), 'routed to custom model and got mock text');
    }
  });

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------
  console.log('\n[teardown] shutting down test servers...');
  await new Promise((resolve) => server.close(resolve));
  await mockOpenAI.close();
  await fakeOllama.close();
  await fakeOpenaiCompat.close();
  await fakeKobold.close();
  await notAService.close();
  await htmlServer.close();
  await authFail.close();
  await slowServer.close();
  await brokenStream.close();
  await authCapture.close();
  try {
    fs.unlinkSync(TMP_CONFIG);
  } catch {
    /* ignore */
  }

  console.log('============================================================');
  console.log(`RESULTS: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
  console.log('============================================================\n');

  if (failedTests > 0) process.exit(1);
}

runSuite().catch((err) => {
  console.error('\nFatal test runner error:', err);
  process.exit(1);
});