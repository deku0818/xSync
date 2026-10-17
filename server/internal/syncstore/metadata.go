package syncstore

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"

	"github.com/jackc/pgx/v5"
)

const MetadataCapability = "metadata-anchors-v1"
const maxSafeNumber int64 = 9007199254740991

type BaseProof struct {
	VaultID    string `json:"vaultId"`
	Epoch      string `json:"epoch"`
	FileID     string `json:"fileId"`
	RevisionID string `json:"revisionId"`
	Digest     string `json:"digest"`
	Boundary   int64  `json:"boundary"`
	Token      string `json:"token"`
}
type BaseAnchor struct {
	Revision Revision  `json:"revision"`
	Proof    BaseProof `json:"proof"`
}
type RequestTracking struct {
	Stream string      `json:"stream"`
	Number int64       `json:"number"`
	Bases  []BaseProof `json:"bases"`
}
type TrackedCommit struct {
	Request  Commit          `json:"request"`
	Tracking RequestTracking `json:"tracking"`
}
type TrackedResult struct {
	Receipt Receipt      `json:"receipt"`
	Bases   []BaseAnchor `json:"bases"`
}
type RequestStream struct {
	ID      string `json:"id"`
	Maximum int64  `json:"maximum"`
	Retired int64  `json:"retired"`
}
type RequestAck struct {
	Stream  string  `json:"stream"`
	Number  int64   `json:"number"`
	OpID    string  `json:"opId"`
	Receipt Receipt `json:"receipt"`
}

func canonicalDigest(value any) (string, error) {
	b, e := json.Marshal(value)
	if e != nil {
		return "", e
	}
	var normalized any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if e = d.Decode(&normalized); e != nil {
		return "", e
	}
	b, e = json.Marshal(normalized)
	if e != nil {
		return "", e
	}
	hash := sha256.Sum256(b)
	return hex.EncodeToString(hash[:]), nil
}
func (s *Store) initializeProofKey(ctx context.Context, tx pgx.Tx) error {
	var initialized bool
	if e := tx.QueryRow(ctx, "SELECT proof_key_initialized FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&initialized); e != nil {
		return e
	}
	var secret []byte
	e := tx.QueryRow(ctx, "SELECT secret FROM metadata_auth WHERE vault_id=$1", s.Config.VaultID).Scan(&secret)
	if e == pgx.ErrNoRows && !initialized {
		secret = make([]byte, 32)
		if _, e = rand.Read(secret); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO metadata_auth(vault_id,secret) VALUES($1,$2)", s.Config.VaultID, secret); e != nil {
			return e
		}
	} else if e != nil {
		return code("PROOF_KEY_UNAVAILABLE")
	}
	if len(secret) != 32 {
		return code("PROOF_KEY_UNAVAILABLE")
	}
	if _, e = tx.Exec(ctx, "UPDATE vaults SET proof_key_initialized=true WHERE id=$1", s.Config.VaultID); e != nil {
		return e
	}
	s.proofKey = secret
	return nil
}
func (s *Store) proofToken(p BaseProof) string {
	p.Token = ""
	encoded, _ := json.Marshal(p)
	mac := hmac.New(sha256.New, s.proofKey)
	mac.Write([]byte("xsync:accepted-base:v1\x00"))
	mac.Write(encoded)
	return hex.EncodeToString(mac.Sum(nil))
}
func (s *Store) anchor(r Revision, boundary int64) (BaseAnchor, error) {
	digest, e := canonicalDigest(r)
	if e != nil {
		return BaseAnchor{}, e
	}
	p := BaseProof{s.Config.VaultID, s.Config.Epoch, r.FileID, r.ID, digest, boundary, ""}
	p.Token = s.proofToken(p)
	return BaseAnchor{r, p}, nil
}
func (s *Store) verifyProof(p BaseProof, file, revision string, seq int64) error {
	if p.VaultID != s.Config.VaultID || p.Epoch != s.Config.Epoch || p.FileID != file || p.RevisionID != revision || !blobPattern.MatchString(p.Digest) || p.Boundary < 0 || p.Boundary > seq {
		return code("BASE_PROOF_INVALID")
	}
	expected, e := hex.DecodeString(s.proofToken(p))
	if e != nil {
		return e
	}
	got, e := hex.DecodeString(p.Token)
	if e != nil || !hmac.Equal(expected, got) {
		return code("BASE_PROOF_INVALID")
	}
	return nil
}
func (s *Store) CertifyBase(ctx context.Context, r Revision) (BaseAnchor, error) {
	tx, e := s.locked(ctx)
	if e != nil {
		return BaseAnchor{}, e
	}
	defer tx.Rollback(ctx)
	if change, _ := ctx.Value(continuityKey{}).(*continuityChange); change != nil {
		if e = s.advanceContinuity(ctx, tx, change.Device); e != nil {
			return BaseAnchor{}, e
		}
	}
	var value []byte
	e = tx.QueryRow(ctx, "SELECT value FROM revisions WHERE vault_id=$1 AND id=$2", s.Config.VaultID, r.ID).Scan(&value)
	if e == pgx.ErrNoRows {
		var file, digest string
		if e = tx.QueryRow(ctx, "SELECT file_id,digest FROM legacy_revisions WHERE vault_id=$1 AND id=$2", s.Config.VaultID, r.ID).Scan(&file, &digest); e == pgx.ErrNoRows {
			return BaseAnchor{}, code("BASE_NOT_ACCEPTED")
		}
		if e != nil {
			return BaseAnchor{}, e
		}
		got, err := canonicalDigest(r)
		if err != nil {
			return BaseAnchor{}, err
		}
		if file != r.FileID || got != digest {
			return BaseAnchor{}, code("BASE_NOT_ACCEPTED")
		}
		value, e = json.Marshal(r)
	}
	if e != nil {
		return BaseAnchor{}, e
	}
	var accepted Revision
	if e = json.Unmarshal(value, &accepted); e != nil {
		return BaseAnchor{}, e
	}
	a, e := canonicalDigest(accepted)
	if e != nil {
		return BaseAnchor{}, e
	}
	b, e := canonicalDigest(r)
	if e != nil {
		return BaseAnchor{}, e
	}
	if a != b {
		return BaseAnchor{}, code("BASE_NOT_ACCEPTED")
	}
	var seq int64
	if e = tx.QueryRow(ctx, "SELECT seq FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&seq); e != nil {
		return BaseAnchor{}, e
	}
	anchor, e := s.anchor(accepted, seq)
	if e != nil {
		return anchor, e
	}
	return anchor, tx.Commit(ctx)
}
func (s *Store) OpenRequestStream(ctx context.Context, device string) (RequestStream, error) {
	tx, e := s.locked(ctx)
	if e != nil {
		return RequestStream{}, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "INSERT INTO request_streams(vault_id,device_id,id) VALUES($1,$2,$3) ON CONFLICT(vault_id,device_id) DO NOTHING", s.Config.VaultID, device, opaqueID()); e != nil {
		return RequestStream{}, e
	}
	var stream RequestStream
	if e = tx.QueryRow(ctx, "SELECT id,maximum,retired FROM request_streams WHERE vault_id=$1 AND device_id=$2", s.Config.VaultID, device).Scan(&stream.ID, &stream.Maximum, &stream.Retired); e != nil {
		return stream, e
	}
	return stream, tx.Commit(ctx)
}

func (s *Store) inspectTracking(ctx context.Context, tx pgx.Tx, c Commit, t RequestTracking, digest []byte, seq int64) (*TrackedResult, error) {
	if !blobPattern.MatchString(t.Stream) || t.Number < 1 || t.Number > maxSafeNumber {
		return nil, code("INVALID_REQUEST")
	}
	var stream RequestStream
	if e := tx.QueryRow(ctx, "SELECT id,maximum,retired FROM request_streams WHERE vault_id=$1 AND device_id=$2", c.VaultID, c.DeviceID).Scan(&stream.ID, &stream.Maximum, &stream.Retired); e != nil {
		return nil, code("REQUEST_STREAM_INVALID")
	}
	if stream.ID != t.Stream {
		return nil, code("REQUEST_STREAM_INVALID")
	}
	var retired bool
	if e := tx.QueryRow(ctx, `SELECT $4::bigint<=$5::bigint OR EXISTS(SELECT 1 FROM acknowledged_ranges WHERE vault_id=$1 AND device_id=$2 AND stream_id=$3 AND first<=$4 AND last>=$4)`, c.VaultID, c.DeviceID, t.Stream, t.Number, stream.Retired).Scan(&retired); e != nil {
		return nil, e
	}
	if retired {
		return nil, code("OPERATION_RETIRED")
	}
	var prior []byte
	var encoded []byte
	var op string
	e := tx.QueryRow(ctx, "SELECT op_id,digest,result FROM tracked_operations WHERE vault_id=$1 AND device_id=$2 AND stream_id=$3 AND number=$4", c.VaultID, c.DeviceID, t.Stream, t.Number).Scan(&op, &prior, &encoded)
	if e == nil {
		if op != c.OpID || !bytes.Equal(prior, digest) {
			return nil, code("OP_ID_REUSED")
		}
		var result TrackedResult
		e = json.Unmarshal(encoded, &result)
		return &result, e
	}
	if e != pgx.ErrNoRows {
		return nil, e
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM tracked_operations WHERE vault_id=$1 AND device_id=$2 AND NOT acknowledged", c.VaultID, c.DeviceID).Scan(&count); e != nil {
		return nil, e
	}
	if count >= 4096 {
		return nil, code("REQUEST_ACK_REQUIRED")
	}
	return nil, nil
}
func (s *Store) validateTrackedBases(c Commit, t RequestTracking, seq int64) error {
	for _, a := range c.Actions {
		if a.Type == "edit" {
			found := false
			for _, p := range t.Bases {
				if p.RevisionID == a.Displayed && p.FileID == a.FileID {
					if e := s.verifyProof(p, a.FileID, a.Displayed, seq); e != nil {
						return e
					}
					found = true
					break
				}
			}
			if !found {
				return code("BASE_PROOF_REQUIRED")
			}
		}
	}
	return nil
}

type trackingContextKey struct{}
type trackingRun struct {
	Tracking RequestTracking
	Result   TrackedResult
}

func (s *Store) CommitTracked(ctx context.Context, c Commit, t RequestTracking) (TrackedResult, error) {
	run := &trackingRun{Tracking: t}
	_, e := s.Commit(context.WithValue(ctx, trackingContextKey{}, run), c)
	return run.Result, e
}
func (s *Store) recordTracking(ctx context.Context, tx pgx.Tx, c Commit, t RequestTracking, digest []byte, r Receipt, seq int64) (TrackedResult, error) {
	result := TrackedResult{r, []BaseAnchor{}}
	for _, revision := range requestRevisions(c) {
		anchor, e := s.anchor(revision, seq)
		if e != nil {
			return result, e
		}
		result.Bases = append(result.Bases, anchor)
	}
	encoded, e := json.Marshal(result)
	if e != nil {
		return result, e
	}
	if len(encoded)+1 > 32<<20 {
		return result, code("RESULT_TOO_LARGE")
	}
	if _, e = tx.Exec(ctx, "INSERT INTO tracked_operations(vault_id,device_id,stream_id,number,op_id,digest,result) VALUES($1,$2,$3,$4,$5,$6,$7)", c.VaultID, c.DeviceID, t.Stream, t.Number, c.OpID, digest, encoded); e != nil {
		return result, code("OP_ID_REUSED")
	}
	_, e = tx.Exec(ctx, "UPDATE request_streams SET maximum=GREATEST(maximum,$3) WHERE vault_id=$1 AND device_id=$2", c.VaultID, c.DeviceID, t.Number)
	return result, e
}
func (s *Store) AcknowledgeRequest(ctx context.Context, device string, ack RequestAck) error {
	if ack.Number < 1 || ack.Number > maxSafeNumber {
		return code("INVALID_REQUEST")
	}
	tx, e := s.locked(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var stream RequestStream
	if e = tx.QueryRow(ctx, "SELECT id,maximum,retired FROM request_streams WHERE vault_id=$1 AND device_id=$2", s.Config.VaultID, device).Scan(&stream.ID, &stream.Maximum, &stream.Retired); e != nil {
		return code("REQUEST_STREAM_INVALID")
	}
	if stream.ID != ack.Stream {
		return code("REQUEST_STREAM_INVALID")
	}
	var retired bool
	if e = tx.QueryRow(ctx, `SELECT $4::bigint<=$5::bigint OR EXISTS(SELECT 1 FROM acknowledged_ranges WHERE vault_id=$1 AND device_id=$2 AND stream_id=$3 AND first<=$4 AND last>=$4)`, s.Config.VaultID, device, ack.Stream, ack.Number, stream.Retired).Scan(&retired); e != nil {
		return e
	}
	if retired {
		return nil
	}
	var encoded []byte
	var op string
	if e = tx.QueryRow(ctx, "SELECT op_id,result FROM tracked_operations WHERE vault_id=$1 AND device_id=$2 AND stream_id=$3 AND number=$4", s.Config.VaultID, device, ack.Stream, ack.Number).Scan(&op, &encoded); e != nil {
		return code("REQUEST_ACK_INVALID")
	}
	var result TrackedResult
	if e = json.Unmarshal(encoded, &result); e != nil {
		return e
	}
	if op != ack.OpID || result.Receipt != ack.Receipt {
		return code("REQUEST_ACK_INVALID")
	}
	if _, e = tx.Exec(ctx, "UPDATE tracked_operations SET acknowledged=true WHERE vault_id=$1 AND device_id=$2 AND stream_id=$3 AND number=$4", s.Config.VaultID, device, ack.Stream, ack.Number); e != nil {
		return e
	}
	type interval struct{ First, Last int64 }
	ranges := []interval{{ack.Number, ack.Number}}
	rows, e := tx.Query(ctx, "SELECT first,last FROM acknowledged_ranges WHERE vault_id=$1 AND device_id=$2 AND stream_id=$3", s.Config.VaultID, device, ack.Stream)
	if e != nil {
		return e
	}
	for rows.Next() {
		var r interval
		if e = rows.Scan(&r.First, &r.Last); e != nil {
			rows.Close()
			return e
		}
		ranges = append(ranges, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].First < ranges[j].First })
	merged := []interval{}
	for _, r := range ranges {
		if r.First <= stream.Retired+1 {
			if r.Last > stream.Retired {
				stream.Retired = r.Last
			}
			continue
		}
		if len(merged) > 0 && r.First <= merged[len(merged)-1].Last+1 {
			if r.Last > merged[len(merged)-1].Last {
				merged[len(merged)-1].Last = r.Last
			}
		} else {
			merged = append(merged, r)
		}
	}
	if _, e = tx.Exec(ctx, "DELETE FROM acknowledged_ranges WHERE vault_id=$1 AND device_id=$2 AND stream_id=$3", s.Config.VaultID, device, ack.Stream); e != nil {
		return e
	}
	for _, r := range merged {
		if _, e = tx.Exec(ctx, "INSERT INTO acknowledged_ranges(vault_id,device_id,stream_id,first,last) VALUES($1,$2,$3,$4,$5)", s.Config.VaultID, device, ack.Stream, r.First, r.Last); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, "UPDATE request_streams SET retired=$3 WHERE vault_id=$1 AND device_id=$2", s.Config.VaultID, device, stream.Retired); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "DELETE FROM tracked_operations WHERE vault_id=$1 AND device_id=$2 AND stream_id=$3 AND number=$4", s.Config.VaultID, device, ack.Stream, ack.Number); e != nil {
		return e
	}
	if s.compact {
		if _, e = tx.Exec(ctx, "DELETE FROM legacy_object_intents WHERE vault_id=$1 AND device_id=$2 AND op_id=$3", s.Config.VaultID, device, ack.OpID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM legacy_intents WHERE vault_id=$1 AND device_id=$2 AND op_id=$3", s.Config.VaultID, device, ack.OpID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM operations WHERE vault_id=$1 AND device_id=$2 AND op_id=$3 AND NOT legacy", s.Config.VaultID, device, ack.OpID); e != nil {
			return e
		}
	}
	if e = s.fault("before-request-ack-commit"); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return s.fault("after-request-ack-commit")
}

// Independent head projection. Full mode checks the complete graph; compact mode has a separate
// randomized complete-graph oracle in compaction_test.go, after pruning at every step.
func shadowHeads(before map[string][]string, c Commit, after *state) error {
	heads := map[string][]string{}
	for id, h := range before {
		heads[id] = append([]string{}, h...)
	}
	add := func(file, revision string, parents []string) {
		next := []string{}
		for _, h := range heads[file] {
			if !contains(parents, h) {
				next = append(next, h)
			}
		}
		heads[file] = append(next, revision)
	}
	for _, a := range c.Actions {
		switch a.Type {
		case "create", "branch":
			add(a.FileID, a.RevisionID, nil)
		case "edit":
			add(a.FileID, a.RevisionID, []string{a.Displayed})
		case "resolve":
			add(a.FileID, a.RevisionID, a.Observed)
			if a.Decision != nil && a.Decision.Companion != nil {
				b := a.Decision.Companion
				add(b.FileID, b.RevisionID, nil)
			}
		}
	}
	for id, f := range after.files {
		if !sameSet(heads[id], f.Heads) {
			return code("CAUSAL_SHADOW_MISMATCH")
		}
	}
	return nil
}
