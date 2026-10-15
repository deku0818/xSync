package syncstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schema string

type Store struct {
	Pool   *pgxpool.Pool
	Config Config
	Fault  func(string) error
	events *eventHub
}

func (s *Store) fault(point string) error {
	if s.Fault != nil {
		return s.Fault(point)
	}
	return nil
}
func Open(ctx context.Context, c Config) (*Store, error) {
	if !validID(c.VaultID) || !validID(c.Epoch) || len(c.Devices) < 1 || !json.Valid(c.KeyPackage) {
		return nil, code("INVALID_CONFIG")
	}
	p, e := pgxpool.New(ctx, c.DSN)
	if e != nil {
		return nil, e
	}
	opened := false
	defer func() {
		if !opened {
			p.Close()
		}
	}()
	s := &Store{Pool: p, Config: c, events: newEventHub()}
	if e = p.Ping(ctx); e != nil {
		p.Close()
		return nil, e
	}
	if _, e = p.Exec(ctx, schema); e != nil {
		p.Close()
		return nil, e
	}
	tx, e := p.Begin(ctx)
	if e != nil {
		p.Close()
		return nil, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "INSERT INTO vaults(id,epoch,key_package) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", c.VaultID, c.Epoch, c.KeyPackage); e != nil {
		return nil, e
	}
	var epoch string
	var pkg []byte
	if e = tx.QueryRow(ctx, "SELECT epoch,key_package FROM vaults WHERE id=$1 FOR UPDATE", c.VaultID).Scan(&epoch, &pkg); e != nil {
		return nil, e
	}
	var v1, v2 any
	_ = json.Unmarshal(pkg, &v1)
	_ = json.Unmarshal(c.KeyPackage, &v2)
	j1, _ := json.Marshal(v1)
	j2, _ := json.Marshal(v2)
	if epoch != c.Epoch || !bytes.Equal(j1, j2) {
		return nil, code("CONFIG_IDENTITY_MISMATCH")
	}
	// Preserve existing names and migrate canonical keys explicitly. Never choose a winner for duplicate names.
	rows, e := tx.Query(ctx, "SELECT id,name FROM devices WHERE vault_id=$1 AND name_key IS NULL FOR UPDATE", c.VaultID)
	if e != nil {
		return nil, e
	}
	oldNames := map[string]string{}
	for rows.Next() {
		var id, name string
		if e = rows.Scan(&id, &name); e != nil {
			rows.Close()
			return nil, e
		}
		oldNames[id] = name
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	for id, name := range oldNames {
		_, key, err := normalizedName(name)
		if err != nil {
			return nil, err
		}
		if _, e = tx.Exec(ctx, "UPDATE devices SET name_key=$3 WHERE vault_id=$1 AND id=$2", c.VaultID, id, key); e != nil {
			return nil, profileError(e)
		}
	}
	for _, d := range c.Devices {
		if !validID(d.ID) || d.Name == "" || len(d.Name) > 128 || len(d.Token) < 32 {
			return nil, code("INVALID_CONFIG")
		}
		name, nameKey, nameErr := normalizedName(d.Name)
		if nameErr != nil {
			return nil, nameErr
		}
		h := sha256.Sum256([]byte(d.Token))
		var previous []byte
		e = tx.QueryRow(ctx, "SELECT token_hash FROM devices WHERE vault_id=$1 AND id=$2", c.VaultID, d.ID).Scan(&previous)
		if e == nil && !bytes.Equal(previous, h[:]) {
			return nil, code("DEVICE_TOKEN_CHANGED")
		}
		if e != nil && e != pgx.ErrNoRows {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO devices(vault_id,id,name,token_hash,name_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(vault_id,id) DO NOTHING", c.VaultID, d.ID, name, h[:], nameKey); e != nil {
			return nil, e
		}
	}
	if _, e = tx.Exec(ctx, "CREATE UNIQUE INDEX IF NOT EXISTS devices_name_unique ON devices(vault_id,name_key)"); e != nil {
		return nil, profileError(e)
	}
	if e = tx.Commit(ctx); e != nil {
		p.Close()
		return nil, e
	}
	opened = true
	return s, nil
}
func (s *Store) Authorize(ctx context.Context, token string) (string, error) {
	h := sha256.Sum256([]byte(token))
	var id string
	e := s.Pool.QueryRow(ctx, "SELECT id FROM devices WHERE vault_id=$1 AND token_hash=$2", s.Config.VaultID, h[:]).Scan(&id)
	if e != nil {
		return "", code("UNAUTHORIZED")
	}
	return id, nil
}
func (s *Store) load(ctx context.Context, tx pgx.Tx) (*state, error) {
	st := newState()
	v := s.Config.VaultID
	rows, e := tx.Query(ctx, "SELECT id,kind,location FROM files WHERE vault_id=$1", v)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		f := &File{Heads: []string{}}
		var l []byte
		if e = rows.Scan(&f.ID, &f.EntryKind, &l); e != nil {
			rows.Close()
			return nil, e
		}
		if e = json.Unmarshal(l, &f.Location); e != nil {
			rows.Close()
			return nil, e
		}
		st.files[f.ID] = f
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	rows, e = tx.Query(ctx, "SELECT value FROM revisions WHERE vault_id=$1", v)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var b []byte
		var r Revision
		if e = rows.Scan(&b); e == nil {
			e = json.Unmarshal(b, &r)
		}
		if e != nil {
			rows.Close()
			return nil, e
		}
		st.revisions[r.ID] = r
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	rows, e = tx.Query(ctx, "SELECT file_id,revision_id FROM heads WHERE vault_id=$1 ORDER BY revision_id", v)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var f, r string
		if e = rows.Scan(&f, &r); e != nil {
			rows.Close()
			return nil, e
		}
		st.files[f].Heads = append(st.files[f].Heads, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	rows, e = tx.Query(ctx, "SELECT id,value FROM locations WHERE vault_id=$1", v)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id string
		var b []byte
		var l Location
		if e = rows.Scan(&id, &b); e == nil {
			e = json.Unmarshal(b, &l)
		}
		if e != nil {
			rows.Close()
			return nil, e
		}
		st.locations[id] = l
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	rows, e = tx.Query(ctx, "SELECT id FROM objects WHERE vault_id=$1", v)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		st.objects[id] = true
	}
	e = rows.Err()
	rows.Close()
	return st, e
}
func (s *Store) Commit(ctx context.Context, c Commit) (Receipt, error) {
	zero := Receipt{}
	if c.Protocol != 0 || c.Required == nil {
		return zero, code("UNSUPPORTED_PROTOCOL")
	}
	for _, f := range c.Required {
		if !contains([]string{"causal-heads", "atomic-groups", "review-cas", "shared-config-v1", "chunked-files-v1", "client-profiles-v1", "independent-branches-v1"}, f) {
			return zero, code("UNSUPPORTED_PROTOCOL")
		}
	}
	if c.VaultID != s.Config.VaultID {
		return zero, code("WRONG_VAULT")
	}
	if !validID(c.DeviceID) || !validID(c.OpID) || len(c.Actions) < 1 || len(c.Actions) > 1000 {
		return zero, code("INVALID_REQUEST")
	}
	body, e := json.Marshal(c)
	if e != nil {
		return zero, e
	}
	digest := sha256.Sum256(body)
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return zero, e
	}
	defer tx.Rollback(ctx)
	var epoch string
	var seq int64
	if e = tx.QueryRow(ctx, "SELECT epoch,seq FROM vaults WHERE id=$1 FOR UPDATE", c.VaultID).Scan(&epoch, &seq); e != nil {
		return zero, e
	}
	if c.Epoch != epoch {
		return zero, code("EPOCH_CHANGED")
	}
	var priorDigest, priorReceipt []byte
	e = tx.QueryRow(ctx, "SELECT digest,receipt FROM operations WHERE vault_id=$1 AND device_id=$2 AND op_id=$3", c.VaultID, c.DeviceID, c.OpID).Scan(&priorDigest, &priorReceipt)
	if e == nil {
		if !bytes.Equal(priorDigest, digest[:]) {
			return zero, code("OP_ID_REUSED")
		}
		var r Receipt
		e = json.Unmarshal(priorReceipt, &r)
		return r, e
	}
	if e != pgx.ErrNoRows {
		return zero, e
	}
	st, e := s.load(ctx, tx)
	if e != nil {
		return zero, e
	}
	old := map[string]bool{}
	for id := range st.revisions {
		old[id] = true
	}
	if e = st.apply(c); e != nil {
		return zero, e
	}
	for _, id := range sortedKeys(st.files) {
		f := st.files[id]
		l, _ := json.Marshal(f.Location)
		if _, e = tx.Exec(ctx, "INSERT INTO files(vault_id,id,kind,location,path_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(vault_id,id) DO UPDATE SET location=excluded.location,path_key=excluded.path_key", c.VaultID, f.ID, f.EntryKind, l, f.Location.PathKey); e != nil {
			return zero, e
		}
	}
	// Retain every location version, including a create followed by a move in one group.
	for _, a := range c.Actions {
		entries := []Action{a}
		if a.Decision != nil && a.Decision.Companion != nil {
			entries = append(entries, *a.Decision.Companion)
		}
		for _, entry := range entries {
			if entry.Location == nil {
				continue
			}
			l, _ := json.Marshal(entry.Location)
			if _, e = tx.Exec(ctx, "INSERT INTO locations(vault_id,id,file_id,value) VALUES($1,$2,$3,$4)", c.VaultID, entry.Location.Revision, entry.FileID, l); e != nil {
				return zero, e
			}
		}
	}
	for _, id := range sortedKeys(st.revisions) {
		if old[id] {
			continue
		}
		r := st.revisions[id]
		b, _ := json.Marshal(r)
		if _, e = tx.Exec(ctx, "INSERT INTO revisions(vault_id,id,file_id,value) VALUES($1,$2,$3,$4)", c.VaultID, id, r.FileID, b); e != nil {
			return zero, e
		}
		for _, obj := range r.Payload.Objects {
			if _, e = tx.Exec(ctx, "INSERT INTO revision_objects(vault_id,revision_id,object_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", c.VaultID, id, obj); e != nil {
				return zero, e
			}
		}
	}
	if _, e = tx.Exec(ctx, "DELETE FROM heads WHERE vault_id=$1", c.VaultID); e != nil {
		return zero, e
	}
	for _, id := range sortedKeys(st.files) {
		f := st.files[id]
		for _, h := range f.Heads {
			if _, e = tx.Exec(ctx, "INSERT INTO heads(vault_id,file_id,revision_id) VALUES($1,$2,$3)", c.VaultID, id, h); e != nil {
				return zero, e
			}
		}
	}
	r := Receipt{epoch, seq + 1, c.OpID}
	rb, _ := json.Marshal(r)
	cb, _ := json.Marshal(Change{r.Seq, c.DeviceID, c.OpID, c.Actions})
	if _, e = tx.Exec(ctx, "UPDATE vaults SET seq=$2 WHERE id=$1", c.VaultID, r.Seq); e != nil {
		return zero, e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO operations(vault_id,device_id,op_id,digest,receipt) VALUES($1,$2,$3,$4,$5)", c.VaultID, c.DeviceID, c.OpID, digest[:], rb); e != nil {
		return zero, e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO changes(vault_id,seq,value) VALUES($1,$2,$3)", c.VaultID, r.Seq, cb); e != nil {
		return zero, e
	}
	if e = s.fault("before-sql-commit"); e != nil {
		return zero, e
	}
	if e = tx.Commit(ctx); e != nil {
		return zero, e
	}
	s.events.publish(r)
	if e = s.fault("after-sql-commit"); e != nil {
		return zero, e
	}
	return r, nil
}
func (s *Store) Snapshot(ctx context.Context) (Snapshot, error) {
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return Snapshot{}, e
	}
	defer tx.Rollback(ctx)
	snap := Snapshot{Files: []File{}, Revisions: []Revision{}}
	if e = tx.QueryRow(ctx, "SELECT epoch,seq FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&snap.Epoch, &snap.Boundary); e != nil {
		return snap, e
	}
	st, e := s.load(ctx, tx)
	if e != nil {
		return snap, e
	}
	for _, id := range sortedKeys(st.files) {
		snap.Files = append(snap.Files, *st.files[id])
	}
	for _, id := range sortedKeys(st.revisions) {
		snap.Revisions = append(snap.Revisions, st.revisions[id])
	}
	return snap, tx.Commit(ctx)
}
func (s *Store) Pull(ctx context.Context, epoch string, after int64) ([]Change, error) {
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	var actual string
	var seq, min int64
	if e = tx.QueryRow(ctx, "SELECT epoch,seq,min_seq FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&actual, &seq, &min); e != nil {
		return nil, e
	}
	if actual != epoch {
		return nil, code("EPOCH_CHANGED")
	}
	if after < min {
		return nil, code("NEED_SNAPSHOT")
	}
	if after < 0 || after > seq {
		return nil, code("INVALID_REQUEST")
	}
	rows, e := tx.Query(ctx, "SELECT value FROM changes WHERE vault_id=$1 AND seq>$2 ORDER BY seq LIMIT 100", s.Config.VaultID, after)
	if e != nil {
		return nil, e
	}
	out := []Change{}
	for rows.Next() {
		var b []byte
		var c Change
		if e = rows.Scan(&b); e == nil {
			e = json.Unmarshal(b, &c)
		}
		if e != nil {
			rows.Close()
			return nil, e
		}
		out = append(out, c)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	return out, tx.Commit(ctx)
}
func (s *Store) Handshake(ctx context.Context) (map[string]any, error) {
	var epoch string
	var seq int64
	var pkg []byte
	e := s.Pool.QueryRow(ctx, "SELECT epoch,seq,key_package FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&epoch, &seq, &pkg)
	if e != nil {
		return nil, e
	}
	rows, e := s.Pool.Query(ctx, "SELECT id,name FROM devices WHERE vault_id=$1 ORDER BY id", s.Config.VaultID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	ds := []Device{}
	for rows.Next() {
		var d Device
		if e = rows.Scan(&d.ID, &d.Name); e != nil {
			return nil, e
		}
		ds = append(ds, d)
	}
	return map[string]any{"protocol": 0, "vaultId": s.Config.VaultID, "epoch": epoch, "seq": seq, "features": []string{"causal-heads", "atomic-groups", "review-cas", "shared-config-v1", "chunked-files-v1", "client-profiles-v1", "independent-branches-v1"}, "keyPackage": json.RawMessage(pkg), "devices": ds, "maxObjectBytes": 16 << 20}, rows.Err()
}
func (s *Store) String() string {
	return fmt.Sprintf("ObsidianSync development store (%s)", s.Config.VaultID)
}
