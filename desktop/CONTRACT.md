# Accio Bridge Desktop — 共享接口契约 (v1)

本文件是 Go 宿主 (A)、UI (B)、Node 后端 (C) 之间唯一的接口来源。任何一方不得单方面改动形状。
所有 JSON 响应都包含 `ok: boolean`；失败时 `ok:false` 且带 `error: string`（现有路由的错误体同样含 `error`）。

## 1. 架构

```
accio-desktop.exe (Go + go-webview2, CGO_ENABLED=0, -H windowsgui)
 ├─ WebView2 原生窗口，加载 http://127.0.0.1:<随机端口>/?token=<hostToken>
 ├─ 系统托盘 (显示窗口 / 启动网关 / 停止网关 / 启动 Accio / 退出)
 ├─ 本地 HTTP 服务 (仅回环)
 │   ├─ /                 go:embed 的 desktop/ui/ 静态文件
 │   ├─ /host/*           宿主接口，要求 X-Host-Token
 │   ├─ /api/bridge/*     反向代理到 Node bridge (支持流式 flush)
 │   └─ /healthz          反向代理到 Node bridge
 └─ 网关监管: 复用已有 bridge 或隐藏启动 `node src/server.js`
```

## 2. 宿主接口 /host/* (Agent A 实现，Agent B 调用)

请求头必须带 `X-Host-Token: <token>`，否则返回 401 `{ok:false,error:"unauthorized"}`。
UI 从页面 URL 查询参数 `token` 读取，或读 `window.__HOST__.token`（A 通过 `Init` 注入，优先）。

`window.__HOST__ = { token: string, version: string, isDesktop: true }`

### GET /host/state
```json
{
  "ok": true,
  "version": "0.1.0",
  "root": "C:\\...\\accio-gateway-bridge",
  "gateway": {
    "state": "stopped | starting | running | stopping | error",
    "managed": true,
    "pid": 1234,
    "port": 8080,
    "url": "http://127.0.0.1:8080",
    "startedAt": "2026-01-01T00:00:00Z",
    "lastError": ""
  },
  "node": { "path": "C:\\...\\node.exe", "found": true },
  "logFile": "C:\\...\\bridge.log"
}
```
`managed=false` 表示复用了外部已运行的 bridge（宿主不会杀掉它）。`pid` 未知时为 0。

### POST /host/gateway/start | /host/gateway/stop | /host/gateway/restart
无请求体。返回与 `/host/state` 相同的形状。
stop 只杀宿主自己启动的进程；`managed=false` 时 stop 返回 `{ok:false,error:"gateway is not managed by this app", ...state}`。

### POST /host/window/hide
隐藏窗口到托盘。返回 `{ok:true}`。

### POST /host/app/quit
退出程序（停止受管网关）。返回 `{ok:true}`。

### POST /host/open
请求体 `{ "target": "logs" | "config" | "root" }`，用资源管理器/默认程序打开对应路径。返回 `{ok:true}`。

## 3. 现有 Node 路由 (已存在，形状不可破坏)

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | /healthz | - | `{ok, upstream, models: string[]}` |
| GET | /api/bridge/status | - | `{ok, status:"running", version, server:{host,port,logLevel}, upstream, modelsCount, activeModelsCount, models: Model[]}` |
| GET | /api/bridge/accio[?force=true] | - | `{ok, accio: AccioInfo, bridgeGatewayUrl}` |
| POST | /api/bridge/accio/launch | `{force?:bool, customExePath?:string}` | 200 `{ok, launched, pid, gatewayBaseUrl, edition, editionLabel, path}`；400/409 `{ok:false, error, needsForce:true, ...}`；404 未安装 |
| GET | /api/bridge/models | - | `{ok, models: Model[]}` |
| POST | /api/bridge/models | Model 字段 (id 必填，upsert) | `{ok, success, model, models}` |
| DELETE | /api/bridge/models?id=X | - | `{ok, success, deleted, models}` |
| POST | /api/bridge/test | `{model, prompt?, temperature?}` | 走 handleGenerate，**流式 SSE 或 JSON** |

`AccioInfo`: `{installed, edition:"cn|global|unknown|none", editionLabel, path, version, evidence:[{source,field,value,description,targetEdition,weight}], running, runningPids:number[], gatewayPort, signedIn, accountCount, scores:{cn,global}}`

`Model`: `{id, modelCode, displayName, provider, baseUrl, upstreamModel, apiKey, contextWindow, multimodal, stream, enabled, visible, isDefault, freeUse, locked, usageLevel, aliases:string[]}`

硬性规则：自定义模型必须保持 `locked:false`、`freeUse:true`。

## 4. 新增 Node 路由 (Agent C 实现，Agent B 调用)

### GET /api/bridge/providers
把 `config.models` 按 `provider + baseUrl + apiKey` 分组。
```json
{
  "ok": true,
  "providers": [
    {
      "id": "p_1a2b3c4d",
      "provider": "ollama",
      "name": "Ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "apiKeyMasked": "sk-a…wxyz",
      "hasKey": true,
      "local": true,
      "enabled": true,
      "modelCount": 2,
      "enabledCount": 1,
      "models": [ { "...Model 字段，但 apiKey 被替换为掩码...": true,
                    "usage": { "requests": 0, "errors": 0, "lastUsedAt": null, "lastLatencyMs": null } } ]
    }
  ]
}
```
- `id` = `"p_" + sha1(provider|baseUrl|apiKey)` 前 8 位十六进制，按配置稳定。
- `apiKeyMasked`：空 key 为 `""`；长度 ≤8 全部显示为 `"••••"`；否则前 4 位 + `…` + 后 4 位。
- `local`：baseUrl 主机是 127.0.0.1 / localhost / ::1。
- `enabled`：组内至少一个模型启用。
- 此接口绝不能返回明文 key。

### POST /api/bridge/providers
新增供应商及其模型。
请求：
```json
{
  "provider": "openai",
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-xxx",
  "models": [
    { "id": "deepseek-chat", "upstreamModel": "deepseek-chat", "displayName": "DeepSeek Chat",
      "contextWindow": 64000, "multimodal": false }
  ]
}
```
- `provider` 必须是 `ollama` 或 `openai`（所有 OpenAI 兼容服务都用 `openai`），否则 400。
- `models` 非空，否则 400；`id` 冲突时覆盖已有模型（upsert），但已有模型的 `isDefault` 保留。
- `upstreamModel` 缺省取 `id`，`displayName` 缺省取 `id`，`modelCode` 取 `id`。
- 始终写入 `locked:false, freeUse:true, enabled:true, visible:true`。
- 响应：`{ok:true, provider: <分组对象>, providers: [...]}`。

### PATCH /api/bridge/providers/:id
请求（字段均可选）：`{ "enabled": bool, "baseUrl": string, "apiKey": string }`
- `enabled` 作用于组内全部模型；`baseUrl`/`apiKey` 改写组内全部模型（因此分组 id 可能变化）。
- 响应：`{ok:true, provider: <新分组对象>, providers: [...]}`；未找到 404。

### DELETE /api/bridge/providers/:id
删除组内全部模型。响应：`{ok:true, deleted: string[], providers: [...]}`；未找到 404。

### POST /api/bridge/providers/:id/models  (v1.1)
向已有分组追加模型，服务端复用该组的 provider/baseUrl/apiKey（UI 无需也拿不到明文 key）。
请求 `{ "models": [ {id, upstreamModel?, displayName?, contextWindow?, multimodal?} ] }`，校验同 POST /api/bridge/providers。
响应 `{ok:true, provider: <分组对象>, providers: [...]}`；分组不存在 404；models 为空 400。

### PATCH /api/bridge/models/:id
请求（字段均可选）：`{ enabled, visible, isDefault, displayName, upstreamModel, contextWindow, multimodal, stream }`
- `isDefault:true` 时清除其它模型的默认标记。
- 不接受修改 `locked`/`freeUse`（忽略这两个字段）。
- 响应：`{ok:true, model: <掩码后的模型>, providers: [...]}`；未找到 404。

### GET /api/bridge/discover[?force=true]
扫描本机推理服务，10 秒缓存。
```json
{
  "ok": true,
  "cached": false,
  "scannedAt": "2026-01-01T00:00:00.000Z",
  "services": [
    {
      "id": "ollama@127.0.0.1:11434",
      "kind": "ollama",
      "name": "Ollama",
      "provider": "ollama",
      "host": "127.0.0.1",
      "port": 11434,
      "baseUrl": "http://127.0.0.1:11434",
      "models": ["deepseek-r1:14b"],
      "alreadyAdded": ["deepseek-r1:14b"],
      "latencyMs": 12
    }
  ]
}
```
探测表：Ollama `/api/tags` :11434；LM Studio `/v1/models` :1234；vLLM `/v1/models` :8000；llama.cpp `/v1/models` :8080；KoboldCpp `/api/v1/model` :5001；LocalAI `/v1/models` :8081；Jan `/v1/models` :1337；TextGen WebUI `/v1/models` :5000。额外端口 11435/1235/8001/8082/5002/1338 用 `/v1/models` 探测。
必须跳过 bridge 自身监听端口。除 ollama 外 `provider` 都是 `openai`，`baseUrl` 带 `/v1`（KoboldCpp 用 `http://host:port/v1`）。

### POST /api/bridge/discover/models
请求 `{provider, baseUrl, apiKey?}` 或 `{providerId}`（v1.1：按已有分组取 provider/baseUrl/apiKey，用于已保存 key 的云端供应商）。列出远端可用模型。
`providerId` 不存在时返回 `{ok:false, error, models:[]}`（HTTP 200）。
响应 `{ok:true, models: string[]}`；连不上 `{ok:false, error, models:[]}`（HTTP 200，便于 UI 展示）。

### GET /api/bridge/logs?lines=200&level=info
响应：
```json
{ "ok": true, "lines": [ { "ts": "2026-01-01T00:00:00.000Z", "level": "info", "msg": "..." } ], "total": 200 }
```
来源是进程内环形缓冲（容量 1000，由 makeLogger 写入）。`level` 过滤出该级别及以上（debug<info<warn<error），缺省不过滤。`lines` 缺省 200，上限 1000。日志消息不得包含明文 API key。

### GET /api/bridge/usage
响应 `{ok:true, usage: { "<modelId>": {requests, errors, lastUsedAt, lastLatencyMs} }, since: "<ISO>"}`。
内存计数，进程重启清零。

## 5. 模型测试的响应解析 (Agent B)

`POST /api/bridge/test` 可能返回 `text/event-stream`（每帧 `data: {...}`）或 JSON。两者的 JSON 结构都是 GenAI 形状：文本在 `candidates[0].content.parts[*].text`，错误在 `error.message`（或顶层 `error`）。UI 需要逐帧累加文本，并显示 TTFT 和总耗时。

## 6. 文件归属 (严格，不得越界)

| 代理 | 可写 | 禁止 |
|---|---|---|
| A Go 宿主+托盘 | `desktop/` 下除 `desktop/ui/` 和本文件外的所有文件；可创建 `desktop/ui/.gitkeep` | `src/`、`bin/`、`tests/`、`package.json`、`config.json`、`desktop/ui/*` |
| B UI | 仅 `desktop/ui/` | 其它全部 |
| C Node 后端 | `src/discovery.js`、`src/server.js`、`tests/test-providers.js`、`package.json` | `desktop/`、`config.json`、`bin/`、`src/cli/` |

本文件 (`desktop/CONTRACT.md`) 只读。

## 7. 通用约束

- 不得占用 8080 或杀掉用户正在运行的 gateway；测试用随机端口和临时配置 (`ACCIO_BRIDGE_CONFIG` 环境变量)。
- 不得修改真实 `config.json`。
- 不得启动真实 Accio.exe。
- 始终使用绝对路径写文件。项目根：`C:\Users\lin\Downloads\exe-reverse\accio-gateway-bridge`。
- 界面文案使用简体中文。
