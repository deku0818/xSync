package syncstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/jackc/pgx/v5"
	"io"
	"os"
	"path/filepath"
)

func syncDirectory(path string) error {
	d, e := os.Open(path)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func (s *Store) objectPath(id string) (string, error) {
	if !objectPattern.MatchString(id) {
		return "", code("INVALID_REQUEST")
	}
	return filepath.Join(s.Config.ObjectDir, s.Config.VaultID, id), nil
}

// PutObject/GetObject are internal contract helpers. HTTP always requires a device-owned lease.
func (s *Store) PutObject(ctx context.Context, id, digest string, data []byte) error {
	return s.putObject(ctx, "", "", id, digest, data)
}
func (s *Store) generationPath(id string, generation int64, tokens ...string) (string, error) {
	path, e := s.objectPath(id)
	if e != nil {
		return "", e
	}
	if generation < 0 {
		return "", code("INVALID_REQUEST")
	}
	if addressedObject(id) {
		if generation != 0 || len(tokens) != 1 || !blobPattern.MatchString(tokens[0]) {
			return "", code("INVALID_REQUEST")
		}
		return path + ".s" + tokens[0], nil
	}
	if len(tokens) > 0 && tokens[0] != "" {
		return "", code("INVALID_REQUEST")
	}
	if generation > 0 {
		path += fmt.Sprintf(".g%d", generation)
	}
	return path, nil
}
func (s *Store) putObject(ctx context.Context, device, lease, id, digest string, data []byte) error {
	if !objectPattern.MatchString(id) || len(data) > 16<<20 {
		return code("INVALID_REQUEST")
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != digest || (addressedObject(id) && id[2:] != digest) {
		return code("DIGEST_MISMATCH")
	}
	tx, e := s.locked(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if device != "" {
		if e = s.validLease(ctx, tx, device, lease, "upload"); e != nil {
			return e
		}
		var included bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM lease_objects WHERE vault_id=$1 AND lease_id=$2 AND object_id=$3)", s.Config.VaultID, lease, id).Scan(&included); e != nil {
			return e
		}
		if !included {
			return code("INVALID_REQUEST")
		}
	}
	var prior, state, storage string
	var size, generation int64
	e = tx.QueryRow(ctx, "SELECT digest,size,state,generation,storage_token FROM objects WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&prior, &size, &state, &generation, &storage)
	if e != nil && e != pgx.ErrNoRows {
		return e
	}
	if e == nil {
		if prior != digest || size != int64(len(data)) {
			return code("OBJECT_IMMUTABLE")
		}
		if state == "deleting" {
			return code("OBJECT_BUSY")
		}
		if state == "ready" || state == "candidate" {
			got, _, readErr := s.readObject(ctx, tx, id, generation, storage)
			if readErr != nil {
				return readErr
			}
			if !bytes.Equal(got, data) {
				return code("OBJECT_IMMUTABLE")
			}
			if _, e = tx.Exec(ctx, "UPDATE objects SET state='ready',unreferenced_at=NULL WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id); e != nil {
				return e
			}
			return tx.Commit(ctx)
		}
		generation++
	} // Existing v0 identities retain their monotonic numeric generation.
	if addressedObject(id) {
		generation = 0
		storage = opaqueID()
	}

	attempt := opaqueID()
	if _, e = tx.Exec(ctx, `INSERT INTO objects(vault_id,id,digest,size,state,generation,storage_token) VALUES($1,$2,$3,$4,'uploading',$5,$6)
 ON CONFLICT(vault_id,id) DO UPDATE SET state='uploading',generation=$5,storage_token=$6,unreferenced_at=NULL`, s.Config.VaultID, id, digest, len(data), generation, storage); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO upload_attempts(vault_id,id,object_id,generation,storage_token) VALUES($1,$2,$3,$4,$5)", s.Config.VaultID, attempt, id, generation, storage); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	if e = s.fault("after-object-reserve"); e != nil {
		return e
	}
	path, e := s.generationPath(id, generation, storage)
	if e != nil {
		return e
	}
	// Reserve is durable before file I/O. Fence a late publisher before it can create any file.
	// The vault lock covers this bounded chunk's write/fsync/publication, not network transfer.
	tx, e = s.locked(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if device != "" {
		if e = s.validLease(ctx, tx, device, lease, "upload"); e != nil {
			return e
		}
	}
	var active bool
	if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM objects o JOIN upload_attempts a
     ON a.vault_id=o.vault_id AND a.object_id=o.id AND a.generation=o.generation AND a.storage_token=o.storage_token
     WHERE o.vault_id=$1 AND o.id=$2 AND o.generation=$3 AND o.storage_token=$4 AND o.state='uploading'
     AND a.id=$5 AND a.expires_at>clock_timestamp())`, s.Config.VaultID, id, generation, storage, attempt).Scan(&active); e != nil {
		return e
	}
	if !active {
		return code("OBJECT_BUSY")
	}
	dir := filepath.Dir(path)
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	if e = syncDirectory(filepath.Dir(dir)); e != nil {
		return e
	}
	name := path + ".upload-" + attempt
	temp, e := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer os.Remove(name)
	if _, e = temp.Write(data); e == nil {
		e = temp.Sync()
	}
	closeErr := temp.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	if e = s.fault("after-object-fsync"); e != nil {
		return e
	}
	if e = os.Link(name, path); e != nil {
		if !os.IsExist(e) {
			return e
		}
		prior, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !bytes.Equal(prior, data) {
			return code("OBJECT_IMMUTABLE")
		}
	}
	if e = syncDirectory(dir); e != nil {
		return e
	}
	if e = s.fault("after-object-publish"); e != nil {
		return e
	}
	if device != "" {
		if e = s.validLease(ctx, tx, device, lease, "upload"); e != nil {
			return e
		}
	}
	// Retire the temporary hard link durably before deleting its only recovery marker.
	if e = os.Remove(name); e != nil {
		return e
	}
	if e = syncDirectory(dir); e != nil {
		return e
	}
	tag, e := tx.Exec(ctx, "UPDATE objects SET state='ready',unreferenced_at=NULL WHERE vault_id=$1 AND id=$2 AND generation=$3 AND state='uploading' AND storage_token=$4", s.Config.VaultID, id, generation, storage)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return code("OBJECT_BUSY")
	}
	if _, e = tx.Exec(ctx, "DELETE FROM upload_attempts WHERE vault_id=$1 AND id=$2", s.Config.VaultID, attempt); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return s.fault("after-object-finalize")
}
func (s *Store) readObject(ctx context.Context, tx pgx.Tx, id string, generation int64, tokens ...string) ([]byte, string, error) {
	var digest, state string
	storage := ""
	if len(tokens) > 0 {
		storage = tokens[0]
	}
	var size int64
	if e := tx.QueryRow(ctx, "SELECT digest,size,state FROM objects WHERE vault_id=$1 AND id=$2 AND generation=$3 AND storage_token=$4", s.Config.VaultID, id, generation, storage).Scan(&digest, &size, &state); e != nil {
		return nil, "", code("OBJECT_MISSING")
	}
	if state != "ready" && state != "candidate" {
		return nil, "", code("OBJECT_MISSING")
	}
	path, e := s.generationPath(id, generation, storage)
	if e != nil {
		return nil, "", e
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, "", code("OBJECT_CORRUPT")
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 16<<20+1))
	if e != nil {
		return nil, "", e
	}
	hash := sha256.Sum256(b)
	if int64(len(b)) != size || hex.EncodeToString(hash[:]) != digest || (addressedObject(id) && id[2:] != digest) {
		return nil, "", code("OBJECT_CORRUPT")
	}
	return b, digest, nil
}
func (s *Store) GetObject(ctx context.Context, id string) ([]byte, string, error) {
	return s.getObject(ctx, "", "", id)
}
func (s *Store) getObject(ctx context.Context, device, lease, id string) ([]byte, string, error) {
	if !objectPattern.MatchString(id) {
		return nil, "", code("INVALID_REQUEST")
	}
	tx, e := s.locked(ctx)
	if e != nil {
		return nil, "", e
	}
	defer tx.Rollback(ctx)
	var generation int64
	var storage string
	if device != "" {
		e = tx.QueryRow(ctx, `SELECT lo.generation,COALESCE(lo.storage_token,'') FROM lease_objects lo JOIN content_leases l ON l.vault_id=lo.vault_id AND l.id=lo.lease_id
  WHERE lo.vault_id=$1 AND l.id=$2 AND l.device_id=$3 AND l.epoch=$4 AND l.kind IN ('read','snapshot')
  AND l.expires_at>clock_timestamp() AND lo.object_id=$5`, s.Config.VaultID, lease, device, s.Config.Epoch, id).Scan(&generation, &storage)
		if e == pgx.ErrNoRows {
			return nil, "", code("VIEW_EXPIRED")
		}
		if e != nil {
			return nil, "", e
		}
	} else {
		if e = tx.QueryRow(ctx, "SELECT generation,storage_token FROM objects WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&generation, &storage); e != nil {
			return nil, "", code("OBJECT_MISSING")
		}
	}
	// Hold the short metadata lock until this bounded chunk is in memory; network writes happen afterwards.
	b, digest, e := s.readObject(ctx, tx, id, generation, storage)
	if device != "" && e != nil && e.Error() == "OBJECT_MISSING" {
		return nil, "", code("OBJECT_CORRUPT")
	}
	return b, digest, e
}
