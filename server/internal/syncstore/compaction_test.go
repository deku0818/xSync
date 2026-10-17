package syncstore

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"testing"
)

func compactRequest(s *Store, stream RequestStream, number int64, actions ...Action) Commit {
	tracking := RequestTracking{Stream: stream.ID, Number: number}
	for index := range actions {
		a := &actions[index]
		if a.RevisionID != "" {
			a.RevisionID = derivedID(tracking, "r", index)
		}
		if a.Location != nil {
			a.Location.Revision = derivedID(tracking, "l", index)
		}
	}
	return Commit{0, s.Config.VaultID, s.Config.Epoch, []string{CompactCapability}, "computer-a", derivedOperation(tracking), actions}
}
func collectMetadata(t *testing.T, s *Store) CleanupReport {
	t.Helper()
	p := DefaultCleanupPolicy()
	p.LogEntries = 1
	report, e := s.Collect(context.Background(), p)
	if e != nil {
		t.Fatal(e)
	}
	return report
}
func acknowledge(t *testing.T, s *Store, stream RequestStream, number int64, r TrackedResult) {
	t.Helper()
	if e := s.AcknowledgeRequest(context.Background(), "computer-a", RequestAck{stream.ID, number, r.Receipt.OpID, r.Receipt}); e != nil {
		t.Fatal(e)
	}
}

func TestCompactMigrationKeepsOldOfflineBasesAndAcceptedReceipts(t *testing.T) {
	ctx := context.Background()
	s := contractStore(t)
	create := req("old-create", createAction("F", "A", "a"))
	submit(t, s, create)
	before, _ := s.Snapshot(ctx)
	old := before.Revisions[0]
	submit(t, s, req("old-edit", editAction("F", "B", "A", "file")))
	s.Config.MetadataMode = ""
	s = reopenRecoveryStore(t, s)
	if !s.compact {
		t.Fatal("migration not activated")
	}
	stream := streamFor(t, s)
	offline := req("old-offline", editAction("F", "C", "A", "file"))
	bundle := LegacyMigration{[]Commit{offline}}
	if e := s.RegisterLegacy(ctx, "computer-a", bundle); e != nil {
		t.Fatal(e)
	}
	collectMetadata(t, s)
	if scalar(t, s, "SELECT count(*) FROM revisions WHERE vault_id=$1 AND id='A'", s.Config.VaultID) != 0 {
		t.Fatal("old full revision retained")
	}
	proof, e := s.CertifyBase(ctx, old)
	if e != nil {
		t.Fatal(e)
	}
	replay := tracked(t, s, create, stream, 1)
	if replay.Receipt.Seq != 1 || replay.Bases[0].Revision.ID != "A" {
		t.Fatal("old accepted result could not be reconstructed")
	}
	acknowledge(t, s, stream, 1, replay)
	result := tracked(t, s, offline, stream, 2, proof.Proof)
	acknowledge(t, s, stream, 2, result)
	snap, e := s.Snapshot(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if !sameSet(snap.Files[0].Heads, []string{"B", "C"}) || len(snap.Revisions) != 2 || len(snap.Bases) != 2 {
		t.Fatal("old offline branch lost")
	}
	changed := offline
	changed.OpID = "unregistered"
	_, e = s.CommitTracked(ctx, changed, RequestTracking{stream.ID, 3, []BaseProof{proof.Proof}})
	expectCode(t, e, "LEGACY_INTENT_UNREGISTERED")
	if e = s.RegisterLegacy(ctx, "computer-a", LegacyMigration{[]Commit{changed}}); e == nil {
		t.Fatal("legacy admission reopened")
	}
}

func TestCompactSteadyStateBoundsRevisionsLocationsAndConfirmedReceipts(t *testing.T) {
	ctx := context.Background()
	s := contractStore(t, func(c *Config) { c.MetadataMode = "compact" })
	stream := streamFor(t, s)
	var base BaseProof
	var first Commit
	var current string
	for number := int64(1); number <= 40; number++ {
		a := createAction("F", "new", "a")
		if number > 1 {
			a = editAction("F", "new", current, "file")
		}
		c := compactRequest(s, stream, number, a)
		if number == 1 {
			first = c
		}
		proofs := []BaseProof{}
		if number > 1 {
			proofs = append(proofs, base)
		}
		r := tracked(t, s, c, stream, number, proofs...)
		base = r.Bases[0].Proof
		current = base.RevisionID
		acknowledge(t, s, stream, number, r)
		collectMetadata(t, s)
		if scalar(t, s, "SELECT count(*) FROM revisions WHERE vault_id=$1", s.Config.VaultID) != 1 || scalar(t, s, "SELECT count(*) FROM operations WHERE vault_id=$1", s.Config.VaultID) != 0 {
			t.Fatal("steady-state metadata grew")
		}
	}
	for number := int64(41); number <= 50; number++ {
		snap, _ := s.Snapshot(ctx)
		a := Action{Type: "move", FileID: "F", Expected: snap.Files[0].Location.Revision, Location: location("unused", "a")}
		c := compactRequest(s, stream, number, a)
		r := tracked(t, s, c, stream, number)
		acknowledge(t, s, stream, number, r)
		collectMetadata(t, s)
		if scalar(t, s, "SELECT count(*) FROM locations WHERE vault_id=$1", s.Config.VaultID) != 1 {
			t.Fatal("old location bodies retained")
		}
	}
	if scalar(t, s, "SELECT count(*) FROM legacy_revisions WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("new edits grew legacy index")
	}
	_, e := s.CommitTracked(ctx, first, RequestTracking{stream.ID, 1, nil})
	expectCode(t, e, "OPERATION_RETIRED")
	reused := compactRequest(s, stream, 51, editAction("F", "new", current, "file"))
	reused.Actions[0].RevisionID = first.Actions[0].RevisionID
	_, e = s.CommitTracked(ctx, reused, RequestTracking{stream.ID, 51, []BaseProof{base}})
	expectCode(t, e, "LEGACY_INTENT_UNREGISTERED")
	_, e = s.Commit(ctx, reused)
	expectCode(t, e, "CLIENT_UPGRADE_REQUIRED")
	snap, _ := s.Snapshot(ctx)
	if snap.Checkpoint == nil || *snap.Checkpoint != 50 || snap.Epoch != s.Config.Epoch || len(snap.Revisions) != 1 || len(snap.Bases) != 1 {
		t.Fatal("checkpoint snapshot invalid")
	}
}

func TestCompactionProtectsFrozenSnapshotsAndRollsBackAsOneTransaction(t *testing.T) {
	ctx := context.Background()
	s := contractStore(t, func(c *Config) { c.MetadataMode = "compact" })
	stream := streamFor(t, s)
	a := tracked(t, s, compactRequest(s, stream, 1, createAction("F", "r", "a")), stream, 1)
	ticket, e := s.CreateSnapshot(ctx, "computer-a", opaqueID())
	if e != nil {
		t.Fatal(e)
	}
	tracked(t, s, compactRequest(s, stream, 2, editAction("F", "r", a.Bases[0].Revision.ID, "file")), stream, 2, a.Bases[0].Proof)
	collectMetadata(t, s)
	if scalar(t, s, "SELECT count(*) FROM revisions WHERE vault_id=$1", s.Config.VaultID) != 2 {
		t.Fatal("frozen head removed")
	}
	if e = s.ReleaseLease(ctx, "computer-a", ticket.LeaseID); e != nil {
		t.Fatal(e)
	}
	s.Fault = func(point string) error {
		if point == "before-metadata-cleanup-commit" {
			return code("interrupted")
		}
		return nil
	}
	p := DefaultCleanupPolicy()
	p.LogEntries = 1
	_, e = s.Collect(ctx, p)
	expectCode(t, e, "interrupted")
	if scalar(t, s, "SELECT count(*) FROM revisions WHERE vault_id=$1", s.Config.VaultID) != 2 {
		t.Fatal("partial metadata cleanup")
	}
	s.Fault = nil
	collectMetadata(t, s)
	if scalar(t, s, "SELECT count(*) FROM revisions WHERE vault_id=$1", s.Config.VaultID) != 1 {
		t.Fatal("released head retained")
	}
	// Unconfirmed results remain replayable even after their source full revision is gone.
	replay := tracked(t, s, compactRequest(s, stream, 1, createAction("F", "r", "a")), stream, 1)
	if replay.Bases[0].Revision.ID != a.Bases[0].Revision.ID {
		t.Fatal("unconfirmed result lost")
	}
}

func TestCompactProjectionMatchesCompleteGraphAfterEveryPrune(t *testing.T) {
	random := rand.New(rand.NewSource(9341))
	full, compact := newState(), newState()
	compact.compact = true
	for index := 0; index < 1000; index++ {
		id := fmt.Sprintf("R%d", index)
		var a Action
		if index == 0 {
			a = createAction("F", id, "a")
		} else {
			parent := fmt.Sprintf("R%d", random.Intn(index))
			a = editAction("F", id, parent, "file")
			compact.accepted[parent] = "F"
			if random.Intn(6) == 0 && len(full.files["F"].Heads) > 1 {
				a = Action{Type: "resolve", FileID: "F", RevisionID: id, Observed: append([]string{}, full.files["F"].Heads...), Payload: p("file"), Decision: &Decision{Kind: "manual"}}
			}
			if random.Intn(9) == 0 {
				a = Action{Type: "branch", FileID: "F", RevisionID: id, Payload: p("file")}
			}
			if a.Type == "edit" && random.Intn(7) == 0 {
				a.Payload = p("deleted")
			}
		}
		c := req(id, a)
		if e := full.apply(c); e != nil {
			t.Fatal(e)
		}
		if e := compact.apply(c); e != nil {
			t.Fatal(e)
		}
		if !sameSet(full.files["F"].Heads, compact.files["F"].Heads) {
			t.Fatal("compacted causal result differs")
		}
		for id := range compact.revisions {
			if !contains(compact.files["F"].Heads, id) {
				delete(compact.revisions, id)
			}
		}
	}
	b, _ := json.Marshal(compact.files)
	if len(b) == 0 {
		t.Fatal("empty oracle")
	}
}

func TestMigrationRollbackAndPreviouslyOpenedFullInstancesAreFenced(t *testing.T) {
	ctx := context.Background()
	old := contractStore(t)
	submit(t, old, req("old", createAction("F", "A", "a")))
	old.Config.MetadataMode = "compact"
	old.Fault = func(point string) error {
		if point == "before-metadata-migration-commit" {
			return code("migration-interrupted")
		}
		return nil
	}
	tx, e := old.locked(ctx)
	if e != nil {
		t.Fatal(e)
	}
	expectCode(t, old.initializeCompaction(ctx, tx), "migration-interrupted")
	tx.Rollback(ctx)
	if scalar(t, old, "SELECT metadata_checkpoint FROM vaults WHERE id=$1", old.Config.VaultID) != -1 || scalar(t, old, "SELECT count(*) FROM legacy_revisions WHERE vault_id=$1", old.Config.VaultID) != 0 {
		t.Fatal("partial migration published")
	}
	old.Fault = nil
	next, e := Open(ctx, old.Config)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(next.Pool.Close)
	_, e = old.Commit(ctx, req("stale-writer", editAction("F", "B", "A", "file")))
	expectCode(t, e, "METADATA_MODE_CHANGED")
	_, e = old.Collect(ctx, DefaultCleanupPolicy())
	expectCode(t, e, "METADATA_MODE_CHANGED")
	_, e = old.Handshake(ctx)
	expectCode(t, e, "METADATA_MODE_CHANGED")
	c := old.Config
	c.MetadataMode = "full"
	downgraded, e := Open(ctx, c)
	if downgraded != nil {
		downgraded.Pool.Close()
	}
	expectCode(t, e, "METADATA_DOWNGRADE_REFUSED")
	if scalar(t, next, "SELECT seq FROM vaults WHERE id=$1", next.Config.VaultID) != 1 {
		t.Fatal("stale instance changed data")
	}
}
