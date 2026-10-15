package syncstore

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type DeviceProfile struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Revision   int64  `json:"revision"`
	Ciphertext string `json:"ciphertext,omitempty"`
	ReportedAt string `json:"reportedAt,omitempty"`
}
type ProfileUpdate struct {
	Name             string `json:"name"`
	ExpectedRevision int64  `json:"expectedRevision"`
	Ciphertext       string `json:"ciphertext"`
}

func normalizedName(name string) (string, string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 40 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", "", code("DEVICE_NAME_INVALID")
	}
	return name, cases.Fold().String(norm.NFKC.String(name)), nil
}
func profileError(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return code("DEVICE_NAME_TAKEN")
	}
	return err
}
func (s *Store) Devices(ctx context.Context) ([]DeviceProfile, error) {
	rows, e := s.Pool.Query(ctx, "SELECT id,name,profile_revision,COALESCE(profile_ciphertext,''),profile_reported_at FROM devices WHERE vault_id=$1 ORDER BY name_key,id", s.Config.VaultID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	result := []DeviceProfile{}
	for rows.Next() {
		var r DeviceProfile
		var at *time.Time
		if e = rows.Scan(&r.ID, &r.Name, &r.Revision, &r.Ciphertext, &at); e != nil {
			return nil, e
		}
		if at != nil {
			r.ReportedAt = at.UTC().Format(time.RFC3339Nano)
		}
		result = append(result, r)
	}
	return result, rows.Err()
}
func (s *Store) PutProfile(ctx context.Context, device string, input ProfileUpdate) (DeviceProfile, error) {
	var zero DeviceProfile
	name, key, e := normalizedName(input.Name)
	if e != nil {
		return zero, e
	}
	if input.ExpectedRevision < 0 || input.ExpectedRevision >= 9007199254740991 || len(input.Ciphertext) == 0 || len(input.Ciphertext) > 262144 {
		return zero, code("INVALID_REQUEST")
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return zero, e
	}
	defer tx.Rollback(ctx)
	var prior DeviceProfile
	var at *time.Time
	e = tx.QueryRow(ctx, "SELECT id,name,profile_revision,COALESCE(profile_ciphertext,''),profile_reported_at FROM devices WHERE vault_id=$1 AND id=$2 FOR UPDATE", s.Config.VaultID, device).Scan(&prior.ID, &prior.Name, &prior.Revision, &prior.Ciphertext, &at)
	if e == pgx.ErrNoRows {
		return zero, code("UNAUTHORIZED")
	}
	if e != nil {
		return zero, e
	}
	if prior.Revision == input.ExpectedRevision+1 && prior.Name == name && prior.Ciphertext == input.Ciphertext {
		if at != nil {
			prior.ReportedAt = at.UTC().Format(time.RFC3339Nano)
		}
		return prior, nil
	}
	if prior.Revision != input.ExpectedRevision {
		return zero, code("PROFILE_STALE")
	}
	var committed time.Time
	e = tx.QueryRow(ctx, "UPDATE devices SET name=$3,name_key=$4,profile_revision=profile_revision+1,profile_ciphertext=$5,profile_reported_at=clock_timestamp() WHERE vault_id=$1 AND id=$2 RETURNING profile_reported_at", s.Config.VaultID, device, name, key, input.Ciphertext).Scan(&committed)
	if e != nil {
		return zero, profileError(e)
	}
	if e = tx.Commit(ctx); e != nil {
		return zero, e
	}
	if e = s.fault("after-profile-commit"); e != nil {
		return zero, e
	}
	return DeviceProfile{device, name, input.ExpectedRevision + 1, input.Ciphertext, committed.UTC().Format(time.RFC3339Nano)}, nil
}
