package syncstore

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestContinuityHTTPRequiresProtectionForWritesButAllowsReadOnlyInspection(t *testing.T) {
	s := contractStore(t)
	before := currentContinuity(t, s, "computer-a")
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	request := func(method, path string, capability bool) int {
		t.Helper()
		r, e := http.NewRequest(method, server.URL+path, nil)
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 64))
		r.Header.Set("X-Sync-Content", ContentCapability)
		r.Header.Set("X-Sync-Objects", ObjectCapability)
		r.Header.Set("X-Sync-Metadata", MetadataCapability)
		r.Header.Set("X-Sync-Compaction", CompactCapability)
		r.Header.Set("X-Sync-Read-Only", "1")
		if capability {
			r.Header.Set("X-Sync-Continuity", ContinuityCapability)
			r.Header.Set("X-Sync-Snapshots", SnapshotCapability)
		}
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	if request("GET", "/handshake", false) != http.StatusUpgradeRequired {
		t.Fatal("missing continuity capability accepted")
	}
	if request("GET", "/changes?epoch=epoch-1&after=0", true) != http.StatusOK {
		t.Fatal("read-only inspection rejected")
	}
	for _, path := range []string{"/commits", "/metadata/commits", "/metadata/continuity/fence"} {
		if request("POST", path, true) != http.StatusBadRequest {
			t.Fatal("read-only header bypassed write protection", path)
		}
	}
	if currentContinuity(t, s, "computer-a") != before {
		t.Fatal("inspection changed continuity")
	}
}

func continuityContext(device, from, next string) context.Context {
	return context.WithValue(context.Background(), continuityKey{}, &continuityChange{device, from, next})
}
func currentContinuity(t *testing.T, s *Store, device string) string {
	t.Helper()
	token, e := s.Continuity(context.Background(), device)
	if e != nil {
		t.Fatal(e)
	}
	return token
}

func TestContinuityCommitAndCachedResultShareTheDataTransaction(t *testing.T) {
	s := contractStore(t)
	old := currentContinuity(t, s, "computer-a")
	next := opaqueID()
	ctx := continuityContext("computer-a", old, next)
	stream := streamFor(t, s)
	c := req("once", createAction("F", "R", "a"))
	s.Fault = func(point string) error {
		if point == "before-sql-commit" {
			return code("rollback")
		}
		return nil
	}
	_, e := s.CommitTracked(ctx, c, RequestTracking{stream.ID, 1, nil})
	expectCode(t, e, "rollback")
	if currentContinuity(t, s, "computer-a") != old || scalar(t, s, "SELECT seq FROM vaults WHERE id=$1", s.Config.VaultID) != 0 {
		t.Fatal("partial continuity/data commit")
	}
	s.Fault = func(point string) error {
		if point == "after-sql-commit" {
			return code("lost-response")
		}
		return nil
	}
	_, e = s.CommitTracked(ctx, c, RequestTracking{stream.ID, 1, nil})
	expectCode(t, e, "lost-response")
	s.Fault = nil
	if currentContinuity(t, s, "computer-a") != next {
		t.Fatal("accepted data missing continuity witness")
	}
	_, e = s.CommitTracked(ctx, c, RequestTracking{stream.ID, 1, nil})
	expectCode(t, e, "CONTINUITY_MISMATCH")
	retry := opaqueID()
	r, e := s.CommitTracked(continuityContext("computer-a", next, retry), c, RequestTracking{stream.ID, 1, nil})
	if e != nil {
		t.Fatal(e)
	}
	if r.Receipt.Seq != 1 || currentContinuity(t, s, "computer-a") != retry || scalar(t, s, "SELECT seq FROM vaults WHERE id=$1", s.Config.VaultID) != 1 {
		t.Fatal("cached retry duplicated data or failed to advance continuity")
	}
}

func TestContinuityGuardsReceiversAndFrozenViewsIndependentlyOfGlobalSeq(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	submit(t, s, req("create", createAction("F", "A", "a")))
	before := currentContinuity(t, s, "computer-b")
	received := opaqueID()
	changes, e := s.Pull(continuityContext("computer-b", before, received), s.Config.Epoch, 0)
	if e != nil || len(changes) != 1 {
		t.Fatal("guarded pull failed", e)
	}
	if currentContinuity(t, s, "computer-b") != received {
		t.Fatal("received view not witnessed")
	}
	submit(t, s, req("two", editAction("F", "B", "A", "file")))
	submit(t, s, req("three", editAction("F", "C", "B", "file")))
	if _, e = s.Pool.Exec(ctx, "UPDATE device_continuity SET token=$3 WHERE vault_id=$1 AND device_id=$2", s.Config.VaultID, "computer-b", before); e != nil {
		t.Fatal(e)
	}
	_, e = s.Pull(continuityContext("computer-b", received, opaqueID()), s.Config.Epoch, 1)
	expectCode(t, e, "CONTINUITY_MISMATCH")
	key := opaqueID()
	first := opaqueID()
	ticket, e := s.CreateSnapshot(continuityContext("computer-b", before, first), "computer-b", key)
	if e != nil {
		t.Fatal(e)
	}
	second := opaqueID()
	again, e := s.CreateSnapshot(continuityContext("computer-b", first, second), "computer-b", key)
	if e != nil || again != ticket {
		t.Fatal("snapshot retry changed frozen view", e)
	}
	if currentContinuity(t, s, "computer-b") != second {
		t.Fatal("cached snapshot did not commit continuity")
	}
}

func TestContinuityFenceRejectsLateCommitWithoutChangingFileData(t *testing.T) {
	s := contractStore(t)
	old := currentContinuity(t, s, "computer-a")
	pending := opaqueID()
	ctx := continuityContext("computer-a", old, pending)
	s.Fault = func(point string) error {
		if point == "after-continuity-update" {
			return code("interrupted")
		}
		return nil
	}
	_, e := s.FenceContinuity(ctx, "computer-a")
	expectCode(t, e, "interrupted")
	if currentContinuity(t, s, "computer-a") != old {
		t.Fatal("fence escaped rollback")
	}
	s.Fault = nil
	token, e := s.FenceContinuity(ctx, "computer-a")
	if e != nil || token != pending {
		t.Fatal("fence failed", e)
	}
	c := req("late", createAction("F", "R", "a"))
	_, e = s.Commit(ctx, c)
	expectCode(t, e, "CONTINUITY_MISMATCH")
	if scalar(t, s, "SELECT seq FROM vaults WHERE id=$1", s.Config.VaultID) != 0 {
		t.Fatal("late request changed data")
	}
	_, e = s.FenceContinuity(ctx, "computer-a")
	expectCode(t, e, "CONTINUITY_MISMATCH")
	if currentContinuity(t, s, "computer-a") != pending {
		t.Fatal("duplicate fence changed token")
	}
	_, e = s.Commit(continuityContext("computer-a", pending, opaqueID()), c)
	if e != nil {
		t.Fatal("fresh transition failed", e)
	}
}
