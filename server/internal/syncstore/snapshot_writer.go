package syncstore

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

type snapshotEntry struct {
	kind  string
	value json.RawMessage
}

func (snap *Snapshot) appendEntry(entry snapshotEntry) error {
	switch entry.kind {
	case "files":
		var file File
		if e := json.Unmarshal(entry.value, &file); e != nil {
			return e
		}
		snap.Files = append(snap.Files, file)
	case "revisions":
		var revision Revision
		if e := json.Unmarshal(entry.value, &revision); e != nil {
			return e
		}
		snap.Revisions = append(snap.Revisions, revision)
	case "bases":
		var proof BaseProof
		if e := json.Unmarshal(entry.value, &proof); e != nil {
			return e
		}
		snap.Bases = append(snap.Bases, proof)
	}
	return nil
}

const snapshotItemsPageQuery = `SELECT kind,value FROM snapshot_items WHERE vault_id=$1 AND snapshot_id=$2 AND position >= $3 ORDER BY position LIMIT 256`

// Close each bounded read before calling visit, so inserts can use the same frozen transaction.
func (s *Store) walkSnapshot(ctx context.Context, tx pgx.Tx, boundary int64, bases bool, visit func([]snapshotEntry) error) error {
	for _, kind := range []string{"files", "revisions"} {
		after := ""
		for {
			query := `SELECT f.id,jsonb_build_object('id',f.id,'entryKind',f.kind,'location',f.location,
 'heads',COALESCE((SELECT jsonb_agg(h.revision_id ORDER BY h.revision_id) FROM heads h WHERE h.vault_id=f.vault_id AND h.file_id=f.id),'[]'::jsonb))
 FROM files f WHERE f.vault_id=$1 AND f.id>$2 ORDER BY f.id LIMIT 16`
			args := []any{s.Config.VaultID, after}
			if kind == "revisions" {
				query = `SELECT r.id,r.value FROM revisions r WHERE r.vault_id=$1 AND r.id>$2
 AND (NOT $3::boolean OR EXISTS(SELECT 1 FROM heads h WHERE h.vault_id=r.vault_id AND h.revision_id=r.id)) ORDER BY r.id LIMIT 16`
				args = append(args, s.compact)
			}
			rows, e := tx.Query(ctx, query, args...)
			if e != nil {
				return e
			}
			entries := []snapshotEntry{}
			used := 0
			last := after
			for rows.Next() {
				var id string
				var raw json.RawMessage
				if e = rows.Scan(&id, &raw); e != nil {
					rows.Close()
					return e
				}
				encoded, err := json.Marshal(raw)
				if err != nil {
					rows.Close()
					return err
				}
				if len(encoded)+1024 > snapshotPageBytes {
					rows.Close()
					return code("SNAPSHOT_TOO_LARGE")
				}
				pair := []snapshotEntry{{kind, encoded}}
				if kind == "revisions" && bases && s.compact {
					var revision Revision
					if e = json.Unmarshal(raw, &revision); e != nil {
						rows.Close()
						return e
					}
					anchor, err := s.anchor(revision, boundary)
					if err != nil {
						rows.Close()
						return err
					}
					proof, err := json.Marshal(anchor.Proof)
					if err != nil {
						rows.Close()
						return err
					}
					pair = append(pair, snapshotEntry{"bases", proof})
				}
				size := 0
				for _, entry := range pair {
					size += len(entry.value)
				}
				if len(entries) > 0 && used+size > snapshotPageBytes {
					break
				}
				entries = append(entries, pair...)
				used += size
				last = id
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return e
			}
			if len(entries) == 0 {
				break
			}
			if e = visit(entries); e != nil {
				return e
			}
			after = last
		}
	}
	return nil
}
func (s *Store) writeSnapshot(ctx context.Context, tx pgx.Tx, id string, boundary int64) (int64, error) {
	var position int64
	e := s.walkSnapshot(ctx, tx, boundary, true, func(entries []snapshotEntry) error {
		rows := make([][]any, 0, len(entries))
		for _, entry := range entries {
			rows = append(rows, []any{s.Config.VaultID, id, position, entry.kind, entry.value})
			position++
		}
		_, err := tx.CopyFrom(ctx, pgx.Identifier{"snapshot_items"}, []string{"vault_id", "snapshot_id", "position", "kind", "value"}, pgx.CopyFromRows(rows))
		return err
	})
	return position, e
}
func (s *Store) pinSnapshot(ctx context.Context, tx pgx.Tx, lease string) error {
	const roots = `SELECT DISTINCT jsonb_array_elements_text(r.value->'payload'->'objects') AS id FROM revisions r JOIN heads h ON h.vault_id=r.vault_id AND h.revision_id=r.id WHERE r.vault_id=$1`
	var invalid bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM (`+roots+`) roots LEFT JOIN objects o ON o.vault_id=$1 AND o.id=roots.id WHERE o.id IS NULL OR o.state NOT IN ('ready','candidate'))`, s.Config.VaultID).Scan(&invalid); e != nil {
		return e
	}
	if invalid {
		return code("OBJECT_CORRUPT")
	}
	if _, e := tx.Exec(ctx, `INSERT INTO lease_objects(vault_id,lease_id,object_id,generation,storage_token) SELECT $1,$2,o.id,o.generation,o.storage_token FROM objects o JOIN (`+roots+`) roots ON roots.id=o.id WHERE o.vault_id=$1 ON CONFLICT DO NOTHING`, s.Config.VaultID, lease); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `UPDATE objects SET state='ready',unreferenced_at=NULL WHERE vault_id=$1 AND id IN (SELECT object_id FROM lease_objects WHERE vault_id=$1 AND lease_id=$2)`, s.Config.VaultID, lease)
	return e
}
