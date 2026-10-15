package syncstore

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Reject duplicate keys and excessive nesting before encoding/json can collapse input.
func checkJSON(d *json.Decoder, depth int) error {
	if depth > 32 {
		return code("INVALID_REQUEST")
	}
	token, e := d.Token()
	if e != nil {
		return e
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			k, e := d.Token()
			if e != nil {
				return e
			}
			key, ok := k.(string)
			if !ok || seen[key] {
				return code("INVALID_REQUEST")
			}
			seen[key] = true
			if e = checkJSON(d, depth+1); e != nil {
				return e
			}
		}
	case '[':
		for d.More() {
			if e = checkJSON(d, depth+1); e != nil {
				return e
			}
		}
	default:
		return code("INVALID_REQUEST")
	}
	_, e = d.Token()
	return e
}
func decodeBody(w http.ResponseWriter, r *http.Request, out any) error {
	body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	if e != nil {
		return code("INVALID_REQUEST")
	}
	first := json.NewDecoder(bytes.NewReader(body))
	first.UseNumber()
	if e = checkJSON(first, 0); e != nil {
		return code("INVALID_REQUEST")
	}
	if _, e = first.Token(); e != io.EOF {
		return code("INVALID_REQUEST")
	}
	d := json.NewDecoder(bytes.NewReader(body))
	if _, ok := out.(*Commit); ok {
		var fields map[string]json.RawMessage
		if json.Unmarshal(body, &fields) != nil {
			return code("INVALID_REQUEST")
		}
		for _, key := range []string{"protocol", "vaultId", "epoch", "requiredFeatures", "deviceId", "opId", "actions"} {
			if _, ok := fields[key]; !ok {
				return code("INVALID_REQUEST")
			}
		}
	}
	d.DisallowUnknownFields()
	if e = d.Decode(out); e != nil {
		return code("INVALID_REQUEST")
	}
	return nil
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, e error) {
	status := http.StatusConflict
	c := e.Error()
	switch c {
	case "UNAUTHORIZED":
		status = 401
	case "ENROLLMENT_CLOSED", "DEVICE_REVOKED":
		status = 403
	case "ENROLLMENT_BUSY", "DEVICE_LIMIT":
		status = 429
	case "ENROLLMENT_EXPIRED", "ENROLLMENT_REPLAY":
		status = 409
	case "INVALID_REQUEST", "UNSUPPORTED_PROTOCOL", "WRONG_VAULT", "DIGEST_MISMATCH", "DEVICE_NAME_INVALID":
		status = 400
	case "OBJECT_MISSING", "FILE_MISSING":
		status = 404
	case "DEVICE_NAME_TAKEN", "PROFILE_STALE", "OP_ID_REUSED", "FILE_EXISTS", "REVISION_EXISTS", "PARENT_MISSING", "LOCATION_STALE", "PATH_OCCUPIED", "REVIEW_STALE", "EPOCH_CHANGED", "NEED_SNAPSHOT", "OBJECT_IMMUTABLE", "OBJECT_CORRUPT":
	default:
		status = 500
		c = "INTERNAL_ERROR"
	}
	writeJSON(w, status, map[string]string{"code": c})
}
func (s *Store) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /devices", func(w http.ResponseWriter, r *http.Request) {
		rows, e := s.Devices(r.Context())
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"devices": rows})
	})
	mux.HandleFunc("PUT /device/profile", func(w http.ResponseWriter, r *http.Request) {
		var input ProfileUpdate
		if e := decodeBody(w, r, &input); e != nil {
			writeError(w, e)
			return
		}
		device, _ := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		row, e := s.PutProfile(r.Context(), device, input)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, row)
	})

	mux.HandleFunc("POST /events/tickets", func(w http.ResponseWriter, r *http.Request) {
		device, e := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if e != nil {
			writeError(w, e)
			return
		}
		ticket, e := s.events.ticket(device, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"ticket": ticket})
	})
	mux.HandleFunc("GET /handshake", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Handshake(r.Context())
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, v)
	})
	mux.HandleFunc("POST /commits", func(w http.ResponseWriter, r *http.Request) {
		var c Commit
		if e := decodeBody(w, r, &c); e != nil {
			writeError(w, e)
			return
		}
		device, _ := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if c.DeviceID != device {
			writeError(w, code("UNAUTHORIZED"))
			return
		}
		receipt, e := s.Commit(r.Context(), c)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, receipt)
	})
	mux.HandleFunc("GET /changes", func(w http.ResponseWriter, r *http.Request) {
		after, e := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		if e != nil {
			writeError(w, code("INVALID_REQUEST"))
			return
		}
		cs, e := s.Pull(r.Context(), r.URL.Query().Get("epoch"), after)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, cs)
	})
	mux.HandleFunc("POST /snapshots", func(w http.ResponseWriter, r *http.Request) {
		snap, e := s.Snapshot(r.Context())
		if e != nil {
			writeError(w, e)
			return
		}
		random := make([]byte, 16)
		if _, e = rand.Read(random); e != nil {
			writeError(w, e)
			return
		}
		id := hex.EncodeToString(random)
		b, e := json.Marshal(snap)
		if e == nil {
			_, e = s.Pool.Exec(r.Context(), "INSERT INTO snapshots(vault_id,id,value) VALUES($1,$2,$3)", s.Config.VaultID, id, b)
		}
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"id": id})
	})
	mux.HandleFunc("GET /snapshots/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !validID(id) {
			writeError(w, code("INVALID_REQUEST"))
			return
		}
		var b []byte
		e := s.Pool.QueryRow(r.Context(), "SELECT value FROM snapshots WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&b)
		if e != nil {
			writeError(w, code("OBJECT_MISSING"))
			return
		}
		writeJSON(w, 200, json.RawMessage(b))
	})
	mux.HandleFunc("PUT /objects/{id}", func(w http.ResponseWriter, r *http.Request) {
		b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
		if e == nil {
			e = s.PutObject(r.Context(), r.PathValue("id"), r.Header.Get("X-Ciphertext-SHA256"), b)
		}
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"finalized": true})
	})
	mux.HandleFunc("GET /objects/{id}", func(w http.ResponseWriter, r *http.Request) {
		b, hash, e := s.GetObject(r.Context(), r.PathValue("id"))
		if e != nil {
			writeError(w, e)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Ciphertext-SHA256", hash)
		_, _ = w.Write(b)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.enrollmentHandler(w, r) {
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/events" {
			s.eventsHandler(w, r)
			return
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if r.Header.Get("Authorization") == token {
			writeError(w, code("UNAUTHORIZED"))
			return
		}
		if _, e := s.Authorize(r.Context(), token); e != nil {
			writeError(w, e)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
