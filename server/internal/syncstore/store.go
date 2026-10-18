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
	"net/http"
	"sync"
)

//go:embed schema.sql
var schema string

type Store struct {
	handlerOnce sync.Once
	handler     http.Handler
	compact     bool
	proofKey    []byte
	Pool        *pgxpool.Pool
	Config      Config
	Fault       func(string) error
	events      *eventHub
}

func (s *Store) fault(point string) error {
	if s.Fault != nil {
		return s.Fault(point)
	}
	return nil
}
func Open(ctx context.Context, c Config) (*Store, error) {
	if c.MetadataMode != "" && c.MetadataMode != "compact" && c.MetadataMode != "full" {
		return nil, code("INVALID_CONFIG")
	}
	if c.CleanupMode != "" && c.CleanupMode != "on" && c.CleanupMode != "off" && c.CleanupMode != "dry-run" {
		return nil, code("INVALID_CONFIG")
	}

	if !validID(c.VaultID) || !validID(c.Epoch) || (len(c.Devices) < 1 && !blobPattern.MatchString(c.EnrollmentPublicKey)) || (c.EnrollmentPublicKey != "" && (!blobPattern.MatchString(c.EnrollmentPublicKey) || len(c.Devices) != 0)) || !json.Valid(c.KeyPackage) {
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
	if _, e = tx.Exec(ctx, "INSERT INTO vaults(id,epoch,key_package,enrollment_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", c.VaultID, c.Epoch, c.KeyPackage, c.EnrollmentPublicKey); e != nil {
		return nil, e
	}
	var epoch string
	var enrollmentKey string
	var pkg []byte
	if e = tx.QueryRow(ctx, "SELECT epoch,key_package,enrollment_key FROM vaults WHERE id=$1 FOR UPDATE", c.VaultID).Scan(&epoch, &pkg, &enrollmentKey); e != nil {
		return nil, e
	}
	var v1, v2 any
	_ = json.Unmarshal(pkg, &v1)
	_ = json.Unmarshal(c.KeyPackage, &v2)
	j1, _ := json.Marshal(v1)
	j2, _ := json.Marshal(v2)
	if epoch != c.Epoch || !bytes.Equal(j1, j2) || enrollmentKey != c.EnrollmentPublicKey {
		return nil, code("CONFIG_IDENTITY_MISMATCH")
	}
	if e = s.initializeProofKey(ctx, tx); e != nil {
		return nil, e
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
	if e = s.initializeCompaction(ctx, tx); e != nil {
		return nil, e
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
	return s.authorizeHash(ctx, h[:])
}
func (s *Store) authorizeHash(ctx context.Context, hash []byte) (string, error) {
	query := "SELECT d.id FROM devices d WHERE d.vault_id=$1 AND d.token_hash=$2 AND d.revoked_at IS NULL"
	if s.Config.Managed {
		query += ` AND EXISTS(SELECT 1 FROM vault_owners o JOIN sync_users u ON u.id=o.user_id
   JOIN device_access a ON a.vault_id=o.vault_id AND a.device_id=d.id
   WHERE o.vault_id=d.vault_id AND u.active AND u.deleted_at IS NULL AND u.key_revision=a.key_revision)`
	}
	var id string
	if e := s.Pool.QueryRow(ctx, query, s.Config.VaultID, hash).Scan(&id); e != nil {
		return "", code("UNAUTHORIZED")
	}
	return id, nil
}

type commitScope struct{ files, paths, objects []string }

func (s *Store) loadCommit(ctx context.Context, tx pgx.Tx, c Commit) (*state, error) {
	if !s.compact {
		// The compatibility model still needs its complete ancestry graph.
		return s.loadState(ctx, tx, nil)
	}
	files, paths, objects := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, a := range c.Actions {
		for _, entry := range actionEntries(a) {
			files[entry.FileID] = true
			if entry.Location != nil {
				paths[entry.Location.PathKey] = true
			}
		}
		for _, id := range actionObjects(a) {
			objects[id] = true
		}
	}
	return s.loadState(ctx, tx, &commitScope{sortedKeys(files), sortedKeys(paths), sortedKeys(objects)})
}

func (s *Store) loadState(ctx context.Context, tx pgx.Tx, scope *commitScope) (*state, error) {
	st := newState()
	v := s.Config.VaultID
	fileQuery := "SELECT id,kind,location FROM files WHERE vault_id=$1"
	fileArgs := []any{v}
	if scope != nil {
		fileQuery += " AND (id=ANY($2) OR path_key=ANY($3))"
		fileArgs = append(fileArgs, scope.files, scope.paths)
	}
	rows, e := tx.Query(ctx, fileQuery, fileArgs...)
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
	revisionQuery := `SELECT r.value FROM revisions r WHERE r.vault_id=$1 AND
 (NOT $2::boolean OR EXISTS(SELECT 1 FROM heads h WHERE h.vault_id=r.vault_id AND h.revision_id=r.id))`
	revisionArgs := []any{v, s.compact}
	selectedFiles := sortedKeys(st.files)
	if scope != nil {
		revisionQuery = `SELECT r.value FROM heads h JOIN revisions r ON r.vault_id=h.vault_id AND r.id=h.revision_id
 WHERE h.vault_id=$1 AND h.file_id=ANY($2)`
		revisionArgs = []any{v, selectedFiles}
	}
	rows, e = tx.Query(ctx, revisionQuery, revisionArgs...)
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
	headQuery := "SELECT file_id,revision_id FROM heads WHERE vault_id=$1"
	headArgs := []any{v}
	if scope != nil {
		headQuery += " AND file_id=ANY($2)"
		headArgs = append(headArgs, selectedFiles)
	}
	rows, e = tx.Query(ctx, headQuery+" ORDER BY revision_id", headArgs...)
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
	locationQuery := `SELECT l.id,l.value FROM locations l WHERE l.vault_id=$1 AND
 (NOT $2::boolean OR EXISTS(SELECT 1 FROM files f WHERE f.vault_id=l.vault_id AND f.location->>'revision'=l.id))`
	locationArgs := []any{v, s.compact}
	if scope != nil {
		locationIDs := []string{}
		for _, f := range st.files {
			locationIDs = append(locationIDs, f.Location.Revision)
		}
		locationQuery = "SELECT id,value FROM locations WHERE vault_id=$1 AND id=ANY($2)"
		locationArgs = []any{v, locationIDs}
	}
	rows, e = tx.Query(ctx, locationQuery, locationArgs...)
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
	objectQuery := "SELECT id FROM objects WHERE vault_id=$1 AND state IN ('ready','candidate')"
	objectArgs := []any{v}
	if scope != nil {
		objectQuery += " AND id=ANY($2)"
		objectArgs = append(objectArgs, scope.objects)
	}
	rows, e = tx.Query(ctx, objectQuery, objectArgs...)
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
		if !contains([]string{"causal-heads", "atomic-groups", "review-cas", "shared-config-v1", "chunked-files-v1", "client-profiles-v1", "independent-branches-v1", ContentCapability, MetadataCapability, CompactCapability, ObjectCapability, ContinuityCapability, SnapshotCapability, legacySnapshotCapability}, f) {
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
	var checkpoint int64
	if e = tx.QueryRow(ctx, "SELECT epoch,seq,metadata_checkpoint FROM vaults WHERE id=$1 FOR UPDATE", c.VaultID).Scan(&epoch, &seq, &checkpoint); e != nil {
		return zero, e
	}
	if e = s.checkMetadataMode(checkpoint); e != nil {
		return zero, e
	}
	if c.Epoch != epoch {
		return zero, code("EPOCH_CHANGED")
	}
	if e = s.advanceContinuity(ctx, tx, c.DeviceID); e != nil {
		return zero, e
	}
	tracking, _ := ctx.Value(trackingContextKey{}).(*trackingRun)
	if tracking != nil {
		cached, err := s.inspectTracking(ctx, tx, c, tracking.Tracking, digest[:], seq)
		if err != nil {
			return zero, err
		}
		if cached != nil {
			tracking.Result = *cached
			return cached.Receipt, tx.Commit(ctx)
		}
	}
	var priorDigest, priorReceipt []byte
	e = tx.QueryRow(ctx, "SELECT digest,receipt FROM operations WHERE vault_id=$1 AND device_id=$2 AND op_id=$3", c.VaultID, c.DeviceID, c.OpID).Scan(&priorDigest, &priorReceipt)
	if e == nil {
		if !bytes.Equal(priorDigest, digest[:]) {
			return zero, code("OP_ID_REUSED")
		}
		var r Receipt
		e = json.Unmarshal(priorReceipt, &r)
		if e == nil && tracking != nil {
			tracking.Result, e = s.recordTracking(ctx, tx, c, tracking.Tracking, digest[:], r, seq)
		}
		if e == nil {
			e = tx.Commit(ctx)
		}
		return r, e
	}
	if e != pgx.ErrNoRows {
		return zero, e
	}
	legacy, e := s.validateCompactRequest(ctx, tx, c, tracking, digest[:])
	if e != nil {
		return zero, e
	}
	if tracking != nil {
		if e = s.validateTrackedBases(c, tracking.Tracking, seq); e != nil {
			return zero, e
		}
	}
	st, e := s.loadCommit(ctx, tx, c)
	if e != nil {
		return zero, e
	}
	st.compact = s.compact
	if tracking != nil {
		for _, p := range tracking.Tracking.Bases {
			st.accepted[p.RevisionID] = p.FileID
		}
	}
	old := map[string]bool{}
	for id := range st.revisions {
		old[id] = true
	}
	previousHeads := map[string][]string{}
	for id, f := range st.files {
		previousHeads[id] = append([]string{}, f.Heads...)
	}
	if e = st.apply(c); e != nil {
		return zero, e
	}
	if e = shadowHeads(previousHeads, c, st); e != nil {
		return zero, e
	}
	for _, a := range c.Actions {
		for _, id := range actionObjects(a) {
			if _, e = tx.Exec(ctx, "UPDATE objects SET state='ready',unreferenced_at=NULL WHERE vault_id=$1 AND id=$2 AND state='candidate'", c.VaultID, id); e != nil {
				return zero, e
			}
		}
	}
	affected := map[string]bool{}
	for _, action := range c.Actions {
		affected[action.FileID] = true
		if action.Decision != nil && action.Decision.Companion != nil {
			affected[action.Decision.Companion.FileID] = true
		}
	}
	for _, id := range sortedKeys(affected) {
		f := st.files[id]
		l, _ := json.Marshal(f.Location)
		if _, e = tx.Exec(ctx, `INSERT INTO files(vault_id,id,kind,location,path_key) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(vault_id,id) DO UPDATE SET location=excluded.location,path_key=excluded.path_key
 WHERE files.location IS DISTINCT FROM excluded.location OR files.path_key IS DISTINCT FROM excluded.path_key`, c.VaultID, f.ID, f.EntryKind, l, f.Location.PathKey); e != nil {
			return zero, e
		}
	}
	// Retain every location version, including a create followed by a move in one group.
	for _, a := range c.Actions {
		for _, entry := range actionEntries(a) {
			if entry.Location == nil {
				continue
			}
			l, _ := json.Marshal(entry.Location)
			if _, e = tx.Exec(ctx, "INSERT INTO locations(vault_id,id,file_id,value) VALUES($1,$2,$3,$4)", c.VaultID, entry.Location.Revision, entry.FileID, l); e != nil {
				return zero, e
			}
			if s.compact && legacy {
				if _, e = tx.Exec(ctx, "INSERT INTO legacy_locations(vault_id,id) VALUES($1,$2)", c.VaultID, entry.Location.Revision); e != nil {
					return zero, e
				}
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
		if s.compact && legacy {
			if e = s.indexLegacyRevision(ctx, tx, r); e != nil {
				return zero, e
			}
		}
		for _, obj := range r.Payload.Objects {
			if _, e = tx.Exec(ctx, "INSERT INTO revision_objects(vault_id,revision_id,object_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", c.VaultID, id, obj); e != nil {
				return zero, e
			}
		}
	}
	for _, id := range sortedKeys(affected) {
		f := st.files[id]
		if sameSet(previousHeads[id], f.Heads) {
			continue
		}
		if _, e = tx.Exec(ctx, "DELETE FROM heads WHERE vault_id=$1 AND file_id=$2", c.VaultID, id); e != nil {
			return zero, e
		}
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
	if _, e = tx.Exec(ctx, "INSERT INTO operations(vault_id,device_id,op_id,digest,receipt,legacy) VALUES($1,$2,$3,$4,$5,$6)", c.VaultID, c.DeviceID, c.OpID, digest[:], rb, legacy); e != nil {
		return zero, e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO changes(vault_id,seq,value) VALUES($1,$2,$3)", c.VaultID, r.Seq, cb); e != nil {
		return zero, e
	}
	if s.compact {
		for _, revision := range requestRevisions(c) {
			if _, e = tx.Exec(ctx, "INSERT INTO change_revisions(vault_id,seq,revision_id) VALUES($1,$2,$3)", c.VaultID, r.Seq, revision.ID); e != nil {
				return zero, e
			}
		}
	}
	if tracking != nil {
		tracking.Result, e = s.recordTracking(ctx, tx, c, tracking.Tracking, digest[:], r, r.Seq)
		if e != nil {
			return zero, e
		}
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
func (s *Store) Pull(ctx context.Context, epoch string, after int64) ([]Change, error) {
	var tx pgx.Tx
	var e error
	change, _ := ctx.Value(continuityKey{}).(*continuityChange)
	if change != nil {
		tx, e = s.locked(ctx)
	} else {
		tx, e = s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	}
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	if change != nil {
		if e = s.advanceContinuity(ctx, tx, change.Device); e != nil {
			return nil, e
		}
	}
	var actual string
	var seq, min, checkpoint int64
	if e = tx.QueryRow(ctx, "SELECT epoch,seq,min_seq,metadata_checkpoint FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&actual, &seq, &min, &checkpoint); e != nil {
		return nil, e
	}
	if e = s.checkMetadataMode(checkpoint); e != nil {
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
	var seq, checkpoint int64
	var pkg []byte
	e := s.Pool.QueryRow(ctx, "SELECT epoch,seq,key_package,metadata_checkpoint FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&epoch, &seq, &pkg, &checkpoint)
	if e != nil {
		return nil, e
	}
	if e = s.checkMetadataMode(checkpoint); e != nil {
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
	result := map[string]any{"protocol": 0, "vaultId": s.Config.VaultID, "epoch": epoch, "seq": seq, "features": []string{"causal-heads", "atomic-groups", "review-cas", "shared-config-v1", "chunked-files-v1", "client-profiles-v1", "independent-branches-v1", ContentCapability, MetadataCapability, CompactCapability, ObjectCapability, ContinuityCapability, SnapshotCapability}, "keyPackage": json.RawMessage(pkg), "devices": ds, "maxObjectBytes": 16 << 20, "continuity": true}
	if s.compact {
		result["metadataCheckpoint"] = checkpoint
	}
	return result, rows.Err()
}
func (s *Store) String() string {
	return fmt.Sprintf("ObsidianSync development store (%s)", s.Config.VaultID)
}
