package syncstore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
)

func TestSnapshotPagesKeepOneFrozenBoundaryAndRequireLiveOwner(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	actions := []Action{}
	for i := 0; i < 300; i++ {
		action := createAction(fmt.Sprintf("F%d", i), fmt.Sprintf("R%d", i), "a")
		action.Location.PathKey = fmt.Sprintf("%064x", i)
		actions = append(actions, action)
	}
	submit(t, s, req("many-files", actions...))
	ticket, e := s.CreateSnapshot(ctx, "computer-a", opaqueID())
	if e != nil {
		t.Fatal(e)
	}
	first, e := s.ReadSnapshotPage(ctx, "computer-a", ticket.ID, 0)
	if e != nil || first.Next == nil || first.Total != 600 {
		t.Fatal("bad first page", first.Total, e)
	}
	submit(t, s, req("after-freeze", createAction("later", "later-rev", "b")))
	files, revisions := len(first.Files), len(first.Revisions)
	next := first.Next
	for next != nil {
		page, err := s.ReadSnapshotPage(ctx, "computer-a", ticket.ID, *next)
		if err != nil {
			t.Fatal(err)
		}
		if page.Boundary != first.Boundary || page.Total != first.Total {
			t.Fatal("mixed snapshot boundaries")
		}
		for _, raw := range page.Files {
			var file File
			if json.Unmarshal(raw, &file) != nil || file.ID == "later" {
				t.Fatal("unfrozen file")
			}
		}
		files += len(page.Files)
		revisions += len(page.Revisions)
		next = page.Next
	}
	if files != 300 || revisions != 300 {
		t.Fatal("incomplete pages", files, revisions)
	}
	_, e = s.ReadSnapshotPage(ctx, "computer-b", ticket.ID, 0)
	expectCode(t, e, "VIEW_EXPIRED")
	_, e = s.ReadSnapshotPage(ctx, "computer-a", ticket.ID, -1)
	expectCode(t, e, "INVALID_REQUEST")
	_, e = s.ReadSnapshotPage(ctx, "computer-a", ticket.ID, 601)
	expectCode(t, e, "INVALID_REQUEST")
	if _, e = s.Pool.Exec(ctx, "UPDATE content_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	_, e = s.ReadSnapshotPage(ctx, "computer-a", ticket.ID, 0)
	expectCode(t, e, "VIEW_EXPIRED")
}

func TestSnapshotPaginationIsNegotiatedBeforeSync(t *testing.T) {
	s := contractStore(t)
	request := httptest.NewRequest("GET", "/handshake", nil)
	request.Header.Set("Authorization", "Bearer "+s.Config.Devices[0].Token)
	request.Header.Set("X-Sync-Content", ContentCapability)
	request.Header.Set("X-Sync-Objects", ObjectCapability)
	request.Header.Set("X-Sync-Continuity", ContinuityCapability)
	recorder := httptest.NewRecorder()
	s.Handler().ServeHTTP(recorder, request)
	if recorder.Code != 426 {
		t.Fatal("legacy client was allowed to use truncated-log recovery")
	}
	request.Header.Set("X-Sync-Snapshots", legacySnapshotCapability)
	recorder = httptest.NewRecorder()
	s.Handler().ServeHTTP(recorder, request)
	if recorder.Code != 426 {
		t.Fatal("pre-streaming snapshot client was allowed")
	}
	request.Header.Set("X-Sync-Snapshots", SnapshotCapability)
	recorder = httptest.NewRecorder()
	s.Handler().ServeHTTP(recorder, request)
	if recorder.Code != 200 {
		t.Fatal(recorder.Body.String())
	}
}

func TestSnapshotPageSlicesOnlyTheRequestedEntries(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	ticket, e := s.CreateSnapshot(ctx, "computer-a", opaqueID())
	if e != nil {
		t.Fatal(e)
	}
	// Opaque markers isolate the JSON range query from file decryption and head projection.
	_, e = s.Pool.Exec(ctx, `UPDATE snapshots SET paged=false,value=jsonb_build_object('epoch',$3::text,'boundary',0,
 'files',(SELECT jsonb_agg(jsonb_build_object('id','F'||n)) FROM generate_series(1,2000) n),
 'revisions',(SELECT jsonb_agg(jsonb_build_object('id','R'||n)) FROM generate_series(1,2000) n),
 'bases',(SELECT jsonb_agg(jsonb_build_object('id','B'||n)) FROM generate_series(1,2000) n))
 WHERE vault_id=$1 AND id=$2`, s.Config.VaultID, ticket.ID, s.Config.Epoch)
	if e != nil {
		t.Fatal(e)
	}
	for _, offset := range []int64{0, 1999, 2000, 3999, 4000, 5744, 5999, 6000} {
		page, err := s.ReadSnapshotPage(ctx, "computer-a", ticket.ID, offset)
		if err != nil {
			t.Fatal(err)
		}
		items := append(append(append([]json.RawMessage{}, page.Files...), page.Revisions...), page.Bases...)
		count := min(int64(256), 6000-offset)
		if int64(len(items)) != count || page.Total != 6000 {
			t.Fatalf("bad range at %d: %d items", offset, len(items))
		}
		for index, item := range items {
			var marker struct {
				ID string `json:"id"`
			}
			if err = json.Unmarshal(item, &marker); err != nil {
				t.Fatal(err)
			}
			position := offset + int64(index)
			want := fmt.Sprintf("%s%d", []string{"F", "R", "B"}[position/2000], position%2000+1)
			if marker.ID != want {
				t.Fatalf("range reordered or skipped: got %s want %s", marker.ID, want)
			}
		}
		if offset+count == 6000 {
			if page.Next != nil {
				t.Fatal("unexpected final cursor")
			}
		} else if page.Next == nil || *page.Next != offset+count {
			t.Fatal("wrong next cursor")
		}
	}
	// Verify the actual query plan's row work, rather than a timing bound dependent on the host.
	type planNode struct {
		NodeType string     `json:"Node Type"`
		Rows     float64    `json:"Actual Rows"`
		Removed  float64    `json:"Rows Removed by Filter"`
		Loops    float64    `json:"Actual Loops"`
		Plans    []planNode `json:"Plans"`
	}
	for _, offset := range []int64{0, 5744} {
		var encoded []byte
		if e = s.Pool.QueryRow(ctx, "EXPLAIN (ANALYZE,FORMAT JSON) "+snapshotPageQuery, s.Config.VaultID, ticket.ID, offset).Scan(&encoded); e != nil {
			t.Fatal(e)
		}
		var plan []struct{ Plan planNode }
		if e = json.Unmarshal(encoded, &plan); e != nil {
			t.Fatal(e)
		}
		var visited float64
		var visit func(planNode)
		visit = func(node planNode) {
			if node.NodeType == "Function Scan" {
				visited += (node.Rows + node.Removed) * node.Loops
			}
			for _, child := range node.Plans {
				visit(child)
			}
		}
		visit(plan[0].Plan)
		if visited > 512 {
			t.Fatalf("page %d enumerated %.0f entries for a 256-entry page", offset, visited)
		}
		t.Logf("page offset=%d visits approximately %.0f entries", offset, visited)
	}
}

func TestPagedSnapshotRetainsHistoricalHeadsAndCascadesItsItems(t *testing.T) {
	ctx := context.Background()
	s := contractStore(t, func(c *Config) { c.MetadataMode = "" })
	stream := streamFor(t, s)
	first := tracked(t, s, compactRequest(s, stream, 1, createAction("F", "first", "a")), stream, 1)
	old := first.Bases[0].Revision
	ticket, e := s.CreateSnapshot(ctx, "computer-a", opaqueID())
	if e != nil {
		t.Fatal(e)
	}
	var items int
	if e = s.Pool.QueryRow(ctx, "SELECT count(*) FROM snapshot_items WHERE vault_id=$1 AND snapshot_id=$2", s.Config.VaultID, ticket.ID).Scan(&items); e != nil {
		t.Fatal(e)
	}
	if items != 3 {
		t.Fatal("snapshot was not stored as bounded entries", items)
	}
	tracked(t, s, compactRequest(s, stream, 2, editAction("F", "second", old.ID, "file")), stream, 2, first.Bases[0].Proof)
	collectMetadata(t, s)
	lease, e := s.ReadLease(ctx, "computer-a", ReadView{Revision: old.ID, Snapshot: ticket.ID, RequestKey: opaqueID()})
	if e != nil {
		t.Fatal("frozen historical head was pruned", e)
	}
	if e = s.ReleaseLease(ctx, "computer-a", lease); e != nil {
		t.Fatal(e)
	}
	if e = s.ReleaseLease(ctx, "computer-a", ticket.LeaseID); e != nil {
		t.Fatal(e)
	}
	if e = s.Pool.QueryRow(ctx, "SELECT count(*) FROM snapshot_items WHERE vault_id=$1 AND snapshot_id=$2", s.Config.VaultID, ticket.ID).Scan(&items); e != nil {
		t.Fatal(e)
	}
	if items != 0 {
		t.Fatal("retired snapshot left items", items)
	}
	collectMetadata(t, s)
	if e = s.Pool.QueryRow(ctx, "SELECT count(*) FROM revisions WHERE vault_id=$1 AND id=$2", s.Config.VaultID, old.ID).Scan(&items); e != nil {
		t.Fatal(e)
	}
	if items != 0 {
		t.Fatal("released historical revision was retained", items)
	}
}

func TestSnapshotHeadLookupDoesNotScanTheFrozenVault(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	ticket, e := s.CreateSnapshot(ctx, "computer-a", opaqueID())
	if e != nil {
		t.Fatal(e)
	}
	// Isolate lookup work with enough frozen file rows for the planner to choose an index.
	_, e = s.Pool.Exec(ctx, `INSERT INTO snapshot_items(vault_id,snapshot_id,position,kind,value)
 SELECT $1,$2,n,'files',jsonb_build_object('id','F'||n,'heads',jsonb_build_array('R'||n)) FROM generate_series(0,9999) n`, s.Config.VaultID, ticket.ID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Pool.Exec(ctx, "ANALYZE snapshot_items"); e != nil {
		t.Fatal(e)
	}
	for _, file := range []string{"F9999", "missing"} {
		var raw []byte
		if e = s.Pool.QueryRow(ctx, "EXPLAIN (ANALYZE,FORMAT JSON) "+snapshotHeadQuery, s.Config.VaultID, ticket.ID, file, "R9999", "computer-a").Scan(&raw); e != nil {
			t.Fatal(e)
		}
		type node struct {
			Relation string  `json:"Relation Name"`
			Rows     float64 `json:"Actual Rows"`
			Removed  float64 `json:"Rows Removed by Filter"`
			Loops    float64 `json:"Actual Loops"`
			Plans    []node  `json:"Plans"`
		}
		var plan []struct{ Plan node }
		if e = json.Unmarshal(raw, &plan); e != nil {
			t.Fatal(e)
		}
		var visited float64
		var visit func(node)
		visit = func(n node) {
			if n.Relation == "snapshot_items" {
				visited += (n.Rows + n.Removed) * n.Loops
			}
			for _, child := range n.Plans {
				visit(child)
			}
		}
		visit(plan[0].Plan)
		if visited > 16 {
			t.Fatalf("head lookup %s visited %.0f frozen files", file, visited)
		}
	}
}
