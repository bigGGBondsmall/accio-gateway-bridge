'use strict';

/**
 * tester.js — Terminal streaming LLM test runner.
 * Connects to the local bridge (or direct provider) and streams completions
 * directly to stdout with TTFT and token performance metrics. No browser required.
 */

const http = require('node:http');
const { c, symbols } = require('./terminal');

/**
 * Run a streaming test for a given model through the bridge.
 * @param {object} opts
 * @param {string} opts.modelId
 * @param {string} [opts.prompt]
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 */
async function runStreamingTest(opts = {}) {
  const modelId = opts.modelId;
  if (!modelId) {
    throw new Error('Model ID is required for testing');
  }

  const prompt = opts.prompt || 'Reply with a short friendly greeting and identify yourself.';
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port) || 8080;

  console.log(`\n${symbols.blueDot} Testing model ${c.bold(modelId)} via ${c.cyan(`http://${host}:${port}`)}`);
  console.log(`${c.dim('Prompt:')} ${prompt}`);
  console.log(`${c.gray('—'.repeat(60))}`);

  const payload = JSON.stringify({
    model: modelId,
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  });

  const startTime = Date.now();
  let ttftMs = 0;
  let chunkCount = 0;
  let totalChars = 0;
  let errorReceived = null;

  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path: '/api/adk/llm/generateContent',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => (errBody += c));
          res.on('end', () => {
            console.log(`\n${symbols.dangerDot} ${c.red(`Bridge responded with HTTP ${res.statusCode}`)}`);
            try {
              const j = JSON.parse(errBody);
              console.log(c.yellow(JSON.stringify(j, null, 2)));
            } catch {
              console.log(c.yellow(errBody));
            }
            resolve({ ok: false, status: res.statusCode, error: errBody });
          });
          return;
        }

        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n\n');
          buffer = lines.pop(); // keep remainder

          for (const block of lines) {
            const trimmed = block.trim();
            if (!trimmed.startsWith('data:')) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') continue;

            let frame;
            try {
              frame = JSON.parse(jsonStr);
            } catch {
              continue;
            }

            if (!ttftMs) {
              ttftMs = Date.now() - startTime;
            }
            chunkCount++;

            if (frame.content && Array.isArray(frame.content.parts)) {
              for (const part of frame.content.parts) {
                if (typeof part.text === 'string') {
                  process.stdout.write(part.text);
                  totalChars += part.text.length;
                }
                if (part.functionCall) {
                  const callText = `\n[Tool Call: ${part.functionCall.name}(${JSON.stringify(part.functionCall.args)})]\n`;
                  process.stdout.write(c.cyan(callText));
                  totalChars += callText.length;
                }
              }
            }

            if (frame.error) {
              errorReceived = frame.error.message || JSON.stringify(frame.error);
              console.log(`\n${symbols.dangerDot} ${c.red(`Stream error: ${errorReceived}`)}`);
            }
          }
        });

        res.on('end', () => {
          const totalMs = Date.now() - startTime;
          console.log(`\n${c.gray('—'.repeat(60))}`);

          if (errorReceived) {
            console.log(`${symbols.dangerDot} ${c.red('Test finished with stream error')}`);
            resolve({ ok: false, error: errorReceived, totalMs });
            return;
          }

          if (totalChars === 0) {
            console.log(`${symbols.warningDot} ${c.yellow('No text received in stream. Check upstream provider connectivity.')}`);
            resolve({ ok: false, error: 'empty_response', totalMs });
            return;
          }

          const approxTokens = Math.max(1, Math.round(totalChars / 3.8));
          const tokPerSec = (totalMs > 0 ? (approxTokens / (totalMs / 1000)).toFixed(1) : '0');

          console.log(
            `${symbols.check} ${c.green('Success')} ${c.gray('│')} ` +
            `TTFT: ${c.bold(ttftMs + 'ms')} ${c.gray('│')} ` +
            `Total: ${c.bold(totalMs + 'ms')} ${c.gray('│')} ` +
            `~${c.bold(approxTokens)} tokens (${tokPerSec} tok/s) ${c.gray('│')} ` +
            `${chunkCount} frames\n`
          );

          resolve({
            ok: true,
            ttftMs,
            totalMs,
            approxTokens,
            tokPerSec,
            chunkCount,
          });
        });
      }
    );

    req.on('error', (err) => {
      console.log(`\n${symbols.dangerDot} ${c.red(`Failed to connect to bridge: ${err.message}`)}`);
      console.log(`${c.dim('Hint: make sure the gateway is running (`accio serve` or `accio daemon start`)')}\n`);
      resolve({ ok: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

module.exports = {
  runStreamingTest,
};
