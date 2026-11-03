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
const zlib = require('node:zlib');
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
    const bodyChunks = [];
    req.on('data', (c) => bodyChunks.push(c));
    req.on('error', () => {});
    req.on('end', () => {
      const bodyText = Buffer.concat(bodyChunks).toString('utf8');

      // Official-model path: this upstream is proxied verbatim, so a gateway/CDN
      // error page arriving as 200 text/html must be turned into an SSE error frame.
      if (bodyText.includes('OFFICIAL_HTML')) {
        const page = '<html><body><a href="https://bixi-intl.alicdn.com/punish/punish:resource:template:ICBUSpace">IP 检测异常，请更换网络环境后重试</a></body></html>';
        // The real gateway gzips this page, so cover both encodings.
        if (bodyText.includes('OFFICIAL_HTML_GZIP')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
          res.end(zlib.gzipSync(Buffer.from(page, 'utf8')));
        } else {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page);
        }
        return;
      }

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

  // Test 4b: reasoning traces must ride on `thought` parts, never message text
  await test('POST /api/adk/llm/generateContent keeps reasoning out of visible message text', async () => {
    const payload = {
      model: 'mock-custom-model',
      contents: [{ role: 'user', parts: [{ text: 'REASONING check my shop' }] }],
    };

    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.strictEqual(res.status, 200, `Expected status 200 but got ${res.status}`);
    const frames = parseSseText(await res.text());

    let visible = '';
    let reasoning = '';
    for (const frame of frames) {
      for (const part of frame.content?.parts || []) {
        if (typeof part.text !== 'string') continue;
        if (part.thought === true) reasoning += part.text;
        else visible += part.text;
      }
    }

    assert.strictEqual(
      visible,
      'Answer.',
      `Reasoning must not appear in visible message text, got: "${visible}"`
    );
    assert.ok(
      reasoning.includes('I need to call the tool.'),
      `Expected the trace to arrive as thought parts, got: "${reasoning}"`
    );
  });

  // Test 4c: a replayed `thought` part must not become assistant content upstream
  await test('replayed thought parts are stripped before reaching the upstream model', async () => {
    const before = mockOpenAI.requests.length;
    const payload = {
      model: 'mock-custom-model',
      contents: [
        { role: 'user', parts: [{ text: 'REASONING replay check' }] },
        {
          role: 'model',
          parts: [
            { text: 'I must call the skill tool now.', thought: true },
            { text: 'Loading the skill.', thought: false },
          ],
        },
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
    };

    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(res.status, 200, `Expected status 200 but got ${res.status}`);
    await res.text();

    const sent = mockOpenAI.requests[before]?.body;
    assert.ok(sent, 'Expected the upstream mock to receive a request');
    const assistant = (sent.messages || []).find((m) => m.role === 'assistant');
    assert.ok(assistant, 'Expected an assistant message in the upstream payload');
    assert.strictEqual(
      assistant.content,
      'Loading the skill.',
      `Assistant history must drop the reasoning trace, got: ${JSON.stringify(assistant.content)}`
    );
    assert.ok(
      !JSON.stringify(assistant).includes('I must call the skill tool now.'),
      'Reasoning trace must not leak into the upstream assistant message'
    );
  });

  // Test 4c-2: Accio's ADK body uses snake_case proto field names
  await test('snake_case function_call / function_response are converted, not dropped', async () => {
    const before = mockOpenAI.requests.length;
    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-custom-model',
        contents: [
          { role: 'user', parts: [{ text: '查一下今天的聊天记录' }] },
          {
            role: 'model',
            parts: [
              { text: 'internal trace', thought: true },
              { function_call: { id: 'call_snake_1', name: 'skill', args_json: JSON.stringify({ action: 'read', skill_id: 'x' }) } },
            ],
          },
          {
            role: 'user',
            parts: [{ function_response: { id: 'call_snake_1', name: 'skill', response_json: JSON.stringify({ result: 'SKILL BODY' }) } }],
          },
        ],
        tools: [{ name: 'skill', description: 'd', parameters_json: JSON.stringify({ type: 'object', properties: { action: { type: 'string' } }, required: ['action'] }) }],
      }),
    });
    await res.text();

    const sent = mockOpenAI.requests[before].body;
    const assistant = (sent.messages || []).find((m) => m.role === 'assistant' && m.tool_calls);
    assert.ok(assistant, `A snake_case function_call must become assistant.tool_calls, got: ${JSON.stringify((sent.messages || []).map((m) => m.role))}`);
    assert.strictEqual(assistant.tool_calls[0].id, 'call_snake_1');
    assert.strictEqual(assistant.tool_calls[0].function.name, 'skill');
    assert.deepStrictEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { action: 'read', skill_id: 'x' });

    const tool = (sent.messages || []).find((m) => m.role === 'tool');
    assert.ok(tool, 'A snake_case function_response must become a tool message');
    assert.strictEqual(tool.tool_call_id, 'call_snake_1', 'the tool result must be paired with the call id');
    assert.strictEqual(tool.content, 'SKILL BODY', 'the result envelope must be unwrapped for the model');

    assert.ok(
      !JSON.stringify(sent.messages).includes('internal trace'),
      'reasoning must still be excluded from the replayed history',
    );
  });

  // Test 4d: a non-SSE upstream (CDN/gateway error page) must not become a blank turn
  await test('non-SSE upstream bodies surface a real error instead of an empty turn', async () => {
    const html = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-custom-model',
        contents: [{ role: 'user', parts: [{ text: 'HTML_PAGE please' }] }],
      }),
    });
    const htmlFrames = parseSseText(await html.text());
    const errorFrame = htmlFrames.find((f) => f.error);
    assert.ok(errorFrame, 'A text/html upstream body must produce an error frame');
    assert.ok(
      /text\/html/.test(errorFrame.error.message),
      `Error must name the offending content-type, got: ${errorFrame.error.message}`
    );
    assert.ok(
      !JSON.stringify(htmlFrames).includes('bixi-intl'),
      'Raw HTML must not be forwarded to Accio as model output'
    );

    const jsonRes = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-custom-model',
        contents: [{ role: 'user', parts: [{ text: 'JSON_ONLY please' }] }],
      }),
    });
    const jsonFrames = parseSseText(await jsonRes.text());
    const text = jsonFrames
      .flatMap((f) => f.content?.parts || [])
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    assert.ok(
      text.includes('non-stream fallback reply'),
      `A 200 application/json body must be converted, got: "${text}"`
    );
  });

  // Test 4d-2: official models are proxied verbatim; an HTML error page must not leak
  await test('official-model path converts a gateway HTML error page into an SSE error frame', async () => {
    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen-max',
        contents: [{ role: 'user', parts: [{ text: 'OFFICIAL_HTML please' }] }],
        stream: true,
      }),
    });
    const raw = await res.text();
    const frames = parseSseText(raw);
    const errFrame = frames.find((f) => f.error);
    assert.ok(errFrame, `A 200 text/html gateway page must become an error frame, got: ${JSON.stringify(raw.slice(0, 160))}`);
    assert.ok(
      /IP 检测异常/.test(errFrame.error.message),
      `Error must carry the page text, got: ${errFrame.error.message}`
    );
    assert.ok(!/<html|<a href/.test(raw), 'Raw HTML must not reach the client');

    // The gateway gzips this page; the message must still be readable text.
    const gz = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen-max',
        contents: [{ role: 'user', parts: [{ text: 'OFFICIAL_HTML_GZIP please' }] }],
        stream: true,
      }),
    });
    const gzRaw = await gz.text();
    const gzErr = parseSseText(gzRaw).find((f) => f.error);
    assert.ok(gzErr, 'A gzipped text/html page must also become an error frame');
    assert.ok(
      /IP 检测异常/.test(gzErr.error.message),
      `Gzipped page text must be decoded before reporting, got: ${JSON.stringify(gzErr.error.message.slice(0, 120))}`
    );
  });

  // Test 4e: providers that restart the tool-call index at 0 must not lose calls
  await test('tool calls reusing the same index are all kept', async () => {
    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-custom-model',
        contents: [{ role: 'user', parts: [{ text: 'DUP_INDEX please' }] }],
      }),
    });
    const calls = parseSseText(await res.text())
      .flatMap((f) => f.content?.parts || [])
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall.name);
    assert.deepStrictEqual(calls, ['first_tool', 'second_tool'], `Both calls must survive, got: ${JSON.stringify(calls)}`);
  });

  // Test 4f: malformed tool arguments must reach Accio verbatim so it can flag them
  await test('invalid tool arguments keep their raw argsJson', async () => {
    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-custom-model',
        contents: [{ role: 'user', parts: [{ text: 'BROKEN_ARGS please' }] }],
      }),
    });
    const call = parseSseText(await res.text())
      .flatMap((f) => f.content?.parts || [])
      .map((p) => p.functionCall)
      .find(Boolean);
    assert.ok(call, 'Expected a functionCall frame');
    assert.strictEqual(call.argsJson, '{"path":', `Raw args must be preserved, got: ${call.argsJson}`);
    assert.ok(!/__raw/.test(call.argsJson), 'Arguments must not be wrapped in { __raw }');
  });

  // Test 4g: attachments and Accio generation knobs must reach the upstream model
  await test('multimodal parts and generation knobs are forwarded upstream', async () => {
    const before = mockOpenAI.requests.length;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-custom-model',
        tools: [
          {
            functionDeclarations: [
              { name: 'skill', description: 'd', parameters: { type: 'object', properties: { action: { type: 'string' } } } },
            ],
          },
        ],
        contents: [
          { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: png } }, { text: 'see attached 图片' }] },
          { role: 'user', parts: [{ fileData: { mimeType: 'application/pdf', fileUri: 'file:///tmp/report.pdf' } }] },
          { role: 'model', parts: [{ text: 'internal trace', thought: true }] },
        ],
        reasoningEffort: 'high',
        responseFormat: 'json_object',
        toolChoice: 'auto',
        generationConfig: { topK: 40 },
      }),
    });
    await res.text();

    const sent = mockOpenAI.requests[before].body;
    const flat = JSON.stringify(sent.messages);
    assert.ok(/data:image\/png;base64/.test(flat), 'Inline image must be forwarded as an image_url data URL');
    assert.ok(/report\.pdf/.test(flat), 'Uploaded file reference must be forwarded');
    assert.ok(
      !(sent.messages || []).some((m) => m.role === 'user' && (m.content === '' || m.content === null)),
      'Empty user messages must not be emitted'
    );
    assert.ok(
      !flat.includes('internal trace'),
      'Reasoning traces must never be replayed as assistant content'
    );
    assert.strictEqual(sent.reasoning_effort, 'high', 'reasoning_effort must be forwarded');
    assert.deepStrictEqual(sent.response_format, { type: 'json_object' }, 'response_format must be an OpenAI object');
    assert.strictEqual(sent.tool_choice, 'auto', 'tool_choice must be forwarded when tools are present');
    assert.strictEqual(sent.top_k, 40, 'generationConfig.topK must be mapped to top_k');
  });

  // Test 4g-2: every tool-declaration shape must keep its schema
  await test('tool declarations keep their schema across key names and encodings', async () => {
    const before = mockOpenAI.requests.length;
    const schema = { type: 'object', properties: { workflow_id: { type: 'string' } }, required: ['workflow_id'] };
    const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-custom-model',
        tools: [
          { type: 'function', function: { name: 'workflow', description: 'run a workflow', parametersJsonSchema: JSON.stringify(schema) } },
          { name: 'skill', parameters: { type: 'object', properties: { action: { type: 'string' } } } },
          { functionDeclarations: [{ name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } }] },
          { name: 'no_schema_tool', description: 'unknown args' },
          { name: 'late_schema_tool', description: 'placeholder first' },
          { name: 'late_schema_tool', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
          // Exactly how Accio 0.37.2 declares a tool: `{ name, description, parameters_json }`.
          {
            name: 'accio_shaped_tool',
            description: 'declared the way Accio declares tools',
            parameters_json: JSON.stringify({ type: 'object', properties: { workflow_id: { type: 'string' } }, required: ['workflow_id'] }),
          },
        ],
        contents: [{ role: 'user', parts: [{ text: 'go' }] }],
      }),
    });
    await res.text();

    const sent = mockOpenAI.requests[before].body;
    const byName = new Map((sent.tools || []).map((t) => [t.function.name, t.function.parameters]));

    assert.ok(byName.has('workflow'), `workflow must be forwarded, got: ${[...byName.keys()].join(',')}`);
    assert.deepStrictEqual(
      byName.get('workflow').properties,
      schema.properties,
      'A schema sent as a JSON string must be parsed, not replaced by the fallback'
    );
    assert.ok(byName.has('skill') && byName.has('bash'), 'bare and nested declarations must both be forwarded');
    assert.strictEqual(
      byName.get('no_schema_tool').additionalProperties,
      true,
      'A declaration without a schema must stay callable (permissive fallback)'
    );
    assert.deepStrictEqual(
      byName.get('late_schema_tool').properties,
      { q: { type: 'string' } },
      'A later declaration with a real schema must replace an earlier placeholder'
    );
    // Regression: Accio declares schemas as `parameters_json` (snake_case JSON string).
    // Missing that key silently stripped the schema from every one of its 37 tools.
    assert.deepStrictEqual(
      byName.get('accio_shaped_tool').properties,
      { workflow_id: { type: 'string' } },
      'A `parameters_json` schema must be parsed, not replaced by the fallback'
    );
    assert.deepStrictEqual(
      byName.get('accio_shaped_tool').required,
      ['workflow_id'],
      'required fields must survive from `parameters_json`'
    );
    assert.strictEqual(sent.tools.length, 6, `expected 6 forwarded tools, got ${sent.tools.length}`);
  });


  // Test 4h: Accio's thinking switch must be honoured
  await test('includeThoughts:false suppresses reasoning parts', async () => {
    const callWith = async (extra) => {
      const res = await httpFetch(`${bridgeUrl}/api/adk/llm/generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-custom-model',
          contents: [{ role: 'user', parts: [{ text: 'REASONING check' }] }],
          ...extra,
        }),
      });
      return parseSseText(await res.text());
    };

    const countThoughts = (frames) =>
      frames.flatMap((f) => f.content?.parts || []).filter((p) => p.thought === true && typeof p.text === 'string').length;

    assert.ok(countThoughts(await callWith({ includeThoughts: true })) > 0, 'includeThoughts:true must keep thought parts');
    assert.strictEqual(countThoughts(await callWith({ includeThoughts: false })), 0, 'includeThoughts:false must drop thought parts');
    assert.strictEqual(countThoughts(await callWith({ thinkingBudget: 0 })), 0, 'thinkingBudget:0 must drop thought parts');
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
