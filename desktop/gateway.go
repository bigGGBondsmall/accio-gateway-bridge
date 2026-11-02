//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Gateway states as defined by desktop/CONTRACT.md.
const (
	stateStopped  = "stopped"
	stateStarting = "starting"
	stateRunning  = "running"
	stateStopping = "stopping"
	stateError    = "error"
)

const (
	createNoWindow    = 0x08000000
	startupTimeout    = 8 * time.Second
	healthInterval    = 3 * time.Second
	defaultProbeTO    = 800 * time.Millisecond
	spawnPollInterval = 200 * time.Millisecond
	stderrTailBytes   = 2048
)

// NotManagedError is returned by Stop/Restart when the running bridge was
// adopted from outside this application.
var errNotManaged = errors.New("gateway is not managed by this app")

// GatewayStatus is the wire shape of the gateway object in /host/state.
type GatewayStatus struct {
	State     string `json:"state"`
	Managed   bool   `json:"managed"`
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	URL       string `json:"url"`
	StartedAt string `json:"startedAt"`
	LastError string `json:"lastError"`
}

type managedProcess struct {
	cmd           *exec.Cmd
	devnull       *os.File
	stderr        *tailBuffer
	done          chan struct{} // closed as soon as the process has exited
	stopRequested bool
}

// GatewayManager supervises the Node bridge: it either adopts an already
// running instance or spawns `node src/server.js` with a hidden window.
type GatewayManager struct {
	root      string
	logFile   string
	pidFile   string
	nodePath  string
	nodeFound bool
	port      int

	// opMu serializes start/stop/restart/sync; mu guards the status fields.
	opMu sync.Mutex
	mu   sync.Mutex

	state       string
	managed     bool
	pid         int
	startedAt   time.Time
	lastError   string
	portBusyErr bool // lastError is a port conflict, which clears once the port frees up
	proc        *managedProcess

	healthStop chan struct{}
	healthOnce sync.Once
}

func NewGatewayManager(root, nodePath string, nodeFound bool, port int) *GatewayManager {
	return &GatewayManager{
		root:       root,
		logFile:    filepath.Join(root, "bridge.log"),
		pidFile:    filepath.Join(root, ".accio-bridge.pid"),
		nodePath:   nodePath,
		nodeFound:  nodeFound,
		port:       port,
		state:      stateStopped,
		healthStop: make(chan struct{}),
	}
}

func (g *GatewayManager) Port() int        { return g.port }
func (g *GatewayManager) LogFile() string  { return g.logFile }
func (g *GatewayManager) NodePath() string { return g.nodePath }
func (g *GatewayManager) NodeFound() bool  { return g.nodeFound }

func (g *GatewayManager) BaseURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", g.port)
}

// Status returns a consistent snapshot of the supervisor state.
func (g *GatewayManager) Status() GatewayStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.snapshotLocked()
}

func (g *GatewayManager) snapshotLocked() GatewayStatus {
	started := ""
	if !g.startedAt.IsZero() {
		started = g.startedAt.UTC().Format(time.RFC3339)
	}
	url := ""
	if g.state == stateRunning || g.state == stateStarting {
		url = g.BaseURL()
	}
	return GatewayStatus{
		State:     g.state,
		Managed:   g.managed,
		PID:       g.pid,
		Port:      g.port,
		URL:       url,
		StartedAt: started,
		LastError: g.lastError,
	}
}

func (g *GatewayManager) setLocked(state string, managed bool, pid int, started time.Time, lastErr string) {
	g.state = state
	g.managed = managed
	g.pid = pid
	g.startedAt = started
	g.lastError = lastErr
	g.portBusyErr = false
}

func (g *GatewayManager) setError(msg string) error {
	g.mu.Lock()
	g.setLocked(stateError, false, 0, time.Time{}, msg)
	g.mu.Unlock()
	return errors.New(msg)
}

// Sync performs the startup probe without ever spawning a process:
// healthy bridge -> running (external), busy port -> error, otherwise stopped.
func (g *GatewayManager) Sync() {
	g.opMu.Lock()
	defer g.opMu.Unlock()
	g.syncLocked()
}

func (g *GatewayManager) syncLocked() {
	g.removeStalePidFile()
	if ok, _ := probeGateway(g.port, defaultProbeTO); ok {
		g.mu.Lock()
		g.setLocked(stateRunning, false, 0, time.Time{}, "")
		g.mu.Unlock()
		return
	}
	if portInUse(g.port, defaultProbeTO) {
		g.mu.Lock()
		g.setLocked(stateError, false, 0, time.Time{},
			fmt.Sprintf("端口 %d 已被其它程序占用（/healthz 无响应），未启动网关", g.port))
		g.portBusyErr = true
		g.mu.Unlock()
		return
	}
	g.mu.Lock()
	g.setLocked(stateStopped, false, 0, time.Time{}, "")
	g.mu.Unlock()
}

// Start adopts a healthy external bridge or spawns its own node process.
func (g *GatewayManager) Start() error {
	g.opMu.Lock()
	defer g.opMu.Unlock()

	g.mu.Lock()
	state, managed := g.state, g.managed
	g.mu.Unlock()
	if state == stateRunning {
		_ = managed // already usable; never kill the external instance
		return nil
	}

	g.mu.Lock()
	g.setLocked(stateStarting, false, 0, time.Time{}, "")
	g.mu.Unlock()

	if ok, _ := probeGateway(g.port, defaultProbeTO); ok {
		g.mu.Lock()
		g.setLocked(stateRunning, false, 0, time.Time{}, "")
		g.mu.Unlock()
		return nil
	}

	if portInUse(g.port, defaultProbeTO) {
		err := g.setError(fmt.Sprintf("端口 %d 已被其它程序占用（/healthz 无响应），未启动网关", g.port))
		g.mu.Lock()
		g.portBusyErr = true
		g.mu.Unlock()
		return err
	}

	if !g.nodeFound {
		return g.setError("未找到 node 可执行文件，请安装 Node.js 或设置环境变量 ACCIO_NODE")
	}
	if !hasServerScript(g.root) {
		return g.setError(fmt.Sprintf("项目根 %s 缺少 src/server.js，无法启动网关", g.root))
	}

	if err := g.spawn(); err != nil {
		return g.setError("启动 node 失败: " + err.Error())
	}

	g.mu.Lock()
	proc := g.proc
	g.mu.Unlock()

	deadline := time.Now().Add(startupTimeout)
	exited := false
	for !exited && time.Now().Before(deadline) {
		select {
		case <-proc.done:
			exited = true
			continue
		case <-time.After(spawnPollInterval):
		}
		if ok, _ := probeGateway(g.port, 500*time.Millisecond); ok {
			g.mu.Lock()
			g.state = stateRunning
			g.managed = true
			g.lastError = ""
			g.mu.Unlock()
			return nil
		}
	}

	tail := proc.stderr.String()
	g.killManagedLocked()
	if tail != "" {
		return g.setError("网关启动失败: " + tail)
	}
	return g.setError("网关启动超时或进程意外退出，详见 " + g.logFile)
}

// tailBuffer keeps the end of a process's stderr for error reporting.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > stderrTailBytes {
		t.buf = t.buf[len(t.buf)-stderrTailBytes:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(t.buf))
}

func (g *GatewayManager) spawn() error {
	script := filepath.Join("src", "server.js")
	cmd := exec.Command(g.nodePath, script)
	cmd.Dir = g.root
	cmd.Env = append(os.Environ(),
		"ACCIO_BRIDGE_DAEMON=1",
		"ACCIO_BRIDGE_LOG_FILE="+g.logFile,
	)

	stderr := &tailBuffer{}
	devnull, devErr := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if devErr == nil {
		cmd.Stdin = devnull
		cmd.Stdout = devnull
	}
	// bridge.log has no entry for fatal startup errors; they only reach stderr.
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}

	if err := cmd.Start(); err != nil {
		if devnull != nil {
			_ = devnull.Close()
		}
		return err
	}

	proc := &managedProcess{cmd: cmd, devnull: devnull, stderr: stderr, done: make(chan struct{})}

	g.mu.Lock()
	g.proc = proc
	g.managed = true
	g.pid = cmd.Process.Pid
	g.startedAt = time.Now()
	g.mu.Unlock()

	// Tie the child's lifetime to ours: if the desktop app crashes or is
	// force-killed, Windows closes the job handle and terminates the bridge.
	// Failure is non-fatal (e.g. nested-job restrictions); normal quit still
	// stops the gateway through Shutdown().
	_ = attachKillOnCloseJob(cmd.Process.Pid)

	g.writePidFile(cmd.Process.Pid)
	go g.monitor(proc)
	return nil
}

// removeStalePidFile drops a pid file left by a crashed run whose process no
// longer exists. A live pid is left alone (it may be a CLI-started daemon).
func (g *GatewayManager) removeStalePidFile() {
	data, err := os.ReadFile(g.pidFile)
	if err != nil {
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err == nil && pid > 0 && pidAlive(pid) {
		return
	}
	_ = os.Remove(g.pidFile)
}

// monitor waits for the spawned process and records unexpected exits.
func (g *GatewayManager) monitor(proc *managedProcess) {
	err := proc.cmd.Wait()
	// Signalled before taking opMu: Start holds opMu while it waits for the exit.
	close(proc.done)

	g.opMu.Lock()
	defer g.opMu.Unlock()

	g.mu.Lock()
	if g.proc != proc {
		g.mu.Unlock()
		return
	}
	g.proc = nil
	intentional := proc.stopRequested
	pid := g.pid
	g.setLocked(stateStopped, false, 0, time.Time{}, "")
	if !intentional {
		msg := "网关进程已退出"
		if err != nil {
			msg = fmt.Sprintf("网关进程已退出: %v", err)
		}
		if tail := proc.stderr.String(); tail != "" {
			msg += ": " + tail
		}
		g.setLocked(stateError, false, 0, time.Time{}, msg)
	}
	g.mu.Unlock()

	if proc.devnull != nil {
		_ = proc.devnull.Close()
	}
	if pid != 0 {
		g.removePidFile(pid)
	}

	// An external instance may have appeared in the meantime.
	if intentional {
		return
	}
	if ok, _ := probeGateway(g.port, defaultProbeTO); ok {
		g.mu.Lock()
		g.setLocked(stateRunning, false, 0, time.Time{}, "")
		g.mu.Unlock()
	}
}

// Stop only ever kills a process this application started.
func (g *GatewayManager) Stop() error {
	g.opMu.Lock()
	defer g.opMu.Unlock()
	return g.stopLocked()
}

func (g *GatewayManager) stopLocked() error {
	g.mu.Lock()
	if !g.managed || g.proc == nil {
		g.mu.Unlock()
		return errNotManaged
	}
	proc := g.proc
	pid := g.pid
	proc.stopRequested = true
	g.setLocked(stateStopping, true, pid, g.startedAt, "")
	g.mu.Unlock()

	g.killProcess(proc, pid)
	// Wait for the exit so an immediate restart does not race the port release.
	select {
	case <-proc.done:
	case <-time.After(3 * time.Second):
	}

	g.mu.Lock()
	g.proc = nil
	g.setLocked(stateStopped, false, 0, time.Time{}, "")
	g.mu.Unlock()

	g.removePidFile(pid)

	if proc.devnull != nil {
		_ = proc.devnull.Close()
	}
	return nil
}

// Restart stops a managed gateway (never an external one) and starts again.
func (g *GatewayManager) Restart() error {
	g.opMu.Lock()
	g.mu.Lock()
	managed := g.managed && g.proc != nil
	g.mu.Unlock()
	if managed {
		if err := g.stopLocked(); err != nil {
			g.opMu.Unlock()
			return err
		}
	}
	g.opMu.Unlock()
	return g.Start()
}

// Shutdown stops the gateway when it is managed by this application.
func (g *GatewayManager) Shutdown() {
	g.healthOnce.Do(func() { close(g.healthStop) })
	g.opMu.Lock()
	defer g.opMu.Unlock()
	g.mu.Lock()
	managed := g.managed && g.proc != nil
	g.mu.Unlock()
	if !managed {
		return
	}
	_ = g.stopLocked()
}

func (g *GatewayManager) killManagedLocked() {
	g.mu.Lock()
	proc, pid := g.proc, g.pid
	if proc != nil {
		proc.stopRequested = true
	}
	g.proc = nil
	g.setLocked(stateStopped, false, 0, time.Time{}, "")
	g.mu.Unlock()
	if proc == nil {
		return
	}
	g.killProcess(proc, pid)
	g.removePidFile(pid)
	if proc.devnull != nil {
		_ = proc.devnull.Close()
	}
}

func (g *GatewayManager) killProcess(proc *managedProcess, pid int) {
	if pid <= 0 {
		return
	}
	select {
	case <-proc.done:
		return // already exited; never taskkill a possibly reused pid
	default:
	}
	kill := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	kill.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
	if err := kill.Run(); err != nil {
		if proc.cmd != nil && proc.cmd.Process != nil {
			_ = proc.cmd.Process.Kill()
		}
	}
}

// StartHealthLoop polls every 3s so external bridges appearing/disappearing
// are reflected in the state. Managed processes are tracked by monitor().
func (g *GatewayManager) StartHealthLoop() {
	go func() {
		ticker := time.NewTicker(healthInterval)
		defer ticker.Stop()
		for {
			select {
			case <-g.healthStop:
				return
			case <-ticker.C:
				g.healthTick()
			}
		}
	}()
}

func (g *GatewayManager) healthTick() {
	g.opMu.Lock()
	defer g.opMu.Unlock()

	g.mu.Lock()
	managed := g.managed && g.proc != nil
	g.mu.Unlock()
	if managed {
		return
	}

	if ok, _ := probeGateway(g.port, defaultProbeTO); ok {
		g.mu.Lock()
		if g.state != stateRunning {
			g.setLocked(stateRunning, false, 0, time.Time{}, "")
		}
		g.mu.Unlock()
		return
	}

	busy := portInUse(g.port, defaultProbeTO)

	g.mu.Lock()
	defer g.mu.Unlock()
	if g.state == stateError {
		// Keep failures visible so the user can read lastError. Only a
		// "port occupied" error clears itself, once the port is free again.
		if !g.portBusyErr || busy {
			return
		}
	}
	if g.state != stateStopped {
		g.setLocked(stateStopped, false, 0, time.Time{}, "")
	}
}

// ---- pid file ----------------------------------------------------------

func (g *GatewayManager) writePidFile(pid int) {
	if g.pidFile == "" || pid <= 0 {
		return
	}
	_ = os.WriteFile(g.pidFile, []byte(strconv.Itoa(pid)), 0o644)
}

func (g *GatewayManager) removePidFile(pid int) {
	if g.pidFile == "" {
		return
	}
	data, err := os.ReadFile(g.pidFile)
	if err != nil {
		return
	}
	if cur, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && cur != pid {
		return // somebody else owns this pid file now
	}
	_ = os.Remove(g.pidFile)
}

// ---- probing ----------------------------------------------------------

// probeGateway returns (healthy, reachable). reachable is true when the port
// answered at all (even with a non-200), which is how a foreign process on the
// same port is detected.
func probeGateway(port int, timeout time.Duration) (bool, bool) {
	if port <= 0 {
		return false, false
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
	if err != nil {
		return false, false
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	var v struct {
		Ok bool `json:"ok"`
	}
	if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &v) != nil || !v.Ok {
		return false, true
	}
	return true, true
}

func portInUse(port int, timeout time.Duration) bool {
	if port <= 0 {
		return false
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
