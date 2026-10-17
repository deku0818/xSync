package syncstore

import (
	"bytes"
	"context"
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
	limit := int64(4 << 20)
	if _, tracked := out.(*TrackedCommit); tracked {
		limit = 8 << 20
	}
	if _, migration := out.(*LegacyMigration); migration {
		limit = 32 << 20
	}
	if _, migration := out.(*LegacyObjectMigration); migration {
		limit = 32 << 20
	}
	body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
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
	if _, tracked := out.(*TrackedCommit); tracked {
		var outer struct {
			Request map[string]json.RawMessage `json:"request"`
		}
		if json.Unmarshal(body, &outer) != nil {
			return code("INVALID_REQUEST")
		}
		for _, key := range []string{"protocol", "vaultId", "epoch", "requiredFeatures", "deviceId", "opId", "actions"} {
			if _, exists := outer.Request[key]; !exists {
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
	case "CLIENT_UPGRADE_REQUIRED":
		status = 426
	case "CONTINUITY_MISMATCH", "RECOVERY_RECONCILIATION_REQUIRED":
		status = 409
	case "CONTENT_BUSY":
		status = 429
	case "VIEW_EXPIRED", "OBJECT_BUSY", "SNAPSHOT_TOO_LARGE", "BASE_NOT_ACCEPTED", "BASE_PROOF_INVALID", "BASE_PROOF_REQUIRED", "REQUEST_STREAM_INVALID", "OPERATION_RETIRED", "REQUEST_ACK_REQUIRED", "REQUEST_ACK_INVALID", "CAUSAL_SHADOW_MISMATCH", "RESULT_TOO_LARGE", "LEGACY_INTENT_UNREGISTERED", "LEGACY_MIGRATION_CHANGED", "METADATA_DOWNGRADE_REFUSED", "METADATA_MODE_CHANGED", "LEGACY_OBJECT_UNREGISTERED", "LEGACY_OBJECT_MIGRATION_CHANGED":
		status = 409
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
	mux.HandleFunc("GET /metadata/continuity", func(w http.ResponseWriter, r *http.Request) {
		device, e := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if e != nil {
			writeError(w, e)
			return
		}
		token, e := s.Continuity(r.Context(), device)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"token": token})
	})
	mux.HandleFunc("GET /metadata/migrations", func(w http.ResponseWriter, r *http.Request) {
		device, e := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if e != nil {
			writeError(w, e)
			return
		}
		state, e := s.MigrationState(r.Context(), device)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, state)
	})
	mux.HandleFunc("POST /metadata/continuity/fence", func(w http.ResponseWriter, r *http.Request) {
		device, e := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if e != nil {
			writeError(w, e)
			return
		}
		token, e := s.FenceContinuity(r.Context(), device)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"token": token})
	})
	mux.HandleFunc("POST /metadata/stream", func(w http.ResponseWriter, r *http.Request) {
		device, _ := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		stream, e := s.OpenRequestStream(r.Context(), device)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, stream)
	})
	mux.HandleFunc("POST /metadata/base", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Revision Revision `json:"revision"`
		}
		if e := decodeBody(w, r, &input); e != nil {
			writeError(w, e)
			return
		}
		anchor, e := s.CertifyBase(r.Context(), input.Revision)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, anchor)
	})
	mux.HandleFunc("POST /metadata/migrate", func(w http.ResponseWriter, r *http.Request) {
		var input LegacyMigration
		if e := decodeBody(w, r, &input); e != nil {
			writeError(w, e)
			return
		}
		device, _ := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if e := s.RegisterLegacy(r.Context(), device, input); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"registered": true})
	})
	mux.HandleFunc("POST /metadata/commits", func(w http.ResponseWriter, r *http.Request) {
		var input TrackedCommit
		if e := decodeBody(w, r, &input); e != nil {
			writeError(w, e)
			return
		}
		device, _ := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if input.Request.DeviceID != device {
			writeError(w, code("UNAUTHORIZED"))
			return
		}
		result, e := s.CommitTracked(r.Context(), input.Request, input.Tracking)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, result)
	})
	mux.HandleFunc("POST /metadata/ack", func(w http.ResponseWriter, r *http.Request) {
		var ack RequestAck
		if e := decodeBody(w, r, &ack); e != nil {
			writeError(w, e)
			return
		}
		device, _ := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if e := s.AcknowledgeRequest(r.Context(), device, ack); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"acknowledged": true})
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
	deviceOf := func(r *http.Request) string {
		device, _ := s.Authorize(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		return device
	}
	mux.HandleFunc("POST /content/migrate", func(w http.ResponseWriter, r *http.Request) {
		var input LegacyObjectMigration
		if e := decodeBody(w, r, &input); e != nil {
			writeError(w, e)
			return
		}
		if e := s.RegisterLegacyObjects(r.Context(), deviceOf(r), input); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"registered": true})
	})
	mux.HandleFunc("POST /content/upload", func(w http.ResponseWriter, r *http.Request) {
		var c Commit
		if e := decodeBody(w, r, &c); e != nil {
			writeError(w, e)
			return
		}
		id, e := s.UploadLease(r.Context(), deviceOf(r), c)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"id": id})
	})
	mux.HandleFunc("POST /content/read", func(w http.ResponseWriter, r *http.Request) {
		var v ReadView
		if e := decodeBody(w, r, &v); e != nil {
			writeError(w, e)
			return
		}
		id, e := s.ReadLease(r.Context(), deviceOf(r), v)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]string{"id": id})
	})
	mux.HandleFunc("POST /content/leases/{id}/renew", func(w http.ResponseWriter, r *http.Request) {
		if e := s.RenewLease(r.Context(), deviceOf(r), r.PathValue("id")); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"renewed": true})
	})
	mux.HandleFunc("DELETE /content/leases/{id}", func(w http.ResponseWriter, r *http.Request) {
		if e := s.ReleaseLease(r.Context(), deviceOf(r), r.PathValue("id")); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"released": true})
	})
	mux.HandleFunc("POST /snapshots", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			RequestID string `json:"requestId"`
		}
		if e := decodeBody(w, r, &input); e != nil {
			writeError(w, e)
			return
		}
		ticket, e := s.CreateSnapshot(r.Context(), deviceOf(r), input.RequestID)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, ticket)
	})
	mux.HandleFunc("GET /snapshots/{id}", func(w http.ResponseWriter, r *http.Request) {
		b, e := s.ReadSnapshot(r.Context(), deviceOf(r), r.PathValue("id"))
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, b)
	})
	mux.HandleFunc("PUT /objects/{id}", func(w http.ResponseWriter, r *http.Request) {
		b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
		if e == nil {
			e = s.putObject(r.Context(), deviceOf(r), r.Header.Get("X-Content-Lease"), r.PathValue("id"), r.Header.Get("X-Ciphertext-SHA256"), b)
		}
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"finalized": true})
	})
	mux.HandleFunc("GET /objects/{id}", func(w http.ResponseWriter, r *http.Request) {
		b, hash, e := s.getObject(r.Context(), deviceOf(r), r.Header.Get("X-Content-Lease"), r.PathValue("id"))
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
		device, e := s.Authorize(r.Context(), token)
		if e != nil {
			writeError(w, e)
			return
		}
		if (r.URL.Path == "/handshake" || r.URL.Path == "/changes" || r.URL.Path == "/commits" || strings.HasPrefix(r.URL.Path, "/objects/") || strings.HasPrefix(r.URL.Path, "/snapshots") || strings.HasPrefix(r.URL.Path, "/content/") || strings.HasPrefix(r.URL.Path, "/metadata/")) && r.Header.Get("X-Sync-Content") != ContentCapability {
			writeError(w, code("CLIENT_UPGRADE_REQUIRED"))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/metadata/") && r.Header.Get("X-Sync-Metadata") != MetadataCapability {
			writeError(w, code("CLIENT_UPGRADE_REQUIRED"))
			return
		}
		if s.compact && r.Header.Get("X-Sync-Compaction") != CompactCapability {
			writeError(w, code("CLIENT_UPGRADE_REQUIRED"))
			return
		}
		if (r.URL.Path == "/handshake" || r.URL.Path == "/changes" || r.URL.Path == "/commits" || strings.HasPrefix(r.URL.Path, "/objects/") || strings.HasPrefix(r.URL.Path, "/snapshots") || strings.HasPrefix(r.URL.Path, "/content/") || strings.HasPrefix(r.URL.Path, "/metadata/")) && r.Header.Get("X-Sync-Objects") != ObjectCapability {
			writeError(w, code("CLIENT_UPGRADE_REQUIRED"))
			return
		}
		if (r.URL.Path == "/handshake" || strings.HasPrefix(r.URL.Path, "/metadata/") || r.URL.Path == "/changes" || r.URL.Path == "/snapshots" || r.URL.Path == "/commits") && r.Header.Get("X-Sync-Continuity") != ContinuityCapability {
			writeError(w, code("CLIENT_UPGRADE_REQUIRED"))
			return
		}
		protected := r.URL.Path == "/changes" || r.URL.Path == "/metadata/base" || r.URL.Path == "/metadata/commits" || r.URL.Path == "/commits" || r.URL.Path == "/metadata/continuity/fence" || (r.URL.Path == "/snapshots" && r.Method == "POST")
		if protected {
			readOnly := r.Header.Get("X-Sync-Read-Only") == "1" && (r.URL.Path == "/changes" || r.URL.Path == "/metadata/base" || r.URL.Path == "/snapshots")
			if !readOnly {
				change := &continuityChange{Device: device, From: r.Header.Get("X-Sync-Continuity-From"), Next: r.Header.Get("X-Sync-Continuity-Next")}
				if !blobPattern.MatchString(change.From) || !blobPattern.MatchString(change.Next) || change.From == change.Next {
					writeError(w, code("INVALID_REQUEST"))
					return
				}
				r = r.WithContext(context.WithValue(r.Context(), continuityKey{}, change))
				w.Header().Set("X-Sync-Continuity-Token", change.Next)
			}
		}
		mux.ServeHTTP(w, r)
	})
}
