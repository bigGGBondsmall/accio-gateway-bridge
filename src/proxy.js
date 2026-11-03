'use strict';

/**
 * proxy.js
 *
 * Transparent reverse proxy to the official Accio gateway
 * (`https://phoenix-gw.alibaba.com`). Used for every request the bridge does
 * not handle itself (auth, entitlement, tools, skills, heartbeat, official
 * model inference, ...) so login and cloud features keep working.
 *
 * The request/response bodies are streamed, never buffered, so SSE and large
 * uploads behave exactly like the direct connection.
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');

/** Hop-by-hop headers that must not be forwarded verbatim. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Response headers that break clients when copied from an already-decoded body. */
const STRIPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding']);

function sanitizeRequestHeaders(headers, { hasBody }) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (hasBody && lower === 'content-length') continue;
    out[key] = value;
  }
  return out;
}

function sanitizeResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build an Accio-shaped SSE error frame.
 *
 * The transport reads `error` out of a `data:` frame, so a failure can be reported
 * on an HTTP 200 stream instead of a raw body the client cannot parse.
 */
function sseErrorFrame(message, code) {
  return `data: ${JSON.stringify({
    error: { code: code || 502, message, status: 'UNAVAILABLE' },
    turnComplete: true,
    finishReason: 'STOP',
  })}\n\n`;
}

/** Collapse an HTML error page into a single readable line. */
function htmlToMessage(html, fallback) {
  const source = String(html || '');
  const text = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (text) return text;

  // Gateway error pages are often script-driven with no body text; the title or the
  // link target still names the failure (for example the punish/ICBUSpace page).
  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title && title[1].replace(/\s+/g, ' ').trim()) {
    return title[1].replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  const link = source.match(/href="([^"]{1,200})"/i);
  if (link && link[1].trim()) return `see ${link[1].trim()}`;
  return fallback;
}

/**
 * Decompress a buffered upstream body.
 *
 * Node's http client does not decode `content-encoding`, and the gateway gzips its
 * error pages, so the bytes have to be decoded before any text can be read.
 * Returns undefined when the body cannot be decoded.
 */
function decodeBody(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
    if (enc.includes('deflate')) {
      try {
        return zlib.inflateSync(buffer);
      } catch {
        return zlib.inflateRawSync(buffer);
      }
    }
  } catch {
    return undefined;
  }
  return buffer;
}

/**
 * Create the proxy handler.
 *
 * @param {object} options
 * @param {string} options.upstreamBaseUrl e.g. https://phoenix-gw.alibaba.com
 * @param {number} [options.timeoutMs]
 * @param {string} [options.apiKey] injected as bearer when the client sends none
 * @param {(level: string, ...args: unknown[]) => void} [options.log]
 * @param {string} [options.mountPath] prefix stripped before building the upstream path
 */
function createProxyHandler(options) {
  const upstream = new URL(options.upstreamBaseUrl);
  const transport = upstream.protocol === 'http:' ? http : https;
  const timeoutMs = Number(options.timeoutMs) || 300000;
  const log = options.log || (() => {});
  const mountPath = (options.mountPath || '').replace(/\/+$/, '');

  const agent = new transport.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 128 });

  return function proxyRequest(req, res, rawBody) {
    const hasBody = Buffer.isBuffer(rawBody) && rawBody.length > 0;
    const headers = sanitizeRequestHeaders(req.headers, { hasBody });

    if (hasBody) headers['content-length'] = String(rawBody.length);
    else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      headers['content-length'] = '0';
    }
    if (options.apiKey && !headers.authorization && !headers.Authorization) {
      headers.authorization = `Bearer ${options.apiKey}`;
    }

    const requestPath = buildUpstreamPath(req, mountPath);

    res.on('error', (err) => {
      log('debug', `client socket error on ${req.method} ${requestPath}: ${err.message}`);
    });
    req.on('error', (err) => {
      log('debug', `client request error on ${req.method} ${requestPath}: ${err.message}`);
    });

    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const upstreamReq = transport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
          method: req.method,
          path: requestPath,
          headers,
          agent,
          servername: upstream.hostname,
        },
        (upstreamRes) => {
          // Generation routes: a gateway/CDN error page answers 200 with HTML, which
          // the client would parse as a broken SSE stream and show as a blank reply.
          const upstreamType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
          if (options.guardHtmlErrors && upstreamRes.statusCode === 200 && upstreamType.includes('text/html')) {
            const chunks = [];
            let size = 0;
            upstreamRes.on('data', (c) => {
              if (size < 65536) {
                chunks.push(c);
                size += c.length;
              }
            });
            upstreamRes.on('end', () => {
              const raw = Buffer.concat(chunks);
              const decoded = decodeBody(raw, upstreamRes.headers['content-encoding']);
              const message = htmlToMessage(
                decoded === undefined ? '' : decoded.toString('utf8'),
                'upstream gateway returned an HTML page instead of a model stream',
              );
              const body = sseErrorFrame(`upstream gateway error from ${requestPath}: ${message}`);
              if (!res.headersSent) {
                res.writeHead(200, {
                  'content-type': 'text/event-stream; charset=utf-8',
                  'cache-control': 'no-cache, no-transform',
                  connection: 'keep-alive',
                  'x-accel-buffering': 'no',
                  'content-length': String(Buffer.byteLength(body)),
                });
              }
              res.end(body);
              log('warn', `upstream HTML error page on ${requestPath}: ${message.slice(0, 120)}`);
              settle();
            });
            upstreamRes.on('error', (err) => {
              res.destroy(err);
              settle();
            });
            return;
          }

          res.writeHead(upstreamRes.statusCode || 502, sanitizeResponseHeaders(upstreamRes.headers));
          upstreamRes.pipe(res);
          upstreamRes.on('end', settle);
          upstreamRes.on('error', (err) => {
            log('warn', 'upstream response error', err.message);
            res.destroy(err);
            settle();
          });
        },
      );

      upstreamReq.setTimeout(timeoutMs, () => {
        upstreamReq.destroy(new Error(`upstream timeout after ${timeoutMs}ms`));
      });

      upstreamReq.on('error', (err) => {
        log('error', `${req.method} ${requestPath} -> ${err.message}`);
        if (!res.headersSent) {
          const payload = JSON.stringify({
            success: false,
            code: '502',
            message: `gateway bridge upstream error: ${err.message}`,
          });
          res.writeHead(502, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
          });
          res.end(payload);
        } else {
          res.destroy(err);
        }
        settle();
      });

      // Abort the upstream call when the desktop client goes away.
      res.on('close', () => {
        if (!res.writableEnded) {
          upstreamReq.destroy(new Error('client disconnected'));
          settle();
        }
      });

      if (hasBody) upstreamReq.write(rawBody);
      upstreamReq.end();
    });
  };
}

/**
 * Rebuild the original request path (query string preserved). The `mountPath`
 * prefix is stripped when the proxy is mounted below a sub path.
 */
function buildUpstreamPath(req, mountPath) {
  let path = req.url || '/';
  if (mountPath && path.startsWith(mountPath)) {
    path = path.slice(mountPath.length) || '/';
    if (!path.startsWith('/')) path = `/${path}`;
  }
  return path;
}

module.exports = { createProxyHandler, buildUpstreamPath, sanitizeRequestHeaders };
