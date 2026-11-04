//go:build windows

package main

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ---- dynamically resolved Win32 entry points (no CGO) --------------------

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")

	procSetWindowLongPtrW             = user32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW               = user32.NewProc("CallWindowProcW")
	procDefWindowProcW                = user32.NewProc("DefWindowProcW")
	procRegisterClassExW              = user32.NewProc("RegisterClassExW")
	procCreateWindowExW               = user32.NewProc("CreateWindowExW")
	procDestroyWindow                 = user32.NewProc("DestroyWindow")
	procShowWindow                    = user32.NewProc("ShowWindow")
	procIsWindowVisible               = user32.NewProc("IsWindowVisible")
	procIsIconic                      = user32.NewProc("IsIconic")
	procSetForegroundWindow           = user32.NewProc("SetForegroundWindow")
	procSendMessageW                  = user32.NewProc("SendMessageW")
	procPostMessageW                  = user32.NewProc("PostMessageW")
	procPostQuitMessage               = user32.NewProc("PostQuitMessage")
	procFindWindowW                   = user32.NewProc("FindWindowW")
	procCreatePopupMenu               = user32.NewProc("CreatePopupMenu")
	procAppendMenuW                   = user32.NewProc("AppendMenuW")
	procTrackPopupMenu                = user32.NewProc("TrackPopupMenu")
	procDestroyMenu                   = user32.NewProc("DestroyMenu")
	procGetCursorPos                  = user32.NewProc("GetCursorPos")
	procCreateIconIndirect            = user32.NewProc("CreateIconIndirect")
	procDestroyIcon                   = user32.NewProc("DestroyIcon")
	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDPIAware            = user32.NewProc("SetProcessDPIAware")
	procGetDpiForSystem               = user32.NewProc("GetDpiForSystem")
	procGetSystemMetrics              = user32.NewProc("GetSystemMetrics")
	procMessageBoxW                   = user32.NewProc("MessageBoxW")

	procShellNotifyIconW = shell32.NewProc("Shell_NotifyIconW")

	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procCreateBitmap       = gdi32.NewProc("CreateBitmap")
	procDeleteObject       = gdi32.NewProc("DeleteObject")

	procCreateMutexW = kernel32.NewProc("CreateMutexW")
	procCloseHandle  = kernel32.NewProc("CloseHandle")
)

// ---- constants -----------------------------------------------------------

const (
	wmDestroy   = 0x0002
	wmClose     = 0x0010
	wmNull      = 0x0000
	wmSetIcon   = 0x0080
	wmLButtonUp = 0x0202

	wmLButtonDblClk = 0x0203
	wmRButtonUp     = 0x0205

	swHide    = 0
	swShow    = 5
	swRestore = 9

	iconSmall = 0
	iconBig   = 1

	tpmRightButton = 0x0002
	tpmReturnCmd   = 0x0100

	nimAdd    = 0x00000000
	nimModify = 0x00000001
	nimDelete = 0x00000002

	nifMessage = 0x00000001
	nifIcon    = 0x00000002
	nifTip     = 0x00000004

	errorAlreadyExists = 183
	dibRGBColors       = 0
)

// wmAppBase is the first free WM_APP slot used by this process.
const wmAppBase = 0x8000

// wmAppQuit asks the window (on its own thread) to tear down and post WM_QUIT.
const wmAppQuit = wmAppBase + 1

// gwlpWndProc is GWLP_WNDPROC (-4) as a pointer-sized value.
const gwlpWndProc = ^uintptr(0) - 3

// hwndMessage is HWND_MESSAGE (-3): parent handle for message-only windows.
const hwndMessage = ^uintptr(0) - 2

// dpiAwarenessPerMonitorV2 is DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4).
const dpiAwarenessPerMonitorV2 = ^uintptr(0) - 3

// GetSystemMetrics indices for the primary screen size.
const (
	smCXScreen = 0
	smCYScreen = 1
)

// ---- structs -------------------------------------------------------------

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     windows.Handle
	hIcon         windows.Handle
	hCursor       windows.Handle
	hbrBackground windows.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       windows.Handle
}

type point struct {
	X int32
	Y int32
}

type iconInfo struct {
	fIcon    int32
	xHotspot uint32
	yHotspot uint32
	hbmMask  windows.Handle
	hbmColor windows.Handle
}

type bitmapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

type bitmapInfo struct {
	header bitmapInfoHeader
	colors [3]uint32
}

type notifyIconData struct {
	cbSize           uint32
	hWnd             uintptr
	uID              uint32
	uFlags           uint32
	uCallbackMessage uint32
	hIcon            uintptr
	szTip            [128]uint16
	dwState          uint32
	dwStateMask      uint32
	szInfo           [256]uint16
	uVersion         uint32
	szInfoTitle      [64]uint16
	dwInfoFlags      uint32
	guidItem         [16]byte
	hBalloonIcon     uintptr
}

// ---- low level helpers ---------------------------------------------------

func callWindowProc(proc, hwnd, msg, wp, lp uintptr) uintptr {
	if proc == 0 {
		r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
		return r
	}
	r, _, _ := procCallWindowProcW.Call(proc, hwnd, msg, wp, lp)
	return r
}

func setDpiAwareness() {
	if r, _, _ := procSetProcessDpiAwarenessContext.Call(dpiAwarenessPerMonitorV2); r != 0 {
		return
	}
	_, _, _ = procSetProcessDPIAware.Call()
}

// systemDPIScale returns the primary-monitor scale factor (1.0 at 96 DPI).
// The process is DPI-aware, so window sizes passed to Win32 are physical
// pixels and must be scaled to keep the intended logical size.
func systemDPIScale() float64 {
	if err := procGetDpiForSystem.Find(); err != nil {
		return 1
	}
	dpi, _, _ := procGetDpiForSystem.Call()
	if dpi == 0 {
		return 1
	}
	return float64(dpi) / 96.0
}

// scaledWindowSize converts a logical size to physical pixels, clamped to
// 90% of the primary screen so the window never opens off-screen.
func scaledWindowSize(w, h int) (int, int) {
	s := systemDPIScale()
	pw, ph := int(float64(w)*s), int(float64(h)*s)
	sw, _, _ := procGetSystemMetrics.Call(smCXScreen)
	sh, _, _ := procGetSystemMetrics.Call(smCYScreen)
	if sw > 0 && pw > int(sw)*9/10 {
		pw = int(sw) * 9 / 10
	}
	if sh > 0 && ph > int(sh)*9/10 {
		ph = int(sh) * 9 / 10
	}
	return pw, ph
}

// createMutex creates (or opens) a named mutex. second return value reports a
// pre-existing mutex, which is how single-instance detection works.
func createMutex(name string) (windows.Handle, bool) {
	n, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, false
	}
	r, _, lastErr := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(n)))
	if r == 0 {
		return 0, false
	}
	if errno, ok := lastErr.(syscall.Errno); ok && uintptr(errno) == errorAlreadyExists {
		return windows.Handle(r), true
	}
	return windows.Handle(r), false
}

func closeHandle(h windows.Handle) {
	if h != 0 {
		_, _, _ = procCloseHandle.Call(uintptr(h))
	}
}

// activateExistingWindow brings an already running instance to the front.
func activateExistingWindow(title string) bool {
	n, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return false
	}
	hwnd, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(n)))
	if hwnd == 0 {
		return false
	}
	_, _, _ = procShowWindow.Call(hwnd, swRestore)
	_, _, _ = procSetForegroundWindow.Call(hwnd)
	return true
}

func showWindowState(hwnd uintptr, cmd int32) {
	if hwnd == 0 {
		return
	}
	_, _, _ = procShowWindow.Call(hwnd, uintptr(cmd))
}

func copyUni16(dst []uint16, s string) {
	u := windows.StringToUTF16(s)
	n := copy(dst, u)
	if n >= len(dst) {
		dst[len(dst)-1] = 0
		return
	}
	dst[n] = 0
}

// createAppIcon draws a rounded square icon at runtime (no embedded .ico).
func createAppIcon() uintptr {
	const (
		w = 32
		h = 32
		r = 8
	)

	hdc, _, _ := procCreateCompatibleDC.Call(0)
	if hdc == 0 {
		return 0
	}
	defer procDeleteDC.Call(hdc)

	bmi := bitmapInfo{}
	bmi.header.biSize = uint32(unsafe.Sizeof(bitmapInfoHeader{}))
	bmi.header.biWidth = w
	bmi.header.biHeight = -h // top-down
	bmi.header.biPlanes = 1
	bmi.header.biBitCount = 32
	bmi.header.biCompression = 0

	var bits unsafe.Pointer
	hbmColor, _, _ := procCreateDIBSection.Call(
		hdc,
		uintptr(unsafe.Pointer(&bmi)),
		dibRGBColors,
		uintptr(unsafe.Pointer(&bits)),
		0,
		0,
	)
	if hbmColor == 0 || bits == nil {
		return 0
	}
	defer procDeleteObject.Call(hbmColor)

	px := unsafe.Slice((*uint32)(bits), w*h)
	// BGRA, premultiplied alpha not required for icons.
	const bg = uint32(0xEB6325FF)   // #2563EB blue with A=FF (0xAARRGGBB)
	const fg = uint32(0xFFFFFFFF)   // opaque white marker
	const none = uint32(0x00000000) // fully transparent

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if !inRoundedRect(x, y, w, h, r) {
				px[y*w+x] = none
				continue
			}
			// small white inner square so the icon reads as a "window"
			if x >= 10 && x < 22 && y >= 10 && y < 22 {
				px[y*w+x] = fg
			} else {
				px[y*w+x] = bg
			}
		}
	}

	hbmMask, _, _ := procCreateBitmap.Call(w, h, 1, 1, 0)
	if hbmMask == 0 {
		return 0
	}
	defer procDeleteObject.Call(hbmMask)

	ii := iconInfo{fIcon: 1, hbmMask: windows.Handle(hbmMask), hbmColor: windows.Handle(hbmColor)}
	hicon, _, _ := procCreateIconIndirect.Call(uintptr(unsafe.Pointer(&ii)))
	return hicon
}

func inRoundedRect(x, y, w, h, r int) bool {
	cx, cy := -1, -1
	if x < r {
		cx = r - 1
	} else if x >= w-r {
		cx = w - r
	}
	if y < r {
		cy = r - 1
	} else if y >= h-r {
		cy = h - r
	}
	if cx < 0 || cy < 0 {
		return true
	}
	dx, dy := x-cx, y-cy
	return dx*dx+dy*dy <= r*r
}

func destroyIcon(hicon uintptr) {
	if hicon != 0 {
		_, _, _ = procDestroyIcon.Call(hicon)
	}
}

// showMessageBox reports a startup failure to the user. The shell is linked with
// -H windowsgui, so nothing reaches stderr: without this, launching it from a
// folder that is not a gateway root looks like "double-click does nothing".
func showMessageBox(title, text string) {
	const (
		mbIconError = 0x00000010
		mbSetFg     = 0x00010000
		mbTopmost   = 0x00040000
	)
	titlePtr, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	textPtr, err := windows.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	_, _, _ = procMessageBoxW.Call(0,
		uintptr(unsafe.Pointer(textPtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		mbIconError|mbSetFg|mbTopmost)
}
