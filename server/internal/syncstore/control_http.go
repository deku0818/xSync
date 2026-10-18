package syncstore

import (
	"crypto/sha256"
	"crypto/subtle"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

func (m *ManagedServer) adminOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !m.admin(r) {
			writeError(w, code("UNAUTHORIZED"))
			return
		}
		next(w, r)
	}
}

func (m *ManagedServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /admin/api/login", m.login)
	mux.HandleFunc("GET /admin/api/session", m.adminOnly(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"authenticated": true})
	}))
	mux.HandleFunc("POST /admin/api/logout", m.adminOnly(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Cookie("xsync_admin")
		_, e := m.Pool.Exec(r.Context(), "DELETE FROM admin_sessions WHERE token_hash=$1", hashSecret(c.Value))
		if e != nil {
			writeError(w, e)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: "xsync_admin", Value: "", Path: "/admin", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		writeJSON(w, 200, map[string]bool{"loggedOut": true})
	}))
	mux.HandleFunc("GET /admin/api/users", m.adminOnly(func(w http.ResponseWriter, r *http.Request) {
		u, e := m.Users(r.Context())
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"users": u})
	}))
	mux.HandleFunc("POST /admin/api/users", m.adminOnly(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name string `json:"name"`
		}
		if e := decodeBody(w, r, &in); e != nil {
			writeError(w, e)
			return
		}
		u, key, e := m.CreateUser(r.Context(), in.Name)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 201, map[string]any{"user": u, "key": key})
	}))
	mux.HandleFunc("POST /admin/api/users/{id}/key", m.adminOnly(func(w http.ResponseWriter, r *http.Request) {
		key, e := m.RotateKey(r.Context(), r.PathValue("id"))
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"key": key})
	}))
	mux.HandleFunc("PUT /admin/api/users/{id}", m.adminOnly(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Active *bool `json:"active"`
		}
		if e := decodeBody(w, r, &in); e != nil || in.Active == nil {
			writeError(w, code("INVALID_REQUEST"))
			return
		}
		if e := m.SetUserActive(r.Context(), r.PathValue("id"), *in.Active); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"updated": true})
	}))
	mux.HandleFunc("DELETE /admin/api/users/{id}", m.adminOnly(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Name string `json:"name"`
		}
		if e := decodeBody(w, r, &in); e != nil {
			writeError(w, e)
			return
		}
		pending, e := m.DeleteUser(r.Context(), r.PathValue("id"), in.Name)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"deleted": true, "cleanupPending": pending})
	}))
	mux.HandleFunc("GET /admin/api/vaults", m.adminOnly(func(w http.ResponseWriter, r *http.Request) {
		v, e := m.Vaults(r.Context(), "")
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"vaults": v})
	}))
	mux.HandleFunc("GET /admin/api/audit", m.adminOnly(func(w http.ResponseWriter, r *http.Request) {
		rows, e := m.Pool.Query(r.Context(), "SELECT at,message FROM admin_audit ORDER BY id DESC LIMIT 100")
		if e != nil {
			writeError(w, e)
			return
		}
		defer rows.Close()
		type entry struct {
			At      time.Time `json:"at"`
			Message string    `json:"message"`
		}
		out := []entry{}
		for rows.Next() {
			var v entry
			if e = rows.Scan(&v.At, &v.Message); e != nil {
				writeError(w, e)
				return
			}
			out = append(out, v)
		}
		if e = rows.Err(); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"entries": out})
	}))
	mux.HandleFunc("GET /api/connection", func(w http.ResponseWriter, r *http.Request) {
		u, e := m.access(r.Context(), bearer(r))
		if e != nil {
			writeError(w, e)
			return
		}
		v, e := m.Vaults(r.Context(), u.ID)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"user": u, "vaults": v})
	})
	mux.HandleFunc("POST /api/vaults", func(w http.ResponseWriter, r *http.Request) {
		u, e := m.access(r.Context(), bearer(r))
		if e != nil {
			writeError(w, e)
			return
		}
		var in NewVault
		if e = decodeBody(w, r, &in); e != nil {
			writeError(w, e)
			return
		}
		v, e := m.CreateVault(r.Context(), u, in)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 201, v)
	})
	mux.HandleFunc("POST /api/vaults/{id}/devices", func(w http.ResponseWriter, r *http.Request) {
		u, e := m.access(r.Context(), bearer(r))
		if e != nil {
			writeError(w, e)
			return
		}
		var in struct {
			ID        string `json:"deviceId"`
			Name      string `json:"name"`
			TokenHash string `json:"tokenHash"`
		}
		if e = decodeBody(w, r, &in); e != nil {
			writeError(w, e)
			return
		}
		if e = m.EnrollDevice(r.Context(), u, r.PathValue("id"), in.ID, in.Name, in.TokenHash); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"enrolled": true})
	})
	mux.HandleFunc("/sync/{vault}/", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("vault")
		if !blobPattern.MatchString(id) {
			writeError(w, code("VAULT_NOT_FOUND"))
			return
		}
		s, e := m.store(r.Context(), id)
		if e != nil {
			writeError(w, e)
			return
		}
		clone := r.Clone(r.Context())
		clone.URL.Path = strings.TrimPrefix(r.URL.Path, "/sync/"+id)
		s.Handler().ServeHTTP(w, clone)
	})
	mux.Handle("GET /admin/", adminFiles())
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/admin/", http.StatusSeeOther) })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/admin") {
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'")
			if r.Method != "GET" && !sameOrigin(r) {
				writeError(w, code("UNAUTHORIZED"))
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func bearer(r *http.Request) string {
	v := r.Header.Get("Authorization")
	if !strings.HasPrefix(v, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(v, "Bearer ")
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return r.Header.Get("Sec-Fetch-Site") != "cross-site"
	}
	u, e := url.Parse(origin)
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return e == nil && u.Host == r.Host && u.Scheme == scheme
}

func (m *ManagedServer) admin(r *http.Request) bool {
	cookie, e := r.Cookie("xsync_admin")
	if e != nil {
		return false
	}
	var ok bool
	e = m.Pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM admin_sessions WHERE token_hash=$1 AND expires_at>now())", hashSecret(cookie.Value)).Scan(&ok)
	return e == nil && ok
}

func (m *ManagedServer) loginClientIP(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	peer, e := netip.ParseAddr(host)
	if e != nil {
		return host
	}
	peer = peer.Unmap()
	for _, trusted := range m.trustedProxies {
		if trusted.Contains(peer) {
			// Nginx must overwrite this header with its TCP client's address.
			forwarded, err := netip.ParseAddr(r.Header.Get("X-Real-IP"))
			if err == nil && forwarded.Zone() == "" {
				return forwarded.Unmap().String()
			}
			break
		}
	}
	return peer.String()
}

func (m *ManagedServer) login(w http.ResponseWriter, r *http.Request) {
	host := m.loginClientIP(r)
	now := time.Now()
	m.mu.Lock()
	if len(m.attempts) >= 1024 {
		for key, v := range m.attempts {
			if now.Sub(v.at) >= time.Minute {
				delete(m.attempts, key)
			}
		}
	}
	if _, known := m.attempts[host]; !known && len(m.attempts) >= 1024 {
		m.mu.Unlock()
		writeError(w, code("LOGIN_RATE_LIMITED"))
		return
	}
	a := m.attempts[host]
	if now.Sub(a.at) >= time.Minute {
		a = loginAttempt{at: now}
	}
	a.count++
	m.attempts[host] = a
	m.mu.Unlock()
	if a.count > 10 {
		writeError(w, code("LOGIN_RATE_LIMITED"))
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if e := decodeBody(w, r, &in); e != nil {
		writeError(w, e)
		return
	}
	given := sha256.Sum256([]byte(in.Password))
	if subtle.ConstantTimeCompare(given[:], m.password[:]) != 1 {
		writeError(w, code("UNAUTHORIZED"))
		return
	}
	token := opaqueID()
	tx, e := m.Pool.Begin(r.Context())
	if e != nil {
		writeError(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "DELETE FROM admin_sessions WHERE expires_at<=now()"); e == nil {
		_, e = tx.Exec(r.Context(), "INSERT INTO admin_sessions(token_hash,expires_at) VALUES($1,now()+interval '12 hours')", hashSecret(token))
	}
	if e == nil {
		e = tx.Commit(r.Context())
	}
	if e != nil {
		writeError(w, e)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "xsync_admin", Value: token, Path: "/admin", HttpOnly: true, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteStrictMode, MaxAge: 43200})
	writeJSON(w, 200, map[string]bool{"authenticated": true})
}
