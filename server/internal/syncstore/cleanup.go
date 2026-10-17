package syncstore

import (
	"context"
	"os"
	"path/filepath"
	"time"
)

type CleanupPolicy struct {
	Grace      time.Duration
	LogAge     time.Duration
	LogEntries int
	LogBytes   int64
	Batch      int
	DryRun     bool
}

func DefaultCleanupPolicy() CleanupPolicy {
	return CleanupPolicy{time.Hour, 7 * 24 * time.Hour, 10000, 64 << 20, 100, false}
}

type CleanupReport struct {
	Revisions  int64 `json:"revisions"`
	Locations  int64 `json:"locations"`
	Candidates int   `json:"candidates"`
	Deleted    int   `json:"deleted"`
	Changes    int64 `json:"changes"`
	Snapshots  int64 `json:"snapshots"`
	Orphans    int   `json:"orphans"`
}
type objectGeneration struct {
	ID         string
	Generation int64
	Storage    string
}

func (s *Store) AuditHeads(ctx context.Context) error {
	tx, e := s.locked(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	rows, e := tx.Query(ctx, `SELECT DISTINCT refs.id,COALESCE(o.generation,-1),COALESCE(o.storage_token,'') FROM revisions r
 JOIN heads h ON h.vault_id=r.vault_id AND h.revision_id=r.id
 CROSS JOIN LATERAL jsonb_array_elements_text(r.value->'payload'->'objects') refs(id)
 LEFT JOIN objects o ON o.vault_id=r.vault_id AND o.id=refs.id WHERE r.vault_id=$1`, s.Config.VaultID)
	if e != nil {
		return e
	}
	roots := []objectGeneration{}
	for rows.Next() {
		var r objectGeneration
		if e = rows.Scan(&r.ID, &r.Generation, &r.Storage); e != nil {
			rows.Close()
			return e
		}
		roots = append(roots, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, r := range roots {
		if _, _, e = s.readObject(ctx, tx, r.ID, r.Generation, r.Storage); e != nil {
			return code("OBJECT_CORRUPT")
		}
	}
	return nil
}

func (s *Store) Collect(ctx context.Context, p CleanupPolicy) (CleanupReport, error) {
	report := CleanupReport{}
	if p.Grace < 0 || p.LogAge <= 0 || p.LogEntries < 1 || p.LogBytes < 1 || p.Batch < 1 || p.Batch > 1000 {
		return report, code("INVALID_REQUEST")
	}
	tx, e := s.locked(ctx)
	if e != nil {
		return report, e
	}
	defer tx.Rollback(ctx)
	// Heads protect every unresolved branch, including files excluded on some devices.
	rows, e := tx.Query(ctx, `SELECT DISTINCT jsonb_array_elements_text(r.value->'payload'->'objects') FROM revisions r JOIN heads h
 ON h.vault_id=r.vault_id AND h.revision_id=r.id WHERE r.vault_id=$1
 UNION SELECT lo.object_id FROM lease_objects lo JOIN content_leases l ON l.vault_id=lo.vault_id AND l.id=lo.lease_id
 WHERE l.vault_id=$1 AND l.epoch=$2 AND l.expires_at>clock_timestamp()`, s.Config.VaultID, s.Config.Epoch)
	if e != nil {
		return report, e
	}
	roots := map[string]bool{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return report, e
		}
		roots[id] = true
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return report, e
	}
	type candidate struct {
		objectGeneration
		State         string
		Old           bool
		UploadExpired bool
	}
	rows, e = tx.Query(ctx, `SELECT id,generation,storage_token,state,COALESCE(unreferenced_at<=clock_timestamp()-($2*interval '1 second'),false),
 NOT EXISTS(SELECT 1 FROM upload_attempts a WHERE a.vault_id=o.vault_id AND a.object_id=o.id AND a.generation=o.generation AND a.storage_token=o.storage_token AND a.expires_at>clock_timestamp())
 FROM objects o WHERE vault_id=$1 AND state IN ('ready','candidate','uploading') ORDER BY id`, s.Config.VaultID, p.Grace.Seconds())
	if e != nil {
		return report, e
	}
	candidates := []candidate{}
	for rows.Next() {
		var c candidate
		if e = rows.Scan(&c.ID, &c.Generation, &c.Storage, &c.State, &c.Old, &c.UploadExpired); e != nil {
			rows.Close()
			return report, e
		}
		candidates = append(candidates, c)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return report, e
	}
	claimed := 0
	for _, c := range candidates {
		if roots[c.ID] {
			if c.State == "candidate" && !p.DryRun {
				if _, e = tx.Exec(ctx, "UPDATE objects SET state='ready',unreferenced_at=NULL WHERE vault_id=$1 AND id=$2", s.Config.VaultID, c.ID); e != nil {
					return report, e
				}
			}
			continue
		}
		if c.State == "uploading" && !c.UploadExpired {
			continue
		}
		report.Candidates++
		if p.DryRun {
			continue
		}
		if c.State == "ready" {
			if _, e = tx.Exec(ctx, "UPDATE objects SET state='candidate',unreferenced_at=clock_timestamp() WHERE vault_id=$1 AND id=$2", s.Config.VaultID, c.ID); e != nil {
				return report, e
			}
			continue
		}
		if (c.State == "uploading" || c.Old) && claimed < p.Batch {
			if _, e = tx.Exec(ctx, "UPDATE objects SET state='deleting' WHERE vault_id=$1 AND id=$2", s.Config.VaultID, c.ID); e != nil {
				return report, e
			}
			if _, e = tx.Exec(ctx, "INSERT INTO object_gc_jobs(vault_id,object_id,generation,storage_token) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", s.Config.VaultID, c.ID, c.Generation, c.Storage); e != nil {
				return report, e
			}
			claimed++
		}
	}
	if p.DryRun {
		return report, nil
	}
	// min_seq and the actual deleted prefix move together under the same vault lock.
	var now time.Time
	if e = tx.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&now); e != nil {
		return report, e
	}
	rows, e = tx.Query(ctx, `SELECT seq,created_at,octet_length(value::text) FROM changes WHERE vault_id=$1 ORDER BY seq DESC`, s.Config.VaultID)
	if e != nil {
		return report, e
	}
	var cutoff int64
	var total int64
	count := 0
	for rows.Next() {
		var seq int64
		var at time.Time
		var size int64
		if e = rows.Scan(&seq, &at, &size); e != nil {
			rows.Close()
			return report, e
		}
		count++
		total += size
		if cutoff == 0 && (count > p.LogEntries || total > p.LogBytes || at.Before(now.Add(-p.LogAge))) {
			cutoff = seq
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return report, e
	}
	if cutoff > 0 {
		// Never retire the only incremental recovery route when a replacement snapshot exceeds wire limits.
		if _, _, e = s.snapshotContents(ctx, tx); e != nil {
			return report, e
		}

		if _, e = tx.Exec(ctx, "UPDATE vaults SET min_seq=GREATEST(min_seq,$2) WHERE id=$1", s.Config.VaultID, cutoff); e != nil {
			return report, e
		}
		tag, err := tx.Exec(ctx, "DELETE FROM changes WHERE vault_id=$1 AND seq<=$2", s.Config.VaultID, cutoff)
		if err != nil {
			return report, err
		}
		report.Changes = tag.RowsAffected()
	}
	tag, e := tx.Exec(ctx, `DELETE FROM snapshots s WHERE vault_id=$1 AND NOT EXISTS(SELECT 1 FROM content_leases l
 WHERE l.vault_id=s.vault_id AND l.id=s.lease_id AND l.expires_at>clock_timestamp())`, s.Config.VaultID)
	if e != nil {
		return report, e
	}
	report.Snapshots = tag.RowsAffected()
	if _, e = tx.Exec(ctx, "DELETE FROM content_leases WHERE vault_id=$1 AND expires_at<=clock_timestamp()", s.Config.VaultID); e != nil {
		return report, e
	}
	if e = s.pruneMetadata(ctx, tx, &report); e != nil {
		return report, e
	}
	if e = s.fault("before-gc-claim"); e != nil {
		return report, e
	}
	if e = tx.Commit(ctx); e != nil {
		return report, e
	}
	if s.compact {
		if e = s.fault("after-metadata-cleanup-commit"); e != nil {
			return report, e
		}
	}
	if e = s.fault("after-gc-claim"); e != nil {
		return report, e
	}
	rows, e = s.Pool.Query(ctx, "SELECT object_id,generation,storage_token FROM object_gc_jobs WHERE vault_id=$1 ORDER BY object_id LIMIT $2", s.Config.VaultID, p.Batch)
	if e != nil {
		return report, e
	}
	jobs := []objectGeneration{}
	for rows.Next() {
		var j objectGeneration
		if e = rows.Scan(&j.ID, &j.Generation, &j.Storage); e != nil {
			rows.Close()
			return report, e
		}
		jobs = append(jobs, j)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return report, e
	}
	for _, j := range jobs {
		if e = s.deleteGeneration(ctx, j); e != nil {
			return report, e
		}
		report.Deleted++
	}
	// Only known, expired attempts are removed. Unknown legacy files are never deleted by age alone.
	rows, e = s.Pool.Query(ctx, `SELECT a.id,a.object_id,a.generation,a.storage_token FROM upload_attempts a LEFT JOIN objects o
 ON o.vault_id=a.vault_id AND o.id=a.object_id WHERE a.vault_id=$1 AND a.expires_at<=clock_timestamp()
 AND (o.id IS NULL OR o.generation<>a.generation OR o.storage_token<>a.storage_token OR o.state='deleted') LIMIT $2`, s.Config.VaultID, p.Batch)
	if e != nil {
		return report, e
	}
	type attempt struct {
		ID string
		objectGeneration
	}
	attempts := []attempt{}
	for rows.Next() {
		var a attempt
		if e = rows.Scan(&a.ID, &a.objectGeneration.ID, &a.Generation, &a.Storage); e != nil {
			rows.Close()
			return report, e
		}
		attempts = append(attempts, a)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return report, e
	}
	for _, a := range attempts {
		path, err := s.generationPath(a.objectGeneration.ID, a.Generation, a.Storage)
		if err != nil {
			return report, err
		}
		if e = removePrivateFile(path); e != nil {
			return report, e
		}
		if !blobPattern.MatchString(a.ID) {
			return report, code("INVALID_REQUEST")
		}
		if e = removePrivateFile(path + ".upload-" + a.ID); e != nil {
			return report, e
		}
		if e = syncDirectory(filepath.Dir(path)); e != nil && !os.IsNotExist(e) {
			return report, e
		}
		if _, e = s.Pool.Exec(ctx, "DELETE FROM upload_attempts WHERE vault_id=$1 AND id=$2", s.Config.VaultID, a.ID); e != nil {
			return report, e
		}
		report.Orphans++
	}
	return report, nil
}

func removePrivateFile(path string) error {
	st, e := os.Lstat(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() {
		return code("UNSAFE_OBJECT_FILE")
	}
	e = os.Remove(path)
	if os.IsNotExist(e) {
		return nil
	}
	return e
}
func (s *Store) deleteGeneration(ctx context.Context, j objectGeneration) error {
	path, e := s.generationPath(j.ID, j.Generation, j.Storage)
	if e != nil {
		return e
	}
	if e = s.fault("before-gc-unlink"); e != nil {
		return e
	}
	if e = removePrivateFile(path); e != nil {
		return e
	}
	if e = syncDirectory(filepath.Dir(path)); e != nil && !os.IsNotExist(e) {
		return e
	}
	if e = s.fault("after-gc-unlink"); e != nil {
		return e
	}
	tx, e := s.locked(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	tag, e := tx.Exec(ctx, "UPDATE objects SET state='deleted',unreferenced_at=NULL WHERE vault_id=$1 AND id=$2 AND generation=$3 AND storage_token=$4 AND state='deleting'", s.Config.VaultID, j.ID, j.Generation, j.Storage)
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, "DELETE FROM object_gc_jobs WHERE vault_id=$1 AND object_id=$2 AND generation=$3 AND storage_token=$4", s.Config.VaultID, j.ID, j.Generation, j.Storage); e != nil {
		return e
	}
	if tag.RowsAffected() > 0 && addressedObject(j.ID) {
		if e = s.fault("before-object-identity-retire"); e != nil {
			return e
		}
		// Past JSON references remain readable as metadata; only current heads require object edges.
		if _, e = tx.Exec(ctx, `DELETE FROM revision_objects ro WHERE vault_id=$1 AND object_id=$2 AND NOT EXISTS
 (SELECT 1 FROM heads h WHERE h.vault_id=ro.vault_id AND h.revision_id=ro.revision_id)`, s.Config.VaultID, j.ID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM objects WHERE vault_id=$1 AND id=$2 AND generation=$3 AND storage_token=$4 AND state='deleted'", s.Config.VaultID, j.ID, j.Generation, j.Storage); e != nil {
			return e
		}
	}
	if e = s.fault("before-gc-confirm"); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	if tag.RowsAffected() > 0 && addressedObject(j.ID) {
		if e = s.fault("after-object-identity-retire"); e != nil {
			return e
		}
	}
	return s.fault("after-gc-confirm")
}
