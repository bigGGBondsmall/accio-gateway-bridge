package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path"
	"strings"
	"sync"
	"time"
)

// uiFS embeds the UI directory. "all:" also matches dot-files such as
// .gitkeep so the package still compiles when desktop/ui/ has no real UI yet.
//
//go:embed all:ui
var uiFS embed.FS

const placeholderHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accio Bridge</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0f1115; color:#e6e6e6;
         font-family: "Microsoft YaHei", system-ui, -apple-system, sans-serif; }
  .card { text-align:center; padding:32px 40px; }
  h1 { font-size:20px; font-weight:600; margin:0 0 12px; }
  p { margin:6px 0; color:#9aa4b2; }
  code { color:#7aa2f7; }
</style>
</head>
<body>
  <div class="card">
    <h1>Accio Bridge 桌面宿主</h1>
    <p>界面文件尚未生成（<code>desktop/ui/index.html</code> 不存在）。</p>
    <p>本地服务已在运行，宿主接口可用：<code>/host/state</code></p>
  </div>
</body>
</html>`

// HostConfig carries everything the local host service needs.
type HostConfig struct {
	Token      string
	Version    string
	Root       string
	LogFile    string
	ConfigPath string
	NodePath   string
	NodeFound  bool
	Gateway    *GatewayManager
	Listener   net.Listener
	OnHide     func()
	OnQuit     func()
}

// HostServer is the loopback HTTP service backing the desktop window.
type HostServer struct {
	cfg     HostConfig
	token   string
	gw      *GatewayManager
	ln      net.Listener
	host    string // expected Host header, e.g. 127.0.0.1:54321
	srv     *http.Server
	handler http.Handler

	mu        sync.Mutex
	proxy     *httputil.ReverseProxy
	proxyPort int
}

func newHostServer(cfg HostConfig) *HostServer {
	h := &HostServer{
		cfg:   cfg,
		token: cfg.Token,
		gw:    cfg.Gateway,
		ln:    cfg.Listener,
	}
	if cfg.Listener != nil {
		h.host = cfg.Listener.Addr().String()
	}
	h.handler = h.buildHandler()
	return h
}

// Addr is the loopback address the service listens on.
func (h *HostServer) Addr() string {
	if h.ln == nil {
		return ""
	}
	return h.ln.Addr().String()
}

func (h *HostServer) BaseURL() string { return "http://" + h.Addr() }

// Serve blocks until the server is closed.
func (h *HostServer) Serve() error {
	h.srv = &http.Server{Handler: h.handler}
	err := h.srv.Serve(h.ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (h *HostServer) Close() {
	if h.srv != nil {
		_ = h.srv.Close()
	}
}

// ---- routing -----------------------------------------------------------

func (h *HostServer) buildHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/host/", h.handleHost)
	mux.HandleFunc("/api/bridge/", h.handleProxy)
	mux.HandleFunc("/healthz", h.handleProxy)
	mux.HandleFunc("/", h.handleStatic)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// DNS-rebinding guard: only the loopback host we are bound to may be used.
		if !h.hostAllowed(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"ok":    false,
				"error": "forbidden host",
			})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (h *HostServer) hostAllowed(r *http.Request) bool {
	want := h.host
	if want == "" {
		return true
	}
	if addr, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok && addr != nil {
		if addr.String() != "" {
			want = addr.String()
		}
	}
	return strings.EqualFold(r.Host, want)
}

// ---- token -------------------------------------------------------------

func newToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand should never fail; fall back to a still-unique value.
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func (h *HostServer) authorized(r *http.Request) bool {
	got := r.Header.Get("X-Host-Token")
	if got == "" || h.token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(h.token)) == 1
}

// ---- /host/* -----------------------------------------------------------

func (h *HostServer) handleHost(w http.ResponseWriter, r *http.Request) {
	if !h.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	p := strings.TrimRight(r.URL.Path, "/")

	switch {
	case r.Method == http.MethodGet && p == "/host/state":
		writeJSON(w, http.StatusOK, h.stateBody())
	case r.Method == http.MethodPost && (p == "/host/gateway/start" || p == "/host/gateway/restart"):
		if p == "/host/gateway/restart" {
			_ = h.gw.Restart()
		} else {
			_ = h.gw.Start()
		}
		writeJSON(w, http.StatusOK, h.stateBody())
	case r.Method == http.MethodPost && p == "/host/gateway/stop":
		if err := h.gw.Stop(); err != nil {
			writeJSON(w, http.StatusOK, h.stateBodyWithError(err.Error()))
			return
		}
		writeJSON(w, http.StatusOK, h.stateBody())
	case r.Method == http.MethodPost && p == "/host/window/hide":
		if h.cfg.OnHide != nil {
			h.cfg.OnHide()
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case r.Method == http.MethodPost && p == "/host/app/quit":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		if h.cfg.OnQuit != nil {
			go h.cfg.OnQuit()
		}
	case r.Method == http.MethodPost && p == "/host/open":
		h.handleOpen(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
	}
}

func (h *HostServer) handleOpen(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64*1024))
	var req struct {
		Target string `json:"target"`
	}
	_ = json.Unmarshal(body, &req)

	switch req.Target {
	case "logs":
		if err := openInExplorer(h.cfg.LogFile); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
	case "config":
		if err := openInExplorer(h.cfg.ConfigPath); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
	case "root":
		if err := openInExplorer(h.cfg.Root); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "unknown target"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func openInExplorer(target string) error {
	target = strings.TrimSpace(target)
	if target == "" {
		return errors.New("路径为空")
	}
	if _, err := os.Stat(target); err != nil {
		return fmt.Errorf("路径不存在: %s", target)
	}
	return exec.Command("explorer.exe", target).Start()
}

func (h *HostServer) stateBody() map[string]any {
	st := h.gw.Status()
	return map[string]any{
		"ok":      true,
		"version": h.cfg.Version,
		"root":    h.cfg.Root,
		"gateway": st,
		"node": map[string]any{
			"path":  h.cfg.NodePath,
			"found": h.cfg.NodeFound,
		},
		"logFile": h.cfg.LogFile,
	}
}

func (h *HostServer) stateBodyWithError(msg string) map[string]any {
	body := h.stateBody()
	body["ok"] = false
	body["error"] = msg
	return body
}

// ---- reverse proxy -----------------------------------------------------

func (h *HostServer) handleProxy(w http.ResponseWriter, r *http.Request) {
	st := h.gw.Status()
	if st.State != stateRunning || st.Port <= 0 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok":    false,
			"error": "网关未运行",
		})
		return
	}
	h.reverseProxy(st.Port).ServeHTTP(w, r)
}

func (h *HostServer) reverseProxy(port int) *httputil.ReverseProxy {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.proxy != nil && h.proxyPort == port {
		return h.proxy
	}
	h.proxy = buildReverseProxy(port)
	h.proxyPort = port
	return h.proxy
}

func buildReverseProxy(port int) *httputil.ReverseProxy {
	target := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", port)}

	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// The host token is an internal detail of this process.
			pr.Out.Header.Del("X-Host-Token")
		},
		// -1 disables buffering so SSE frames reach the UI immediately.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"ok":    false,
				"error": "网关代理失败: " + err.Error(),
			})
		},
	}

	rp.ModifyResponse = func(resp *http.Response) error {
		if strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
			// Do not let downstream layers buffer or cache a stream.
			resp.Header.Set("Cache-Control", "no-cache")
			resp.Header.Set("X-Accel-Buffering", "no")
		}
		return nil
	}
	return rp
}

// ---- static assets -----------------------------------------------------

func (h *HostServer) handleStatic(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if rel == "" {
		rel = "index.html"
	}
	if strings.HasPrefix(rel, "..") {
		http.NotFound(w, r)
		return
	}

	data, err := uiFS.ReadFile("ui/" + rel)
	if err != nil {
		if rel == "index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
			_, _ = w.Write([]byte(placeholderHTML))
			return
		}
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", contentTypeFor(rel))
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	_, _ = w.Write(data)
}

func contentTypeFor(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".ico":
		return "image/x-icon"
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".txt", ".md":
		return "text/plain; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

// ---- helpers -----------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"ok":false,"error":"json encode failed"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}
