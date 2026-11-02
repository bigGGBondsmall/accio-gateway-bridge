# Accio Gateway Bridge

> **Local Gateway Bridge for Accio Work Desktop**: Route LLM traffic to local models (Ollama, LM Studio, vLLM) and OpenAI-compatible APIs while seamlessly proxying official Alibaba gateway services.

---

## Overview

**Accio Gateway Bridge** is a local reverse proxy and protocol translation gateway running at `http://127.0.0.1:8080`. By starting Accio Work Desktop with `GATEWAY_BASE_URL=http://127.0.0.1:8080`, you can use any local or private AI model (such as DeepSeek R1, Qwen 2.5 Coder, Llama 3) directly inside the Accio Desktop interface.

### Key Highlights
- **Zero Runtime Dependencies**: Written entirely in modern Node.js using native `node:http`, `node:https`, and global `fetch` (Node 18+).
- **Accio GenAI Protocol Translation**: Converts Accio's native GenAI streaming format to OpenAI chat completions SSE and Ollama NDJSON bi-directionally.
- **Full Client Compatibility**: Merges custom models into the official catalogue with `locked: false` and `freeUse: true` so all custom models are immediately unlocked and usable.
- **Transparent Official Passthrough**: Telemetry, login, account entitlement, tools, skills, and official Alibaba models (`qwen-max`, `qwen-plus`) are forwarded transparently to `https://phoenix-gw.alibaba.com`.
- **Web Management Dashboard & Live Playground**: Built-in modern web UI for adding/editing models and live testing streaming completions before launching Accio.
- **1-Click Windows Launchers**: Batch and PowerShell scripts for starting the bridge and launching Accio in one click.

---

## Architecture Diagram

```
┌────────────────────────────────────────────────────────┐
│               Accio Work Desktop Client                │
│       (%LOCALAPPDATA%\Programs\Accio\Accio.exe)        │
└───────────────────────────┬────────────────────────────┘
                            │
               GATEWAY_BASE_URL=http://127.0.0.1:8080
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│             Accio Gateway Bridge (:8080)               │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Web Dashboard & Live Playground (/dashboard, /)  │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Catalog Merger (/api/llm/config/v2)              │  │
│  │ - Custom models injected (locked=false, freeUse) │  │
│  │ - Official models fetched & cached               │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Generation Router (/api/adk/llm/generateContent) │  │
│  │ - Custom model: GenAI <-> OpenAI / Ollama        │  │
│  │ - Official model: pass through upstream          │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Transparent Reverse Proxy (all other paths)      │  │
│  │ - Auth, telemetry, heartbeat, skills passthrough │  │
│  └──────────────────────────────────────────────────┘  │
└───────────────┬────────────────────────┬───────────────┘
                │                        │
         Custom Models             Passthrough
                │                        │
       ┌────────┴────────┐               ▼
       ▼                 ▼     ┌────────────────────────┐
┌──────────────┐  ┌──────────┐ │ Upstream Alibaba Cloud  │
│    Ollama    │  │  OpenAI  │ │   Gateway (Phoenix)    │
│ (127.0.0.1:  │  │ (LM Studio│ │(phoenix-gw.alibaba.com)│
│    11434)    │  │  vLLM)   │ └────────────────────────┘
└──────────────┘  └──────────┘
```

---
---

## Accio Work 国际版 vs 中国版 深度对比与自动识别

根据对官方站点、更新通道和客户端代码的实测分析，Accio Work 存在两条并行的官方发行线：

### 1. 核心差异矩阵

| 维度 | Accio Work 国际版 (Global) | Accio Work 中国版 (China) |
|---|---|---|
| **官方站点** | `https://www.accio.com/work` | `https://www.accio-ai.com/work` |
| **站点标语** | *Your AI Business Team That Turns Ideas Into Profits* | *您的 AI 商业团队，帮助您把创意转化为收益* |
| **更新与下载 CDN** | `work-download.accio.com` | `work-download.accio-ai.com` |
| **文件与图片服务** | `filebroker.accio.com` | `filebroker.accio-ai.com` |
| **安装包代码签名主体** | Generic / International | `ALIBABA (CHINA) NETWORK TECHNOLOGY CO.,LTD.` (阿里巴巴网络技术有限公司) |
| **官方支持模型口径** | Gemini, GPT-4o, Claude, Qwen | DeepSeek, 通义千问, 文心一言, 豆包, Kimi, MiniMax |
| **外部机器人渠道** | Telegram, Discord, DingTalk, Lark, WeChat | 钉钉, 飞书, 微信 |
| **内部路由业务码** | `icbu_accio_global` | `icbu_accio_china` |
| **模型目录区域键** | `packageRegion` (通常为 `GLOBAL`) | `packageRegion` (通常为 `GLOBAL`，注意见下文) |
| **本地主判据** | `domain-config.json` -> `region: "GLOBAL"` | `domain-config.json` -> `region: "CN"` |

> **重要避坑注意**：  
> 客户端在首次启动时会在 `%USERPROFILE%\.accio\appInstall.jsonl` 中记录 `{"packageRegion":"GLOBAL"}`。该字段仅用于**大模型目录的云端路由分片**（如海外服务器集群），**不等于客户端发行版本**！  
> 真正的版本判据是 `%USERPROFILE%\.accio\domain-config.json` 中的 `region: "CN"` 以及 `services.client.domain: "work-download.accio-ai.com"`。

### 2. 桥接器自动识别与一键接管机制

Accio Gateway Bridge 内置了只读取证模块 `src/accio-detect.js`：
- **打开 Web 控制台** 即自动探测系统安装的 Accio Work 客户端。
- **证据链逐项打分**：自动读取 `domain-config.json`、`appInstall.jsonl`、`app-update.yml`，并核验签名主体。
- **四态智能徽标**：`Accio Work 中国版` (绿色)、`Accio Work 国际版` (蓝色)、`未知发行版本`、`未安装`。
- **一键接管按钮**：直接在界面上点击「一键启动并接管」，Bridge 自动通过子进程注入 `GATEWAY_BASE_URL=http://127.0.0.1:8080` 拉起客户端，无需手动打开终端输命令。


## 桌面客户端 (Magpie 式原生窗口)

与 Magpie 相同的架构：Go 单文件程序 + WebView2 原生窗口 + 系统托盘，Node bridge 作为网关引擎在后台由它托管。不打开浏览器。

```powershell
# 构建（需要 Go 1.25+，无需 CGO）
cd desktop; .\build.ps1          # 产物：项目根目录 accio-desktop.exe

# 运行：双击 accio-desktop.exe
```

- 启动即自动拉起网关（已有 bridge 在跑则复用，不会杀它）；设 `ACCIO_DESKTOP_NO_AUTOSTART=1` 可关闭自动启动。
- 界面：概览（Accio 中国版识别 + 一键接管）/ 供应商（分组、掩码 Key、抽屉编辑、拉取模型、检测本机 Ollama/LM Studio 等）/ 模型 / 网关 / 日志 / 测试（流式 TTFT）/ 设置。
- 关闭按钮隐藏到托盘；托盘菜单：显示窗口、启动/停止网关、启动 Accio、退出。退出或程序崩溃时，受管网关会随之结束。
- 单实例：重复双击会激活已有窗口。
- 自检：`accio-desktop.exe --selftest --out result.json`（加 `--selftest-start` 同时验证网关启停）。
- 接口契约见 `desktop/CONTRACT.md`，宿主说明见 `desktop/README.md`。

## Magpie 风格纯后端终端客户端 (CLI Client)

为了摆脱 Web 依赖，完全模仿 **Magpie 客户端架构**（终端优先、纯后端操控、服务守护进程、直接在命令行看流式输出），本项目提供了原生 `accio`（或 `accio-bridge`）命令行客户端工具：

```bash
# 1. 类似 `magpie ls`：列出识别到的 Accio Work 客户端、配置路径与绑定的本地网关
accio ls

# 2. 系统健康与网关状态概览 (Bridge 状态、上游连接、Accio 中国版检测、账号配置)
accio status

# 3. 类似 `magpie providers`：列出所有本地/云端模型供应商 (Ollama, LM Studio, vLLM, OpenAI)
accio providers

# 4. 类似 `magpie models`：列出当前注册到 Accio 的自定义模型 (locked: false, freeUse: true)
accio models

# 5. 添加自定义模型 (自动写入 config.json，免手填复杂 JSON)
accio model add deepseek-r1 --provider ollama --url http://127.0.0.1:11434
accio model add gpt-4o --provider openai --url https://api.openai.com/v1 --key sk-...

# 6. 删除自定义模型
accio model rm deepseek-r1

# 7. 纯终端流式测试 (逐 Token 直出终端，测量 TTFT 首字延迟与吞吐速率，无需打开浏览器)
accio test deepseek-local "你好，请用一句话介绍你自己"

# 8. 一键启动并接管 Accio Work (注入 GATEWAY_BASE_URL，自动区分中国版与运行态)
accio launch

# 9. 查看中国版 vs 国际版 5 项证据链与得分细则
accio evidence

# 10. 守护进程管理 (类似 `magpie daemon start/stop/status/log`)
accio daemon start     # 后台静默启动网关并写入 PID
accio daemon status    # 查看后台服务健康与 PID
accio daemon log       # 查看最近网关日志 (tail)
accio daemon stop      # 优雅关闭后台服务
```

## Quickstart Guide

### Option 1: One-Click Launcher (Recommended for Windows)

Double-click `start-all.bat` in the project root (or run `.\accio.cmd launch` in terminal):
1. Starts the Accio Gateway Bridge daemon in the background (`accio daemon start`).
2. Inspects and prints the Accio Work China Edition status card directly to the console (`accio status`).
3. Sets `GATEWAY_BASE_URL=http://127.0.0.1:8080` and launches the Accio Desktop client automatically (zero browser popups).

### Option 2: PowerShell Launcher

Run `launch-accio.ps1` in Windows PowerShell:
```powershell
.\launch-accio.ps1
```
The script will check if the bridge is running (offering to start it if offline), verify the Accio executable path, set the environment variable, and start Accio with colorized status messages.

### Option 3: Manual Startup

1. **Start the Gateway Bridge**:
   ```bash
   npm start
   ```
   Or in background with auto-reload:
   ```bash
   npm run dev
   ```

2. **Launch Accio Desktop Client**:
   - **Command Prompt (cmd.exe)**:
     ```cmd
     set GATEWAY_BASE_URL=http://127.0.0.1:8080 && start "" "%LOCALAPPDATA%\Programs\Accio\Accio.exe"
     ```
   - **PowerShell**:
     ```powershell
     $env:GATEWAY_BASE_URL = "http://127.0.0.1:8080"
     & "$env:LOCALAPPDATA\Programs\Accio\Accio.exe"
     ```

---

## Web Management & Status Dashboard

Access the Web Dashboard at:
**[http://127.0.0.1:8080/dashboard](http://127.0.0.1:8080/dashboard)** or **[http://127.0.0.1:8080/](http://127.0.0.1:8080/)**

The dashboard provides a complete web interface with:
- **Server Health & Metrics**: Live status indicators, port configuration, active model counts, and upstream gateway target.
- **Model Management**: Add, edit, enable/disable, or delete custom models with instant persistence to `config.json`.
- **Preconfigured Presets**: One-click fill for Ollama, LM Studio, vLLM, OpenAI Hosted, and OpenRouter.
- **Live Test Playground**: Send test prompts directly through the bridge and monitor real-time typewriter SSE streaming chunks, Time-To-First-Token (TTFT), latency, and tool-calling frames.
- **Quick-Copy Snippets**: One-click copy buttons for both CMD and PowerShell launcher commands.
- **Modern Responsive Dark/Light UI**: Pure CSS/JS implementation with zero external CDN dependencies, fully functional offline.

---

## Configuration (`config.json`)

Configuration is stored in `config.json` in the root directory:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8080,
    "maxBodyBytes": 26214400,
    "cors": true,
    "token": "",
    "enforceToken": false,
    "logLevel": "info"
  },
  "upstream": {
    "baseUrl": "https://phoenix-gw.alibaba.com",
    "timeoutMs": 300000,
    "apiKey": ""
  },
  "catalog": {
    "enabled": true,
    "providerName": "custom",
    "providerDisplayName": "Custom AI (Local / OpenAI)",
    "fetchOfficial": true,
    "timeoutMs": 8000,
    "cacheTtlMs": 300000
  },
  "models": [
    {
      "id": "deepseek-r1:14b",
      "modelCode": "deepseek-r1:14b",
      "displayName": "DeepSeek R1 14B (Ollama · local)",
      "provider": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "upstreamModel": "deepseek-r1:14b",
      "apiKey": "",
      "contextWindow": 131072,
      "stream": true,
      "multimodal": false,
      "enabled": true,
      "visible": true,
      "isDefault": true,
      "freeUse": true,
      "locked": false,
      "usageLevel": 0
    },
    {
      "id": "qwen2.5-coder-7b",
      "modelCode": "qwen2.5-coder-7b",
      "displayName": "Qwen2.5 Coder 7B (LM Studio)",
      "provider": "openai",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "upstreamModel": "qwen2.5-coder-7b-instruct",
      "apiKey": "not-needed",
      "contextWindow": 32768,
      "stream": true,
      "multimodal": false,
      "enabled": true,
      "visible": true,
      "isDefault": false,
      "freeUse": true,
      "locked": false,
      "usageLevel": 0
    }
  ]
}
```

### Model Configuration Fields

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier recognized by Accio client (e.g. `deepseek-r1:14b`). |
| `modelCode` | `string` | Model code sent to client (defaults to `id`). |
| `displayName` | `string` | Human-readable label displayed in Accio model selector dropdown. |
| `provider` | `string` | Provider dialect: `ollama` (native `/api/chat`) or `openai` (chat completions). |
| `baseUrl` | `string` | Endpoint URL. For Ollama: `http://127.0.0.1:11434`. For OpenAI: include `/v1` prefix. |
| `upstreamModel` | `string` | Exact model name passed to the upstream provider (defaults to `id`). |
| `apiKey` | `string` | Bearer token injected into `Authorization` header (if required). |
| `contextWindow` | `number` | Maximum context tokens (e.g. `131072`, `32768`, `128000`). |
| `stream` | `boolean` | When `true`, streams SSE chunks to Accio (recommended: `true`). |
| `multimodal` | `boolean` | Flags whether model accepts image inputs. |
| `enabled` | `boolean` | Toggle availability in Accio model catalog. |
| `isDefault` | `boolean` | Sets model as default selection on startup. |
| `freeUse` | `boolean` | Set to `true` to ensure client allows unrestricted generation. |
| `locked` | `boolean` | Set to `false` to ensure client displays model as unlocked. |

---

## API Endpoints

| Endpoint | Method | Function |
|---|---|---|
| `/dashboard`, `/` | `GET` | Serves the Web Management & Live Playground UI |
| `/healthz` | `GET` | Returns bridge status, upstream URL, and active model IDs |
| `/api/bridge/status` | `GET` | Returns full bridge status and server metadata JSON |
| `/api/bridge/models` | `GET` | Returns all configured models |
| `/api/bridge/models` | `POST` | Adds or updates a custom model |
| `/api/bridge/models` | `DELETE` | Deletes a custom model by `?id=` |
| `/api/bridge/test` | `POST` | Playground test endpoint for model verification |
| `/api/bridge/accio` | `GET` | 自动识别本机 Accio Work 客户端安装状态、发行版（中国版/国际版）及证据链 |
| `/api/bridge/accio/launch` | `POST` | 一键注入 `GATEWAY_BASE_URL` 并拉起 Accio Work 客户端进程 |
| `/api/llm/config/v2` | `POST` | Merged model catalog with custom models (`locked=false`, `freeUse=true`) |
| `/api/adk/llm/generateContent` | `POST` | Translates GenAI requests to OpenAI/Ollama SSE streaming |
| `*` (All other paths) | `ANY` | Transparently proxied to upstream `phoenix-gw.alibaba.com` |

---

## Launcher Scripts Reference

| Script | Purpose |
|---|---|
| `start-bridge.bat` | Verifies Node.js 18+, runs package checks, and starts the bridge server on `127.0.0.1:8080`. |
| `launch-accio.bat` | Sets `GATEWAY_BASE_URL=http://127.0.0.1:8080`, searches for `Accio.exe`, and starts the client. |
| `start-all.bat` | Starts the bridge server, waits for health check, opens the dashboard, and launches Accio Desktop client. |
| `launch-accio.ps1` | PowerShell launcher featuring health checks, process verification, and colorized status reporting. |

---

## Verification & Testing Suite

The repository includes a comprehensive test suite with automated integration checks and a standalone mock OpenAI server:

### Run Automated Integration Tests
```bash
npm test
```
Executes `tests/test-integration.js`, which:
- Starts `tests/mock-openai.js` on an ephemeral port.
- Starts a mock upstream gateway server.
- Verifies `GET /dashboard` and `GET /` return HTTP 200 with HTML markup.
- Verifies `POST /api/llm/config/v2` returns custom models with `locked: false` and `freeUse: true`.
- Verifies `POST /api/adk/llm/generateContent` streams SSE chunks in valid Accio GenAI format (`content.role === "model"`, `turnComplete: true`, `finishReason: "STOP"`).
- Verifies tool-calling frames (`read_file`).
- Verifies Bridge management APIs (`GET /api/bridge/status`, model addition, model deletion).

### Run Standalone Smoke Tests
```bash
npm run smoke
```
Runs `test/smoke.js` to verify catalog merge, Ollama NDJSON streaming, and transparent reverse proxying.

### Run Code Syntax Verification
```bash
npm run check
```

---

## Troubleshooting Guide

### 1. Port 8080 is already in use (`EADDRINUSE`)
If port 8080 is occupied by another application:
1. Open `config.json` and change `server.port` to another port (e.g. `8085`).
2. Update `GATEWAY_BASE_URL=http://127.0.0.1:8085` in `launch-accio.bat` and `launch-accio.ps1`.
3. Restart the bridge.

### 2. Accio.exe Not Found
The default location is `%LOCALAPPDATA%\Programs\Accio\Accio.exe`.
If you installed Accio in a custom folder, either:
- Set the environment variable:
  ```cmd
  set ACCIO_EXE=D:\MyApps\Accio\Accio.exe
  ```
- Or pass the path directly to PowerShell:
  ```powershell
  .\launch-accio.ps1 -AccioPath "D:\MyApps\Accio\Accio.exe"
  ```

### 3. Ollama Connection Issues
- Make sure Ollama is running (`ollama list` in terminal).
- If Ollama runs on a different machine or WSL, ensure `OLLAMA_HOST=0.0.0.0` and `OLLAMA_ORIGINS=*` are set so remote requests are allowed.
- Verify baseUrl in `config.json`: `http://127.0.0.1:11434` (do NOT append `/v1`).

### 4. LM Studio / vLLM Compatibility
- For LM Studio: ensure the local inference server is started (default `http://127.0.0.1:1234/v1`).
- In `config.json`, set `provider: "openai"` and `baseUrl: "http://127.0.0.1:1234/v1"`.
- Set `apiKey: "not-needed"`.

### 5. Upstream Alibaba Gateway Passthrough
- Features like login, profile, skills, and official models depend on `https://phoenix-gw.alibaba.com`.
- If the official gateway is blocked in your network, configure an upstream mirror in `config.json` under `upstream.baseUrl`.

---

## License

MIT License. Open source for local client customization.
