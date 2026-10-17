package syncstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

const ContentCapability = "content-leases-v1"

func opaqueID() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}

func (s *Store) locked(ctx context.Context) (pgx.Tx, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	var epoch string
	var checkpoint int64
	e = tx.QueryRow(ctx, "SELECT epoch,metadata_checkpoint FROM vaults WHERE id=$1 FOR UPDATE", s.Config.VaultID).Scan(&epoch, &checkpoint)
	if e == nil && epoch != s.Config.Epoch {
		e = code("EPOCH_CHANGED")
	}
	if e == nil {
		e = s.checkMetadataMode(checkpoint)
	}
	if e != nil {
		tx.Rollback(ctx)
		return nil, e
	}
	return tx, nil
}

func (s *Store) validLease(ctx context.Context, tx pgx.Tx, device, id, kind string) error {
	var ok bool
	e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM content_leases WHERE vault_id=$1 AND id=$2
 AND device_id=$3 AND epoch=$4 AND kind=$5 AND expires_at>clock_timestamp())`, s.Config.VaultID, id, device, s.Config.Epoch, kind).Scan(&ok)
	if e != nil {
		return e
	}
	if !ok {
		return code("VIEW_EXPIRED")
	}
	return nil
}

func (s *Store) newLease(ctx context.Context, tx pgx.Tx, device, kind, key string, body any) (string, bool, error) {
	if !validID(device) || !blobPattern.MatchString(key) {
		return "", false, code("INVALID_REQUEST")
	}
	encoded, e := json.Marshal(body)
	if e != nil {
		return "", false, e
	}
	digest := sha256.Sum256(encoded)
	var id string
	var prior []byte
	var live bool
	e = tx.QueryRow(ctx, `SELECT id,digest,expires_at>clock_timestamp() FROM content_leases
 WHERE vault_id=$1 AND device_id=$2 AND kind=$3 AND request_key=$4`, s.Config.VaultID, device, kind, key).Scan(&id, &prior, &live)
	if e == nil {
		if !bytes.Equal(prior, digest[:]) {
			return "", false, code("OP_ID_REUSED")
		}
		if live {
			return id, true, nil
		}
		if _, e = tx.Exec(ctx, "DELETE FROM content_leases WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id); e != nil {
			return "", false, e
		}
	} else if e != pgx.ErrNoRows {
		return "", false, e
	}
	limit := 4
	if kind == "snapshot" {
		limit = 2
	}
	var count int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM content_leases WHERE vault_id=$1 AND device_id=$2 AND kind=$3 AND expires_at>clock_timestamp()`, s.Config.VaultID, device, kind).Scan(&count); e != nil {
		return "", false, e
	}
	if count >= limit {
		return "", false, code("CONTENT_BUSY")
	}
	id = opaqueID()
	_, e = tx.Exec(ctx, `INSERT INTO content_leases(vault_id,id,device_id,kind,request_key,digest,epoch) VALUES($1,$2,$3,$4,$5,$6,$7)`, s.Config.VaultID, id, device, kind, key, digest[:], s.Config.Epoch)
	return id, false, e
}

func actionObjects(a Action) []string {
	ids := []string{}
	if a.Payload != nil {
		ids = append(ids, a.Payload.Objects...)
	}
	if a.Decision != nil && a.Decision.Companion != nil {
		ids = append(ids, actionObjects(*a.Decision.Companion)...)
	}
	return ids
}

func (s *Store) UploadLease(ctx context.Context, device string, c Commit) (string, error) {
	if c.Protocol != 0 || c.Required == nil {
		return "", code("UNSUPPORTED_PROTOCOL")
	}
	if c.VaultID != s.Config.VaultID || c.Epoch != s.Config.Epoch || c.DeviceID != device || !validID(c.OpID) || len(c.Actions) == 0 || len(c.Actions) > 1000 {
		return "", code("INVALID_REQUEST")
	}
	tx, e := s.locked(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	// The original request is never rewritten; pending legacy outboxes retain their request digest.
	hashBody, _ := json.Marshal(c)
	digest := sha256.Sum256(hashBody)
	var prior []byte
	e = tx.QueryRow(ctx, "SELECT digest FROM operations WHERE vault_id=$1 AND device_id=$2 AND op_id=$3", s.Config.VaultID, device, c.OpID).Scan(&prior)
	if e == nil && !bytes.Equal(prior, digest[:]) {
		return "", code("OP_ID_REUSED")
	}
	if e != nil && e != pgx.ErrNoRows {
		return "", e
	}
	if e = s.validateLegacyObjectUpload(ctx, tx, c, digest[:]); e != nil {
		return "", e
	}
	keyHash := sha256.Sum256([]byte(c.OpID))
	id, reused, e := s.newLease(ctx, tx, device, "upload", hex.EncodeToString(keyHash[:]), c)
	if e != nil {
		return "", e
	}
	if !reused {
		for _, a := range c.Actions {
			for _, obj := range actionObjects(a) {
				if !objectPattern.MatchString(obj) {
					return "", code("INVALID_REQUEST")
				}
				if _, e = tx.Exec(ctx, "INSERT INTO lease_objects(vault_id,lease_id,object_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", s.Config.VaultID, id, obj); e != nil {
					return "", e
				}
			}
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return "", e
	}
	return id, nil
}

func (s *Store) pinObjects(ctx context.Context, tx pgx.Tx, lease string, objects []string) error {
	for _, id := range objects {
		var generation int64
		var state, storage string
		if e := tx.QueryRow(ctx, "SELECT generation,state,storage_token FROM objects WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&generation, &state, &storage); e != nil {
			return code("OBJECT_CORRUPT")
		}
		if state != "ready" && state != "candidate" {
			return code("OBJECT_CORRUPT")
		}
		if _, e := tx.Exec(ctx, "UPDATE objects SET state='ready',unreferenced_at=NULL WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `INSERT INTO lease_objects(vault_id,lease_id,object_id,generation,storage_token) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, s.Config.VaultID, lease, id, generation, storage); e != nil {
			return e
		}
	}
	return nil
}

type ReadView struct {
	Revision   string `json:"revisionId"`
	Snapshot   string `json:"snapshotId,omitempty"`
	RequestKey string `json:"requestId"`
}

func (s *Store) ReadLease(ctx context.Context, device string, view ReadView) (string, error) {
	if !validID(view.Revision) {
		return "", code("INVALID_REQUEST")
	}
	tx, e := s.locked(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	var encoded []byte
	var current bool
	e = tx.QueryRow(ctx, "SELECT value FROM revisions WHERE vault_id=$1 AND id=$2", s.Config.VaultID, view.Revision).Scan(&encoded)
	if e == pgx.ErrNoRows {
		return "", code("VIEW_EXPIRED")
	}
	if e != nil {
		return "", e
	}
	var r Revision
	if e = json.Unmarshal(encoded, &r); e != nil {
		return "", e
	}
	if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM heads WHERE vault_id=$1 AND revision_id=$2)", s.Config.VaultID, r.ID).Scan(&current); e != nil {
		return "", e
	}
	if !current && view.Snapshot != "" {
		var snap Snapshot
		if e = tx.QueryRow(ctx, `SELECT s.value FROM snapshots s JOIN content_leases l ON l.vault_id=s.vault_id AND l.id=s.lease_id
    WHERE s.vault_id=$1 AND s.id=$2 AND l.device_id=$3 AND l.expires_at>clock_timestamp()`, s.Config.VaultID, view.Snapshot, device).Scan(&encoded); e == nil {
			if e = json.Unmarshal(encoded, &snap); e != nil {
				return "", e
			}
			for _, f := range snap.Files {
				if f.ID == r.FileID && contains(f.Heads, r.ID) {
					current = true
				}
			}
		} else if e != pgx.ErrNoRows {
			return "", e
		}
	}
	if !current {
		return "", code("VIEW_EXPIRED")
	}
	id, reused, e := s.newLease(ctx, tx, device, "read", view.RequestKey, view)
	if e != nil {
		return "", e
	}
	if !reused {
		if e = s.pinObjects(ctx, tx, id, r.Payload.Objects); e != nil {
			return "", e
		}
	}
	return id, tx.Commit(ctx)
}

func (s *Store) RenewLease(ctx context.Context, device, id string) error {
	tx, e := s.locked(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	tag, e := tx.Exec(ctx, `UPDATE content_leases SET expires_at=clock_timestamp()+interval '5 minutes'
 WHERE vault_id=$1 AND id=$2 AND device_id=$3 AND epoch=$4 AND expires_at>clock_timestamp()`, s.Config.VaultID, id, device, s.Config.Epoch)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return code("VIEW_EXPIRED")
	}
	return tx.Commit(ctx)
}
func (s *Store) ReleaseLease(ctx context.Context, device, id string) error {
	tx, e := s.locked(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "DELETE FROM snapshots WHERE vault_id=$1 AND lease_id=$2 AND device_id=$3", s.Config.VaultID, id, device); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "DELETE FROM content_leases WHERE vault_id=$1 AND id=$2 AND device_id=$3", s.Config.VaultID, id, device); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
