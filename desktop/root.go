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
	appName     = "Accio Bridge"
	appVersion  = "0.1.0"
	defaultPort = 8080
)

// resolveRoot determines the project root that contains src/server.js.
// Priority: ACCIO_BRIDGE_ROOT environment variable (when it points at a valid
// root), then a walk up the directory tree starting at exeDir.
func resolveRoot(exeDir, envRoot string) (string, error) {
	envRoot = strings.TrimSpace(envRoot)
	if envRoot != "" {
		if dir, ok := existingDir(envRoot); ok && hasServerScript(dir) {
			return dir, nil
		}
	}

	dir := strings.TrimSpace(exeDir)
	for dir != "" {
		if hasServerScript(dir) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir || parent == "" {
			break
		}
		dir = parent
	}

	if envRoot != "" {
		return "", fmt.Errorf("未找到项目根：环境变量 ACCIO_BRIDGE_ROOT=%q 不是有效根（缺少 src/server.js），且从 %q 向上未找到 src/server.js", envRoot, exeDir)
	}
	return "", fmt.Errorf("未找到项目根：从 %q 向上未找到含 src/server.js 的目录，可用环境变量 ACCIO_BRIDGE_ROOT 指定", exeDir)
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
