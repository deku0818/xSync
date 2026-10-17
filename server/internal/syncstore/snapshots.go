package syncstore

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

type SnapshotTicket struct {
	ID      string `json:"id"`
	LeaseID string `json:"leaseId"`
}

const SnapshotCapability = "snapshot-pages-v1"
const snapshotPageBytes = 24 << 20

type SnapshotPage struct {
	Epoch      string            `json:"epoch"`
	Boundary   int64             `json:"boundary"`
	Checkpoint *int64            `json:"checkpoint,omitempty"`
	Files      []json.RawMessage `json:"files"`
	Revisions  []json.RawMessage `json:"revisions"`
	Bases      []json.RawMessage `json:"bases,omitempty"`
	Total      int64             `json:"total"`
	Next       *int64            `json:"next"`
}

// Slice the binary JSON arrays before expanding rows; ordinality filters would visit every entry.
const snapshotPageQuery = `WITH frozen AS MATERIALIZED (
 SELECT value,jsonb_array_length(value->'files') AS files,jsonb_array_length(value->'revisions') AS revisions,
 COALESCE(jsonb_array_length(value->'bases'),0) AS bases FROM snapshots WHERE vault_id=$1 AND id=$2)
 SELECT part.kind,item.value FROM frozen s
 CROSS JOIN LATERAL (VALUES
 (0,'files',0::bigint,s.files,'strict $.files[$start to $end]'::jsonpath),
 (1,'revisions',s.files::bigint,s.revisions,'strict $.revisions[$start to $end]'::jsonpath),
 (2,'bases',s.files::bigint+s.revisions,s.bases,'strict $.bases[$start to $end]'::jsonpath)
 ) part(rank,kind,start,length,path)
 CROSS JOIN LATERAL jsonb_array_elements(CASE
 WHEN part.length > 0 AND $3::bigint < part.start+part.length AND $3::bigint+255 >= part.start
 THEN jsonb_path_query_array(s.value,part.path,jsonb_build_object(
 'start',GREATEST(0,$3::bigint-part.start),'end',LEAST(part.length-1,$3::bigint+255-part.start)))
 ELSE '[]'::jsonb END) WITH ORDINALITY item(value,n)
 ORDER BY part.rank,item.n`

// Every page comes from the same frozen JSON and device-owned content lease.
func (s *Store) ReadSnapshotPage(ctx context.Context, device, id string, offset int64) (SnapshotPage, error) {
	page := SnapshotPage{Files: []json.RawMessage{}, Revisions: []json.RawMessage{}}
	if offset < 0 {
		return page, code("INVALID_REQUEST")
	}
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return page, e
	}
	defer tx.Rollback(ctx)
	e = tx.QueryRow(ctx, `SELECT s.value->>'epoch',(s.value->>'boundary')::bigint,(s.value->>'checkpoint')::bigint,
 jsonb_array_length(s.value->'files')+jsonb_array_length(s.value->'revisions')+COALESCE(jsonb_array_length(s.value->'bases'),0)
 FROM snapshots s JOIN content_leases l ON l.vault_id=s.vault_id AND l.id=s.lease_id
 WHERE s.vault_id=$1 AND s.id=$2 AND l.device_id=$3 AND l.epoch=$4 AND l.expires_at>clock_timestamp()`, s.Config.VaultID, id, device, s.Config.Epoch).Scan(&page.Epoch, &page.Boundary, &page.Checkpoint, &page.Total)
	if e == pgx.ErrNoRows {
		return page, code("VIEW_EXPIRED")
	}
	if e != nil {
		return page, e
	}
	if offset > page.Total {
		return page, code("INVALID_REQUEST")
	}
	rows, e := tx.Query(ctx, snapshotPageQuery, s.Config.VaultID, id, offset)
	if e != nil {
		return page, e
	}
	used, count := 1024, int64(0)
	for rows.Next() {
		var kind string
		var raw json.RawMessage
		if e = rows.Scan(&kind, &raw); e != nil {
			rows.Close()
			return page, e
		}
		encoded, err := json.Marshal(raw)
		if err != nil {
			rows.Close()
			return page, err
		}
		if len(encoded)+1024 > snapshotPageBytes {
			rows.Close()
			return page, code("SNAPSHOT_TOO_LARGE")
		}
		if used+len(encoded)+1 > snapshotPageBytes {
			break
		}
		used += len(encoded) + 1
		switch kind {
		case "files":
			page.Files = append(page.Files, raw)
		case "revisions":
			page.Revisions = append(page.Revisions, raw)
		case "bases":
			page.Bases = append(page.Bases, raw)
		}
		count++
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return page, e
	}
	if next := offset + count; next < page.Total {
		page.Next = &next
	}
	return page, tx.Commit(ctx)
}

func (s *Store) CreateSnapshot(ctx context.Context, device, key string) (SnapshotTicket, error) {
	tx, e := s.locked(ctx)
	if e != nil {
		return SnapshotTicket{}, e
	}
	defer tx.Rollback(ctx)
	if e = s.advanceContinuity(ctx, tx, device); e != nil {
		return SnapshotTicket{}, e
	}
	lease, reused, e := s.newLease(ctx, tx, device, "snapshot", key, key)
	if e != nil {
		return SnapshotTicket{}, e
	}
	if reused {
		var id string
		e = tx.QueryRow(ctx, "SELECT id FROM snapshots WHERE vault_id=$1 AND lease_id=$2", s.Config.VaultID, lease).Scan(&id)
		if e == nil {
			e = tx.Commit(ctx)
		}
		return SnapshotTicket{id, lease}, e
	}
	snap, encoded, e := s.snapshotContents(ctx, tx)
	if e != nil {
		return SnapshotTicket{}, e
	}
	revisions := map[string]Revision{}
	for _, r := range snap.Revisions {
		revisions[r.ID] = r
	}
	objects := map[string]bool{}
	for _, f := range snap.Files {
		for _, head := range f.Heads {
			for _, id := range revisions[head].Payload.Objects {
				objects[id] = true
			}
		}
	}
	if e = s.pinObjects(ctx, tx, lease, sortedKeys(objects)); e != nil {
		return SnapshotTicket{}, e
	}
	id := opaqueID()[:32]
	if _, e = tx.Exec(ctx, "INSERT INTO snapshots(vault_id,id,value,lease_id,device_id) VALUES($1,$2,$3,$4,$5)", s.Config.VaultID, id, encoded, lease, device); e != nil {
		return SnapshotTicket{}, e
	}
	if e = s.fault("before-server-snapshot-commit"); e != nil {
		return SnapshotTicket{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return SnapshotTicket{}, e
	}
	if e = s.fault("after-server-snapshot-commit"); e != nil {
		return SnapshotTicket{}, e
	}
	return SnapshotTicket{id, lease}, nil
}
func (s *Store) ReadSnapshot(ctx context.Context, device, id string) (json.RawMessage, error) {
	var b []byte
	e := s.Pool.QueryRow(ctx, `SELECT s.value FROM snapshots s JOIN content_leases l ON l.vault_id=s.vault_id AND l.id=s.lease_id
 WHERE s.vault_id=$1 AND s.id=$2 AND l.device_id=$3 AND l.epoch=$4 AND l.expires_at>clock_timestamp()`, s.Config.VaultID, id, device, s.Config.Epoch).Scan(&b)
	if e == pgx.ErrNoRows {
		return nil, code("VIEW_EXPIRED")
	}
	if e != nil {
		return nil, e
	}
	encoded, e := json.Marshal(json.RawMessage(b))
	if e != nil {
		return nil, e
	}
	if len(encoded)+1 > 32<<20 {
		return nil, code("SNAPSHOT_TOO_LARGE")
	}
	return b, e
}

// Use the same encoding and limits for snapshot creation and log-retention admission.
func (s *Store) snapshotContents(ctx context.Context, tx pgx.Tx) (Snapshot, []byte, error) {
	snap := Snapshot{Epoch: s.Config.Epoch, Files: []File{}, Revisions: []Revision{}}
	st, e := s.load(ctx, tx)
	if e != nil {
		return snap, nil, e
	}
	if e = tx.QueryRow(ctx, "SELECT seq FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&snap.Boundary); e != nil {
		return snap, nil, e
	}
	for _, id := range sortedKeys(st.files) {
		snap.Files = append(snap.Files, *st.files[id])
	}
	if s.compact {
		var checkpoint int64
		if e = tx.QueryRow(ctx, "SELECT metadata_checkpoint FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&checkpoint); e != nil {
			return snap, nil, e
		}
		snap.Checkpoint = &checkpoint
		for _, f := range snap.Files {
			for _, id := range f.Heads {
				r, ok := st.revisions[id]
				if !ok {
					return snap, nil, code("PARENT_MISSING")
				}
				anchor, err := s.anchor(r, snap.Boundary)
				if err != nil {
					return snap, nil, err
				}
				snap.Revisions = append(snap.Revisions, r)
				snap.Bases = append(snap.Bases, anchor.Proof)
			}
		}
	} else {
		for _, id := range sortedKeys(st.revisions) {
			snap.Revisions = append(snap.Revisions, st.revisions[id])
		}
	}
	encoded, e := json.Marshal(snap)
	if e != nil {
		return snap, nil, e
	}
	// Whole snapshots may exceed one response; every individual entry must fit a page.
	if e = snapshotEntriesFit(snap.Files); e != nil {
		return snap, nil, e
	}
	if e = snapshotEntriesFit(snap.Revisions); e != nil {
		return snap, nil, e
	}
	return snap, encoded, nil
}

func snapshotEntriesFit[T any](entries []T) error {
	for _, entry := range entries {
		b, e := json.Marshal(entry)
		if e != nil {
			return e
		}
		if len(b)+1024 > snapshotPageBytes {
			return code("SNAPSHOT_TOO_LARGE")
		}
	}
	return nil
}
