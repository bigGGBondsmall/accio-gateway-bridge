package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const testToken = "0123456789abcdef0123456789abcdef"

// testHost starts the host HTTP service on a random loopback port. gwPort is
// the gateway port the supervisor should consider healthy (0 => stopped).
func testHost(t *testing.T, gwPort int) (base, token string) {
	t.Helper()

	gw := NewGatewayManager(t.TempDir(), "", false, gwPort)
	if gwPort > 0 {
		gw.Sync()
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	h := newHostServer(HostConfig{
		Token:      testToken,
		Version:    appVersion,
		Root:       t.TempDir(),
		LogFile:    "bridge.log",
		ConfigPath: "config.json",
		NodePath:   "node",
		NodeFound:  true,
		Gateway:    gw,
		Listener:   ln,
	})
	go func() { _ = h.Serve() }()
	t.Cleanup(func() {
		h.Close()
		gw.Shutdown()
	})

	return h.BaseURL(), testToken
}

func mustPort(t *testing.T, rawURL string) int {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := net.SplitHostPort(u.Host)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, c := range p {
		n = n*10 + int(c-'0')
	}
	return n
}

func getWith(t *testing.T, rawURL, token string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("X-Host-Token", token)
	}
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("request %s failed: %v", rawURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, string(body)
}

func TestHostTokenEnforced(t *testing.T) {
	base, token := testHost(t, 0)

	if code, body := getWith(t, base+"/host/state", ""); code != http.StatusUnauthorized {
		t.Fatalf("no token: status %d body %s, want 401", code, body)
	}
	if code, _ := getWith(t, base+"/host/state", "wrong-token"); code != http.StatusUnauthorized {
		t.Fatalf("wrong token: status %d, want 401", code)
	}

	code, body := getWith(t, base+"/host/state", token)
	if code != http.StatusOK {
		t.Fatalf("with token: status %d body %s, want 200", code, body)
	}
	var parsed struct {
		Ok      bool   `json:"ok"`
		Version string `json:"version"`
		Root    string `json:"root"`
		Gateway struct {
			State   string `json:"state"`
			Managed bool   `json:"managed"`
			Port    int    `json:"port"`
		} `json:"gateway"`
		Node struct {
			Path  string `json:"path"`
			Found bool   `json:"found"`
		} `json:"node"`
		LogFile string `json:"logFile"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatalf("state body is not valid JSON: %v (%s)", err, body)
	}
	if !parsed.Ok {
		t.Fatalf("state ok = false: %s", body)
	}
	if parsed.Version != appVersion {
		t.Fatalf("version = %q, want %q", parsed.Version, appVersion)
	}
	if parsed.Gateway.State != stateStopped {
		t.Fatalf("gateway state = %q, want stopped", parsed.Gateway.State)
	}
	if !parsed.Node.Found {
		t.Fatalf("node.found = false, want true")
	}
}

func TestHostHeaderIsValidated(t *testing.T) {
	base, _ := testHost(t, 0)

	// Valid Host header (the address we bound to).
	if code, _ := getWith(t, base+"/healthz", ""); code != http.StatusServiceUnavailable {
		t.Fatalf("loopback Host: status %d, want 503 (gateway down)", code)
	}

	// Spoofed Host header -> 403 (DNS rebinding guard).
	req, err := http.NewRequest(http.MethodGet, base+"/healthz", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "evil.example.com"
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("spoofed Host: status %d body %s, want 403", resp.StatusCode, string(body))
	}
	if !strings.Contains(string(body), "forbidden host") {
		t.Fatalf("403 body should explain the reason: %s", string(body))
	}
}

func TestStaticServesPlaceholderWhenUIMissing(t *testing.T) {
	base, _ := testHost(t, 0)

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET / status %d, want 200", resp.StatusCode)
	}
	if len(body) == 0 {
		t.Fatal("GET / returned an empty body")
	}
	if cc := resp.Header.Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
		t.Fatalf("Cache-Control = %q, want no-cache", cc)
	}
}

func TestProxyReturns503WhenGatewayDown(t *testing.T) {
	base, _ := testHost(t, 0)

	for _, p := range []string{"/healthz", "/api/bridge/status"} {
		code, body := getWith(t, base+p, "")
		if code != http.StatusServiceUnavailable {
			t.Fatalf("GET %s: status %d body %s, want 503", p, code, body)
		}
		if !strings.Contains(body, "网关未运行") {
			t.Fatalf("GET %s: body %s, want \"网关未运行\"", p, body)
		}
	}
}

func TestProxyForwardsPathAndStripsHostToken(t *testing.T) {
	var gotPath, gotQuery, gotHostToken string

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"upstream":"fake","models":[]}`))
	})
	mux.HandleFunc("/api/bridge/models", func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotHostToken = r.Header.Get("X-Host-Token")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"models":[]}`))
	})

	fake := httptest.NewServer(mux)
	defer fake.Close()

	base, token := testHost(t, mustPort(t, fake.URL))

	code, body := getWith(t, base+"/api/bridge/models?force=true", token)
	if code != http.StatusOK {
		t.Fatalf("proxied GET: status %d body %s, want 200", code, body)
	}
	if gotPath != "/api/bridge/models" {
		t.Fatalf("upstream path = %q, want /api/bridge/models", gotPath)
	}
	if gotQuery != "force=true" {
		t.Fatalf("upstream query = %q, want force=true", gotQuery)
	}
	if gotHostToken != "" {
		t.Fatalf("X-Host-Token must not be forwarded to the gateway, got %q", gotHostToken)
	}
}

// TestProxyStreamsSSE verifies FlushInterval=-1: the client must observe the
// first SSE frame while the upstream is still blocked writing the second.
func TestProxyStreamsSSE(t *testing.T) {
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"models":[]}`))
	})
	mux.HandleFunc("/api/bridge/test", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, ok := w.(http.Flusher)
		if !ok {
			t.Error("fake gateway cannot flush")
			return
		}
		_, _ = w.Write([]byte("data: {\"seq\":1}\n\n"))
		fl.Flush()
		<-release
		_, _ = w.Write([]byte("data: {\"seq\":2}\n\n"))
		fl.Flush()
	})

	fake := httptest.NewServer(mux)
	defer fake.Close()

	base, _ := testHost(t, mustPort(t, fake.URL))

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Get(base + "/api/bridge/test")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache (set by ModifyResponse)", cc)
	}

	rd := bufio.NewReader(resp.Body)

	first, ok := readLineWithin(t, rd, 3*time.Second)
	if !ok {
		t.Fatal("first SSE frame was buffered: nothing arrived while upstream was blocked")
	}
	if !strings.Contains(first, `"seq":1`) {
		t.Fatalf("first line = %q, want the seq:1 frame", first)
	}

	close(release)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		line, ok := readLineWithin(t, rd, time.Until(deadline))
		if !ok {
			break
		}
		if strings.Contains(line, `"seq":2`) {
			return
		}
	}
	t.Fatal("second SSE frame never arrived")
}

// readLineWithin reads one line, giving up after d. Leaked reader goroutines
// end when the response body is closed.
func readLineWithin(t *testing.T, rd *bufio.Reader, d time.Duration) (string, bool) {
	t.Helper()
	if d <= 0 {
		return "", false
	}
	ch := make(chan string, 1)
	go func() {
		line, _ := rd.ReadString('\n')
		ch <- line
	}()
	select {
	case line := <-ch:
		return line, true
	case <-time.After(d):
		return "", false
	}
}
