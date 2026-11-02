/* Accio Bridge — API layer.
   All URLs are relative so the Go host can reverse-proxy them (CONTRACT §1/§2).
   /host/* requests carry X-Host-Token. In mock mode every call is served from
   mock.js instead — real mode never falls back to fake data. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  /* ---------- token ---------- */
  function token() {
    try {
      if (window.__HOST__ && window.__HOST__.token) return String(window.__HOST__.token);
    } catch (e) { /* ignore */ }
    var m = /[?&]token=([^&#]+)/.exec(window.location.search || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  AB.token = token;

  /* ---------- errors ---------- */
  function ApiError(message, opts) {
    opts = opts || {};
    var err = new Error(message || '请求失败');
    err.name = 'ApiError';
    err.status = opts.status || 0;
    err.payload = opts.payload || null;
    err.network = !!opts.network;
    err.gatewayDown = opts.status === 503 || (!!opts.payload && opts.payload.gatewayDown === true);
    return err;
  }

  AB.ApiError = ApiError;

  function errorFromPayload(payload, status, fallback) {
    var message = '';
    if (payload && typeof payload === 'object') {
      if (typeof payload.error === 'string') message = payload.error;
      else if (payload.error && typeof payload.error.message === 'string') message = payload.error.message;
    }
    if (!message) message = fallback || ('HTTP ' + status);
    return ApiError(message, { status: status, payload: payload });
  }

  function mockOn() {
    return !!(AB.mock && AB.mock.enabled && AB.mock.enabled());
  }

  /* ---------- request plumbing ---------- */
  function request(method, path, body, opts) {
    opts = opts || {};
    var qIndex = path.indexOf('?');
    var base = qIndex >= 0 ? path.slice(0, qIndex) : path;
    var query = qIndex >= 0 ? path.slice(qIndex + 1) : '';
    var headers = {};

    if (mockOn()) {
      if (!AB.mock.handle) {
        return Promise.reject(ApiError('mock 模块未加载', { status: 0 }));
      }
      return Promise.resolve(AB.mock.handle({
        method: method,
        path: base,
        query: query,
        body: body
      })).then(function (res) {
        if (!res) return Promise.reject(ApiError('mock 未返回结果', { status: 0 }));
        if (res.status !== 200 || !res.json || res.json.ok === false) {
          throw errorFromPayload(res.json, res.status, 'HTTP ' + res.status);
        }
        return res.json;
      });
    }

    if (base.indexOf('/host/') === 0) headers['X-Host-Token'] = token();
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';

    return fetch(base + (query ? '?' + query : ''), {
      method: method,
      headers: headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      signal: opts.signal
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        if (text) {
          try { json = JSON.parse(text); } catch (e) { json = null; }
        }
        if (!res.ok) {
          throw errorFromPayload(json, res.status, 'HTTP ' + res.status + (text ? '：' + text.slice(0, 200) : ''));
        }
        if (!json) throw ApiError('响应不是有效的 JSON', { status: res.status });
        if (json.ok === false) throw errorFromPayload(json, res.status, '请求被拒绝');
        return json;
      });
    }, function (err) {
      if (err && err.name === 'AbortError') throw err;
      if (err && err.name === 'ApiError') throw err;
      throw ApiError('无法连接宿主服务：' + base, { status: 0, network: true });
    });
  }

  AB.request = request;

  /* ---------- host ---------- */
  AB.api = {
    getState: function () {
      return request('GET', '/host/state');
    },
    gatewayStart: function () {
      return request('POST', '/host/gateway/start');
    },
    gatewayStop: function () {
      return request('POST', '/host/gateway/stop');
    },
    gatewayRestart: function () {
      return request('POST', '/host/gateway/restart');
    },
    windowHide: function () {
      return request('POST', '/host/window/hide');
    },
    appQuit: function () {
      return request('POST', '/host/app/quit');
    },
    open: function (target) {
      return request('POST', '/host/open', { target: target });
    },

    /* ---------- bridge (reverse-proxied to Node) ---------- */
    getStatus: function () {
      return request('GET', '/api/bridge/status');
    },
    getAccio: function (force) {
      return request('GET', '/api/bridge/accio' + (force ? '?force=true' : ''));
    },
    launchAccio: function (options) {
      var body = {};
      if (options && options.force) body.force = true;
      if (options && options.customExePath) body.customExePath = options.customExePath;
      return request('POST', '/api/bridge/accio/launch', body);
    },
    getProviders: function () {
      return request('GET', '/api/bridge/providers');
    },
    createProvider: function (payload) {
      return request('POST', '/api/bridge/providers', payload);
    },
    patchProvider: function (id, patch) {
      return request('PATCH', '/api/bridge/providers/' + encodeURIComponent(id), patch);
    },
    /* v1.1：按分组 id 追加模型，服务端复用该组的 provider/baseUrl/apiKey（UI 不需要明文 key） */
    addProviderModels: function (providerId, models) {
      return request('POST', '/api/bridge/providers/' + encodeURIComponent(providerId) + '/models',
        { models: models || [] });
    },
    deleteProvider: function (id) {
      return request('DELETE', '/api/bridge/providers/' + encodeURIComponent(id));
    },
    getModels: function () {
      return request('GET', '/api/bridge/models');
    },
    patchModel: function (id, patch) {
      return request('PATCH', '/api/bridge/models/' + encodeURIComponent(id), patch);
    },
    deleteModel: function (id) {
      return request('DELETE', '/api/bridge/models?id=' + encodeURIComponent(id));
    },
    getUsage: function () {
      return request('GET', '/api/bridge/usage');
    },
    getLogs: function (options) {
      options = options || {};
      var qs = [];
      if (options.lines) qs.push('lines=' + encodeURIComponent(options.lines));
      if (options.level) qs.push('level=' + encodeURIComponent(options.level));
      return request('GET', '/api/bridge/logs' + (qs.length ? '?' + qs.join('&') : ''));
    },
    discover: function (force) {
      return request('GET', '/api/bridge/discover' + (force ? '?force=true' : ''));
    },
    discoverModels: function (options) {
      /* v1.1：传 providerId 时按已有分组取 provider/baseUrl/apiKey，body 只发 providerId */
      var body;
      if (options.providerId) {
        body = { providerId: options.providerId };
        return request('POST', '/api/bridge/discover/models', body);
      }
      body = { provider: options.provider, baseUrl: options.baseUrl };
      /* 空 apiKey 不发送字段：本地服务不需要，云端留空时由后端报错 */
      if (options.apiKey) body.apiKey = options.apiKey;
      return request('POST', '/api/bridge/discover/models', body);
    }
  };

  /* ---------- model test (SSE or JSON, CONTRACT §5) ---------- */
  function extractText(frame) {
    if (!frame || typeof frame !== 'object') return '';
    var out = '';
    var candidates = frame.candidates;
    if (Array.isArray(candidates) && candidates.length) {
      var content = candidates[0] && candidates[0].content;
      if (content && Array.isArray(content.parts)) {
        content.parts.forEach(function (part) {
          if (part && typeof part.text === 'string') out += part.text;
        });
      } else if (candidates[0] && typeof candidates[0].text === 'string') {
        out = candidates[0].text;
      }
    } else if (typeof frame.text === 'string') {
      out = frame.text;
    } else if (typeof frame.content === 'string') {
      out = frame.content;
    } else if (frame.content && Array.isArray(frame.content.parts)) {
      /* 真实网关的 SSE 帧是 { content: { role, parts: [{ text }] } }（不带 candidates 包装） */
      frame.content.parts.forEach(function (part) {
        if (part && typeof part.text === 'string') out += part.text;
      });
    } else if (frame.choices && frame.choices[0]) {
      var choice = frame.choices[0];
      if (choice.delta && typeof choice.delta.content === 'string') out = choice.delta.content;
      else if (choice.message && typeof choice.message.content === 'string') out = choice.message.content;
      else if (typeof choice.text === 'string') out = choice.text;
    }
    return out;
  }

  function extractError(frame) {
    if (!frame || typeof frame !== 'object') return '';
    if (typeof frame.error === 'string') return frame.error;
    if (frame.error && typeof frame.error === 'object' && typeof frame.error.message === 'string') return frame.error.message;
    if (frame.promptFeedback && frame.promptFeedback.blockReason) {
      return '提示被拦截：' + frame.promptFeedback.blockReason;
    }
    var candidates = frame.candidates;
    if (Array.isArray(candidates) && candidates[0]) {
      var reason = candidates[0].finishReason;
      if (reason === 'ERROR' || reason === 'SAFETY' || reason === 'RECITATION' || reason === 'BLOCKED') {
        return '生成被上游中断：' + reason;
      }
    }
    return '';
  }

  function extractUsage(frame) {
    if (!frame || typeof frame !== 'object') return null;
    var usage = frame.usageMetadata || frame.usage;
    if (!usage || typeof usage !== 'object') return null;
    var candidates = Number(usage.candidatesTokenCount || usage.completion_tokens || usage.completionTokens);
    var prompt = Number(usage.promptTokenCount || usage.prompt_tokens || usage.promptTokens);
    var total = Number(usage.totalTokenCount || usage.total_tokens || usage.totalTokens);
    if (isNaN(candidates) && isNaN(prompt) && isNaN(total)) return null;
    return {
      candidates: isNaN(candidates) ? null : candidates,
      prompt: isNaN(prompt) ? null : prompt,
      total: isNaN(total) ? null : total
    };
  }

  AB.sse = { extractText: extractText, extractError: extractError, extractUsage: extractUsage };

  /**
   * POST /api/bridge/test.
   * handlers: { onText(chunk), onError(message), onMeta({status, contentType}), onFrame(frame) }
   * resolves with { status, contentType, text, error, ttftMs, totalMs, usage }
   */
  AB.api.testStream = function (options) {
    var handlers = options.handlers || {};
    var signal = options.signal;
    var body = { model: options.model, prompt: options.prompt };
    if (typeof options.temperature === 'number') body.temperature = options.temperature;

    var result = {
      status: 0,
      contentType: '',
      text: '',
      error: '',
      ttftMs: null,
      totalMs: null,
      usage: null,
      chars: 0
    };
    var startedAt = performance.now();

    function handleFrame(frame) {
      var message = extractError(frame);
      if (message && !result.error) {
        result.error = message;
        if (handlers.onError) handlers.onError(message);
      }
      var usage = extractUsage(frame);
      if (usage) result.usage = usage;
      var text = extractText(frame);
      if (text) {
        if (result.ttftMs === null) result.ttftMs = performance.now() - startedAt;
        result.text += text;
        result.chars += text.length;
        if (handlers.onText) handlers.onText(text);
      }
      if (handlers.onFrame) handlers.onFrame(frame);
    }

    function feedBlock(block) {
      block.split('\n').forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed || trimmed.charAt(0) === ':') return;
        if (trimmed.indexOf('event:') === 0 || trimmed.indexOf('id:') === 0 || trimmed.indexOf('retry:') === 0) return;
        var payload = trimmed.indexOf('data:') === 0 ? trimmed.slice(5).trim() : trimmed;
        if (!payload || payload === '[DONE]') return;
        var frame = null;
        try { frame = JSON.parse(payload); } catch (e) { return; }
        handleFrame(frame);
      });
    }

    function finish() {
      result.totalMs = performance.now() - startedAt;
      return result;
    }

    if (mockOn()) {
      result.status = 200;
      result.contentType = 'text/event-stream';
      if (handlers.onMeta) handlers.onMeta({ status: 200, contentType: result.contentType });
      return AB.mock.testStream(
        { model: options.model, prompt: options.prompt },
        { signal: signal, onFrame: handleFrame }
      ).then(function () {
        return finish();
      }, function (err) {
        if (err && err.name === 'AbortError') throw err;
        throw err;
      });
    }
    return fetch('/api/bridge/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (res) {
      result.status = res.status;
      result.contentType = res.headers.get('content-type') || '';
      if (handlers.onMeta) handlers.onMeta({ status: res.status, contentType: result.contentType });

      if (!res.ok) {
        return res.text().then(function (text) {
          var payload = null;
          try { payload = JSON.parse(text); } catch (e) { payload = null; }
          throw errorFromPayload(payload, res.status,
            'HTTP ' + res.status + '：' + (text || '').slice(0, 300));
        });
      }

      var isSse = result.contentType.indexOf('event-stream') >= 0;
      if (isSse && res.body && typeof res.body.getReader === 'function') {
        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) {
              buffer += decoder.decode();
              if (buffer.trim()) feedBlock(buffer);
              return null;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            var index;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              feedBlock(buffer.slice(0, index));
              buffer = buffer.slice(index + 2);
            }
            return pump();
          });
        }
        return pump().then(finish);
      }

      return res.text().then(function (text) {
        var json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        if (json) {
          handleFrame(json);
          if (json.content && !extractText(json)) {
            var parts = json.content.parts;
            if (Array.isArray(parts)) {
              parts.forEach(function (part) {
                if (part && typeof part.text === 'string') handleFrame({ content: { parts: [part] } });
              });
            }
          }
        } else if (text) {
          /* 非 JSON 且非 SSE：把原始响应交给用户看，而不是吞掉 */
          result.error = result.error || '';
          result.text += text;
          result.chars += text.length;
          if (result.ttftMs === null) result.ttftMs = performance.now() - startedAt;
          if (handlers.onText) handlers.onText(text);
        }
        return finish();
      });
    }, function (err) {
      if (err && err.name === 'AbortError') throw err;
      if (err && err.name === 'ApiError') throw err;
      throw ApiError('无法连接网关：/api/bridge/test', { status: 0, network: true });
    });
  };
})(window.AB);