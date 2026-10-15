package syncstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	if !blobPattern.MatchString(id) {
		return "", code("INVALID_REQUEST")
	}
	return filepath.Join(s.Config.ObjectDir, s.Config.VaultID, id), nil
}
func (s *Store) PutObject(ctx context.Context, id, digest string, data []byte) error {
	path, e := s.objectPath(id)
	if e != nil {
		return e
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != digest {
		return code("DIGEST_MISMATCH")
	}
	dir := filepath.Dir(path)
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	// The root exists before serving; make the per-vault directory durable before finalizing any object.
	if e = syncDirectory(filepath.Dir(dir)); e != nil {
		return e
	}
	temp, e := os.CreateTemp(dir, ".upload-")
	if e != nil {
		return e
	}
	name := temp.Name()
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
	// Link is create-if-absent. Never overwrite an existing immutable ciphertext.
	if e = os.Link(name, path); e != nil {
		if !os.IsExist(e) {
			return e
		}
		prior, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
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
	_, e = s.Pool.Exec(ctx, "INSERT INTO objects(vault_id,id,digest,size) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", s.Config.VaultID, id, digest, len(data))
	if e != nil {
		return e
	}
	var storedDigest string
	var size int64
	if e = s.Pool.QueryRow(ctx, "SELECT digest,size FROM objects WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&storedDigest, &size); e != nil {
		return e
	}
	if storedDigest != digest || size != int64(len(data)) {
		return code("OBJECT_IMMUTABLE")
	}
	return s.fault("after-object-finalize")
}
func (s *Store) GetObject(ctx context.Context, id string) ([]byte, string, error) {
	path, e := s.objectPath(id)
	if e != nil {
		return nil, "", e
	}
	var digest string
	var size int64
	if e = s.Pool.QueryRow(ctx, "SELECT digest,size FROM objects WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&digest, &size); e != nil {
		return nil, "", code("OBJECT_MISSING")
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
	if int64(len(b)) != size || hex.EncodeToString(hash[:]) != digest {
		return nil, "", code("OBJECT_CORRUPT")
	}
	return b, digest, nil
}
