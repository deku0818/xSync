package syncstore

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

type Challenge struct {
	ID    string `json:"id"`
	Nonce string `json:"nonce"`
}
type Enrollment struct {
	Format    int       `json:"format"`
	VaultID   string    `json:"vaultId"`
	Epoch     string    `json:"epoch"`
	Challenge Challenge `json:"challenge"`
	DeviceID  string    `json:"deviceId"`
	Name      string    `json:"name"`
	TokenHash string    `json:"tokenHash"`
	Signature string    `json:"signature"`
}

func enrollmentMessage(in Enrollment) []byte {
	var out bytes.Buffer
	for _, field := range []string{"xsync:device-enrollment-v1", in.VaultID, in.Epoch, in.Challenge.ID, in.Challenge.Nonce, in.DeviceID, in.Name, in.TokenHash} {
		_ = binary.Write(&out, binary.BigEndian, uint32(len([]byte(field))))
		out.WriteString(field)
	}
	return out.Bytes()
}
func randomHex() (string, error) {
	b := make([]byte, 32)
	_, e := rand.Read(b)
	return hex.EncodeToString(b), e
}
func (s *Store) NewChallenge(ctx context.Context) (Challenge, error) {
	var result Challenge
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return result, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT id FROM vaults WHERE id=$1 FOR UPDATE", s.Config.VaultID); e != nil {
		return result, e
	}
	// NULL enrollment_until is closed once any device has enrolled.
	var open bool
	e = tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM devices WHERE vault_id=$1) OR COALESCE(enrollment_until > clock_timestamp(),false) FROM vaults WHERE id=$1`, s.Config.VaultID).Scan(&open)
	if e != nil {
		return result, e
	}
	if !open {
		return result, code("ENROLLMENT_CLOSED")
	}
	if _, e = tx.Exec(ctx, "DELETE FROM enrollment_challenges WHERE vault_id=$1 AND accepted_digest IS NULL AND expires_at < clock_timestamp()", s.Config.VaultID); e != nil {
		return result, e
	}
	var active int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM enrollment_challenges WHERE vault_id=$1 AND accepted_digest IS NULL", s.Config.VaultID).Scan(&active); e != nil {
		return result, e
	}
	if active >= 128 {
		return result, code("ENROLLMENT_BUSY")
	}
	if result.ID, e = randomHex(); e != nil {
		return result, e
	}
	if result.Nonce, e = randomHex(); e != nil {
		return result, e
	}
	_, e = tx.Exec(ctx, "INSERT INTO enrollment_challenges(vault_id,id,nonce,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '90 seconds')", s.Config.VaultID, result.ID, result.Nonce)
	if e != nil {
		return result, e
	}
	return result, tx.Commit(ctx)
}
func (s *Store) Enroll(ctx context.Context, in Enrollment) error {
	name, nameKey, e := normalizedName(in.Name)
	if e != nil {
		return e
	}
	if in.Format != 1 || in.VaultID != s.Config.VaultID || in.Epoch != s.Config.Epoch || name != in.Name || !validID(in.DeviceID) || !blobPattern.MatchString(in.TokenHash) || !blobPattern.MatchString(in.Challenge.ID) || !blobPattern.MatchString(in.Challenge.Nonce) {
		return code("INVALID_REQUEST")
	}
	public, e := hex.DecodeString(s.Config.EnrollmentPublicKey)
	if e != nil || len(public) != ed25519.PublicKeySize {
		return code("UNAUTHORIZED")
	}
	signature, e := hex.DecodeString(in.Signature)
	message := enrollmentMessage(in)
	if e != nil || !ed25519.Verify(public, message, signature) {
		return code("UNAUTHORIZED")
	}
	digest := sha256.Sum256(message)
	hash, _ := hex.DecodeString(in.TokenHash)
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT id FROM vaults WHERE id=$1 FOR UPDATE", s.Config.VaultID); e != nil {
		return e
	}
	var nonce string
	var expires time.Time
	var accepted []byte
	e = tx.QueryRow(ctx, "SELECT nonce,expires_at,accepted_digest FROM enrollment_challenges WHERE vault_id=$1 AND id=$2 FOR UPDATE", s.Config.VaultID, in.Challenge.ID).Scan(&nonce, &expires, &accepted)
	if e == pgx.ErrNoRows {
		return code("ENROLLMENT_EXPIRED")
	}
	if e != nil {
		return e
	}
	if nonce != in.Challenge.Nonce {
		return code("UNAUTHORIZED")
	}
	var previous []byte
	var revoked bool
	e = tx.QueryRow(ctx, "SELECT token_hash,revoked_at IS NOT NULL FROM devices WHERE vault_id=$1 AND id=$2", s.Config.VaultID, in.DeviceID).Scan(&previous, &revoked)
	exists := e == nil
	if e != nil && e != pgx.ErrNoRows {
		return e
	}
	if revoked {
		return code("DEVICE_REVOKED")
	}
	if accepted != nil {
		if !bytes.Equal(accepted, digest[:]) {
			return code("ENROLLMENT_REPLAY")
		}
		if !exists || !bytes.Equal(previous, hash) {
			return code("UNAUTHORIZED")
		}
		return nil // Exact receipt retry never rotates credentials a second time.
	}
	var open bool
	e = tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM devices WHERE vault_id=$1) OR COALESCE(enrollment_until > clock_timestamp(),false) FROM vaults WHERE id=$1`, s.Config.VaultID).Scan(&open)
	if e != nil {
		return e
	}
	if !open {
		return code("ENROLLMENT_CLOSED")
	}
	// Use database time for expiry, including processes with a skewed host clock.
	var fresh bool
	if e = tx.QueryRow(ctx, "SELECT $1::timestamptz > clock_timestamp()", expires).Scan(&fresh); e != nil {
		return e
	}
	if !fresh {
		return code("ENROLLMENT_EXPIRED")
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM devices WHERE vault_id=$1", s.Config.VaultID).Scan(&count); e != nil {
		return e
	}
	if !exists && count >= 256 {
		return code("DEVICE_LIMIT")
	}
	if exists {
		_, e = tx.Exec(ctx, "UPDATE devices SET token_hash=$3,name=$4,name_key=$5 WHERE vault_id=$1 AND id=$2", s.Config.VaultID, in.DeviceID, hash, name, nameKey)
	} else {
		_, e = tx.Exec(ctx, "INSERT INTO devices(vault_id,id,name,name_key,token_hash) VALUES($1,$2,$3,$4,$5)", s.Config.VaultID, in.DeviceID, name, nameKey, hash)
	}
	if e != nil {
		return profileError(e)
	}
	if _, e = tx.Exec(ctx, "DELETE FROM enrollment_challenges WHERE vault_id=$1 AND device_id=$2 AND accepted_digest IS NOT NULL", s.Config.VaultID, in.DeviceID); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "UPDATE enrollment_challenges SET accepted_digest=$3,device_id=$4 WHERE vault_id=$1 AND id=$2", s.Config.VaultID, in.Challenge.ID, digest[:], in.DeviceID); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

// Administrative operations are local CLI calls, never public HTTP endpoints.
func (s *Store) OpenEnrollment(ctx context.Context, duration time.Duration) error {
	if s.Config.EnrollmentPublicKey == "" || duration < 0 || duration > time.Hour {
		return code("INVALID_REQUEST")
	}
	_, e := s.Pool.Exec(ctx, "UPDATE vaults SET enrollment_until=clock_timestamp()+make_interval(secs => $2) WHERE id=$1", s.Config.VaultID, duration.Seconds())
	return e
}
func (s *Store) RevokeDevice(ctx context.Context, id string) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT id FROM vaults WHERE id=$1 FOR UPDATE", s.Config.VaultID); e != nil {
		return e
	}
	result, e := tx.Exec(ctx, "UPDATE devices SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id)
	if e != nil {
		return e
	}
	if result.RowsAffected() == 0 {
		return code("DEVICE_MISSING")
	}
	return tx.Commit(ctx)
}
func (s *Store) enrollmentHandler(w http.ResponseWriter, r *http.Request) bool {
	if s.Config.EnrollmentPublicKey == "" {
		return false
	}
	route := r.Method + " " + r.URL.Path
	if route != "GET /onboarding" && route != "POST /enroll/challenges" && route != "POST /enroll" {
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	switch route {
	case "GET /onboarding":
		writeJSON(w, 200, map[string]any{"format": 1, "vaultId": s.Config.VaultID, "epoch": s.Config.Epoch, "keyPackage": s.Config.KeyPackage, "publicKey": s.Config.EnrollmentPublicKey})
	case "POST /enroll/challenges":
		var empty struct{}
		if e := decodeBody(w, r, &empty); e != nil {
			writeError(w, e)
			return true
		}
		challenge, e := s.NewChallenge(r.Context())
		if e != nil {
			writeError(w, e)
		} else {
			writeJSON(w, 200, challenge)
		}
	case "POST /enroll":
		var in Enrollment
		if e := decodeBody(w, r, &in); e != nil {
			writeError(w, e)
			return true
		}
		if e := s.Enroll(r.Context(), in); e != nil {
			writeError(w, e)
		} else {
			writeJSON(w, 200, map[string]bool{"enrolled": true})
		}
	default:
		return false
	}
	return true
}
