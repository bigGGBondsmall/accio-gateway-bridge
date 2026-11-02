//go:build windows

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	webview2 "github.com/jchv/go-webview2"
)

const singleInstanceMutex = `Local\AccioBridgeDesktop`

// appContext ties the webview, tray and gateway supervisor together.
type appContext struct {
	version  string
	gw       *GatewayManager
	host     *HostServer
	webview  webview2.WebView
	tray     *tray
	quitOnce sync.Once
}

func main() {
	os.Exit(run())
}

func run() int {
	var (
		selftest      bool
		selftestStart bool
		outPath       string
	)
	flag.BoolVar(&selftest, "selftest", false, "运行自检模式（不创建窗口/托盘），把结果写入 --out")
	flag.BoolVar(&selftestStart, "selftest-start", false, "自检时启动网关并在结束时停止")
	flag.StringVar(&outPath, "out", "", "自检结果 JSON 输出路径")
	flag.Parse()

	if selftest {
		return runSelfTest(outPath, selftestStart)
	}
	return runApp()
}

func executableDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(exe)
}

func localAppData() string {
	if v := os.Getenv("LOCALAPPDATA"); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, "AppData", "Local")
	}
	return os.TempDir()
}

// hostInitScript builds the JS injected into every page as window.__HOST__.
func hostInitScript(token string) string {
	payload := struct {
		Token     string `json:"token"`
		Version   string `json:"version"`
		IsDesktop bool   `json:"isDesktop"`
	}{Token: token, Version: appVersion, IsDesktop: true}
	b, err := json.Marshal(payload)
	if err != nil {
		return "window.__HOST__ = null;"
	}
	return "window.__HOST__ = " + string(b) + ";"
}

func runApp() int {
	// The WebView2 window and the tray must live on the same thread as the
	// message loop started by webview.Run().
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	setDpiAwareness()

	mutex, already := createMutex(singleInstanceMutex)
	if already {
		activateExistingWindow(appName)
		closeHandle(mutex)
		return 0
	}
	defer closeHandle(mutex)

	exeDir := executableDir()
	root, err := resolveRoot(exeDir, os.Getenv("ACCIO_BRIDGE_ROOT"))
	if err != nil {
		return 1
	}
	nodePath, nodeFound := resolveNode(os.Getenv("ACCIO_NODE"))
	port, configPath := resolveGatewayPort(root, os.Getenv("ACCIO_BRIDGE_CONFIG"))

	gw := NewGatewayManager(root, nodePath, nodeFound, port)
	gw.Sync()
	// Like Magpie, serving starts with the app. Opt out with ACCIO_DESKTOP_NO_AUTOSTART=1.
	if os.Getenv("ACCIO_DESKTOP_NO_AUTOSTART") != "1" && gw.Status().State == stateStopped {
		go func() { _ = gw.Start() }()
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		gw.Shutdown()
		return 1
	}

	token := newToken()
	app := &appContext{version: appVersion, gw: gw}
	host := newHostServer(HostConfig{
		Token:      token,
		Version:    appVersion,
		Root:       root,
		LogFile:    gw.LogFile(),
		ConfigPath: configPath,
		NodePath:   nodePath,
		NodeFound:  nodeFound,
		Gateway:    gw,
		Listener:   ln,
		OnHide:     app.hideWindow,
		OnQuit:     app.requestQuit,
	})
	app.host = host
	go func() { _ = host.Serve() }()
	defer host.Close()

	gw.StartHealthLoop()
	defer gw.Shutdown()

	dataPath := filepath.Join(localAppData(), "AccioBridge", "webview")
	_ = os.MkdirAll(dataPath, 0o755)

	winW, winH := scaledWindowSize(1180, 760)
	minW, minH := scaledWindowSize(900, 600)
	wv := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  dataPath,
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  appName,
			Width:  uint(winW),
			Height: uint(winH),
			Center: true,
		},
	})
	if wv == nil {
		return 1
	}
	app.webview = wv
	wv.SetSize(minW, minH, webview2.HintMin)

	wv.Init(hostInitScript(token))
	wv.Navigate(fmt.Sprintf("http://%s/?token=%s", host.Addr(), token))

	tr := newTray(app)
	app.tray = tr
	if !tr.install(wv) {
		// Tray unavailable: closing the window exits the app (WM_CLOSE falls
		// through to the default handler, so nothing else is required here).
		_ = errNoTray
	}

	tipStop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-tipStop:
				return
			case <-ticker.C:
				app.refreshTip()
			}
		}
	}()

	wv.Run()

	close(tipStop)
	tr.remove()
	return 0
}

// ---- self test ----------------------------------------------------------

type selfTestResult struct {
	Ok            bool     `json:"ok"`
	Root          string   `json:"root"`
	NodeFound     bool     `json:"nodeFound"`
	Port          int      `json:"port"`
	GatewayState  string   `json:"gatewayState"`
	TokenEnforced bool     `json:"tokenEnforced"`
	UiServed      bool     `json:"uiServed"`
	Errors        []string `json:"errors"`
}

func runSelfTest(outPath string, startGateway bool) int {
	if outPath == "" {
		outPath = filepath.Join(os.TempDir(), "accio-selftest.json")
	}
	res := selfTestResult{Errors: []string{}}

	writeOut := func() int {
		b, err := json.MarshalIndent(res, "", "  ")
		if err != nil {
			return 1
		}
		if err := os.WriteFile(outPath, b, 0o644); err != nil {
			return 1
		}
		if res.Ok {
			return 0
		}
		return 1
	}
	fail := func(msg string) int {
		res.Errors = append(res.Errors, msg)
		res.Ok = false
		return writeOut()
	}

	root, err := resolveRoot(executableDir(), os.Getenv("ACCIO_BRIDGE_ROOT"))
	if err != nil {
		return fail(err.Error())
	}
	res.Root = root

	nodePath, nodeFound := resolveNode(os.Getenv("ACCIO_NODE"))
	res.NodeFound = nodeFound

	port, configPath := resolveGatewayPort(root, os.Getenv("ACCIO_BRIDGE_CONFIG"))
	res.Port = port

	gw := NewGatewayManager(root, nodePath, nodeFound, port)
	gw.Sync()
	if startGateway {
		if err := gw.Start(); err != nil {
			res.Errors = append(res.Errors, err.Error())
		}
		defer gw.Shutdown()
	}
	res.GatewayState = gw.Status().State

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fail("无法监听本地端口: " + err.Error())
	}

	token := newToken()
	host := newHostServer(HostConfig{
		Token:      token,
		Version:    appVersion,
		Root:       root,
		LogFile:    gw.LogFile(),
		ConfigPath: configPath,
		NodePath:   nodePath,
		NodeFound:  nodeFound,
		Gateway:    gw,
		Listener:   ln,
	})
	go func() { _ = host.Serve() }()
	defer host.Close()

	base := host.BaseURL()

	if code, body := httpGet(base+"/", ""); code == http.StatusOK && len(body) > 0 {
		res.UiServed = true
	} else {
		res.Errors = append(res.Errors, fmt.Sprintf("GET / 返回 %d（期望 200）", code))
	}

	withCode, _ := httpGet(base+"/host/state", token)
	withoutCode, _ := httpGet(base+"/host/state", "")
	res.TokenEnforced = withCode == http.StatusOK && withoutCode == http.StatusUnauthorized
	if !res.TokenEnforced {
		res.Errors = append(res.Errors,
			fmt.Sprintf("token 校验异常：带 token=%d 不带 token=%d（期望 200/401）", withCode, withoutCode))
	}

	res.Ok = res.TokenEnforced && res.UiServed && len(res.Errors) == 0
	return writeOut()
}

func httpGet(url, token string) (int, string) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return 0, ""
	}
	if token != "" {
		req.Header.Set("X-Host-Token", token)
	}
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return 0, ""
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, string(body)
}
