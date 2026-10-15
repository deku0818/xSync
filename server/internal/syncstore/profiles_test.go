package syncstore

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
)

func TestDeviceProfilesUniqueCASAndRetry(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	first := ProfileUpdate{"MacBook", 0, "cipher-one"}
	r, e := s.PutProfile(ctx, "computer-a", first)
	if e != nil || r.Revision != 1 {
		t.Fatalf("first: %v", e)
	}
	if _, e = s.PutProfile(ctx, "computer-b", ProfileUpdate{"  ＭＡＣＢＯＯＫ  ", 0, "other"}); e == nil || e.Error() != "DEVICE_NAME_TAKEN" {
		t.Fatalf("duplicate: %v", e)
	}
	retry, e := s.PutProfile(ctx, "computer-a", first)
	if e != nil || retry.Revision != 1 {
		t.Fatalf("retry: %v", e)
	}
	if _, e = s.PutProfile(ctx, "computer-a", ProfileUpdate{"different", 0, "different"}); e == nil || e.Error() != "PROFILE_STALE" {
		t.Fatalf("CAS: %v", e)
	}
	s.Fault = func(point string) error {
		if point == "after-profile-commit" {
			return errors.New("lost reply")
		}
		return nil
	}
	next := ProfileUpdate{"MacBook renamed", 1, "cipher-two"}
	if _, e = s.PutProfile(ctx, "computer-a", next); e == nil {
		t.Fatal("expected lost reply")
	}
	s.Fault = nil
	retry, e = s.PutProfile(ctx, "computer-a", next)
	if e != nil || retry.Revision != 2 {
		t.Fatalf("retry after commit: %v", e)
	}
	reopened, e := Open(ctx, s.Config)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Pool.Close()
	rows, e := reopened.Devices(ctx)
	if e != nil {
		t.Fatal(e)
	}
	for _, d := range rows {
		if d.ID == "computer-a" && (d.Name != "MacBook renamed" || d.Revision != 2 || d.Ciphertext != "cipher-two") {
			t.Fatal("restart reset the profile")
		}
	}
}
func TestConcurrentDeviceRenameHasOneWinner(t *testing.T) {
	s := contractStore(t)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, id := range []string{"computer-a", "computer-b"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, e := s.PutProfile(context.Background(), id, ProfileUpdate{"same name", 0, id + "-cipher"})
			results <- e
		}(id)
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		} else if e.Error() != "DEVICE_NAME_TAKEN" {
			t.Fatal(e)
		}
	}
	if success != 1 {
		t.Fatal("name uniqueness was not atomic")
	}
}
func TestProfileBoundsAndUnknownDevice(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	for _, name := range []string{"", "\n", "name\x00"} {
		if _, e := s.PutProfile(ctx, "computer-a", ProfileUpdate{name, 0, "cipher"}); e == nil {
			t.Fatal("invalid name accepted")
		}
	}
	if _, e := s.PutProfile(ctx, "unknown", ProfileUpdate{"valid", 0, "cipher"}); e == nil || e.Error() != "UNAUTHORIZED" {
		t.Fatal(e)
	}
	if _, e := s.PutProfile(ctx, "computer-a", ProfileUpdate{"valid", -1, "cipher"}); e == nil {
		t.Fatal("negative revision accepted")
	}
}

func TestResolutionRejectsUnseenLocationAndIndependentRootsKeepBothHeads(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	submit(t, s, req("root-create", createAction("F", "R0", "a")))
	branch := req("independent", Action{Type: "branch", FileID: "F", RevisionID: "R1", Payload: p("file")})
	branch.DeviceID = "computer-b"
	submit(t, s, branch)
	var raw []byte
	if e := s.Pool.QueryRow(ctx, "SELECT value FROM revisions WHERE vault_id=$1 AND id=$2", s.Config.VaultID, "R1").Scan(&raw); e != nil {
		t.Fatal(e)
	}
	var revision Revision
	if e := json.Unmarshal(raw, &revision); e != nil {
		t.Fatal(e)
	}
	if len(revision.Parents) != 0 {
		t.Fatal("independent root invented an ancestor")
	}
	submit(t, s, req("move-after-review", Action{Type: "move", FileID: "F", Expected: "L-F", Location: location("L-new", "b")}))
	choice := Action{Type: "resolve", FileID: "F", RevisionID: "R2", Expected: "L-F", Observed: []string{"R0", "R1"}, Payload: p("file"), Decision: &Decision{Kind: "select", Selected: "R0"}}
	if _, e := s.Commit(ctx, req("stale-location", choice)); e == nil || e.Error() != "REVIEW_STALE" {
		t.Fatalf("unseen move accepted: %v", e)
	}
	choice.Expected = "L-new"
	submit(t, s, req("fresh-location", choice))
}
