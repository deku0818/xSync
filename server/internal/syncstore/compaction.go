package syncstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
)

const CompactCapability = "compact-heads-v1"

func (s *Store) checkMetadataMode(checkpoint int64) error {
	if (checkpoint >= 0) != s.compact {
		return code("METADATA_MODE_CHANGED")
	}
	return nil
}

type LegacyMigration struct {
	Requests []Commit `json:"requests"`
}

func derivedID(t RequestTracking, role string, index int) string {
	return fmt.Sprintf("m_%s_%d_%s_%d", t.Stream, t.Number, role, index)
}
func derivedOperation(t RequestTracking) string { return fmt.Sprintf("q_%s_%d", t.Stream, t.Number) }
func derivedRequest(c Commit, t RequestTracking) bool {
	if c.OpID != derivedOperation(t) {
		return false
	}
	for index, a := range c.Actions {
		if a.RevisionID != "" && a.RevisionID != derivedID(t, "r", index) {
			return false
		}
		if a.Location != nil && a.Location.Revision != derivedID(t, "l", index) {
			return false
		}
		if a.Decision != nil && a.Decision.Companion != nil {
			b := a.Decision.Companion
			if b.RevisionID != derivedID(t, "rc", index) || b.Location == nil || b.Location.Revision != derivedID(t, "lc", index) {
				return false
			}
		}
	}
	return true
}

// A one-time accepted identity index lets pre-upgrade clients certify their exact old baseline.
// Future derived identities need no ever-growing used-ID set.
func (s *Store) initializeCompaction(ctx context.Context, tx pgx.Tx) error {
	var checkpoint int64
	if e := tx.QueryRow(ctx, "SELECT metadata_checkpoint FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&checkpoint); e != nil {
		return e
	}
	if checkpoint >= 0 {
		if s.Config.MetadataMode == "full" {
			return code("METADATA_DOWNGRADE_REFUSED")
		}
		s.compact = true
		return nil
	}
	if s.Config.MetadataMode == "full" {
		return nil
	}
	var e error
	last := ""
	for {
		rows, err := tx.Query(ctx, "SELECT id,value FROM revisions WHERE vault_id=$1 AND id>$2 ORDER BY id LIMIT 256", s.Config.VaultID, last)
		if err != nil {
			return err
		}
		revisions := []Revision{}
		for rows.Next() {
			var b []byte
			var r Revision
			if e = rows.Scan(&last, &b); e == nil {
				e = json.Unmarshal(b, &r)
			}
			if e != nil {
				rows.Close()
				return e
			}
			revisions = append(revisions, r)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, r := range revisions {
			if e = s.indexLegacyRevision(ctx, tx, r); e != nil {
				return e
			}
		}
		if len(revisions) < 256 {
			break
		}
	}
	if _, e = tx.Exec(ctx, `INSERT INTO legacy_locations(vault_id,id) SELECT vault_id,id FROM locations WHERE vault_id=$1 ON CONFLICT DO NOTHING`, s.Config.VaultID); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO change_revisions(vault_id,seq,revision_id)
 SELECT c.vault_id,c.seq,a->>'revisionId' FROM changes c CROSS JOIN LATERAL jsonb_array_elements(c.value->'actions') a WHERE c.vault_id=$1 AND a ? 'revisionId'
 UNION SELECT c.vault_id,c.seq,a->'decision'->'companion'->>'revisionId' FROM changes c CROSS JOIN LATERAL jsonb_array_elements(c.value->'actions') a WHERE c.vault_id=$1 AND a->'decision' ? 'companion'
 ON CONFLICT DO NOTHING`, s.Config.VaultID); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "UPDATE vaults SET metadata_checkpoint=seq WHERE id=$1", s.Config.VaultID); e != nil {
		return e
	}
	if e = s.fault("before-metadata-migration-commit"); e != nil {
		return e
	}
	s.compact = true
	return nil
}
func (s *Store) indexLegacyRevision(ctx context.Context, tx pgx.Tx, r Revision) error {
	digest, e := canonicalDigest(r)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "INSERT INTO legacy_revisions(vault_id,id,file_id,digest) VALUES($1,$2,$3,$4)", s.Config.VaultID, r.ID, r.FileID, digest)
	return e
}

// Registration is once per device and retries bind the same immutable bundle. It does not submit data.
func (s *Store) RegisterLegacy(ctx context.Context, device string, m LegacyMigration) error {
	if !s.compact {
		return code("INVALID_REQUEST")
	}
	if m.Requests == nil || len(m.Requests) > 4096 {
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
	e = tx.QueryRow(ctx, "SELECT digest FROM legacy_migrations WHERE vault_id=$1 AND device_id=$2", s.Config.VaultID, device).Scan(&prior)
	if e == nil {
		if prior != bundle {
			return code("LEGACY_MIGRATION_CHANGED")
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
		b, e := json.Marshal(c)
		if e != nil {
			return e
		}
		digest := sha256.Sum256(b)
		if _, e = tx.Exec(ctx, "INSERT INTO legacy_intents(vault_id,device_id,op_id,digest) VALUES($1,$2,$3,$4)", c.VaultID, device, c.OpID, digest[:]); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, "INSERT INTO legacy_migrations(vault_id,device_id,digest) VALUES($1,$2,$3)", s.Config.VaultID, device, bundle); e != nil {
		return e
	}
	if e = s.fault("before-legacy-registration-commit"); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return s.fault("after-legacy-registration-commit")
}

func (s *Store) validateCompactRequest(ctx context.Context, tx pgx.Tx, c Commit, t *trackingRun, digest []byte) (bool, error) {
	if !s.compact {
		return true, nil
	}
	if t == nil {
		return false, code("CLIENT_UPGRADE_REQUIRED")
	}
	legacy := !derivedRequest(c, t.Tracking)
	if legacy {
		var accepted []byte
		e := tx.QueryRow(ctx, "SELECT digest FROM legacy_intents WHERE vault_id=$1 AND device_id=$2 AND op_id=$3", c.VaultID, c.DeviceID, c.OpID).Scan(&accepted)
		if e != nil && e != pgx.ErrNoRows {
			return false, e
		}
		if e == pgx.ErrNoRows || !bytes.Equal(accepted, digest) {
			return false, code("LEGACY_INTENT_UNREGISTERED")
		}
	}
	for _, a := range c.Actions {
		entries := []Action{a}
		if a.Decision != nil && a.Decision.Companion != nil {
			entries = append(entries, *a.Decision.Companion)
		}
		for _, entry := range entries {
			if entry.RevisionID != "" {
				var used bool
				if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM legacy_revisions WHERE vault_id=$1 AND id=$2)", c.VaultID, entry.RevisionID).Scan(&used); e != nil {
					return false, e
				}
				if used {
					return false, code("REVISION_EXISTS")
				}
			}
			if entry.Location != nil {
				var used bool
				if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM legacy_locations WHERE vault_id=$1 AND id=$2)", c.VaultID, entry.Location.Revision).Scan(&used); e != nil {
					return false, e
				}
				if used {
					return false, code("LOCATION_STALE")
				}
			}
		}
	}
	return legacy, nil
}

func requestRevisions(c Commit) []Revision {
	revisions := []Revision{}
	for _, a := range c.Actions {
		if a.RevisionID == "" || a.Payload == nil {
			continue
		}
		parents := []string{}
		source := ""
		if a.Type == "edit" {
			parents = []string{a.Displayed}
		}
		if a.Type == "resolve" {
			parents = a.Observed
			if a.Decision != nil && a.Decision.Kind != "manual" {
				source = a.Decision.Selected
			}
		}
		revisions = append(revisions, Revision{a.RevisionID, a.FileID, parents, c.DeviceID, *a.Payload, source})
		if a.Decision != nil && a.Decision.Companion != nil {
			b := a.Decision.Companion
			if b.Payload != nil {
				revisions = append(revisions, Revision{b.RevisionID, b.FileID, []string{}, c.DeviceID, *b.Payload, a.Decision.Source})
			}
		}
	}
	return revisions
}

func (s *Store) pruneMetadata(ctx context.Context, tx pgx.Tx, report *CleanupReport) error {
	if !s.compact {
		return nil
	}
	// Logs and active frozen heads remain independently usable. No recursive parent retention.
	if _, e := tx.Exec(ctx, `CREATE TEMP TABLE metadata_keep ON COMMIT DROP AS
 SELECT revision_id AS id FROM heads WHERE vault_id=$1
 UNION SELECT revision_id FROM change_revisions WHERE vault_id=$1
 UNION SELECT jsonb_array_elements_text(f->'heads') FROM snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.value->'files') f WHERE s.vault_id=$1`, s.Config.VaultID); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, "DELETE FROM revision_objects WHERE vault_id=$1 AND revision_id NOT IN (SELECT id FROM metadata_keep)", s.Config.VaultID); e != nil {
		return e
	}
	tag, e := tx.Exec(ctx, "DELETE FROM revisions WHERE vault_id=$1 AND id NOT IN (SELECT id FROM metadata_keep)", s.Config.VaultID)
	if e != nil {
		return e
	}
	report.Revisions = tag.RowsAffected()
	tag, e = tx.Exec(ctx, "DELETE FROM locations WHERE vault_id=$1 AND id NOT IN (SELECT location->>'revision' FROM files WHERE vault_id=$1)", s.Config.VaultID)
	if e != nil {
		return e
	}
	report.Locations = tag.RowsAffected()
	if _, e = tx.Exec(ctx, "UPDATE vaults SET metadata_checkpoint=seq WHERE id=$1", s.Config.VaultID); e != nil {
		return e
	}
	return s.fault("before-metadata-cleanup-commit")
}
