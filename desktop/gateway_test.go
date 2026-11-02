//go:build windows

package main

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestExternalGatewayIsAdoptedAndStopRefused ensures a bridge that this app did
// not start is reused (managed=false) and never killed.
func TestExternalGatewayIsAdoptedAndStopRefused(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"upstream":"fake","models":["m"]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	root := t.TempDir()
	gw := NewGatewayManager(root, "", false, mustPort(t, ts.URL))
	defer gw.Shutdown()

	gw.Sync()
	st := gw.Status()
	if st.State != stateRunning {
		t.Fatalf("state = %q, want running", st.State)
	}
	if st.Managed {
		t.Fatal("an adopted bridge must not be managed")
	}
	if st.PID != 0 {
		t.Fatalf("pid = %d, want 0 for an adopted bridge", st.PID)
	}

	err := gw.Stop()
	if err == nil {
		t.Fatal("Stop must be refused for an external bridge")
	}
	if !errors.Is(err, errNotManaged) {
		t.Fatalf("Stop error = %v, want errNotManaged", err)
	}

	// The external process must still be alive.
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("external gateway was killed: %v", err)
	}
	_ = resp.Body.Close()

	// Nothing was written to the pid file.
	if _, statErr := os.Stat(filepath.Join(root, ".accio-bridge.pid")); statErr == nil {
		t.Fatal("no pid file should be written when reusing an external bridge")
	}
}

func TestSyncReportsBusyPortWithoutKillingIt(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	port := ln.Addr().(*net.TCPAddr).Port

	root := t.TempDir()
	gw := NewGatewayManager(root, "", false, port)
	gw.Sync()

	st := gw.Status()
	if st.State != stateError {
		t.Fatalf("state = %q, want error for an occupied port", st.State)
	}
	if !strings.Contains(st.LastError, "已被其它程序占用") {
		t.Fatalf("lastError = %q, want the port-occupied explanation", st.LastError)
	}
	if st.Managed {
		t.Fatal("nothing must be managed when the port is owned by another program")
	}

	// Starting must also refuse instead of spawning a competing process.
	if err := gw.Start(); err == nil {
		t.Fatal("Start must fail when the port is occupied by another program")
	}

	// The foreign listener must still be alive.
	if _, err := net.Dial("tcp", ln.Addr().String()); err != nil {
		t.Fatalf("foreign process was killed: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(root, ".accio-bridge.pid")); statErr == nil {
		t.Fatal("no pid file should be written for a foreign process")
	}
}

func TestStartFailsWithoutNode(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	gw := NewGatewayManager(t.TempDir(), "", false, port)
	err = gw.Start()
	if err == nil {
		t.Fatal("Start must fail when node could not be found")
	}
	if !strings.Contains(err.Error(), "node") && !strings.Contains(err.Error(), "src/server.js") {
		t.Fatalf("unexpected error: %v", err)
	}
	st := gw.Status()
	if st.State != stateError {
		t.Fatalf("state = %q, want error", st.State)
	}
	if st.Managed {
		t.Fatal("no process may be managed after a failed start")
	}
}

func TestHealthTickDetectsExternalBridgeDisappearing(t *testing.T) {
	alive := true
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !alive {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	port := mustPort(t, ts.URL)

	gw := NewGatewayManager(t.TempDir(), "", false, port)
	defer gw.Shutdown()

	gw.Sync()
	if st := gw.Status(); st.State != stateRunning {
		t.Fatalf("state = %q, want running", st.State)
	}

	alive = false
	ts.Close()

	gw.healthTick()
	if st := gw.Status(); st.State != stateStopped {
		t.Fatalf("state = %q, want stopped after the external bridge vanished", st.State)
	}
}

// TestStartReportsNodeStderrOnEarlyExit ensures fatal startup errors (which
// never reach bridge.log) are surfaced in lastError and survive health ticks.
func TestStartReportsNodeStderrOnEarlyExit(t *testing.T) {
	nodePath, ok := resolveNode("")
	if !ok {
		t.Skip("node is not installed")
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	script := "console.error('listen EACCES: permission denied 127.0.0.1:1'); process.exit(1);"
	if err := os.WriteFile(filepath.Join(root, "src", "server.js"), []byte(script), 0o644); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	gw := NewGatewayManager(root, nodePath, true, port)
	defer gw.Shutdown()
	if err := gw.Start(); err == nil {
		t.Fatal("Start must fail when node exits immediately")
	}
	st := gw.Status()
	if st.State != stateError || !strings.Contains(st.LastError, "EACCES") {
		t.Fatalf("state=%q lastError=%q, want error containing node stderr", st.State, st.LastError)
	}
	gw.healthTick()
	if st := gw.Status(); st.State != stateError || st.LastError == "" {
		t.Fatalf("health tick cleared a real failure: state=%q lastError=%q", st.State, st.LastError)
	}
	if _, statErr := os.Stat(filepath.Join(root, ".accio-bridge.pid")); statErr == nil {
		t.Fatal("pid file must be removed after a failed start")
	}
}

// TestSyncRemovesOnlyStalePidFile: a crash leaves a pid file behind; the next
// launch must drop it, but never one that points at a live process.
func TestSyncRemovesOnlyStalePidFile(t *testing.T) {
	root := t.TempDir()
	pidFile := filepath.Join(root, ".accio-bridge.pid")
	if err := os.WriteFile(pidFile, []byte("999999999"), 0o644); err != nil {
		t.Fatal(err)
	}
	gw := NewGatewayManager(root, "", false, 1)
	gw.Sync()
	if _, err := os.Stat(pidFile); err == nil {
		t.Fatal("stale pid file should be removed")
	}

	if err := os.WriteFile(pidFile, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		t.Fatal(err)
	}
	gw.Sync()
	if _, err := os.Stat(pidFile); err != nil {
		t.Fatal("pid file of a live process must be kept")
	}
}

func TestHealthTickClearsPortErrorOnceFree(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	gw := NewGatewayManager(t.TempDir(), "", false, port)
	gw.Sync()
	if st := gw.Status(); st.State != stateError {
		t.Fatalf("state = %q, want error while the port is busy", st.State)
	}
	gw.healthTick()
	if st := gw.Status(); st.State != stateError {
		t.Fatalf("state = %q, want error to persist while the port is still busy", st.State)
	}
	_ = ln.Close()
	gw.healthTick()
	if st := gw.Status(); st.State != stateStopped {
		t.Fatalf("state = %q, want stopped once the port is free", st.State)
	}
}
