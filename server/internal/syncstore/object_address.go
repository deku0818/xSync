package syncstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5"
)

const ObjectCapability = "addressed-objects-v1"

func addressedObject(id string) bool {
	return strings.HasPrefix(id, "c_") && objectPattern.MatchString(id)
}

type LegacyObjectMigration struct {
	Requests []Commit `json:"requests"`
}

// A separate once-only bundle also admits outboxes created after the 3B migration was closed.
func (s *Store) RegisterLegacyObjects(ctx context.Context, device string, m LegacyObjectMigration) error {
	if !s.compact || m.Requests == nil || len(m.Requests) > 4096 {
		return code("INVALID_REQUEST")
	}
	bundle, e := canonicalDigest(m)
	if e != nil {
		return e
	}
	tx, e := s.locked(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var prior string
	e = tx.QueryRow(ctx, "SELECT digest FROM legacy_object_migrations WHERE vault_id=$1 AND device_id=$2", s.Config.VaultID, device).Scan(&prior)
	if e == nil {
		if prior != bundle {
			return code("LEGACY_OBJECT_MIGRATION_CHANGED")
		}
		return nil
	}
	if e != pgx.ErrNoRows {
		return e
	}
	seen := map[string]bool{}
	for _, c := range m.Requests {
		if c.Protocol != 0 || c.Required == nil || c.VaultID != s.Config.VaultID || c.Epoch != s.Config.Epoch || c.DeviceID != device || !validID(c.OpID) || len(c.Actions) == 0 || len(c.Actions) > 1000 || seen[c.OpID] {
			return code("INVALID_REQUEST")
		}
		seen[c.OpID] = true
		for _, a := range c.Actions {
			for _, id := range actionObjects(a) {
				if !objectPattern.MatchString(id) {
					return code("INVALID_REQUEST")
				}
			}
		}
		encoded, e := json.Marshal(c)
		if e != nil {
			return e
		}
		digest := sha256.Sum256(encoded)
		if _, e = tx.Exec(ctx, "INSERT INTO legacy_object_intents(vault_id,device_id,op_id,digest) VALUES($1,$2,$3,$4)", c.VaultID, device, c.OpID, digest[:]); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, "INSERT INTO legacy_object_migrations(vault_id,device_id,digest) VALUES($1,$2,$3)", s.Config.VaultID, device, bundle); e != nil {
		return e
	}
	if e = s.fault("before-legacy-object-registration-commit"); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return s.fault("after-legacy-object-registration-commit")
}

func (s *Store) validateLegacyObjectUpload(ctx context.Context, tx pgx.Tx, c Commit, digest []byte) error {
	if !s.compact {
		return nil
	}
	unknown := false
	for _, a := range c.Actions {
		for _, id := range actionObjects(a) {
			if !objectPattern.MatchString(id) {
				return code("INVALID_REQUEST")
			}
			if addressedObject(id) {
				continue
			}
			var known bool
			if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM objects WHERE vault_id=$1 AND id=$2)", c.VaultID, id).Scan(&known); e != nil {
				return e
			}
			if !known {
				unknown = true
			}
		}
	}
	if !unknown {
		return nil
	}
	var accepted []byte
	e := tx.QueryRow(ctx, "SELECT digest FROM legacy_object_intents WHERE vault_id=$1 AND device_id=$2 AND op_id=$3", c.VaultID, c.DeviceID, c.OpID).Scan(&accepted)
	if e != nil && e != pgx.ErrNoRows {
		return e
	}
	if e == pgx.ErrNoRows || !bytes.Equal(accepted, digest) {
		return code("LEGACY_OBJECT_UNREGISTERED")
	}
	return nil
}
