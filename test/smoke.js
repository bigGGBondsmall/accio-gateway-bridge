'use strict';

/**
 * smoke.js — self-contained end-to-end check, no network access required.
 *
 * Spins up two fake providers (OpenAI-compatible + Ollama) and a fake upstream
 * gateway, then drives the bridge through catalog merge, streaming, tool calls
 * and transparent proxying.
 *
 * Run with: npm run smoke
 */

const http = require('node:http');
const assert = require('node:assert');

const { createServer, normalizeConfig } = require('../src/server');

let failures = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    results.push(`FAIL  ${name}\n        ${err.message}`);
  }
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

function sseChunks(response, lines) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const line of lines) response.write(line);
  response.end();
}

function readFrames(text) {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => JSON.parse(block.slice(5).trim()));
}

async function main() {
  const received = { openai: [], ollama: [], upstream: [] };

  // Fake OpenAI-compatible provider.
  const openai = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      received.openai.push({ url: req.url, body });
      if (body.messages?.some((m) => String(m.content || '').includes('CALL_TOOL'))) {
        sseChunks(res, [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
        return;
      }
      sseChunks(res, [
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hello "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
  });

  // Fake Ollama provider (NDJSON).
  const ollama = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.ollama.push({ url: req.url, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"message":{"role":"assistant","content":"local "},"done":false}\n');
      res.write('{"message":{"role":"assistant","content":"answer"},"done":false}\n');
      res.write('{"done":true,"done_reason":"stop","prompt_eval_count":7,"eval_count":9}\n');
      res.end();
    });
  });

  // Fake upstream gateway (official models + passthrough features).
  const upstream = await listen((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.upstream.push({ url: req.url, method: req.method, headers: req.headers, raw });
      if (req.url.startsWith('/api/llm/config/v2')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          code: '200',
          data: [{ provider: 'alibaba', providerDisplayName: 'Official', modelList: [{ modelCode: 'qwen-max' }] }],
        }));
        return;
      }
      if (req.url.startsWith('/api/adk/llm')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"content":{"role":"model","parts":[{"text":"official"}]},"turnComplete":true}\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
    });
  });

  const config = normalizeConfig({
    server: { host: '127.0.0.1', port: 0, logLevel: 'error' },
    upstream: { baseUrl: baseUrl(upstream), timeoutMs: 10000 },
    catalog: { enabled: true, fetchOfficial: true, timeoutMs: 5000 },
    models: [
      {
        id: 'fake-openai',
        displayName: 'Fake OpenAI',
        provider: 'openai',
        baseUrl: `${baseUrl(openai)}/v1`,
        upstreamModel: 'fake-openai-real',
        apiKey: 'sk-test',
        isDefault: true,
        contextWindow: 8000,
      },
      {
        id: 'fake-ollama',
        displayName: 'Fake Ollama',
        provider: 'ollama',
        baseUrl: baseUrl(ollama),
        upstreamModel: 'llama3',
        contextWindow: 8000,
      },
    ],
  });

  const bridge = createServer(config);
  await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const bridgeUrl = baseUrl(bridge);

  const post = (path, body, headers = {}) =>
    fetch(`${bridgeUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  await check('healthz reports enabled models', async () => {
    const res = await fetch(`${bridgeUrl}/healthz`);
    const json = await res.json();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(json.models.sort(), ['fake-ollama', 'fake-openai']);
  });

  await check('catalog merges custom provider before official models', async () => {
    const res = await post('/api/llm/config/v2', { token: 't', supportAutoModel: true });
    const json = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.code, '200');
    assert.strictEqual(json.data[0].provider, 'custom');
    assert.strictEqual(json.data[0].modelList[0].modelCode, 'fake-openai');
    assert.strictEqual(json.data[0].modelList[0].isDefault, true);
    assert.strictEqual(json.data[0].modelList[0].contextWindow, 8000);
    assert.strictEqual(json.data[1].provider, 'alibaba');
    assert.ok(received.upstream.some((r) => r.url.startsWith('/api/llm/config/v2')));
  });

  await check('custom openai model streams translated SSE frames', async () => {
    const res = await post('/api/adk/llm/generateContent?sg_k=t',
      {
        model: 'fake-openai',
        systemInstruction: 'You are Accio',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        temperature: 0.5,
        maxOutputTokens: 256,
        tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      },
      { authorization: 'Bearer x' });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const frames = readFrames(await res.text());

    assert.strictEqual(frames[0].content.parts[0].text, 'Hello ');
    assert.strictEqual(frames[0].turnComplete, false);
    assert.strictEqual(frames[1].content.parts[0].text, 'world');
    const last = frames[frames.length - 1];
    assert.deepStrictEqual(last.content.parts, []);
    assert.strictEqual(last.turnComplete, true);
    assert.strictEqual(last.finishReason, 'STOP');
    assert.strictEqual(last.usageMetadata.totalTokenCount, 30);

    const seen = received.openai.at(-1);
    assert.strictEqual(seen.url, '/v1/chat/completions');
    assert.strictEqual(seen.body.model, 'fake-openai-real');
    assert.strictEqual(seen.body.stream, true);
    assert.strictEqual(seen.body.messages[0].role, 'system');
    assert.strictEqual(seen.body.messages[0].content, 'You are Accio');
    assert.strictEqual(seen.body.messages[1].content, 'hi');
    assert.strictEqual(seen.body.temperature, 0.5);
    assert.strictEqual(seen.body.max_tokens, 256);
    assert.strictEqual(seen.body.tools[0].type, 'function');
    assert.strictEqual(seen.body.tools[0].function.name, 'read_file');
  });

  await check('streamed tool calls collapse into one TOOL_CALLS frame', async () => {
    const res = await post('/api/adk/llm', {
      model: 'fake-openai',
      contents: [{ role: 'user', parts: [{ text: 'CALL_TOOL now' }] }],
    });
    const frames = readFrames(await res.text());
    const last = frames.at(-1);
    assert.strictEqual(last.turnComplete, true);
    assert.strictEqual(last.finishReason, 'TOOL_CALLS');
    assert.strictEqual(last.content.parts[0].functionCall.name, 'read_file');
    assert.deepStrictEqual(last.content.parts[0].functionCall.args, { path: 'a.txt' });
  });

  await check('ollama model uses native /api/chat and NDJSON', async () => {
    const res = await post('/api/adk/llm/generateContent', {
      model: 'fake-ollama',
      contents: [
        { role: 'user', parts: [{ text: 'use the tool' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'x' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { ok: true } } }] },
      ],
    });
    const frames = readFrames(await res.text());
    assert.strictEqual(frames[0].content.parts[0].text, 'local ');
    assert.strictEqual(frames.at(-1).finishReason, 'STOP');
    assert.strictEqual(frames.at(-1).usageMetadata.totalTokenCount, 16);

    const sent = received.ollama.at(-1);
    assert.strictEqual(sent.url, '/api/chat');
    assert.strictEqual(sent.body.messages.at(-1).role, 'tool');
    assert.deepStrictEqual(sent.body.messages[1].tool_calls[0].function.arguments, { path: 'x' });
  });

  await check('non-custom model is forwarded transparently upstream', async () => {
    const res = await post('/api/adk/llm/generateContent?sg_k=abc', {
      model: 'qwen-max',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    const text = await res.text();
    assert.match(text, /"official"/);
    const forwarded = received.upstream.at(-1);
    assert.strictEqual(forwarded.url, '/api/adk/llm/generateContent?sg_k=abc');
    assert.match(forwarded.raw, /qwen-max/);
    assert.strictEqual(forwarded.headers.host, undefined ?? forwarded.headers.host);
    assert.notStrictEqual(forwarded.headers.host, `127.0.0.1:${bridge.address().port}`);
  });

  await check('unknown endpoints proxy with body, query and headers', async () => {
    const res = await post('/api/tool/invoke?x=1', { hello: 'world' }, { 'x-custom': 'keep-me' });
    const json = await res.json();
    assert.strictEqual(json.path, '/api/tool/invoke?x=1');
    assert.strictEqual(json.method, 'POST');
    const forwarded = received.upstream.at(-1);
    assert.strictEqual(forwarded.headers['x-custom'], 'keep-me');
    assert.match(forwarded.raw, /world/);
  });

  await check('invalid JSON gets a 400', async () => {
    const res = await fetch(`${bridgeUrl}/api/adk/llm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    assert.strictEqual(res.status, 400);
  });

  await check('converter round-trips GenAI <-> OpenAI non-streaming', async () => {
    const converter = require('../src/converter');
    const frame = converter.openAIResponseToGenAI({
      choices: [{ message: { content: 'hey', tool_calls: [{ function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    assert.strictEqual(frame.content.parts[1].functionCall.name, 'f');
    assert.deepStrictEqual(frame.content.parts[1].functionCall.args, { a: 1 });
    assert.strictEqual(frame.finishReason, 'TOOL_CALLS');
    const back = converter.genAIResponseToOpenAI(frame, 'm');
    assert.strictEqual(back.choices[0].message.tool_calls[0].function.name, 'f');
    assert.strictEqual(back.choices[0].finish_reason, 'tool_calls');
  });

  bridge.close();
  openai.close();
  ollama.close();
  upstream.close();

  console.log(results.join('\n'));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
