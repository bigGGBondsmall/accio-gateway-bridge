/* Accio Bridge — in-memory mock of the whole contract (CONTRACT §2–§5).
   Active only with ?mock=1 or when the page is opened over file:// so the UI can
   be previewed without the Go host or the Node bridge. Real mode never uses this.

   Extra scenario switches: stopped | noaccio | empty | error | external
   Every fixture here is demo data and is labelled as such by the UI banner. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var params = new URLSearchParams(window.location.search || '');
  var scenarioName = params.get('scenario') || '';

  function enabled() {
    return params.get('mock') === '1' || window.location.protocol === 'file:';
  }

  function scenario() { return scenarioName; }

  /* ---------- helpers ---------- */
  function isoAgo(seconds) {
    return new Date(Date.now() - seconds * 1000).toISOString();
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return ''; }
  }

  function isLocalUrl(url) {
    var host = hostOf(url);
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  }

  /* 32-bit FNV-1a, rendered as 8 hex chars — stands in for sha1(provider|baseUrl|apiKey) */
  function shortHash(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  function maskKey(key) {
    if (!key) return '';
    if (key.length <= 8) return '••••';
    return key.slice(0, 4) + '…' + key.slice(-4);
  }

  /* ---------- fixtures ---------- */
  var ROOT = 'C:\\Users\\lin\\Downloads\\exe-reverse\\accio-gateway-bridge';
  var OLLAMA_URL = 'http://127.0.0.1:11434';
  var DEEPSEEK_URL = 'https://api.deepseek.com/v1';
  var SILICONFLOW_URL = 'https://api.siliconflow.cn/v1';

  var ACCIO_CN = {
    installed: true,
    edition: 'cn',
    editionLabel: '中国版',
    path: 'C:\\Users\\lin\\AppData\\Local\\Accio\\Accio.exe',
    version: '1.4.2',
    evidence: [
      {
        source: 'registry',
        field: 'DisplayName',
        value: 'Accio Work 中国版',
        description: '卸载注册表项 DisplayName 为中文发行名称，匹配 CN 发行包。',
        targetEdition: 'cn',
        weight: 100
      },
      {
        source: 'file-version',
        field: 'CompanyName',
        value: '杭州阿里云技术有限公司',
        description: '主程序版本信息中的公司与 CN 发行方一致，Global 包为 Alibaba Cloud (Singapore)。',
        targetEdition: 'cn',
        weight: 100
      },
      {
        source: 'asar',
        field: 'resources/app.asar',
        value: 'C:\\Users\\lin\\AppData\\Local\\Accio\\resources\\app.asar（含 zh-CN 语言包）',
        description: 'app.asar 内存在 zh-CN 语言包与 phonix-gw.alibaba.com 域名白名单。',
        targetEdition: 'cn',
        weight: 90
      },
      {
        source: 'path',
        field: 'installDir',
        value: 'C:\\Users\\lin\\AppData\\Local\\Accio',
        description: '安装目录位于用户级 AppData\\Local\\Accio，而非 Program Files。',
        targetEdition: 'cn',
        weight: 70
      },
      {
        source: 'process',
        field: 'cmdline',
        value: 'Accio.exe --gateway-base-url=http://127.0.0.1:4097',
        description: '进程命令行带网关地址参数（当前指向 4097，不是本程序的 8080）。',
        targetEdition: 'neutral',
        weight: 0
      }
    ],
    running: true,
    runningPids: [12884, 12960],
    gatewayPort: 4097,
    signedIn: true,
    accountCount: 2,
    scores: { cn: 350, global: 0 }
  };

  var ACCIO_NONE = {
    installed: false,
    edition: 'none',
    editionLabel: '未安装',
    path: '',
    version: '',
    evidence: [
      {
        source: 'registry',
        field: 'UninstallKeys',
        value: '未找到 Accio Work 相关卸载项',
        description: 'HKCU/HKLM 卸载项中没有任何 Accio 发行记录。',
        targetEdition: 'neutral',
        weight: 0
      },
      {
        source: 'path',
        field: 'searchPaths',
        value: 'C:\\Users\\lin\\AppData\\Local\\Accio；C:\\Program Files\\Accio',
        description: '标准安装目录中未发现 Accio.exe。',
        targetEdition: 'neutral',
        weight: 0
      }
    ],
    running: false,
    runningPids: [],
    gatewayPort: null,
    signedIn: false,
    accountCount: 0,
    scores: { cn: 0, global: 0 }
  };

  function makeModel(options) {
    return {
      id: options.id,
      modelCode: options.id,
      displayName: options.displayName || options.id,
      provider: options.provider,
      baseUrl: options.baseUrl,
      upstreamModel: options.upstreamModel || options.id,
      apiKey: options.apiKey || '',
      contextWindow: options.contextWindow || 0,
      multimodal: !!options.multimodal,
      stream: options.stream !== false,
      enabled: options.enabled !== false,
      visible: options.visible !== false,
      isDefault: !!options.isDefault,
      freeUse: true,
      locked: false,
      usageLevel: options.usageLevel || 0,
      aliases: options.aliases || []
    };
  }

  /* groups: { provider, baseUrl, apiKey, models: [] } */
  function seedGroups() {
    if (scenarioName === 'empty') return [];
    return [
      {
        provider: 'ollama',
        baseUrl: OLLAMA_URL,
        apiKey: '',
        models: [
          makeModel({
            id: 'deepseek-local', provider: 'ollama', baseUrl: OLLAMA_URL,
            displayName: 'DeepSeek R1 14B（Ollama 本地）', upstreamModel: 'deepseek-r1:14b',
            contextWindow: 128000, enabled: true, isDefault: true
          }),
          makeModel({
            id: 'qwen-local', provider: 'ollama', baseUrl: OLLAMA_URL,
            displayName: 'Qwen2.5 7B Instruct（Ollama 本地）', upstreamModel: 'qwen2.5:7b-instruct',
            contextWindow: 32768, enabled: false
          })
        ]
      },
      {
        provider: 'openai',
        baseUrl: DEEPSEEK_URL,
        apiKey: 'sk-demo-deepseek-0000',
        models: [
          makeModel({
            id: 'deepseek-chat', provider: 'openai', baseUrl: DEEPSEEK_URL,
            displayName: 'DeepSeek Chat', upstreamModel: 'deepseek-chat',
            contextWindow: 64000, enabled: true
          }),
          makeModel({
            id: 'deepseek-reasoner', provider: 'openai', baseUrl: DEEPSEEK_URL,
            displayName: 'DeepSeek Reasoner', upstreamModel: 'deepseek-reasoner',
            contextWindow: 64000, enabled: false
          })
        ]
      },
      {
        provider: 'openai',
        baseUrl: SILICONFLOW_URL,
        apiKey: 'sk-demo-siliconflow-1111',
        models: [
          makeModel({
            id: 'siliconflow-qwen-72b', provider: 'openai', baseUrl: SILICONFLOW_URL,
            displayName: 'Qwen2.5 72B Instruct（硅基流动）', upstreamModel: 'Qwen/Qwen2.5-72B-Instruct',
            contextWindow: 32768, multimodal: false, enabled: true
          })
        ]
      }
    ];
  }

  function seedUsage() {
    if (scenarioName === 'empty') return {};
    return {
      'deepseek-local': { requests: 43, errors: 1, lastUsedAt: isoAgo(95), lastLatencyMs: 486 },
      'qwen-local': { requests: 0, errors: 0, lastUsedAt: null, lastLatencyMs: null },
      'deepseek-chat': { requests: 52, errors: 3, lastUsedAt: isoAgo(41), lastLatencyMs: 812 },
      'deepseek-reasoner': { requests: 0, errors: 0, lastUsedAt: null, lastLatencyMs: null },
      'siliconflow-qwen-72b': { requests: 33, errors: 0, lastUsedAt: isoAgo(12), lastLatencyMs: 1265 }
    };
  }

  var state = {
    gateway: {
      state: scenarioName === 'stopped' ? 'stopped' : 'running',
      managed: scenarioName !== 'external',
      pid: scenarioName === 'stopped' || scenarioName === 'external' ? 0 : 48212,
      port: 8080,
      url: 'http://127.0.0.1:8080',
      startedAt: scenarioName === 'stopped' ? '' : isoAgo(37 * 60),
      lastError: scenarioName === 'error' ? 'spawn node src\\server.js EADDRINUSE: 端口 8080 已被占用' : ''
    },
    node: { path: 'C:\\Program Files\\nodejs\\node.exe', found: true },
    version: '0.1.0',
    root: ROOT,
    logFile: ROOT + '\\bridge.log',
    accio: scenarioName === 'noaccio' ? Object.assign({}, ACCIO_NONE) : Object.assign({}, ACCIO_CN),
    groups: seedGroups(),
    usage: seedUsage(),
    usageSince: isoAgo(3 * 3600),
    logs: [],
    lastLogAt: Date.now()
  };

  /* ---------- logs ---------- */
  var LOG_SEED = [
    ['info', 'accio-bridge v1.0.0 starting, node v22.14.0 win32 x64'],
    ['debug', 'config loaded: ' + ROOT + '\\config.json (3 providers, 5 models)'],
    ['info', 'listening on 127.0.0.1:8080 (cors enabled, logLevel=debug)'],
    ['error', 'spawn node src\\server.js EADDRINUSE: 端口 8080 已被占用'],
    ['warn', '端口 8080 已被占用，复用已运行的 bridge 进程'],
    ['info', 'accion detect: edition=cn scores={cn:350,global:0} installed=true'],
    ['debug', 'catalog fetch: phoenix-gw.alibaba.com -> 200, 12 models, cached 300s'],
    ['info', 'routing model "deepseek-local" -> ollama ' + OLLAMA_URL],
    ['debug', 'SSE frame flush: 34 bytes, turnComplete=false'],
    ['info', 'generation done: deepseek-local ttft=486ms total=2410ms'],
    ['warn', 'ollama /api/tags latency 1280ms (超过 1000ms 阈值)'],
    ['info', 'routing model "deepseek-chat" -> openai ' + DEEPSEEK_URL],
    ['error', 'generation failed for deepseek-chat: upstream 401 Unauthorized (invalid api key)'],
    ['info', 'provider config saved: ollama ' + OLLAMA_URL + ' (2 models)'],
    ['debug', 'usage counter flush: 5 models, 128 requests'],
    ['info', 'model test ok: deepseek-local, ttft 612ms, 96 chars'],
    ['warn', 'discover scan skipped port 8080 (bridge 自身监听端口)'],
    ['info', 'GET /api/bridge/providers -> 200 (4ms)'],
    ['debug', 'GET /api/bridge/logs?lines=200 -> 200 (2ms)'],
    ['info', 'GET /api/bridge/models -> 200 (3ms)']
  ];

  var LOG_POOL = [
    ['debug', 'GET /api/bridge/status -> 200 (3ms)'],
    ['debug', 'GET /api/bridge/usage -> 200 (1ms)'],
    ['info', 'upstream phoenix-gw.alibaba.com reachable, tls handshake 42ms'],
    ['debug', 'keep-alive ping from 127.0.0.1 (accion 客户端)'],
    ['info', 'routing model "siliconflow-qwen-72b" -> openai ' + SILICONFLOW_URL],
    ['debug', 'converted GenAI request -> OpenAI chat.completions (stream=true)'],
    ['info', 'generation done: siliconflow-qwen-72b ttft=1265ms total=6840ms'],
    ['warn', 'catalog cache expired, refetching in background'],
    ['debug', 'SSE frame flush: 18 bytes, turnComplete=false'],
    ['info', 'healthz ok: models=5 upstream=phoenix-gw.alibaba.com'],
    ['error', 'upstream timeout after 300000ms for model "deepseek-reasoner"，已返回 turnComplete'],
    ['info', 'accion gateway port probe: 4097 listening (未接管)']
  ];

  var logCursor = 0;

  function seedLogs() {
    var now = Date.now();
    var lines = LOG_SEED.map(function (item, index) {
      return {
        ts: new Date(now - (LOG_SEED.length - index) * 4200).toISOString(),
        level: item[0],
        msg: item[1].replace('undefined', '')
      };
    });
    state.logs = lines.slice(-1000);
    state.lastLogAt = now;
  }

  function appendLogs(steps) {
    for (var i = 0; i < steps; i++) {
      var item = LOG_POOL[logCursor % LOG_POOL.length];
      logCursor += 1;
      state.logs.push({
        ts: new Date().toISOString(),
        level: item[0],
        msg: item[1]
      });
      if (state.logs.length > 1000) state.logs.shift();
    }
    state.lastLogAt = Date.now();
  }

  /* the ring buffer grows on wall-clock time, no timers needed */
  function catchUpLogs() {
    var running = state.gateway.state === 'running';
    var everyMs = running ? 2600 : 9000;
    var due = Math.floor((Date.now() - state.lastLogAt) / everyMs);
    if (due <= 0) return;
    appendLogs(Math.min(due, 12));
  }

  function flushLogs() {
    catchUpLogs();
  }

  seedLogs();
  appendLogs(0);

  /* ---------- gateway transitions ---------- */
  var transitionTimer = null;

  function setGateway(next) {
    state.gateway = Object.assign({}, state.gateway, next);
  }

  function scheduleSettle(nextState, delayMs, patch) {
    if (transitionTimer) window.clearTimeout(transitionTimer);
    transitionTimer = window.setTimeout(function () {
      transitionTimer = null;
      var next = Object.assign({}, state.gateway, patch || {}, { state: nextState });
      if (nextState === 'running') {
        next.startedAt = new Date().toISOString();
        if (!next.pid) next.pid = 48212;
        next.lastError = '';
      }
      if (nextState === 'stopped') {
        next.pid = 0;
        next.startedAt = '';
      }
      state.gateway = next;
      state.logs.push({
        ts: new Date().toISOString(),
        level: nextState === 'running' ? 'info' : 'warn',
        msg: nextState === 'running'
          ? 'gateway started: node src\\server.js (pid ' + next.pid + ', port ' + next.port + ')'
          : 'gateway stopped: 端口 ' + next.port + ' 已释放'
      });
    }, delayMs);
  }

  /* ---------- providers view of the world ---------- */
  function groupKey(group) {
    return group.provider + '|' + group.baseUrl + '|' + group.apiKey;
  }

  function groupId(group) {
    return 'p_' + shortHash(groupKey(group));
  }

  function providerDisplayName(group) {
    var host = hostOf(group.baseUrl);
    var known = {
      'api.deepseek.com': 'DeepSeek',
      'api.openai.com': 'OpenAI',
      'openrouter.ai': 'OpenRouter',
      'api.siliconflow.cn': '硅基流动',
      'dashscope.aliyuncs.com': '通义千问（DashScope）',
      'api.moonshot.cn': 'Moonshot',
      'open.bigmodel.cn': '智谱 GLM'
    };
    if (group.provider === 'ollama') return 'Ollama';
    if (known[host]) return known[host];
    if (isLocalUrl(group.baseUrl)) return '本机 OpenAI 兼容服务';
    return host || 'OpenAI 兼容服务';
  }

  function publicModel(model) {
    var copy = Object.assign({}, model);
    copy.apiKey = maskKey(model.apiKey);
    return copy;
  }

  function publicGroup(group) {
    var models = group.models.map(function (model) {
      var out = publicModel(model);
      out.usage = state.usage[model.id] || { requests: 0, errors: 0, lastUsedAt: null, lastLatencyMs: null };
      return out;
    });
    return {
      id: groupId(group),
      provider: group.provider,
      name: providerDisplayName(group),
      baseUrl: group.baseUrl,
      apiKeyMasked: maskKey(group.apiKey),
      hasKey: !!group.apiKey,
      local: isLocalUrl(group.baseUrl),
      enabled: models.some(function (m) { return m.enabled; }),
      modelCount: models.length,
      enabledCount: models.filter(function (m) { return m.enabled; }).length,
      models: models
    };
  }

  function allGroups() {
    return state.groups.map(publicGroup);
  }

  function allModels() {
    var out = [];
    state.groups.forEach(function (group) {
      group.models.forEach(function (model) { out.push(publicModel(model)); });
    });
    return out;
  }

  function findGroupByModelId(id) {
    for (var i = 0; i < state.groups.length; i++) {
      var group = state.groups[i];
      for (var j = 0; j < group.models.length; j++) {
        if (group.models[j].id === id) return { group: group, model: group.models[j] };
      }
    }
    return null;
  }

  function findGroupById(id) {
    for (var i = 0; i < state.groups.length; i++) {
      if (groupId(state.groups[i]) === id) return state.groups[i];
    }
    return null;
  }

  /* ---------- discovery fixtures ---------- */
  function discoverServices() {
    var addedIds = state.groups.reduce(function (acc, group) {
      group.models.forEach(function (model) { acc.push(model.id); });
      return acc;
    }, []);
    function added(list) {
      return list.filter(function (id) { return addedIds.indexOf(id) >= 0; });
    }
    return [
      {
        id: 'ollama@127.0.0.1:11434',
        kind: 'ollama',
        name: 'Ollama',
        provider: 'ollama',
        host: '127.0.0.1',
        port: 11434,
        baseUrl: OLLAMA_URL,
        models: ['deepseek-r1:14b', 'qwen2.5:7b-instruct', 'llama3.2:3b'],
        alreadyAdded: added(['deepseek-r1:14b', 'qwen2.5:7b-instruct']),
        latencyMs: 8
      },
      {
        id: 'lmstudio@127.0.0.1:1234',
        kind: 'lmstudio',
        name: 'LM Studio',
        provider: 'openai',
        host: '127.0.0.1',
        port: 1234,
        baseUrl: 'http://127.0.0.1:1234/v1',
        models: ['qwen2.5-coder-7b-instruct'],
        alreadyAdded: [],
        latencyMs: 15
      },
      {
        id: 'localai@127.0.0.1:8081',
        kind: 'localai',
        name: 'LocalAI',
        provider: 'openai',
        host: '127.0.0.1',
        port: 8081,
        baseUrl: 'http://127.0.0.1:8081/v1',
        models: ['llama-3.2-3b-instruct', 'nomic-embed-text'],
        alreadyAdded: [],
        latencyMs: 23
      }
    ];
  }

  var REMOTE_CATALOG = {
    'https://api.deepseek.com/v1': ['deepseek-chat', 'deepseek-reasoner'],
    'https://api.siliconflow.cn/v1': ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'BAAI/bge-m3'],
    'https://dashscope.aliyuncs.com/compatible-mode/v1': ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    'https://api.moonshot.cn/v1': ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'],
    'https://open.bigmodel.cn/api/paas/v4': ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    'https://api.openai.com/v1': ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    'https://openrouter.ai/api/v1': [
      'anthropic/claude-3.7-sonnet',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.3-70b-instruct'
    ],
    'http://127.0.0.1:11434': ['llama3.2:3b', 'qwen2.5:7b-instruct', 'deepseek-r1:14b'],
    'http://127.0.0.1:1234/v1': ['qwen2.5-coder-7b-instruct', 'deepseek-r1-distill-qwen-7b'],
    'http://127.0.0.1:8081/v1': ['llama-3.2-3b-instruct']
  };

  function normalizeUrl(url) {
    var text = String(url || '').trim().replace(/\/+$/, '');
    return text.replace(/^http:\/\/localhost/, 'http://127.0.0.1');
  }

  /* ---------- model test stream ---------- */
  var ANSWER_LOCAL = '我是由 Ollama 在 127.0.0.1:11434 提供的 deepseek-r1:14b 本地模型。' +
    '这次请求由 Accio Bridge 网关完成协议转换后转发，推理全程在本机完成，没有经过云端。';
  var ANSWER_CLOUD = '你好，我是通过硅基流动 OpenAI 兼容接口调用的 Qwen2.5-72B-Instruct。' +
    '网关已完成 GenAI ↔ chat.completions 的请求与流式响应转换，你可以继续提问。';

  function chunkText(text) {
    var chunks = [];
    var index = 0;
    while (index < text.length) {
      var size = 2 + Math.floor(Math.random() * 3);
      chunks.push(text.slice(index, index + size));
      index += size;
    }
    return chunks;
  }

  function abortError() {
    var err = new Error('aborted');
    err.name = 'AbortError';
    return err;
  }

  /**
   * Emits GenAI-shaped frames progressively.
   * options: { signal, onFrame(frame) } -> Promise<frames[]>
   */
  function testStream(body, options) {
    options = options || {};
    var signal = options.signal;
    var frames = [];
    var model = findGroupByModelId(body.model);

    function push(frame) {
      frames.push(frame);
      if (options.onFrame) options.onFrame(frame);
    }

    if (!model) {
      return Promise.resolve().then(function () {
        push({
          error: { code: 404, message: 'model "' + body.model + '" not found（演示数据）', status: 'NOT_FOUND' },
          turnComplete: true
        });
        return frames;
      });
    }

    var isLocal = model.group.provider === 'ollama';
    var host = hostOf(model.group.baseUrl);

    return new Promise(function (resolve, reject) {
      var timer = null;
      function stop() {
        if (timer) { window.clearTimeout(timer); timer = null; }
      }
      function check() {
        if (signal && signal.aborted) {
          stop();
          reject(abortError());
          return true;
        }
        return false;
      }

      /* 演示数据：deepseek.com 上的供应商用的是占位 Key，这里模拟上游拒绝 */
      if (!isLocal && host === 'api.deepseek.com') {
        timer = window.setTimeout(function () {
          if (check()) return;
          push({
            error: {
              code: 401,
              message: '401 Unauthorized：DeepSeek 拒绝了请求，请检查 API Key（演示数据，非真实请求）。',
              status: 'UNAUTHENTICATED'
            },
            turnComplete: true
          });
          resolve(frames);
        }, 700);
        return;
      }

      var text = isLocal ? ANSWER_LOCAL : ANSWER_CLOUD;
      var chunks = chunkText(text);
      var cursor = 0;

      function step() {
        if (check()) return;
        if (cursor >= chunks.length) {
          push({
            content: { role: 'model', parts: [] },
            turnComplete: true,
            finishReason: 'STOP',
            usageMetadata: {
              promptTokenCount: Math.max(8, Math.round((body.prompt || '').length * 0.8)),
              candidatesTokenCount: Math.round(text.length * 0.75),
              totalTokenCount: Math.round(text.length * 0.75 + 12)
            }
          });
          resolve(frames);
          return;
        }
        var chunk = chunks[cursor];
        cursor += 1;
        push({
          content: { role: 'model', parts: [{ text: chunk }] },
          turnComplete: false
        });
        var delay = cursor === 1 ? 320 : 38 + Math.floor(Math.random() * 45);
        timer = window.setTimeout(step, delay);
      }

      timer = window.setTimeout(step, 260);
    });
  }

  /* ---------- request router ---------- */
  function json(status, payload) {
    return { status: status, json: payload };
  }

  function hostStatePayload() {
    return {
      ok: true,
      version: state.version,
      root: state.root,
      gateway: Object.assign({}, state.gateway),
      node: Object.assign({}, state.node),
      logFile: state.logFile
    };
  }

  function latencyFor(path, method) {
    if (path === '/api/bridge/discover' || path === '/api/bridge/discover/models') return 320 + Math.random() * 240;
    if (path === '/api/bridge/logs') return 12;
    return 35 + Math.random() * 60;
  }

  function route(request) {
    var method = request.method;
    var path = request.path;
    var query = new URLSearchParams(request.query || '');
    var body = request.body || {};

    catchUpLogs();

    /* --- /host/* --- */
    if (path === '/host/state') {
      if (scenarioName === 'error') {
        return json(500, { ok: false, error: '宿主服务内部错误：无法读取网关状态（演示场景 error）' });
      }
      return json(200, hostStatePayload());
    }
    if (path === '/host/gateway/start') {
      if (scenarioName === 'error') {
        return json(500, { ok: false, error: '宿主服务内部错误：启动网关失败（演示场景 error）' });
      }
      if (state.gateway.state === 'running') return json(200, hostStatePayload());
      setGateway({ state: 'starting', lastError: '' });
      scheduleSettle('running', 1400, {});
      return json(200, hostStatePayload());
    }
    if (path === '/host/gateway/stop') {
      if (state.gateway.managed === false) {
        return json(400, Object.assign({ ok: false, error: 'gateway is not managed by this app' }, hostStatePayload()));
      }
      if (state.gateway.state === 'stopped') return json(200, hostStatePayload());
      setGateway({ state: 'stopping' });
      scheduleSettle('stopped', 900, {});
      return json(200, hostStatePayload());
    }
    if (path === '/host/gateway/restart') {
      if (state.gateway.managed === false) {
        return json(400, Object.assign({ ok: false, error: 'gateway is not managed by this app' }, hostStatePayload()));
      }
      setGateway({ state: 'starting', lastError: '' });
      scheduleSettle('running', 1800, {});
      return json(200, hostStatePayload());
    }
    if (path === '/host/window/hide') return json(200, { ok: true });
    if (path === '/host/app/quit') return json(200, { ok: true });
    if (path === '/host/open') return json(200, { ok: true });

    /* --- bridge endpoints: real failures for the error / stopped scenarios --- */
    if (path.indexOf('/api/bridge/') === 0) {
      if (scenarioName === 'error') {
        return json(500, {
          ok: false,
          error: '网关内部错误：Node bridge 请求处理失败（演示场景 error）'
        });
      }
      if (state.gateway.state !== 'running') {
        return json(503, { ok: false, error: 'gateway is not running', gatewayDown: true });
      }
    }

    if (path === '/api/bridge/status') {
      var models = allModels();
      return json(200, {
        ok: true,
        status: 'running',
        version: '1.0.0',
        server: { host: '127.0.0.1', port: state.gateway.port, logLevel: 'debug' },
        upstream: 'https://phoenix-gw.alibaba.com',
        modelsCount: models.length,
        activeModelsCount: models.filter(function (m) { return m.enabled; }).length,
        models: models
      });
    }

    if (path === '/api/bridge/accio') {
      if (query.get('force') === 'true') {
        state.accio.evidence = state.accio.evidence.slice();
      }
      return json(200, {
        ok: true,
        accio: Object.assign({}, state.accio),
        bridgeGatewayUrl: 'http://127.0.0.1:' + state.gateway.port
      });
    }

    if (path === '/api/bridge/accio/launch') {
      var accio = state.accio;
      if (!accio.installed || !accio.path) {
        return json(404, { ok: false, error: 'Accio Work 客户端未安装，或在标准路径中未找到可执行文件。请先下载安装。' });
      }
      var force = body.force === true || query.get('force') === 'true';
      if (accio.edition !== 'cn' && !force) {
        return json(400, {
          ok: false,
          error: '当前检测到的客户端为【' + accio.editionLabel + '】，非 Accio Work 中国版。如需强行接管，请传入 force: true。',
          edition: accio.edition,
          editionLabel: accio.editionLabel,
          needsForce: true
        });
      }
      if (accio.running && !force) {
        return json(409, {
          ok: false,
          error: '检测到 Accio Work 正在运行，重启并接管会终止当前进程。确认后可强制接管。',
          needsForce: true,
          runningPids: accio.runningPids
        });
      }
      state.accio = Object.assign({}, accio, {
        running: true,
        runningPids: [17812, 17840],
        gatewayPort: state.gateway.port,
        signedIn: accio.signedIn
      });
      state.logs.push({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'accion launched: pid 17812 GATEWAY_BASE_URL=http://127.0.0.1:' + state.gateway.port
      });
      return json(200, {
        ok: true,
        launched: true,
        pid: 17812,
        gatewayBaseUrl: 'http://127.0.0.1:' + state.gateway.port,
        edition: state.accio.edition,
        editionLabel: state.accio.editionLabel,
        path: state.accio.path
      });
    }

    if (path === '/api/bridge/providers') {
      if (method === 'GET') return json(200, { ok: true, providers: allGroups() });

      if (method === 'POST') {
        var provider = String(body.provider || '').trim();
        var baseUrl = String(body.baseUrl || '').trim();
        if (provider !== 'ollama' && provider !== 'openai') {
          return json(400, { ok: false, error: 'provider 必须是 ollama 或 openai' });
        }
        if (!/^https?:\/\//i.test(baseUrl)) {
          return json(400, { ok: false, error: 'baseUrl 必须以 http:// 或 https:// 开头' });
        }
        if (!Array.isArray(body.models) || !body.models.length) {
          return json(400, { ok: false, error: '至少需要一个模型' });
        }
        var apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
        var target = null;
        for (var i = 0; i < state.groups.length; i++) {
          if (groupKey(state.groups[i]) === provider + '|' + baseUrl + '|' + apiKey) {
            target = state.groups[i];
            break;
          }
        }
        if (!target) {
          target = { provider: provider, baseUrl: baseUrl, apiKey: apiKey, models: [] };
          state.groups.push(target);
        }
        body.models.forEach(function (item) {
          var id = String(item.id || '').trim();
          if (!id) return;
          var existing = null;
          for (var k = 0; k < target.models.length; k++) {
            if (target.models[k].id === id) { existing = target.models[k]; break; }
          }
          var next = makeModel({
            id: id,
            provider: provider,
            baseUrl: baseUrl,
            apiKey: apiKey,
            displayName: item.displayName || id,
            upstreamModel: item.upstreamModel || id,
            contextWindow: Number(item.contextWindow) || 0,
            multimodal: !!item.multimodal
          });
          if (existing) {
            next.isDefault = existing.isDefault;
            var at = target.models.indexOf(existing);
            target.models[at] = Object.assign(next, { apiKey: apiKey });
          } else {
            target.models.push(next);
          }
          if (!state.usage[id]) {
            state.usage[id] = { requests: 0, errors: 0, lastUsedAt: null, lastLatencyMs: null };
          }
        });
        return json(200, { ok: true, provider: publicGroup(target), providers: allGroups() });
      }
    }

    /* v1.1：POST /api/bridge/providers/:id/models（必须先于通用 /providers/:id 分支匹配） */
    if (method === 'POST' && path.indexOf('/api/bridge/providers/') === 0 && path.slice(-7) === '/models') {
      var appendId = decodeURIComponent(path.slice('/api/bridge/providers/'.length, path.length - 7));
      var appendGroup = findGroupById(appendId);
      if (!appendGroup) return json(404, { ok: false, error: 'provider not found' });
      var incoming = Array.isArray(body.models) ? body.models : [];
      if (!incoming.length) return json(400, { ok: false, error: '至少需要一个模型' });
      incoming.forEach(function (item) {
        var newId = String(item.id || '').trim();
        if (!newId) return;
        var hit = null;
        for (var k = 0; k < appendGroup.models.length; k++) {
          if (appendGroup.models[k].id === newId) { hit = appendGroup.models[k]; break; }
        }
        /* 复用该组的 provider/baseUrl/apiKey，UI 不需要明文 key */
        var fresh = makeModel({
          id: newId,
          provider: appendGroup.provider,
          baseUrl: appendGroup.baseUrl,
          apiKey: appendGroup.apiKey,
          displayName: item.displayName || newId,
          upstreamModel: item.upstreamModel || newId,
          contextWindow: Number(item.contextWindow) || 0,
          multimodal: !!item.multimodal
        });
        if (hit) {
          fresh.isDefault = hit.isDefault;
          appendGroup.models[appendGroup.models.indexOf(hit)] = fresh;
        } else {
          appendGroup.models.push(fresh);
        }
        if (!state.usage[newId]) {
          state.usage[newId] = { requests: 0, errors: 0, lastUsedAt: null, lastLatencyMs: null };
        }
      });
      state.logs.push({
        ts: new Date().toISOString(),
        level: 'info',
        msg: 'provider models appended: ' + appendGroup.baseUrl + ' (+' + incoming.length + ' models)'
      });
      return json(200, { ok: true, provider: publicGroup(appendGroup), providers: allGroups() });
    }

    if (path.indexOf('/api/bridge/providers/') === 0) {
      var id = decodeURIComponent(path.slice('/api/bridge/providers/'.length));
      var group = findGroupById(id);
      if (!group) return json(404, { ok: false, error: 'provider not found' });

      if (method === 'PATCH') {
        if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
          group.models.forEach(function (model) { model.enabled = body.enabled !== false; });
        }
        if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
          var nextBase = body.baseUrl.trim();
          if (!/^https?:\/\//i.test(nextBase)) {
            return json(400, { ok: false, error: 'baseUrl 必须以 http:// 或 https:// 开头' });
          }
          group.baseUrl = nextBase;
          group.models.forEach(function (model) { model.baseUrl = nextBase; });
        }
        if (typeof body.apiKey === 'string' && body.apiKey.length) {
          group.apiKey = body.apiKey;
          group.models.forEach(function (model) { model.apiKey = body.apiKey; });
        }
        return json(200, { ok: true, provider: publicGroup(group), providers: allGroups() });
      }

      if (method === 'DELETE') {
        var deleted = group.models.map(function (model) { return model.id; });
        state.groups = state.groups.filter(function (item) { return item !== group; });
        state.logs.push({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: 'provider removed: ' + group.provider + ' ' + group.baseUrl + ' (' + deleted.length + ' models)'
        });
        return json(200, { ok: true, deleted: deleted, providers: allGroups() });
      }
    }

    if (path === '/api/bridge/models') {
      if (method === 'GET') return json(200, { ok: true, models: allModels() });
    }

    if (path.indexOf('/api/bridge/models/') === 0) {
      var modelId = decodeURIComponent(path.slice('/api/bridge/models/'.length));
      var found = findGroupByModelId(modelId);
      if (!found) return json(404, { ok: false, error: 'model not found' });
      if (method === 'PATCH') {
        var model = found.model;
        ['enabled', 'visible', 'multimodal', 'stream'].forEach(function (key) {
          if (Object.prototype.hasOwnProperty.call(body, key)) model[key] = !!body[key];
        });
        ['displayName', 'upstreamModel'].forEach(function (key) {
          if (typeof body[key] === 'string' && body[key].trim()) model[key] = body[key].trim();
        });
        if (Object.prototype.hasOwnProperty.call(body, 'contextWindow')) {
          var cw = Number(body.contextWindow);
          if (!isNaN(cw) && cw > 0) model.contextWindow = Math.round(cw);
        }
        if (body.isDefault === true) {
          state.groups.forEach(function (item) {
            item.models.forEach(function (item2) { item2.isDefault = item2.id === model.id; });
          });
        } else if (body.isDefault === false) {
          model.isDefault = false;
        }
        /* locked / freeUse 由后端强制，这里同样忽略 */
        return json(200, { ok: true, model: publicModel(model), providers: allGroups() });
      }
    }

    if (path === '/api/bridge/usage') {
      return json(200, { ok: true, usage: state.usage, since: state.usageSince });
    }

    if (path === '/api/bridge/logs') {
      var lines = Number(query.get('lines')) || 200;
      var level = query.get('level') || '';
      var weight = { debug: 10, info: 20, warn: 30, error: 40 };
      var filtered = state.logs.filter(function (line) {
        return !level || (weight[line.level] || 20) >= (weight[level] || 0);
      });
      var slice = filtered.slice(-Math.min(lines, 1000));
      return json(200, { ok: true, lines: slice, total: filtered.length });
    }

    if (path === '/api/bridge/discover') {
      return json(200, {
        ok: true,
        cached: query.get('force') !== 'true',
        scannedAt: new Date().toISOString(),
        services: discoverServices()
      });
    }

    if (path === '/api/bridge/discover/models') {
      /* v1.1：只给 providerId 时，按已有分组取 provider/baseUrl/apiKey */
      if (body.providerId) {
        var byIdGroup = findGroupById(String(body.providerId));
        if (!byIdGroup) {
          return json(200, { ok: false, error: 'provider not found：' + body.providerId + '（演示数据）', models: [] });
        }
        var byIdBase = normalizeUrl(byIdGroup.baseUrl);
        var byIdCatalog = REMOTE_CATALOG[byIdBase] || null;
        if (!byIdCatalog) {
          return json(200, {
            ok: false,
            error: isLocalUrl(byIdBase)
              ? 'connect ECONNREFUSED ' + byIdBase + '（演示数据）'
              : '上游未返回模型列表（HTTP 404，演示数据）',
            models: []
          });
        }
        return json(200, { ok: true, models: byIdCatalog.slice() });
      }
      var baseUrl = normalizeUrl(body.baseUrl);
      var key = normalizeUrl(REMOTE_CATALOG[baseUrl] ? baseUrl : '');
      var catalog = key ? REMOTE_CATALOG[key] : null;
      if (!catalog) {
        if (isLocalUrl(baseUrl)) {
          var hostPort = '';
          try { hostPort = new URL(baseUrl).host; } catch (e) { hostPort = baseUrl; }
          return json(200, {
            ok: false,
            error: 'connect ECONNREFUSED ' + hostPort + '（演示数据：该地址未在探测结果中）',
            models: []
          });
        }
        if (!body.apiKey) {
          return json(200, { ok: false, error: '401 Unauthorized：该服务需要 API Key', models: [] });
        }
        return json(200, { ok: false, error: '上游未返回模型列表（HTTP 404，演示数据）', models: [] });
      }
      return json(200, { ok: true, models: catalog.slice() });
    }

    if (path === '/healthz') {
      return json(200, { ok: true, upstream: 'https://phoenix-gw.alibaba.com', models: allModels().map(function (m) { return m.id; }) });
    }

    return json(404, { ok: false, error: 'not found: ' + path });
  }

  function handle(request) {
    return new Promise(function (resolve) {
      window.setTimeout(function () {
        var result;
        try {
          result = route(request);
        } catch (err) {
          result = json(500, { ok: false, error: 'mock 内部错误：' + (err && err.message) });
        }
        resolve(result);
      }, latencyFor(request.path, request.method));
    });
  }

  AB.mock = {
    enabled: enabled,
    scenario: scenario,
    handle: handle,
    testStream: testStream,
    flushLogs: flushLogs,
    /* exposed for the preview harness only */
    _state: state
  };
})(window.AB);