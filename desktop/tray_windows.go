//go:build windows

package main

import (
	"errors"
	"net/http"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

// Pure syscall/system-tray implementation (Shell_NotifyIconW + a hidden
// message window). No CGO, no third-party tray library.

const trayClassName = "AccioBridgeTrayWnd"

// Tray menu command ids.
const (
	trayIDShowWindow   = 1
	trayIDStartGateway = 2
	trayIDStopGateway  = 3
	trayIDLaunchAccio  = 4
	trayIDQuit         = 5
)

type tray struct {
	app      *appContext
	hwnd     uintptr // go-webview2 window
	msgHwnd  uintptr // hidden message-only window owning the tray icon
	hicon    uintptr
	cbMsg    uint32
	origProc uintptr

	// Set before the message loop starts; read from the window procedures.
	ok bool

	// Keep callbacks alive for the lifetime of the process.
	webviewProcCb uintptr
	trayProcCb    uintptr

	mu      sync.Mutex
	removed bool
	lastTip string
}

func newTray(app *appContext) *tray {
	return &tray{
		app:   app,
		cbMsg: uint32(wmAppBase + 100),
	}
}

// install wires the icon, the hidden message window and the WNDPROC subclass
// that turns WM_CLOSE into "hide to tray". Returns false when the tray could
// not be created; closing the window then exits the application.
func (t *tray) install(wv webview2.WebView) bool {
	if wv == nil {
		return false
	}
	t.hwnd = uintptr(wv.Window())
	if t.hwnd == 0 {
		return false
	}

	t.hicon = createAppIcon()

	var hinstance windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hinstance)

	className, err := windows.UTF16PtrFromString(trayClassName)
	if err != nil {
		return false
	}
	windowTitle, err := windows.UTF16PtrFromString(appName + " Tray")
	if err != nil {
		return false
	}

	t.trayProcCb = windows.NewCallback(t.wndProcTray)
	wc := wndClassExW{
		cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
		lpfnWndProc:   t.trayProcCb,
		hInstance:     hinstance,
		lpszClassName: className,
	}
	// A previously registered class (error 1410) is fine.
	_, _, _ = procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	msgHwnd, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowTitle)),
		0, 0, 0, 0, 0,
		hwndMessage,
		0,
		uintptr(hinstance),
		0,
	)
	if msgHwnd == 0 {
		return false
	}
	t.msgHwnd = msgHwnd

	// Best effort window icon.
	_, _, _ = procSendMessageW.Call(t.hwnd, wmSetIcon, iconBig, t.hicon)
	_, _, _ = procSendMessageW.Call(t.hwnd, wmSetIcon, iconSmall, t.hicon)

	if !t.addIcon(t.tipText()) {
		return false
	}

	t.webviewProcCb = windows.NewCallback(t.wndProcWebview)
	orig, _, lastErr := procSetWindowLongPtrW.Call(t.hwnd, gwlpWndProc, t.webviewProcCb)
	if orig == 0 {
		if errno, isErrno := lastErr.(syscall.Errno); isErrno && errno != 0 {
			return false
		}
	}
	t.origProc = orig

	t.ok = true
	return true
}

// ---- icon + tooltip ------------------------------------------------------

func (t *tray) notifyData(flags uint32) notifyIconData {
	nid := notifyIconData{}
	nid.cbSize = uint32(unsafe.Sizeof(nid))
	nid.hWnd = t.msgHwnd
	nid.uID = 1
	nid.uFlags = flags
	nid.uCallbackMessage = t.cbMsg
	nid.hIcon = t.hicon
	return nid
}

func (t *tray) addIcon(tip string) bool {
	nid := t.notifyData(nifMessage | nifIcon | nifTip)
	copyUni16(nid.szTip[:], tip)

	t.mu.Lock()
	t.lastTip = tip
	t.mu.Unlock()

	r, _, _ := procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&nid)))
	return r != 0
}

func (t *tray) tipText() string {
	if t.app == nil || t.app.gw == nil {
		return appName
	}
	return appName + " · " + stateLabel(t.app.gw.Status())
}

// setTip updates the hover tooltip. Safe to call from any goroutine.
func (t *tray) setTip(text string) {
	if t.msgHwnd == 0 || !t.ok {
		return
	}
	t.mu.Lock()
	if text == t.lastTip {
		t.mu.Unlock()
		return
	}
	t.lastTip = text
	t.mu.Unlock()

	nid := t.notifyData(nifTip)
	copyUni16(nid.szTip[:], text)
	_, _, _ = procShellNotifyIconW.Call(nimModify, uintptr(unsafe.Pointer(&nid)))
}

// remove deletes the tray icon. It is idempotent.
func (t *tray) remove() {
	t.mu.Lock()
	if t.removed {
		t.mu.Unlock()
		return
	}
	t.removed = true
	msgHwnd, hicon := t.msgHwnd, t.hicon
	t.mu.Unlock()

	if msgHwnd != 0 {
		nid := t.notifyData(0)
		nid.hWnd = msgHwnd
		_, _, _ = procShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
	}
	destroyIcon(hicon)
}

// ---- window procedures ---------------------------------------------------

func (t *tray) wndProcWebview(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmClose:
		if t.ok {
			// Hide to tray instead of exiting.
			showWindowState(hwnd, swHide)
			return 0
		}
	case wmAppQuit:
		t.remove()
		_, _, _ = procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		t.remove()
	}
	return callWindowProc(t.origProc, hwnd, msg, wp, lp)
}

func (t *tray) wndProcTray(hwnd, msg, wp, lp uintptr) uintptr {
	if msg == uintptr(t.cbMsg) {
		switch lp {
		case wmLButtonUp, wmLButtonDblClk:
			t.showWindow()
		case wmRButtonUp:
			t.showMenu()
		}
		return 0
	}
	if msg == wmDestroy {
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}

func (t *tray) showWindow() {
	if t.hwnd == 0 {
		return
	}
	if iconic, _, _ := procIsIconic.Call(t.hwnd); iconic != 0 {
		showWindowState(t.hwnd, swRestore)
	} else {
		showWindowState(t.hwnd, swShow)
	}
	_, _, _ = procSetForegroundWindow.Call(t.hwnd)
}

func (t *tray) showMenu() {
	if t.msgHwnd == 0 {
		return
	}
	menu, _, _ := procCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)

	items := []struct {
		id    uint32
		label string
	}{
		{trayIDShowWindow, "显示窗口"},
		{trayIDStartGateway, "启动网关"},
		{trayIDStopGateway, "停止网关"},
		{trayIDLaunchAccio, "启动 Accio"},
		{trayIDQuit, "退出"},
	}
	for _, it := range items {
		label, err := windows.UTF16PtrFromString(it.label)
		if err != nil {
			continue
		}
		_, _, _ = procAppendMenuW.Call(menu, 0, uintptr(it.id), uintptr(unsafe.Pointer(label)))
	}

	var pt point
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	_, _, _ = procSetForegroundWindow.Call(t.msgHwnd)
	cmd, _, _ := procTrackPopupMenu.Call(
		menu,
		tpmRightButton|tpmReturnCmd,
		uintptr(pt.X),
		uintptr(pt.Y),
		0,
		t.msgHwnd,
		0,
	)
	_, _, _ = procPostMessageW.Call(t.msgHwnd, wmNull, 0, 0)

	t.handleCommand(uint32(cmd))
}

func (t *tray) handleCommand(cmd uint32) {
	if t.app == nil {
		return
	}
	switch cmd {
	case trayIDShowWindow:
		t.showWindow()
	case trayIDStartGateway:
		go t.app.startGateway()
	case trayIDStopGateway:
		go t.app.stopGateway()
	case trayIDLaunchAccio:
		go t.app.launchAccio()
	case trayIDQuit:
		t.app.requestQuit()
	}
}

// ---- gateway actions invoked from the tray -------------------------------

const launchTimeout = 20 * time.Second

func (a *appContext) startGateway() {
	_ = a.gw.Start()
	a.refreshTip()
}

func (a *appContext) stopGateway() {
	_ = a.gw.Stop()
	a.refreshTip()
}

func (a *appContext) launchAccio() {
	st := a.gw.Status()
	if st.State != stateRunning {
		if err := a.gw.Start(); err != nil {
			a.refreshTip()
			return
		}
		st = a.gw.Status()
	}
	if st.Port <= 0 {
		return
	}

	req, err := http.NewRequest(http.MethodPost,
		"http://127.0.0.1:"+itoa(st.Port)+"/api/bridge/accio/launch",
		strings.NewReader("{}"))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: launchTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
	a.refreshTip()
}

// refreshTip pushes the current gateway state into the tray tooltip.
func (a *appContext) refreshTip() {
	if a.tray == nil || a.webview == nil {
		return
	}
	text := a.tray.tipText()
	// Shell_NotifyIcon is safest on the thread that owns the icon.
	a.webview.Dispatch(func() { a.tray.setTip(text) })
}

// requestQuit asks the window thread to tear the window down (WM_QUIT then
// ends Run()). Safe to call from any goroutine.
func (a *appContext) requestQuit() {
	a.quitOnce.Do(func() {
		if a.tray != nil && a.tray.hwnd != 0 {
			_, _, _ = procPostMessageW.Call(a.tray.hwnd, wmAppQuit, 0, 0)
		}
	})
}

// hideWindow hides the window to the tray. Called from an HTTP handler.
func (a *appContext) hideWindow() {
	if a.tray == nil {
		return
	}
	if a.webview == nil {
		return
	}
	a.webview.Dispatch(func() { showWindowState(a.tray.hwnd, swHide) })
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func stateLabel(st GatewayStatus) string {
	switch st.State {
	case stateRunning:
		if st.Managed {
			return "网关运行中（受管）"
		}
		return "网关运行中（外部）"
	case stateStarting:
		return "网关启动中…"
	case stateStopping:
		return "网关停止中…"
	case stateError:
		if st.LastError != "" {
			return "网关错误：" + st.LastError
		}
		return "网关错误"
	default:
		return "网关已停止"
	}
}

var errNoTray = errors.New("系统托盘不可用")
