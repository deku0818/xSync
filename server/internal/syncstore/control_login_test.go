package syncstore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func managedLogin(h http.Handler, peer, forwarded, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"password": password})
	r := httptest.NewRequest("POST", "https://sync.example.com/admin/api/login", strings.NewReader(string(body)))
	r.RemoteAddr = peer
	r.Header.Set("X-Real-IP", forwarded)
	r.Header.Set("X-Forwarded-For", forwarded)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestManagedLoginRateLimitBehindTrustedProxy(t *testing.T) {
	m := managedFixture(t, func(c *Config) { c.TrustedProxies = []string{"172.18.0.2/32"} })
	h := m.Handler()
	for i := 0; i < 10; i++ {
		if w := managedLogin(h, "172.18.0.2:43210", "198.51.100.1", "wrong"); w.Code != 401 {
			t.Fatalf("failed attempt %d: %d", i, w.Code)
		}
	}
	if w := managedLogin(h, "172.18.0.2:54321", "198.51.100.2", "test-admin-password-only"); w.Code != 200 {
		t.Fatalf("unrelated client with correct password was blocked: %d %s", w.Code, w.Body.String())
	}
	if w := managedLogin(h, "172.18.0.2:54322", "198.51.100.1", "test-admin-password-only"); w.Code != 429 {
		t.Fatalf("limited source bypassed its quota: %d", w.Code)
	}
}

func TestManagedLoginIgnoresUntrustedForwarding(t *testing.T) {
	m := managedFixture(t, func(c *Config) { c.TrustedProxies = []string{"172.18.0.2/32"} })
	h := m.Handler()
	for i := 0; i < 10; i++ {
		if w := managedLogin(h, "203.0.113.9:43210", fmt.Sprintf("198.51.100.%d", i+1), "wrong"); w.Code != 401 {
			t.Fatalf("failed attempt %d: %d", i, w.Code)
		}
	}
	if w := managedLogin(h, "203.0.113.9:54321", "198.51.100.99", "test-admin-password-only"); w.Code != 429 {
		t.Fatalf("forged forwarding bypassed rate limit: %d", w.Code)
	}
	if w := managedLogin(h, "203.0.113.10:54321", "198.51.100.99", "test-admin-password-only"); w.Code != 200 {
		t.Fatalf("unrelated direct client was blocked: %d", w.Code)
	}
}

func TestManagedLoginLimiterReclaimsExpiredBucketsAtCapacity(t *testing.T) {
	m := managedFixture(t)
	for i := 0; i < 1024; i++ {
		m.attempts[fmt.Sprintf("source-%d", i)] = loginAttempt{at: time.Now().Add(-2 * time.Minute), count: 10}
	}
	if w := managedLogin(m.Handler(), "203.0.113.20:43210", "", "test-admin-password-only"); w.Code != 200 {
		t.Fatalf("expired buckets permanently blocked login: %d", w.Code)
	}
}

func TestManagedRejectsInvalidTrustedProxy(t *testing.T) {
	_, e := NewManagedServer(context.Background(), Config{ObjectDir: t.TempDir(), TrustedProxies: []string{"not-a-cidr"}}, "test-admin-password-only")
	if e == nil || e.Error() != "invalid trusted proxy CIDR" {
		t.Fatalf("invalid proxy configuration was not rejected: %v", e)
	}
}

func TestManagedLoginClientAddress(t *testing.T) {
	for _, test := range []struct {
		name, peer, forwarded, expected string
		trusted                         []netip.Prefix
	}{
		{"default distrusts forwarding", "172.18.0.2:1", "198.51.100.1", "172.18.0.2", nil},
		{"trusted proxy", "172.18.0.2:1", "198.51.100.1", "198.51.100.1", []netip.Prefix{netip.MustParsePrefix("172.18.0.2/32")}},
		{"untrusted peer", "172.18.0.3:1", "198.51.100.1", "172.18.0.3", []netip.Prefix{netip.MustParsePrefix("172.18.0.2/32")}},
		{"missing header", "172.18.0.2:1", "", "172.18.0.2", []netip.Prefix{netip.MustParsePrefix("172.18.0.2/32")}},
		{"malformed chain", "172.18.0.2:1", "198.51.100.1, 198.51.100.2", "172.18.0.2", []netip.Prefix{netip.MustParsePrefix("172.18.0.2/32")}},
		{"mapped peer", "[::ffff:172.18.0.2]:1", "198.51.100.1", "198.51.100.1", []netip.Prefix{netip.MustParsePrefix("172.18.0.2/32")}},
		{"IPv6 client canonicalization", "172.18.0.2:1", "2001:0db8:0:0:0:0:0:1", "2001:db8::1", []netip.Prefix{netip.MustParsePrefix("172.18.0.2/32")}},
		{"IPv6 proxy and mapped client", "[2001:db8:1::2]:1", "::ffff:198.51.100.1", "198.51.100.1", []netip.Prefix{netip.MustParsePrefix("2001:db8:1::/64")}},
		{"scoped address rejected", "172.18.0.2:1", "fe80::1%lo0", "172.18.0.2", []netip.Prefix{netip.MustParsePrefix("172.18.0.2/32")}},
	} {
		t.Run(test.name, func(t *testing.T) {
			m := &ManagedServer{trustedProxies: test.trusted}
			r := httptest.NewRequest("POST", "/admin/api/login", nil)
			r.RemoteAddr = test.peer
			r.Header.Set("X-Real-IP", test.forwarded)
			if got := m.loginClientIP(r); got != test.expected {
				t.Fatalf("client address: got %s, want %s", got, test.expected)
			}
		})
	}
}

func TestManagedLoginLimiterPreservesExistingBucketsAtCapacity(t *testing.T) {
	m := managedFixture(t)
	for i := 0; i < 1023; i++ {
		m.attempts[fmt.Sprintf("source-%d", i)] = loginAttempt{at: time.Now(), count: 10}
	}
	m.attempts["203.0.113.20"] = loginAttempt{at: time.Now(), count: 1}
	h := m.Handler()
	if w := managedLogin(h, "203.0.113.21:1", "", "wrong"); w.Code != 429 {
		t.Fatalf("new source expanded a full limiter: %d", w.Code)
	}
	if w := managedLogin(h, "203.0.113.20:1", "", "test-admin-password-only"); w.Code != 200 {
		t.Fatalf("existing source with remaining quota was blocked: %d", w.Code)
	}
	if len(m.attempts) != 1024 {
		t.Fatalf("limiter exceeded its capacity: %d", len(m.attempts))
	}
}
