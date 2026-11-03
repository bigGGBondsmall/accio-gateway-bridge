package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	appName        = "Accio Bridge"
	appVersion     = "0.1.0"
	defaultPort    = 8080
	rustEngineName = "accio-gateway-bridge-rust.exe"
)

// resolveRoot determines the gateway root: the directory that owns config.json and the
// engine process. Two layouts are accepted: the Node bridge (src/server.js) and the Rust
// gateway (config.json plus a built accio-gateway-bridge-rust.exe under target/).
// Priority: ACCIO_BRIDGE_ROOT environment variable (when it points at a valid root),
// then a walk up the directory tree starting at exeDir.
func resolveRoot(exeDir, envRoot string) (string, error) {
	envRoot = strings.TrimSpace(envRoot)
	if envRoot != "" {
		if dir, ok := existingDir(envRoot); ok && isGatewayRoot(dir) {
			return dir, nil
		}
	}

	dir := strings.TrimSpace(exeDir)
	for dir != "" {
		if isGatewayRoot(dir) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir || parent == "" {
			break
		}
		dir = parent
	}

	shape := "含 src/server.js，或含 config.json 与已构建 " + rustEngineName + " 的目录"
	if envRoot != "" {
		return "", fmt.Errorf("未找到网关根：环境变量 ACCIO_BRIDGE_ROOT=%q 不是有效根（应为%s），且从 %q 向上也未找到", envRoot, shape, exeDir)
	}
	return "", fmt.Errorf("未找到网关根：从 %q 向上未找到%s，可用环境变量 ACCIO_BRIDGE_ROOT 指定", exeDir, shape)
}

// isGatewayRoot reports whether dir can act as the gateway root.
func isGatewayRoot(dir string) bool {
	if hasServerScript(dir) {
		return true
	}
	_, ok := rustEnginePath(dir)
	return ok
}

// rustEnginePath finds a built Rust gateway inside dir. The candidates match the Rust
// source package layout, where the build output lives under target/. A config.json must be
// present: without it the directory is not a gateway root, just a directory.
func rustEnginePath(dir string) (string, bool) {
	if strings.TrimSpace(dir) == "" {
		return "", false
	}
	if st, err := os.Stat(filepath.Join(dir, "config.json")); err != nil || st.IsDir() {
		return "", false
	}
	for _, rel := range []string{
		filepath.Join("target", "release", rustEngineName),
		filepath.Join("target", "debug", rustEngineName),
		rustEngineName,
	} {
		candidate := filepath.Join(dir, rel)
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate, true
		}
	}
	return "", false
}

// engineSpec is the engine process the shell supervises.
type engineSpec struct {
	path  string
	args  []string
	rust  bool
	found bool
}

// resolveEngine picks the engine to spawn. ACCIO_BRIDGE_ENGINE wins, then a Rust gateway
// found in the root, then the Node bridge. Adoption of an already healthy gateway happens
// before any spawn, so a running Rust gateway is reused rather than duplicated.
func resolveEngine(root, envEngine, configPath, nodePath string, nodeFound bool) engineSpec {
	if p := strings.TrimSpace(envEngine); p != "" {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			if abs, aerr := filepath.Abs(p); aerr == nil {
				p = abs
			}
			return engineSpec{path: p, args: []string{"--config", configPath}, rust: true, found: true}
		}
	}
	if p, ok := rustEnginePath(root); ok {
		return engineSpec{path: p, args: []string{"--config", configPath}, rust: true, found: true}
	}
	return engineSpec{path: nodePath, args: []string{filepath.Join("src", "server.js")}, found: nodeFound}
}

func existingDir(p string) (string, bool) {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return "", false
	}
	return filepath.Clean(abs), true
}

func hasServerScript(dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	st, err := os.Stat(filepath.Join(dir, "src", "server.js"))
	return err == nil && !st.IsDir()
}

// resolveNode resolves the node executable. ACCIO_NODE wins, otherwise LookPath.
func resolveNode(envNode string) (string, bool) {
	if p := strings.TrimSpace(envNode); p != "" {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			if abs, aerr := filepath.Abs(p); aerr == nil {
				return abs, true
			}
			return p, true
		}
	}
	if p, err := exec.LookPath("node"); err == nil {
		if abs, aerr := filepath.Abs(p); aerr == nil {
			return abs, true
		}
		return p, true
	}
	return "", false
}

// resolveGatewayPort reads the bridge port from ACCIO_BRIDGE_CONFIG or
// <root>/config.json (server.port). Missing or malformed configuration falls
// back to 8080. The second return value is the config path that was consulted.
func resolveGatewayPort(root, envConfig string) (int, string) {
	configPath := strings.TrimSpace(envConfig)
	if configPath == "" {
		configPath = filepath.Join(root, "config.json")
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return defaultPort, configPath
	}
	// Notepad / PowerShell 5 often save UTF-8 with a BOM, which encoding/json rejects.
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})

	var raw struct {
		Server struct {
			Port any `json:"port"`
		} `json:"server"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return defaultPort, configPath
	}

	switch v := raw.Server.Port.(type) {
	case float64:
		if p := int(v); p > 0 && p <= 65535 && float64(p) == v {
			return p, configPath
		}
	case string:
		if p, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && p > 0 && p <= 65535 {
			return p, configPath
		}
	}
	return defaultPort, configPath
}
