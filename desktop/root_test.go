package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeServerScript(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "server.js"), []byte("// stub\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func absClean(t *testing.T, p string) string {
	t.Helper()
	a, err := filepath.Abs(p)
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(a)
}

func TestResolveRootEnvTakesPriority(t *testing.T) {
	envRoot := t.TempDir()
	writeServerScript(t, envRoot)

	walkRoot := t.TempDir()
	writeServerScript(t, walkRoot)
	deep := filepath.Join(walkRoot, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveRoot(deep, envRoot)
	if err != nil {
		t.Fatalf("resolveRoot returned error: %v", err)
	}
	if got != absClean(t, envRoot) {
		t.Fatalf("resolveRoot = %q, want env root %q", got, absClean(t, envRoot))
	}
}

func TestResolveRootWalksUp(t *testing.T) {
	root := t.TempDir()
	writeServerScript(t, root)
	deep := filepath.Join(root, "x", "y", "z")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := resolveRoot(deep, "")
	if err != nil {
		t.Fatalf("resolveRoot returned error: %v", err)
	}
	if got != absClean(t, root) {
		t.Fatalf("resolveRoot = %q, want %q", got, absClean(t, root))
	}
}

func TestResolveRootRejectsInvalidEnv(t *testing.T) {
	root := t.TempDir() // no src/server.js anywhere below a temp dir
	missing := filepath.Join(root, "does-not-exist")

	_, err := resolveRoot(missing, missing)
	if err == nil {
		t.Skip("an ancestor unexpectedly contains src/server.js")
	}
	if !strings.Contains(err.Error(), "ACCIO_BRIDGE_ROOT") {
		t.Fatalf("error should mention the invalid env var, got: %v", err)
	}
}

func TestResolveGatewayPortFromConfig(t *testing.T) {
	root := t.TempDir()
	cfgPath := filepath.Join(root, "config.json")
	if err := os.WriteFile(cfgPath, []byte(`{"server":{"host":"127.0.0.1","port":9123}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port, used := resolveGatewayPort(root, "")
	if port != 9123 {
		t.Fatalf("port = %d, want 9123", port)
	}
	if used != cfgPath {
		t.Fatalf("config path = %q, want %q", used, cfgPath)
	}
}

func TestResolveGatewayPortMissingConfig(t *testing.T) {
	root := t.TempDir()
	port, _ := resolveGatewayPort(root, "")
	if port != defaultPort {
		t.Fatalf("port = %d, want default %d", port, defaultPort)
	}
}

func TestResolveGatewayPortBadJSON(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(`{"server":{"port":`), 0o644); err != nil {
		t.Fatal(err)
	}
	port, _ := resolveGatewayPort(root, "")
	if port != defaultPort {
		t.Fatalf("port = %d, want default %d on malformed JSON", port, defaultPort)
	}
}

func TestResolveGatewayPortEnvConfigWins(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(`{"server":{"port":1111}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	envCfg := filepath.Join(t.TempDir(), "custom.json")
	if err := os.WriteFile(envCfg, []byte(`{"server":{"port":2222}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	port, used := resolveGatewayPort(root, envCfg)
	if port != 2222 {
		t.Fatalf("port = %d, want 2222 from ACCIO_BRIDGE_CONFIG", port)
	}
	if used != envCfg {
		t.Fatalf("config path = %q, want %q", used, envCfg)
	}
}

func TestResolveGatewayPortStringPort(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(`{"server":{"port":"3333"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	port, _ := resolveGatewayPort(root, "")
	if port != 3333 {
		t.Fatalf("port = %d, want 3333", port)
	}
}

func TestResolveGatewayPortToleratesUTF8BOM(t *testing.T) {
	root := t.TempDir()
	data := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"server":{"port":4444}}`)...)
	if err := os.WriteFile(filepath.Join(root, "config.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	port, _ := resolveGatewayPort(root, "")
	if port != 4444 {
		t.Fatalf("port = %d, want 4444 from BOM-prefixed config", port)
	}
}

func TestResolveNodeIgnoresMissingEnvFile(t *testing.T) {
	bogus := filepath.Join(t.TempDir(), "nope.exe")
	got, ok := resolveNode(bogus)
	if ok && filepath.Clean(got) == filepath.Clean(bogus) {
		t.Fatalf("resolveNode returned the non-existent ACCIO_NODE path %q", bogus)
	}
	if !ok {
		t.Skip("node is not installed on PATH and ACCIO_NODE is unset")
	}
}

func TestNewTokenIsRandomHex(t *testing.T) {
	a, b := newToken(), newToken()
	if len(a) != 64 {
		t.Fatalf("token length = %d, want 64 hex chars", len(a))
	}
	if a == b {
		t.Fatal("two generated tokens should differ")
	}
}
