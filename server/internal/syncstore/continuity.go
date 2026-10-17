package syncstore

import (
	"context"

	"github.com/jackc/pgx/v5"
)

const ContinuityCapability = "device-continuity-v1"

type continuityKey struct{}
type continuityChange struct{ Device, From, Next string }

// One replaceable register per device witnesses the database history it has consumed. Other
// devices cannot advance it, so a restored database cannot hide behind a higher global seq.
func (s *Store) Continuity(ctx context.Context, device string) (string, error) {
	tx, e := s.locked(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "INSERT INTO device_continuity(vault_id,device_id,token) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", s.Config.VaultID, device, opaqueID()); e != nil {
		return "", e
	}
	var token string
	if e = tx.QueryRow(ctx, "SELECT token FROM device_continuity WHERE vault_id=$1 AND device_id=$2", s.Config.VaultID, device).Scan(&token); e != nil {
		return "", e
	}
	return token, tx.Commit(ctx)
}
func (s *Store) advanceContinuity(ctx context.Context, tx pgx.Tx, device string) error {
	change, _ := ctx.Value(continuityKey{}).(*continuityChange)
	if change == nil {
		return nil
	} // Internal contract helpers have no HTTP caller.
	if change.Device != device || !blobPattern.MatchString(change.From) || !blobPattern.MatchString(change.Next) || change.From == change.Next {
		return code("INVALID_REQUEST")
	}
	tag, e := tx.Exec(ctx, "UPDATE device_continuity SET token=$4 WHERE vault_id=$1 AND device_id=$2 AND token=$3", s.Config.VaultID, device, change.From, change.Next)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return code("CONTINUITY_MISMATCH")
	}
	return s.fault("after-continuity-update")
}

// Advance the pending transition without consuming file data. This fences a timed-out request
// which has not reached its transaction yet; if it already won, the caller reads the same token.
func (s *Store) FenceContinuity(ctx context.Context, device string) (string, error) {
	tx, e := s.locked(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	change, _ := ctx.Value(continuityKey{}).(*continuityChange)
	if change == nil {
		return "", code("INVALID_REQUEST")
	}
	if e = s.advanceContinuity(ctx, tx, device); e != nil {
		return "", e
	}
	return change.Next, tx.Commit(ctx)
}
func (s *Store) MigrationState(ctx context.Context, device string) (map[string]bool, error) {
	var legacy, objects bool
	e := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM legacy_migrations WHERE vault_id=$1 AND device_id=$2),
 EXISTS(SELECT 1 FROM legacy_object_migrations WHERE vault_id=$1 AND device_id=$2)`, s.Config.VaultID, device).Scan(&legacy, &objects)
	return map[string]bool{"legacy": legacy, "objects": objects}, e
}
