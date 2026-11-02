'use strict';

/**
 * test-integration.js — Automated end-to-end integration test suite.
 *
 * Verifies:
 *   1. GET /dashboard (and GET /) serves the Web Management Dashboard HTML.
 *   2. POST /api/llm/config/v2 returns the custom model with locked=false and freeUse=true.
 *   3. POST /api/adk/llm/generateContent with mock OpenAI verifies SSE chunks
 *      are streamed in valid Accio GenAI format.
 *   4. Streamed tool calling produces valid GenAI functionCall frames.
 *   5. Bridge management APIs (GET /api/bridge/status, models CRUD).
 *
 * Run with: npm test
 */

const http = require('node:http');
const assert = require('node:assert');

const { createServer, normalizeConfig } = require('../src/server');
const { startMockOpenAI } = require('./mock-openai');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testLogs = [];

async function test(name, fn) {
  totalTests++;
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    passedTests++;
    const msg = `  [PASS] ${name} (${duration}ms)`;
    console.log(msg);
    testLogs.push({ name, status: 'PASS', duration });
  } catch (err) {
    failedTests++;
    const duration = Date.now() - start;
    const msg = `  [FAIL] ${name} (${duration}ms)\n         Error: ${err.message}`;
    console.error(msg);
    testLogs.push({ name, status: 'FAIL', duration, error: err.message });
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

function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: () => Promise.resolve(buffer.toString('utf8')),
          json: () => Promise.resolve(JSON.parse(buffer.toString('utf8'))),
          buffer: () => Promise.resolve(buffer),
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function parseSseText(text) {
  return text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data:'))
    .map((b) => {
      const dataStr = b.slice(5).trim();
      if (dataStr === '[DONE]') return { done: true };
      try {
        return JSON.parse(dataStr);
      } catch {
        return { raw: dataStr };
      }
    });
}

async function runSuite() {
  console.log('\n============================================================');
  console.log('       ACCIO GATEWAY BRIDGE — INTEGRATION TEST SUITE        ');
  console.log('============================================================\n');

  // 1. Start Mock OpenAI server
  const mockOpenAI = await startMockOpenAI(0);
  console.log(`[setup] Mock OpenAI server listening on ${mockOpenAI.url}`);

  // 2. Start fake upstream server (phoenix-gw emulation)
  const upstream = await listen((req, res) => {
    if (req.url.startsWith('/api/llm/config/v2')) {
      const responsePayload = {
        success: true,
        code: '200',
        data: [
          {
            provider: 'alibaba',
            providerDisplayName: 'Official Alibaba Models',
            modelList: [
              {
                modelCode: 'qwen-max',
                modelName: 'qwen-max',
                modelDisplayName: 'Qwen Max (Official)',
                freeUse: false,
                locked: false,
              },
            ],
          },
        ],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstreamProxy: true, path: req.url }));
  });
  console.log(`[setup] Fake Upstream server listening on ${upstream.url}`);

  // 3. Configure and start Bridge server
  const bridgeConfig = normalizeConfig({
    server: {
      host: '127.0.0.1',
      port: 0,
      logLevel: 'error',
      cors: true,
      cors: true,
    },
    disableDiskSave: true,
    upstream: {
      baseUrl: upstream.url,
      timeoutMs: 5000,
    },
    catalog: {
      enabled: true,
      providerName: 'custom',
      providerDisplayName: 'Custom AI (Local / OpenAI)',
      fetchOfficial: true,
    },
    models: [
      {
        id: 'mock-custom-model',
        modelCode: 'mock-custom-model',
        displayName: 'Mock Custom Model (OpenAI-compatible)',
        provider: 'openai',
        baseUrl: `${mockOpenAI.url}/v1`,
        upstreamModel: 'mock-custom-model',
        apiKey: 'test-secret-key',
        contextWindow: 128000,
        stream: true,
        multimodal: false,
        enabled: true,
        visible: true,
        isDefault: true,
        freeUse: true,
        locked: false,
      },
    ],
  });

  const bridgeHttpServer = createServer(bridgeConfig);
  await new Promise((resolve) => bridgeHttpServer.listen(0, '127.0.0.1', resolve));
  const bridgePort = bridgeHttpServer.address().port;
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  console.log(`[setup] Bridge server listening on ${bridgeUrl}\n`);

  console.log('Running test cases:');

  // Test 1: GET /dashboard & GET /
  await test('GET /dashboard returns 200 OK and serves HTML dashboard', async () => {
    const res = await httpFetch(`${bridgeUrl}/dashboard`);
    assert.strictEqual(res.status, 200, `Expected status 200 but got ${res.status}`);
    const contentType = res.headers['content-type'] || '';
    assert.ok(contentType.includes('text/html'), `Expected text/html content-type but got "${contentType}"`);
    const body = await res.text();
    assert.ok(body.includes('Accio Gateway Bridge'), 'Dashboard HTML should contain "Accio Gateway Bridge" title');
    assert.ok(body.includes('Quick Launch Accio Desktop'), 'Dashboard HTML should contain quick launch section');
    assert.ok(body.includes('Live Test Playground'), 'Dashboard HTML should contain playground section');
  });

  await test('GET / (root) returns 200 OK and serves dashboard HTML', async () => {
    const res = await httpFetch(`${bridgeUrl}/`);
    assert.strictEqual(res.status, 200, `Expected status 200 but got ${res.status}`);
    const contentType = res.headers['content-type'] || '';
    assert.ok(contentType.includes('text/html'), `Expected text/html content-type but got "${contentType}"`);
  });

  // Test 2: POST /api/llm/config/v2
  await test('POST /api/llm/config/v2 returns custom model with locked=false and freeUse=true', async () => {
    const res = await httpFetch(`${bridgeUrl}/api/llm/config/v2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'test-session-token' }),
    });

    assert.strictEqual(res.status, 200, `Expected status 200 but got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.success, true, 'Response success should be true');
    assert.ok(Array.isArray(data.data), 'Response data should be an array of providers');

    // Custom provider block must be merged in front
    const customProvider = data.data.find((p) => p.provider === 'custom');
    assert.ok(customProvider, 'Custom provider block must be present in catalogue');
    assert.ok(Array.isArray(customProvider.modelList), 'Custom provider should have modelList');

    const customModel = customProvider.modelList.find((m) => m.modelCode === 'mock-custom-model');
    assert.ok(customModel, 'Custom model "mock-custom-model" must be present in modelList');

    // Specific user requirement verification: locked=false, freeUse=true
    assert.strictEqual(customModel.locked, false, 'Custom model MUST have locked: false');
    assert.strictEqual(customModel.freeUse, true, 'Custom model MUST have freeUse: true');

    // Also verify official provider is preserved
    const officialProvider = data.data.find((p) => p.provider === 'alibaba');
    assert.ok(officialProvider, 'Official upstream provider should also be present in catalogue');
  });

  // Test 3: POST /api/adk/llm/generateContent (SSE streaming with mock OpenAI)
  await test('POST /api/adk/llm/generateContent streams SSE chunks in valid Accio GenAI format', async () => {
    const payload = {
      model: 'mock-custom-model',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Hello from Accio integration test' }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
      },
    };

    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.strictEqual(res.status, 200, `Expected status 200 but got ${res.status}`);
    const contentType = res.headers['content-type'] || '';
    assert.ok(contentType.includes('text/event-stream'), `Expected text/event-stream but got "${contentType}"`);

    const rawText = await res.text();
    const frames = parseSseText(rawText);

    assert.ok(frames.length >= 2, `Expected at least 2 SSE frames, received ${frames.length}`);

    // Verify GenAI format on intermediate text chunks
    let accumulatedText = '';
    let foundDoneFrame = false;

    for (const frame of frames) {
      if (frame.content) {
        assert.strictEqual(frame.content.role, 'model', 'Frame content role must be "model"');
        assert.ok(Array.isArray(frame.content.parts), 'Frame content parts must be an array');
        for (const part of frame.content.parts) {
          if (typeof part.text === 'string') {
            accumulatedText += part.text;
          }
        }
      }

      if (frame.turnComplete === true) {
        foundDoneFrame = true;
        assert.strictEqual(frame.finishReason, 'STOP', 'Terminal frame finishReason must be "STOP"');
      }
    }

    assert.ok(foundDoneFrame, 'Terminal GenAI frame with turnComplete: true must be emitted');
    assert.ok(
      accumulatedText.includes('Mock OpenAI response!'),
      `Expected accumulated text to contain "Mock OpenAI response!", got: "${accumulatedText}"`
    );
  });

  // Test 4: Tool call translation
  await test('POST /api/adk/llm/generateContent streams tool call frames in valid GenAI format', async () => {
    const payload = {
      model: 'mock-custom-model',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'CALL_TOOL please read file test.txt' }],
        },
      ],
    };

    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.strictEqual(res.status, 200, `Expected status 200 but got ${res.status}`);
    const rawText = await res.text();
    const frames = parseSseText(rawText);

    // Look for toolCalls GenAI frame
    const toolCallFrame = frames.find(
      (f) => f.content?.parts?.some((p) => p.functionCall && p.functionCall.name === 'read_file')
    );

    assert.ok(toolCallFrame, 'Must receive a GenAI frame containing functionCall with name "read_file"');
    const funcCall = toolCallFrame.content.parts[0].functionCall;
    assert.strictEqual(funcCall.name, 'read_file');
    assert.deepStrictEqual(funcCall.args, { path: 'test.txt' });
    assert.strictEqual(toolCallFrame.turnComplete, true);
  });

  // Test 5: Bridge Management APIs
  await test('GET /api/bridge/status returns running status and server metadata', async () => {
    const res = await httpFetch(`${bridgeUrl}/api/bridge/status`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.status, 'running');
    assert.strictEqual(data.version, '1.0.0');
    assert.strictEqual(data.server.port, bridgePort);
    assert.ok(Array.isArray(data.models));
  });

  await test('POST /api/bridge/models and DELETE /api/bridge/models manages custom models', async () => {
    // 1. Add model
    const addRes = await httpFetch(`${bridgeUrl}/api/bridge/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'temp-test-model',
        displayName: 'Temporary Test Model',
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        contextWindow: 65536,
        stream: true,
      }),
    });
    assert.strictEqual(addRes.status, 200);
    const addData = await addRes.json();
    assert.strictEqual(addData.ok, true);
    assert.ok(addData.models.some((m) => m.id === 'temp-test-model'));

    // 2. Delete model
    const delRes = await httpFetch(`${bridgeUrl}/api/bridge/models?id=temp-test-model`, {
      method: 'DELETE',
    });
    assert.strictEqual(delRes.status, 200);
    const delData = await delRes.json();
    assert.strictEqual(delData.ok, true);
    assert.ok(!delData.models.some((m) => m.id === 'temp-test-model'));
  });
  // Test 7: GET /api/bridge/accio detects client installation and edition
  await test('GET /api/bridge/accio detects Accio Work edition and returns evidence', async () => {
    const res = await httpFetch(`${bridgeUrl}/api/bridge/accio`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.accio, 'data.accio must be returned');
    assert.ok(typeof data.accio.installed === 'boolean');
    assert.ok(['cn', 'global', 'unknown', 'none'].includes(data.accio.edition));
    assert.ok(Array.isArray(data.accio.evidence));
    assert.ok(typeof data.bridgeGatewayUrl === 'string');
  });

  // Test 8: detectAccioWorkCN unit edge cases on synthetic directories
  await test('detectAccioWorkCN correctly discriminates CN vs Global vs Unknown editions', async () => {
    const { detectAccioWorkCN } = require('../src/accio-detect');
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accio-test-'));
    try {
      // Fake executable
      const fakeExe = path.join(tmpRoot, 'Accio.exe');
      fs.writeFileSync(fakeExe, 'fake-exe');

      // Case A: China Edition with domain-config.json region=CN and packageRegion=GLOBAL trap
      const dirA = path.join(tmpRoot, 'dirA');
      fs.mkdirSync(dirA);
      fs.writeFileSync(
        path.join(dirA, 'domain-config.json'),
        JSON.stringify({ region: 'CN', services: { client: { domain: 'work-download.accio-ai.com' } } })
      );
      fs.writeFileSync(
        path.join(dirA, 'appInstall.jsonl'),
        JSON.stringify({ region: 'CN' }) + '\n' + JSON.stringify({ packageRegion: 'GLOBAL' }) + '\n'
      );

      const resA = detectAccioWorkCN({ customExePath: fakeExe, customAccioDir: dirA });
      assert.strictEqual(resA.installed, true);
      assert.strictEqual(resA.edition, 'cn', 'Must identify China edition based on region=CN and accio-ai.com');
      assert.ok(resA.scores.cn > resA.scores.global);

      // Case B: Global Edition with domain-config.json region=GLOBAL
      const dirB = path.join(tmpRoot, 'dirB');
      fs.mkdirSync(dirB);
      fs.writeFileSync(
        path.join(dirB, 'domain-config.json'),
        JSON.stringify({ region: 'GLOBAL', services: { client: { domain: 'work-download.accio.com' } } })
      );

      const resB = detectAccioWorkCN({ customExePath: fakeExe, customAccioDir: dirB });
      assert.strictEqual(resB.installed, true);
      assert.strictEqual(resB.edition, 'global', 'Must identify Global edition based on region=GLOBAL');
      assert.ok(resB.scores.global > resA.scores.global);

      // Case C: Empty directory -> unknown
      const dirC = path.join(tmpRoot, 'dirC');
      fs.mkdirSync(dirC);
      const resC = detectAccioWorkCN({ customExePath: fakeExe, customAccioDir: dirC });
      assert.strictEqual(resC.installed, true);
      assert.strictEqual(resC.edition, 'unknown', 'No evidence must classify as unknown');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });


  // Teardown
  console.log('\n[teardown] Shutting down test servers...');
  await new Promise((resolve) => bridgeHttpServer.close(resolve));
  await mockOpenAI.close();
  await upstream.close();
  console.log('[teardown] All test servers shut down cleanly.\n');

  // Summary
  console.log('============================================================');
  console.log(`RESULTS: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
  console.log('============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('\nFatal test runner error:', err);
  process.exit(1);
});
