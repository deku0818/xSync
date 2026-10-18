package syncstore

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func managedFixture(t *testing.T, configure ...func(*Config)) *ManagedServer {
	t.Helper()
	legacy := contractStore(t)
	if _, e := legacy.Pool.Exec(context.Background(), "TRUNCATE vaults CASCADE"); e != nil {
		t.Fatal(e)
	}
	c := Config{DSN: legacy.Config.DSN, ObjectDir: t.TempDir()}
	for _, change := range configure {
		change(&c)
	}
	m, e := NewManagedServer(context.Background(), c, "test-admin-password-only")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(m.Close)
	return m
}
func managedVault(t *testing.T, m *ManagedServer, u User, name string) ManagedVault {
	t.Helper()
	id := opaqueID()
	pkg := json.RawMessage(`{"format":0,"vaultId":"` + id + `","kdf":"Argon2id13","memory":67108864,"ops":2,"salt":"fixture","wrapped":{"v":0,"n":"fixture","c":"fixture"}}`)
	v, e := m.CreateVault(context.Background(), u, NewVault{id, name, opaqueID(), pkg})
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func TestManagedAdminRoutesRequireSession(t *testing.T) {
	m := managedFixture(t)
	h := m.Handler()
	token := opaqueID()
	if _, e := m.Pool.Exec(context.Background(), "INSERT INTO admin_sessions(token_hash,expires_at) VALUES($1,now()-interval '1 second')", hashSecret(token)); e != nil {
		t.Fatal(e)
	}
	for _, session := range []struct {
		name   string
		cookie *http.Cookie
	}{
		{"missing", nil},
		{"expired", &http.Cookie{Name: "xsync_admin", Value: token}},
	} {
		for _, route := range []struct{ method, path string }{
			{"GET", "/admin/api/session"},
			{"POST", "/admin/api/logout"},
			{"GET", "/admin/api/users"},
			{"POST", "/admin/api/users"},
			{"POST", "/admin/api/users/test/key"},
			{"PUT", "/admin/api/users/test"},
			{"DELETE", "/admin/api/users/test"},
			{"GET", "/admin/api/vaults"},
			{"GET", "/admin/api/audit"},
		} {
			t.Run(session.name+" "+route.method+" "+route.path, func(t *testing.T) {
				r := httptest.NewRequest(route.method, route.path, nil)
				if session.cookie != nil {
					r.AddCookie(session.cookie)
				}
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != 401 || !strings.Contains(w.Body.String(), "UNAUTHORIZED") {
					t.Fatalf("management route did not require a valid session: %d %s", w.Code, w.Body.String())
				}
			})
		}
	}
}
func TestManagedUserKeyLifecycleAndVaultIsolation(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	a, key, e := m.CreateUser(ctx, "用户 A")
	if e != nil {
		t.Fatal(e)
	}
	b, other, e := m.CreateUser(ctx, "用户 B")
	if e != nil {
		t.Fatal(e)
	}
	va := managedVault(t, m, a, "工作笔记")
	vb := managedVault(t, m, b, "工作笔记")
	if va.ID == vb.ID {
		t.Fatal("shared vault identity")
	}
	if e = m.EnrollDevice(ctx, b, va.ID, "phone", "手机", strings.Repeat("c", 64)); e == nil {
		t.Fatal("cross-user enrollment accepted")
	}
	token := strings.Repeat("d", 64)
	if e = m.EnrollDevice(ctx, a, va.ID, "computer", "电脑", stringHash(token)); e != nil {
		t.Fatal(e)
	}
	sa, e := m.store(ctx, va.ID)
	if e != nil {
		t.Fatal(e)
	}
	sb, e := m.store(ctx, vb.ID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = sa.Authorize(ctx, token); e != nil {
		t.Fatal(e)
	}
	if _, e = sb.Authorize(ctx, token); e == nil {
		t.Fatal("cross-vault token accepted")
	}
	if e = m.SetUserActive(ctx, a.ID, false); e != nil {
		t.Fatal(e)
	}
	if _, e = sa.Authorize(ctx, token); e == nil {
		t.Fatal("disabled device accepted")
	}
	if _, e = m.access(ctx, key); e == nil {
		t.Fatal("disabled key accepted")
	}
	refreshed, e := m.RotateKey(ctx, a.ID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.access(ctx, refreshed); e == nil {
		t.Fatal("rotation re-enabled user")
	}
	if e = m.SetUserActive(ctx, a.ID, true); e != nil {
		t.Fatal(e)
	}
	if _, e = m.access(ctx, key); e == nil {
		t.Fatal("old key accepted")
	}
	if _, e = sa.Authorize(ctx, token); e == nil {
		t.Fatal("old device authorization revived")
	}
	renewed, e := m.access(ctx, refreshed)
	if e != nil {
		t.Fatal(e)
	}
	newToken := strings.Repeat("e", 64)
	if e = m.EnrollDevice(ctx, renewed, va.ID, "computer", "电脑", stringHash(newToken)); e != nil {
		t.Fatal(e)
	}
	if _, e = sa.Authorize(ctx, newToken); e != nil {
		t.Fatal(e)
	}
	if _, e = sa.Authorize(ctx, token); e == nil {
		t.Fatal("old token accepted after reauthorization")
	}
	if _, e = m.access(ctx, other); e != nil {
		t.Fatal(e)
	}
	v, e := m.Vaults(ctx, a.ID)
	if e != nil || len(v) != 1 {
		t.Fatal("user vaults unavailable", e)
	}
	x, _ := canonicalDigest(v[0].KeyPackage)
	y, _ := canonicalDigest(va.KeyPackage)
	if x != y {
		t.Fatal("key rotation changed encryption package")
	}

	var raw []byte
	if e = m.Pool.QueryRow(ctx, "SELECT key_hash FROM sync_users WHERE id=$1", a.ID).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(raw, []byte(refreshed)) {
		t.Fatal("plaintext key persisted")
	}
}
func stringHash(value string) string {
	const alphabet = "0123456789abcdef"
	result := make([]byte, 64)
	for i, b := range hashSecret(value) {
		result[i*2] = alphabet[b>>4]
		result[i*2+1] = alphabet[b&15]
	}
	return string(result)
}
func TestManagedHTTPAdminAndDeletedUserRecovery(t *testing.T) {
	ctx := context.Background()
	m := managedFixture(t)
	h := m.Handler()
	request := func(method, path, body, token string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/admin/api/users", "", "", nil); w.Code != 401 {
		t.Fatal(w.Code)
	}
	login := request("POST", "/admin/api/login", `{"password":"test-admin-password-only"}`, "", nil)
	if login.Code != 200 {
		t.Fatal(login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe cookie")
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1/admin/api/users", strings.NewReader(`{"name":"CSRF"}`))
	r.AddCookie(cookie)
	r.Header.Set("Origin", "https://attacker.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("CSRF accepted")
	}
	u, key, e := m.CreateUser(ctx, "删除测试")
	if e != nil {
		t.Fatal(e)
	}
	v := managedVault(t, m, u, "笔记")
	if e = m.EnrollDevice(ctx, u, v.ID, "computer", "电脑", strings.Repeat("a", 64)); e != nil {
		t.Fatal(e)
	}
	if w = request("GET", "/api/connection", "", key, nil); w.Code != 200 || !strings.Contains(w.Body.String(), v.ID) {
		t.Fatal(w.Body.String())
	}
	if w = request("GET", "/admin/api/users", "", "", cookie); w.Code != 200 || strings.Contains(w.Body.String(), key) {
		t.Fatal("admin users exposed full key")
	}
	if _, e = m.DeleteUser(ctx, u.ID, "wrong"); e == nil {
		t.Fatal("unconfirmed deletion")
	}
	path := filepath.Join(m.config.ObjectDir, v.ID)
	if e = os.MkdirAll(path, 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(path, "ciphertext"), []byte("private"), 0600); e != nil {
		t.Fatal(e)
	}
	pending, e := m.DeleteUser(ctx, u.ID, u.Name)
	if e != nil || pending {
		t.Fatal("deletion failed", pending, e)
	}
	if _, e = os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("objects not removed")
	}
	if w = request("GET", "/api/connection", "", key, nil); w.Code != 401 {
		t.Fatal("deleted key accepted")
	}
	var count int
	if e = m.Pool.QueryRow(ctx, "SELECT count(*) FROM vaults WHERE id=$1", v.ID).Scan(&count); e != nil || count != 0 {
		t.Fatal("vault metadata retained")
	}
	// Interrupted deletion resumes from a durable tombstone.
	u, _, e = m.CreateUser(ctx, "中断测试")
	if e != nil {
		t.Fatal(e)
	}
	managedVault(t, m, u, "保留到重试")
	if _, e = m.Pool.Exec(ctx, "UPDATE sync_users SET active=false,key_hash=NULL,deleted_at=now() WHERE id=$1", u.ID); e != nil {
		t.Fatal(e)
	}
	if e = m.purgeDeleted(ctx); e != nil {
		t.Fatal(e)
	}
	if w = request("GET", "/admin/", "", "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "管理密码") {
		t.Fatal("admin page unavailable")
	}
}
