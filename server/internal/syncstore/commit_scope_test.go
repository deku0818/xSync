package syncstore

import (
	"context"
	"fmt"
	"testing"
)

func TestCommitLoadsOnlyTouchedFilesAndDestinationOwners(t *testing.T) {
	for _, count := range []int{1000, 10000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			s := contractStore(t, func(c *Config) { c.MetadataMode = "" })
			stream := streamFor(t, s)
			number := int64(1)
			for offset := 0; offset < count; offset += 1000 {
				actions := []Action{}
				for i := offset; i < min(count, offset+1000); i++ {
					a := createAction(fmt.Sprintf("F%d", i), "R", "a")
					a.Location.PathKey = fmt.Sprintf("%064x", i)
					actions = append(actions, a)
				}
				tracked(t, s, compactRequest(s, stream, number, actions...), stream, number)
				number++
			}
			tx, e := s.locked(context.Background())
			if e != nil {
				t.Fatal(e)
			}
			defer tx.Rollback(context.Background())
			st, e := s.loadCommit(context.Background(), tx, req("probe", editAction("F0", "next", "parent", "file")))
			if e != nil {
				t.Fatal(e)
			}
			if len(st.files) != 1 || len(st.revisions) != 1 || len(st.locations) != 1 || len(st.objects) != 0 {
				t.Fatalf("full-vault load: files=%d revisions=%d locations=%d objects=%d", len(st.files), len(st.revisions), len(st.locations), len(st.objects))
			}
			move := Action{Type: "move", FileID: "F0", Location: &Location{Revision: "move", PathKey: fmt.Sprintf("%064x", 1), EncryptedPath: "opaque"}}
			st, e = s.loadCommit(context.Background(), tx, req("probe-move", move))
			if e != nil {
				t.Fatal(e)
			}
			if len(st.files) != 2 || st.files["F1"] == nil {
				t.Fatal("destination occupancy was not loaded")
			}
			t.Logf("vault=%d files: edit loads one file/head/location; occupied move loads two files", count)
		})
	}
}
