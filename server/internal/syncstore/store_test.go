package syncstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func contractStore(t *testing.T, configure ...func(*Config)) *Store {
	t.Helper()
	ctx := context.Background()
	path := os.Getenv("OBSIDIAN_SYNC_TEST_CONFIG")
	if path == "" {
		path = "../../../.local/desktop/server.json"
	}
	b, e := os.ReadFile(path)
	if e != nil {
		t.Skip("Docker PostgreSQL contract test requires desktop:setup and OBSIDIAN_SYNC_TEST_CONFIG")
	}
	var c Config
	if e = json.Unmarshal(b, &c); e != nil {
		t.Fatal(e)
	}
	// Only a dedicated local development DB; never accept arbitrary production DSNs here.
	if !strings.Contains(c.DSN, "127.0.0.1:55438/obsidiansync") {
		t.Fatal("refusing non-development database")
	}
	admin, e := pgxpool.New(ctx, c.DSN)
	if e != nil {
		t.Fatal(e)
	}
	random := make([]byte, 8)
	_, _ = rand.Read(random)
	schemaName := "contract_" + hex.EncodeToString(random)
	if _, e = admin.Exec(ctx, "CREATE SCHEMA "+schemaName); e != nil {
		admin.Close()
		t.Fatal(e)
	}
	c.DSN += "&search_path=" + schemaName
	c.ObjectDir = t.TempDir()
	c.VaultID = "contract-vault"
	c.MetadataMode = "full" // Original complete-graph contracts remain a distinct migration oracle.
	c.Epoch = "epoch-1"
	c.KeyPackage = json.RawMessage(`{"fixture":true}`)
	c.Devices = []Device{{"computer-a", "电脑 A", strings.Repeat("a", 64)}, {"computer-b", "电脑 B", strings.Repeat("b", 64)}}
	for _, change := range configure {
		change(&c)
	}
	s, e := Open(ctx, c)
	if e != nil {
		_, _ = admin.Exec(ctx, "DROP SCHEMA "+schemaName+" CASCADE")
		admin.Close()
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Pool.Close(); _, _ = admin.Exec(ctx, "DROP SCHEMA "+schemaName+" CASCADE"); admin.Close() })
	return s
}
func p(kind string) *Payload {
	objects := []string{}
	return &Payload{kind, 1, "synthetic-encrypted-manifest", objects}
}
func location(id, key string) *Location {
	return &Location{id, strings.Repeat(key, 64), "synthetic-encrypted-path"}
}
func createAction(id, revision, key string) Action {
	return Action{Type: "create", FileID: id, RevisionID: revision, Payload: p("file"), Location: location("L-"+id, key)}
}
func editAction(id, revision, parent, kind string) Action {
	return Action{Type: "edit", FileID: id, RevisionID: revision, Payload: p(kind), Displayed: parent}
}
func req(op string, actions ...Action) Commit {
	return Commit{0, "contract-vault", "epoch-1", []string{"causal-heads", "atomic-groups", "review-cas"}, "computer-a", op, actions}
}
func submit(t *testing.T, s *Store, c Commit) Receipt {
	t.Helper()
	r, e := s.Commit(context.Background(), c)
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func expectCode(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || err.Error() != want {
		t.Fatalf("want %s, got %v", want, err)
	}
}

func TestCommitCausalityAndResolution(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	submit(t, s, req("create", createAction("F", "A", "a")))
	submit(t, s, req("edit-a", editAction("F", "B", "A", "file")))
	r := req("edit-b", editAction("F", "C", "A", "deleted"))
	r.DeviceID = "computer-b"
	submit(t, s, r)
	snap, e := s.Snapshot(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if !sameSet(snap.Files[0].Heads, []string{"B", "C"}) {
		t.Fatal("concurrent delete/edit lost")
	}
	resolution := Action{Type: "resolve", FileID: "F", RevisionID: "R", Payload: p("file"), Observed: []string{"B", "C"}, Decision: &Decision{Kind: "select", Selected: "B"}}
	submit(t, s, req("resolve", resolution))
	snap, e = s.Snapshot(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if len(snap.Revisions) != 4 || !sameSet(snap.Files[0].Heads, []string{"R"}) {
		t.Fatal("resolution history lost")
	}
	submit(t, s, req("old-phone", editAction("F", "D", "A", "file")))
	_, e = s.Commit(ctx, req("stale", resolution))
	expectCode(t, e, "REVIEW_STALE")
	snap, _ = s.Snapshot(ctx)
	if !sameSet(snap.Files[0].Heads, []string{"R", "D"}) {
		t.Fatal("unreviewed branch lost")
	}
}
func TestIdempotencyRollbackAndLostReceipt(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	r := req("create", createAction("F", "A", "a"))
	s.Fault = func(point string) error {
		if point == "before-sql-commit" {
			return code("injected")
		}
		return nil
	}
	_, e := s.Commit(ctx, r)
	expectCode(t, e, "injected")
	snap, _ := s.Snapshot(ctx)
	if snap.Boundary != 0 || len(snap.Files) != 0 {
		t.Fatal("SQL rollback leaked")
	}
	s.Fault = func(point string) error {
		if point == "after-sql-commit" {
			return code("response-lost")
		}
		return nil
	}
	_, e = s.Commit(ctx, r)
	expectCode(t, e, "response-lost")
	s.Fault = nil
	receipt := submit(t, s, r)
	if receipt.Seq != 1 || submit(t, s, r) != receipt {
		t.Fatal("retry duplicated commit")
	}
	changed := req("create", createAction("G", "G1", "b"))
	_, e = s.Commit(ctx, changed)
	expectCode(t, e, "OP_ID_REUSED")
	bad := createAction("G", "G1", "b")
	bad.Payload.Objects = []string{strings.Repeat("f", 64)}
	_, e = s.Commit(ctx, req("bad", editAction("F", "B", "A", "file"), bad))
	expectCode(t, e, "OBJECT_MISSING")
	snap, _ = s.Snapshot(ctx)
	if snap.Boundary != 1 || len(snap.Revisions) != 1 {
		t.Fatal("failed group leaked changes")
	}
	// Open a fresh pool as a restart, retaining SQL and objects.
	reopened, e := Open(ctx, s.Config)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Pool.Close()
	if submit(t, reopened, r) != receipt {
		t.Fatal("idempotency not durable across restart")
	}
}
func TestNamespaceAndKeepBoth(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	submit(t, s, req("create", createAction("F", "A", "a"), createAction("G", "G1", "b")))
	_, e := s.Commit(ctx, req("occupied", Action{Type: "move", FileID: "F", Expected: "L-F", Location: location("LF2", "b")}))
	expectCode(t, e, "PATH_OCCUPIED")
	submit(t, s, req("swap", Action{Type: "move", FileID: "F", Expected: "L-F", Location: location("LF2", "b")}, Action{Type: "move", FileID: "G", Expected: "L-G", Location: location("LG2", "a")}))
	events, e := s.Pull(ctx, "epoch-1", 1)
	if e != nil || len(events) != 1 || len(events[0].Actions) != 2 {
		t.Fatal("group split or failed swap")
	}
	submit(t, s, req("B", editAction("F", "B", "A", "file")))
	submit(t, s, req("C", editAction("F", "C", "A", "file")))
	companion := createAction("H", "H1", "c")
	a := Action{Type: "resolve", FileID: "F", RevisionID: "R", Payload: p("file"), Observed: []string{"B", "C"}, Decision: &Decision{Kind: "keep-both", Selected: "B", Source: "C", Companion: &companion}}
	r := req("keep", a)
	first := submit(t, s, r)
	if submit(t, s, r) != first {
		t.Fatal("duplicate keep-both")
	}
	snap, _ := s.Snapshot(ctx)
	if len(snap.Files) != 3 {
		t.Fatal("companion missing or duplicated")
	}
}
func TestLocationVersionsSurviveCreateAndMoveGroup(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	submit(t, s, req("group", createAction("F", "A", "a"), Action{Type: "move", FileID: "F", Expected: "L-F", Location: location("L2", "b")}))
	_, e := s.Commit(ctx, req("ABA", Action{Type: "move", FileID: "F", Expected: "L2", Location: location("L-F", "c")}))
	expectCode(t, e, "LOCATION_STALE")
}
func TestConcurrentSequencePublication(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := fmt.Sprintf("%064x", i+1)
			a := createAction(fmt.Sprintf("F%d", i), fmt.Sprintf("R%d", i), "a")
			a.Location.PathKey = key
			_, e := s.Commit(ctx, req(fmt.Sprintf("op%d", i), a))
			if e != nil {
				errs <- e
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	events, e := s.Pull(ctx, "epoch-1", 0)
	if e != nil || len(events) != 16 {
		t.Fatal("missing events")
	}
	for i, c := range events {
		if c.Seq != int64(i+1) {
			t.Fatal("publication gap")
		}
	}
}
func TestDurableImmutableObjectBoundaries(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	id := strings.Repeat("c", 64)
	data := []byte("synthetic ciphertext only")
	h := sha256.Sum256(data)
	digest := hex.EncodeToString(h[:])
	s.Fault = func(point string) error {
		if point == "after-object-publish" {
			return code("crash")
		}
		return nil
	}
	expectCode(t, s.PutObject(ctx, id, digest, data), "crash")
	_, _, e := s.GetObject(ctx, id)
	expectCode(t, e, "OBJECT_MISSING")
	s.Fault = nil
	if e = s.PutObject(ctx, id, digest, data); e != nil {
		t.Fatal(e)
	}
	if e = s.PutObject(ctx, id, digest, data); e != nil {
		t.Fatal(e)
	}
	prior, _, e := s.GetObject(ctx, id)
	if e != nil || !bytes.Equal(prior, data) {
		t.Fatal("ciphertext mismatch")
	}
	changed := []byte("different bytes")
	hh := sha256.Sum256(changed)
	expectCode(t, s.PutObject(ctx, id, hex.EncodeToString(hh[:]), changed), "OBJECT_IMMUTABLE")
	a := createAction("F", "A", "a")
	a.Payload.Objects = []string{id}
	submit(t, s, req("create", a))
	var generation int64
	if e = s.Pool.QueryRow(ctx, "SELECT generation FROM objects WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&generation); e != nil {
		t.Fatal(e)
	}
	path, _ := s.generationPath(id, generation)
	if e = os.WriteFile(path, []byte("corrupt"), 0600); e != nil {
		t.Fatal(e)
	}
	_, _, e = s.GetObject(ctx, id)
	expectCode(t, e, "OBJECT_CORRUPT")
}
func TestHTTPAuthenticationAndStrictJSON(t *testing.T) {
	s := contractStore(t)
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	post := func(body, token string) int {
		r, _ := http.NewRequest("POST", server.URL+"/commits", strings.NewReader(body))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
			r.Header.Set("X-Sync-Content", ContentCapability)
			r.Header.Set("X-Sync-Objects", ObjectCapability)
			r.Header.Set("X-Sync-Continuity", ContinuityCapability)
			continuityToken, err := s.Continuity(context.Background(), "computer-a")
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("X-Sync-Continuity-From", continuityToken)
			r.Header.Set("X-Sync-Continuity-Next", opaqueID())
		}
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	body, _ := json.Marshal(req("create", createAction("F", "A", "a")))
	if post(string(body), "") != 401 {
		t.Fatal("missing auth accepted")
	}
	if post(string(body), strings.Repeat("b", 64)) != 401 {
		t.Fatal("spoofed device accepted")
	}
	duplicate := strings.Replace(string(body), `"protocol":0`, `"protocol":0,"protocol":0`, 1)
	if post(duplicate, strings.Repeat("a", 64)) != 400 {
		t.Fatal("duplicate JSON keys accepted")
	}
	unknown := strings.Replace(string(body), `"protocol":0`, `"protocol":0,"unknown":true`, 1)
	if post(unknown, strings.Repeat("a", 64)) != 400 {
		t.Fatal("unknown field accepted")
	}
	missing := strings.Replace(string(body), `"protocol":0,`, "", 1)
	if post(missing, strings.Repeat("a", 64)) != 400 {
		t.Fatal("missing version accepted")
	}
	if post(string(body), strings.Repeat("a", 64)) != 200 {
		t.Fatal("valid commit failed")
	}
}
func TestEpochAndExpiredLogGates(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	submit(t, s, req("create", createAction("F", "A", "a")))
	old := req("old", editAction("F", "B", "A", "file"))
	old.Epoch = "old"
	_, e := s.Commit(ctx, old)
	expectCode(t, e, "EPOCH_CHANGED")
	if _, e = s.Pool.Exec(ctx, "UPDATE vaults SET min_seq=1 WHERE id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	_, e = s.Pull(ctx, "epoch-1", 0)
	expectCode(t, e, "NEED_SNAPSHOT")
}
