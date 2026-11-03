# Accio Bridge Desktop（Go 宿主）

Accio Gateway Bridge 的 Windows 原生桌面客户端宿主：Go + go-webview2（WebView2）+ 纯 syscall 系统托盘，
**不使用 CGO**，产物为单文件 `accio-desktop.exe`。引擎可为 Node 桥，也可以是 Rust 网关（见下"引擎选择"）。

> **两种壳不要混淆：** 本目录是当前在用的 Go 壳源码。Rust 网关包（本机 `C:\Users\lin\Downloads\Accio-Bridge-Rust-f39fef4`）里的 `desktop/` 是 Tauri 2 壳源码，**未启用、从未构建**，不是当前入口。部署时把 `accio-desktop.exe` 放到该 Rust 包的 `target\release\`（与引擎同目录，本轮即如此）；仓库内被 git 跟踪的旧 `accio-desktop.exe` 不要覆盖。

## 结构

| 文件 | 作用 |
|---|---|
| `main.go` | 入口、参数、单实例、窗口装配、`--selftest` 自检 |
| `host.go` | 本地 HTTP 服务：`/`(go:embed ui/)、`/host/*`、`/api/bridge/*` 反向代理、`/healthz` |
| `gateway.go` | 网关监管：收编外部健康网关，或隐藏启动所选引擎（Rust 网关或 `node src/server.js`） |
| `tray_windows.go` | 系统托盘（`Shell_NotifyIconW` + 隐藏消息窗口 + 弹出菜单）与 WNDPROC 子类化 |
| `winapi_windows.go` | Win32 syscall 声明、结构体、图标生成、单实例互斥量、DPI 感知 |
| `root.go` | 网关根解析（Node 项目或 Rust 网关包）、引擎选择、node / 端口解析 |
| `ui/` | 前端静态资源（`go:embed all:ui`，为空时占位页兜底） |

## 构建

```powershell
cd desktop
.\build.ps1            # CGO_ENABLED=0、GOPROXY=goproxy.cn，输出 ..\accio-desktop.exe
```

## 自检

```powershell
..\accio-desktop.exe --selftest --out $env:TEMP\accio-selftest.json
# 需要同时启动（并在结束时停止）受管网关时加 --selftest-start
```

因为用了 `-H windowsgui`，程序没有控制台输出，自检结果一律写入 `--out` 指定的 JSON 文件
（字段：`ok, root, nodeFound, port, gatewayState, tokenEnforced, uiServed, engine, engineRust, errors[]`）。

## 保活与退出

- 关闭按钮隐藏到系统托盘（WNDPROC 子类化截获 `WM_CLOSE`）；托盘创建失败时关闭即退出。
- 左键单击托盘图标显示窗口，右键弹出菜单：显示窗口 / 启动网关 / 停止网关 / 启动 Accio / 退出。
- `stop` 只结束本程序启动的网关；复用外部 bridge 时 `stop` 返回错误且不会杀别人的进程。
- 程序退出时只停止受管的网关。

## 引擎选择

宿主只负责一个引擎进程：它先探测 `server.port` 上是否已有健康网关（有则直接收编、**绝不重复启动**），
需要自己启动时按以下顺序挑选引擎：

1. `ACCIO_BRIDGE_ENGINE` 指定的可执行文件（以 `--config <config.json>` 启动）；
2. 根目录内的 Rust 网关 `target/release/accio-gateway-bridge-rust.exe`（或 `target/debug/`）；
3. 回退到 Node 桥 `node src/server.js`。

因此把 Rust 网关的构建产物放进任何一个"根"里，这套 7 视图界面就会直接驱动 Rust 引擎，
管理接口（`/api/bridge/*`）两者一致，界面无需区分。

## 环境变量

| 变量 | 作用 |
|---|---|
| `ACCIO_BRIDGE_ROOT` | 指定网关根（优先于从 exe 目录向上查找）。根可以是 Node 项目（含 `src/server.js`），也可以是 Rust 网关包（含 `config.json` 与 `target/release/accio-gateway-bridge-rust.exe`） |
| `ACCIO_BRIDGE_ENGINE` | 指定要启动的网关可执行文件（优先于根目录内的 Rust 网关与 node）。用于自定义构建位置 |
| `ACCIO_NODE` | 指定 node 可执行文件（优先于 `PATH` 中的 node） |
| `ACCIO_BRIDGE_CONFIG` | 指定 config.json（读取 `server.port`，缺省 8080） |
| `ACCIO_DESKTOP_NO_AUTOSTART` | 设为 `1` 时启动窗口不自动拉起网关 |

## 约定

接口形状以 `desktop/CONTRACT.md` 为准；`/host/*` 需要 `X-Host-Token`，`window.__HOST__` 由宿主注入。
本地服务仅监听 `127.0.0.1:0`，并校验 `Host` 头必须是本服务地址（防 DNS rebinding）。