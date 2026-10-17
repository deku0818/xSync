package syncstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func ciphertext(t *testing.T, s *Store, letter string) string {
	t.Helper()
	id := strings.Repeat(letter, 64)
	data := []byte("ciphertext-" + letter)
	sum := sha256.Sum256(data)
	if e := s.PutObject(context.Background(), id, hex.EncodeToString(sum[:]), data); e != nil {
		t.Fatal(e)
	}
	return id
}
func withObject(a Action, id string) Action { a.Payload.Objects = []string{id}; return a }
func collectNow(t *testing.T, s *Store) CleanupReport {
	t.Helper()
	p := DefaultCleanupPolicy()
	p.Grace = 0
	if _, e := s.Collect(context.Background(), p); e != nil {
		t.Fatal(e)
	}
	report, e := s.Collect(context.Background(), p)
	if e != nil {
		t.Fatal(e)
	}
	return report
}
func scalar(t *testing.T, s *Store, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	if e := s.Pool.QueryRow(context.Background(), sql, args...).Scan(&n); e != nil {
		t.Fatal(e)
	}
	return n
}

func TestCollectionRetainsHeadsAndReceiptsButRetiresAncestorCiphertext(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	a := ciphertext(t, s, "a")
	b := ciphertext(t, s, "b")
	original := req("original", withObject(createAction("F", "A", "a"), a))
	receipt := submit(t, s, original)
	submit(t, s, req("edit", withObject(editAction("F", "B", "A", "file"), b)))
	if report := collectNow(t, s); report.Deleted != 1 {
		t.Fatalf("wrong deleted count: %+v", report)
	}
	if _, _, e := s.GetObject(ctx, a); e == nil {
		t.Fatal("old ciphertext retained")
	}
	if _, _, e := s.GetObject(ctx, b); e != nil {
		t.Fatal(e)
	}
	if got := submit(t, s, original); got != receipt {
		t.Fatal("receipt changed after cleanup")
	}
	// An offline edit only needs the original parent identity, never the retired parent bytes.
	c := ciphertext(t, s, "c")
	submit(t, s, req("offline", withObject(editAction("F", "C", "A", "file"), c)))
	snap, e := s.Snapshot(ctx)
	if e != nil || len(snap.Files[0].Heads) != 2 {
		t.Fatalf("offline branch lost: %v", e)
	}
	collectNow(t, s)
	if _, _, e = s.GetObject(ctx, b); e != nil {
		t.Fatal(e)
	}
	if _, _, e = s.GetObject(ctx, c); e != nil {
		t.Fatal(e)
	}
	if scalar(t, s, "SELECT count(*) FROM revisions WHERE vault_id=$1", s.Config.VaultID) != 3 {
		t.Fatal("causal revisions were removed")
	}
}

func TestSnapshotRegistrationIsIdempotentPinsOnlyFrozenHeadsAndExpires(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	a := ciphertext(t, s, "a")
	b := ciphertext(t, s, "b")
	c := ciphertext(t, s, "c")
	submit(t, s, req("a", withObject(createAction("F", "A", "a"), a)))
	submit(t, s, req("b", withObject(editAction("F", "B", "A", "file"), b)))
	key := opaqueID()
	ticket, e := s.CreateSnapshot(ctx, "computer-a", key)
	if e != nil {
		t.Fatal(e)
	}
	if again, e := s.CreateSnapshot(ctx, "computer-a", key); e != nil || again != ticket {
		t.Fatalf("snapshot retry differs: %v", e)
	}
	submit(t, s, req("c", withObject(editAction("F", "C", "B", "file"), c)))
	collectNow(t, s)
	if _, _, e = s.GetObject(ctx, a); e == nil {
		t.Fatal("snapshot pinned all ancestors")
	}
	if _, _, e = s.GetObject(ctx, b); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ReadSnapshot(ctx, "computer-b", ticket.ID); e == nil {
		t.Fatal("snapshot ownership ignored")
	}
	view := ReadView{"B", ticket.ID, opaqueID()}
	lease, e := s.ReadLease(ctx, "computer-a", view)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.ReleaseLease(ctx, "computer-a", ticket.LeaseID); e != nil {
		t.Fatal(e)
	}
	collectNow(t, s)
	if _, _, e = s.getObject(ctx, "computer-a", lease, b); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Pool.Exec(ctx, "UPDATE content_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	expectCode(t, s.RenewLease(ctx, "computer-a", lease), "VIEW_EXPIRED")
	collectNow(t, s)
	if _, _, e = s.GetObject(ctx, b); e == nil {
		t.Fatal("expired download kept old ciphertext")
	}
	if scalar(t, s, "SELECT count(*) FROM snapshots WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("expired snapshots remained")
	}
}

func TestUploadLeaseAndImmutableReuploadAfterCollection(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	id := strings.Repeat("d", 64)
	data := []byte("immutable pending ciphertext")
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	request := req("pending", withObject(createAction("F", "A", "a"), id))
	lease, e := s.UploadLease(ctx, "computer-a", request)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.putObject(ctx, "computer-a", lease, id, digest, data); e != nil {
		t.Fatal(e)
	}
	collectNow(t, s)
	if _, _, e = s.GetObject(ctx, id); e != nil {
		t.Fatal("upload protection failed", e)
	}
	if e = s.ReleaseLease(ctx, "computer-a", lease); e != nil {
		t.Fatal(e)
	}
	collectNow(t, s)
	if _, _, e = s.GetObject(ctx, id); e == nil {
		t.Fatal("uncommitted expired upload retained")
	}
	var oldGen int64
	if e = s.Pool.QueryRow(ctx, "SELECT generation FROM objects WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&oldGen); e != nil {
		t.Fatal(e)
	}
	lease, e = s.UploadLease(ctx, "computer-a", request)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.putObject(ctx, "computer-a", lease, id, digest, data); e != nil {
		t.Fatal(e)
	}
	// A delayed old worker is fenced by its physical generation, even after the same ID is republished.
	if e = s.deleteGeneration(ctx, objectGeneration{ID: id, Generation: oldGen}); e != nil {
		t.Fatal(e)
	}
	submit(t, s, request)
	if _, _, e = s.GetObject(ctx, id); e != nil {
		t.Fatal("old deletion removed new ciphertext", e)
	}
	changed := []byte("different")
	other := sha256.Sum256(changed)
	expectCode(t, s.putObject(ctx, "computer-a", lease, id, hex.EncodeToString(other[:]), changed), "OBJECT_IMMUTABLE")
}

func TestCollectionRecoveryBoundaries(t *testing.T) {
	for _, point := range []string{"before-gc-claim", "after-gc-claim", "before-gc-unlink", "after-gc-unlink", "before-gc-confirm", "after-gc-confirm"} {
		t.Run(point, func(t *testing.T) {
			s := contractStore(t)
			ctx := context.Background()
			id := ciphertext(t, s, "e")
			p := DefaultCleanupPolicy()
			p.Grace = 0
			if _, e := s.Collect(ctx, p); e != nil {
				t.Fatal(e)
			}
			s.Fault = func(at string) error {
				if at == point {
					return code("interrupted")
				}
				return nil
			}
			if _, e := s.Collect(ctx, p); e == nil {
				t.Fatal("fault not reached")
			}
			s = reopenRecoveryStore(t, s)
			collectNow(t, s)
			if scalar(t, s, "SELECT count(*) FROM object_gc_jobs WHERE vault_id=$1", s.Config.VaultID) != 0 {
				t.Fatal("delete journal stuck")
			}
			path, _ := s.generationPath(id, 0)
			if _, e := os.Stat(path); !os.IsNotExist(e) {
				t.Fatal("ciphertext not retired")
			}
		})
	}
}

func TestLogTruncationReallyDeletesPrefixAtomically(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	submit(t, s, req("a", createAction("F", "A", "a")))
	submit(t, s, req("b", editAction("F", "B", "A", "file")))
	submit(t, s, req("c", editAction("F", "C", "B", "file")))
	p := DefaultCleanupPolicy()
	p.LogEntries = 1
	s.Fault = func(point string) error {
		if point == "before-gc-claim" {
			return code("interrupted")
		}
		return nil
	}
	if _, e := s.Collect(ctx, p); e == nil {
		t.Fatal("fault missing")
	}
	if scalar(t, s, "SELECT min_seq FROM vaults WHERE id=$1", s.Config.VaultID) != 0 || scalar(t, s, "SELECT count(*) FROM changes WHERE vault_id=$1", s.Config.VaultID) != 3 {
		t.Fatal("partial prefix deletion")
	}
	s.Fault = nil
	if report, e := s.Collect(ctx, p); e != nil || report.Changes != 2 {
		t.Fatalf("log cleanup: %+v %v", report, e)
	}
	if scalar(t, s, "SELECT min_seq FROM vaults WHERE id=$1", s.Config.VaultID) != 2 {
		t.Fatal("wrong lower boundary")
	}
	_, e := s.Pull(ctx, s.Config.Epoch, 1)
	expectCode(t, e, "NEED_SNAPSHOT")
	changes, e := s.Pull(ctx, s.Config.Epoch, 2)
	if e != nil || len(changes) != 1 || changes[0].Seq != 3 {
		t.Fatal("remaining log invalid")
	}
}

func TestDryRunAndCandidateRevival(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	id := ciphertext(t, s, "f")
	p := DefaultCleanupPolicy()
	p.DryRun = true
	p.Grace = 0
	if report, e := s.Collect(ctx, p); e != nil || report.Candidates != 1 {
		t.Fatalf("dry run: %+v %v", report, e)
	}
	var state string
	if e := s.Pool.QueryRow(ctx, "SELECT state FROM objects WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&state); e != nil || state != "ready" {
		t.Fatal("dry run mutated objects")
	}
	p.DryRun = false
	if _, e := s.Collect(ctx, p); e != nil {
		t.Fatal(e)
	}
	submit(t, s, req("revive", withObject(createAction("F", "A", "a"), id)))
	collectNow(t, s)
	if _, _, e := s.GetObject(ctx, id); e != nil {
		t.Fatal("candidate revival failed", e)
	}
}

func TestContentCapabilityAndExpiredReadAreEnforced(t *testing.T) {
	s := contractStore(t)
	h := s.Handler()
	request := httptest.NewRequest("GET", "/handshake", nil)
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 64))
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != 426 {
		t.Fatal("old client not gated")
	}
	request.Header.Set("X-Sync-Content", ContentCapability)
	request.Header.Set("X-Sync-Objects", ObjectCapability)
	request.Header.Set("X-Sync-Continuity", ContinuityCapability)
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal("new client blocked")
	}
	id := ciphertext(t, s, "a")
	request = httptest.NewRequest("GET", "/objects/"+id, nil)
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 64))
	request.Header.Set("X-Sync-Content", ContentCapability)
	request.Header.Set("X-Sync-Objects", ObjectCapability)
	request.Header.Set("X-Sync-Continuity", ContinuityCapability)
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	var body map[string]string
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if body["code"] != "VIEW_EXPIRED" {
		t.Fatal("unprotected object read accepted", response.Body.String())
	}
}

func TestKnownOrphanAttemptsDoNotDeleteActiveGeneration(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	id := strings.Repeat("b", 64)
	data := []byte("pending")
	sum := sha256.Sum256(data)
	s.Fault = func(at string) error {
		if at == "after-object-publish" {
			return code("interrupted")
		}
		return nil
	}
	if e := s.PutObject(ctx, id, hex.EncodeToString(sum[:]), data); e == nil {
		t.Fatal("fault missing")
	}
	s.Fault = nil
	if e := s.PutObject(ctx, id, hex.EncodeToString(sum[:]), data); e != nil {
		t.Fatal(e)
	}
	submit(t, s, req("accept", withObject(createAction("F", "A", "a"), id)))
	if _, e := s.Pool.Exec(ctx, "UPDATE upload_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	collectNow(t, s)
	if _, _, e := s.GetObject(ctx, id); e != nil {
		t.Fatal("orphan sweep deleted current version", e)
	}
	if scalar(t, s, "SELECT count(*) FROM upload_attempts WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("orphan attempt leaked")
	}
}

func TestCleanupGraceAndLogAgeUseDatabaseTime(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	ciphertext(t, s, "a")
	p := DefaultCleanupPolicy()
	collectNowPolicy := func() {
		t.Helper()
		if _, e := s.Collect(ctx, p); e != nil {
			t.Fatal(e)
		}
	}
	collectNowPolicy()
	collectNowPolicy()
	if scalar(t, s, "SELECT count(*) FROM objects WHERE vault_id=$1 AND state='deleted'", s.Config.VaultID) != 0 {
		t.Fatal("grace ignored")
	}
	if _, e := s.Pool.Exec(ctx, "UPDATE objects SET unreferenced_at=clock_timestamp()-interval '2 hours' WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	collectNowPolicy()
	submit(t, s, req("empty", createAction("F", "A", "a")))
	p.LogAge = time.Second
	if _, e := s.Pool.Exec(ctx, "UPDATE changes SET created_at=clock_timestamp()-interval '2 seconds' WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	collectNowPolicy()
	if scalar(t, s, "SELECT count(*) FROM changes WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("aged log retained")
	}
}

func TestConcurrentCommitAndCollectionNeverAcceptMissingCiphertext(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	p := DefaultCleanupPolicy()
	p.Grace = 0
	for i, letter := range []string{"a", "b", "c", "d"} {
		id := ciphertext(t, s, letter)
		if _, e := s.Collect(ctx, p); e != nil {
			t.Fatal(e)
		}
		request := req("race-"+letter, withObject(createAction("F-"+letter, "R-"+letter, letter), id))
		commitDone := make(chan error, 1)
		gcDone := make(chan error, 1)
		go func() { _, e := s.Commit(ctx, request); commitDone <- e }()
		go func() { _, e := s.Collect(ctx, p); gcDone <- e }()
		e := <-commitDone
		if err := <-gcDone; err != nil {
			t.Fatal(err)
		}
		if e != nil {
			expectCode(t, e, "OBJECT_MISSING")
			ciphertext(t, s, letter)
			submit(t, s, request)
		}
		if _, _, e = s.GetObject(ctx, id); e != nil {
			t.Fatalf("accepted object missing in race %d: %v", i, e)
		}
	}
}

func TestSnapshotCommitFaultsPreserveAtomicProtection(t *testing.T) {
	for _, point := range []string{"before-server-snapshot-commit", "after-server-snapshot-commit"} {
		t.Run(point, func(t *testing.T) {
			s := contractStore(t)
			ctx := context.Background()
			id := ciphertext(t, s, "a")
			submit(t, s, req("create", withObject(createAction("F", "A", "a"), id)))
			key := opaqueID()
			s.Fault = func(at string) error {
				if at == point {
					return code("interrupted")
				}
				return nil
			}
			if _, e := s.CreateSnapshot(ctx, "computer-a", key); e == nil {
				t.Fatal("fault missing")
			}
			s.Fault = nil
			expected := int64(0)
			if point == "after-server-snapshot-commit" {
				expected = 1
			}
			if scalar(t, s, "SELECT count(*) FROM snapshots WHERE vault_id=$1", s.Config.VaultID) != expected || scalar(t, s, "SELECT count(*) FROM lease_objects WHERE vault_id=$1", s.Config.VaultID) != expected {
				t.Fatal("partial snapshot/protection")
			}
			ticket, e := s.CreateSnapshot(ctx, "computer-a", key)
			if e != nil {
				t.Fatal(e)
			}
			submit(t, s, req("delete", editAction("F", "D", "A", "deleted")))
			collectNow(t, s)
			if _, _, e = s.getObject(ctx, "computer-a", ticket.LeaseID, id); e != nil {
				t.Fatal("snapshot content lost", e)
			}
		})
	}
}

func TestExpiredReservationWithoutDirectoryCanBeRetired(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	id := strings.Repeat("a", 64)
	data := []byte("reserved only")
	sum := sha256.Sum256(data)
	s.Fault = func(point string) error {
		if point == "after-object-reserve" {
			return code("interrupted")
		}
		return nil
	}
	expectCode(t, s.PutObject(ctx, id, hex.EncodeToString(sum[:]), data), "interrupted")
	s.Fault = nil
	if _, e := s.Pool.Exec(ctx, "UPDATE upload_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	collectNow(t, s)
	if scalar(t, s, "SELECT count(*) FROM upload_attempts WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("abandoned reservation leaked")
	}
}

func TestLogRetentionRequiresRecoverableSnapshot(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	// AEAD envelopes are opaque to the server. Escaped JSON can exceed the wire limit even when
	// individual accepted manifests fit their bounds; retention must use the actual snapshot encoding.
	manifest := strings.Repeat("<", 2<<20)
	a := createAction("F", "A", "a")
	a.Payload.Manifest = manifest
	submit(t, s, req("large-a", a))
	for _, id := range []string{"B", "C"} {
		a = editAction("F", id, a.RevisionID, "file")
		a.Payload.Manifest = manifest
		submit(t, s, req("large-"+id, a))
	}
	p := DefaultCleanupPolicy()
	p.LogEntries = 1
	_, e := s.Collect(ctx, p)
	expectCode(t, e, "SNAPSHOT_TOO_LARGE")
	if scalar(t, s, "SELECT count(*) FROM changes WHERE vault_id=$1", s.Config.VaultID) != 3 || scalar(t, s, "SELECT min_seq FROM vaults WHERE id=$1", s.Config.VaultID) != 0 {
		t.Fatal("retention cut off recovery")
	}
	_, e = s.CreateSnapshot(ctx, "computer-a", opaqueID())
	expectCode(t, e, "SNAPSHOT_TOO_LARGE")
	if scalar(t, s, "SELECT count(*) FROM content_leases WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("failed snapshot leaked protection")
	}
}
