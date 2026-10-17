package syncstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"
)

func addressedBytes(data []byte) (string, string) {
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	return "c_" + digest, digest
}
func physicalObject(t *testing.T, s *Store, id string) objectGeneration {
	t.Helper()
	r := objectGeneration{ID: id}
	if e := s.Pool.QueryRow(context.Background(), "SELECT generation,storage_token FROM objects WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id).Scan(&r.Generation, &r.Storage); e != nil {
		t.Fatal(e)
	}
	return r
}
func TestAddressedIdentityCanBeForgottenAndOldWorkersCannotDeleteRepublishedContent(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	data := []byte("opaque new format ciphertext")
	id, digest := addressedBytes(data)
	if e := s.PutObject(ctx, id, digest, data); e != nil {
		t.Fatal(e)
	}
	old := physicalObject(t, s, id)
	collectNow(t, s)
	if scalar(t, s, "SELECT count(*) FROM objects WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("addressed identity retained")
	}
	changed := []byte("different ciphertext")
	_, wrong := addressedBytes(changed)
	expectCode(t, s.PutObject(ctx, id, wrong, changed), "DIGEST_MISMATCH")
	if e := s.PutObject(ctx, id, digest, data); e != nil {
		t.Fatal(e)
	}
	next := physicalObject(t, s, id)
	if next.Storage == old.Storage || next.Generation != 0 {
		t.Fatal("physical identity was reused")
	}
	if e := s.deleteGeneration(ctx, old); e != nil {
		t.Fatal(e)
	}
	got, _, e := s.GetObject(ctx, id)
	if e != nil || !bytes.Equal(got, data) {
		t.Fatal("stale delete removed the new object", e)
	}
	// The old in-memory worker also must not consume a newer deletion task with the same public ID.
	if _, e = s.Pool.Exec(ctx, "UPDATE objects SET state='deleting' WHERE vault_id=$1 AND id=$2", s.Config.VaultID, id); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Pool.Exec(ctx, "INSERT INTO object_gc_jobs(vault_id,object_id,generation,storage_token) VALUES($1,$2,$3,$4)", s.Config.VaultID, id, next.Generation, next.Storage); e != nil {
		t.Fatal(e)
	}
	if e = s.deleteGeneration(ctx, old); e != nil {
		t.Fatal(e)
	}
	if scalar(t, s, "SELECT count(*) FROM object_gc_jobs WHERE vault_id=$1", s.Config.VaultID) != 1 {
		t.Fatal("stale worker consumed the newer task")
	}
	path, _ := s.generationPath(id, next.Generation, next.Storage)
	if _, e = os.Stat(path); e != nil {
		t.Fatal("new physical bytes removed")
	}
	if e = s.deleteGeneration(ctx, next); e != nil {
		t.Fatal(e)
	}
	if scalar(t, s, "SELECT count(*) FROM objects WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("new identity not retired")
	}
}

func TestLatePublisherIsFencedBeforeCreatingUntrackedFiles(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	data := []byte("late ciphertext")
	id, digest := addressedBytes(data)
	reserved, resume := make(chan struct{}), make(chan struct{})
	result := make(chan error, 1)
	s.Fault = func(point string) error {
		if point == "after-object-reserve" {
			close(reserved)
			<-resume
		}
		return nil
	}
	go func() { result <- s.PutObject(ctx, id, digest, data) }()
	<-reserved
	old := physicalObject(t, s, id)
	if _, e := s.Pool.Exec(ctx, "UPDATE upload_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	collectNow(t, s)
	close(resume)
	expectCode(t, <-result, "OBJECT_BUSY")
	s.Fault = nil
	path, _ := s.generationPath(id, old.Generation, old.Storage)
	if _, e := os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("late publisher created a forgotten file")
	}
	if scalar(t, s, "SELECT count(*) FROM upload_attempts WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("expired attempt leaked")
	}
	if e := s.PutObject(ctx, id, digest, data); e != nil {
		t.Fatal(e)
	}
	if _, _, e := s.GetObject(ctx, id); e != nil {
		t.Fatal(e)
	}
}

func TestSettledAddressedObjectsAndEdgesRemainBounded(t *testing.T) {
	s := contractStore(t, func(c *Config) { c.MetadataMode = "compact" })
	ctx := context.Background()
	stream := streamFor(t, s)
	var base BaseProof
	for number := int64(1); number <= 30; number++ {
		data := []byte(fmt.Sprintf("opaque ciphertext %d", number))
		id, digest := addressedBytes(data)
		if e := s.PutObject(ctx, id, digest, data); e != nil {
			t.Fatal(e)
		}
		action := createAction("F", "r", "a")
		proofs := []BaseProof{}
		if number > 1 {
			action = editAction("F", "r", base.RevisionID, "file")
			proofs = append(proofs, base)
		}
		action.Payload.Objects = []string{id}
		c := compactRequest(s, stream, number, action)
		r := tracked(t, s, c, stream, number, proofs...)
		base = r.Bases[0].Proof
		acknowledge(t, s, stream, number, r)
		policy := DefaultCleanupPolicy()
		policy.Grace = 0
		policy.LogEntries = 1
		for i := 0; i < 2; i++ {
			if _, e := s.Collect(ctx, policy); e != nil {
				t.Fatal(e)
			}
		}
		if scalar(t, s, "SELECT count(*) FROM objects WHERE vault_id=$1", s.Config.VaultID) != 1 || scalar(t, s, "SELECT count(*) FROM revision_objects WHERE vault_id=$1", s.Config.VaultID) != 1 {
			t.Fatal("settled object identities or edges grew")
		}
		if _, _, e := s.GetObject(ctx, id); e != nil {
			t.Fatal("current head content lost", e)
		}
	}
}

func TestOldObjectAdmissionIsOnceOnlyAndPreservesRandomIdentityDigest(t *testing.T) {
	s := contractStore(t, func(c *Config) { c.MetadataMode = "compact" })
	ctx := context.Background()
	stream := streamFor(t, s)
	id := strings.Repeat("a", 64)
	c := compactRequest(s, stream, 1, withObject(createAction("F", "r", "a"), id))
	_, e := s.UploadLease(ctx, "computer-a", c)
	expectCode(t, e, "LEGACY_OBJECT_UNREGISTERED")
	bundle := LegacyObjectMigration{[]Commit{c}}
	s.Fault = func(point string) error {
		if point == "after-legacy-object-registration-commit" {
			return code("lost-registration")
		}
		return nil
	}
	expectCode(t, s.RegisterLegacyObjects(ctx, "computer-a", bundle), "lost-registration")
	s = reopenRecoveryStore(t, s)
	if e = s.RegisterLegacyObjects(ctx, "computer-a", bundle); e != nil {
		t.Fatal(e)
	}
	lease, e := s.UploadLease(ctx, "computer-a", c)
	if e != nil {
		t.Fatal(e)
	}
	data := []byte("original old ciphertext")
	_, digest := addressedBytes(data)
	if e = s.putObject(ctx, "computer-a", lease, id, digest, data); e != nil {
		t.Fatal(e)
	}
	if e = s.ReleaseLease(ctx, "computer-a", lease); e != nil {
		t.Fatal(e)
	}
	collectNow(t, s)
	if scalar(t, s, "SELECT count(*) FROM objects WHERE vault_id=$1 AND state='deleted'", s.Config.VaultID) != 1 {
		t.Fatal("old immutable identity evidence forgotten")
	}
	if e = s.putObject(ctx, "", "", id, digest, data); e != nil {
		t.Fatal(e)
	}
	wrong := []byte("other old ciphertext")
	_, wrongDigest := addressedBytes(wrong)
	expectCode(t, s.PutObject(ctx, id, wrongDigest, wrong), "OBJECT_IMMUTABLE")
	changed := bundle
	changed.Requests = []Commit{}
	expectCode(t, s.RegisterLegacyObjects(ctx, "computer-a", changed), "LEGACY_OBJECT_MIGRATION_CHANGED")
}

func TestObjectCapabilityIsRequiredBeforeServingAddressedState(t *testing.T) {
	s := contractStore(t)
	request := httptest.NewRequest("GET", "/handshake", nil)
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 64))
	request.Header.Set("X-Sync-Content", ContentCapability)
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != 426 {
		t.Fatal("pre-addressed client admitted")
	}
	request.Header.Set("X-Sync-Objects", ObjectCapability)
	request.Header.Set("X-Sync-Continuity", ContinuityCapability)
	response = httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal("capable client rejected")
	}
}

func TestCurrentHeadJSONRemainsTheContentRootWhenAnIndexEdgeIsMissing(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	data := []byte("current ciphertext")
	id, digest := addressedBytes(data)
	if e := s.PutObject(ctx, id, digest, data); e != nil {
		t.Fatal(e)
	}
	submit(t, s, req("head", withObject(createAction("F", "R", "a"), id)))
	if _, e := s.Pool.Exec(ctx, "DELETE FROM revision_objects WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	if e := s.AuditHeads(ctx); e != nil {
		t.Fatal(e)
	}
	collectNow(t, s)
	if _, _, e := s.GetObject(ctx, id); e != nil {
		t.Fatal("missing derived edge allowed current content retirement", e)
	}
	if _, e := s.Pool.Exec(ctx, "DELETE FROM objects WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	expectCode(t, s.AuditHeads(ctx), "OBJECT_CORRUPT")
}

// Runs only as a private child of the test below. Production has no crash endpoint/flag.
func TestAddressedUploadProcessHelper(t *testing.T) {
	path := os.Getenv("XSYNC_OBJECT_KILL_CONFIG")
	if path == "" {
		t.Skip("isolated child helper")
	}
	encoded, e := os.ReadFile(path)
	if e != nil {
		t.Fatal("cannot read child fixture")
	}
	var c Config
	if json.Unmarshal(encoded, &c) != nil || !strings.Contains(c.DSN, "127.0.0.1:55438/obsidiansync") || !regexp.MustCompile(`search_path=contract_[a-f0-9]{16}($|&)`).MatchString(c.DSN) {
		t.Fatal("refusing non-isolated database")
	}
	s, e := Open(context.Background(), c)
	if e != nil {
		t.Fatal("child store unavailable")
	}
	defer s.Pool.Close()
	point := os.Getenv("XSYNC_OBJECT_KILL_POINT")
	s.Fault = func(at string) error {
		if at == point {
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		}
		return nil
	}
	data := []byte("public addressed SIGKILL fixture")
	id, digest := addressedBytes(data)
	_ = s.PutObject(context.Background(), id, digest, data)
	t.Fatal("expected object publication fault was not reached")
}

func TestAddressedUploadSurvivesActualProcessKills(t *testing.T) {
	for _, point := range []string{"after-object-reserve", "after-object-fsync", "after-object-publish", "after-object-finalize"} {
		t.Run(point, func(t *testing.T) {
			s := contractStore(t)
			ctx := context.Background()
			encoded, e := json.Marshal(s.Config)
			if e != nil {
				t.Fatal(e)
			}
			config := filepath.Join(t.TempDir(), "child.json")
			if e = os.WriteFile(config, encoded, 0600); e != nil {
				t.Fatal(e)
			}
			binary, e := os.Executable()
			if e != nil {
				t.Fatal(e)
			}
			childCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			command := exec.CommandContext(childCtx, binary, "-test.run=^TestAddressedUploadProcessHelper$")
			command.Env = append(os.Environ(), "XSYNC_OBJECT_KILL_CONFIG="+config, "XSYNC_OBJECT_KILL_POINT="+point)
			e = command.Run()
			exit, ok := e.(*exec.ExitError)
			if !ok || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
				t.Fatal("child did not reach the requested SIGKILL boundary")
			}
			s = reopenRecoveryStore(t, s)
			data := []byte("public addressed SIGKILL fixture")
			id, digest := addressedBytes(data)
			if point != "after-object-finalize" {
				_, _, e = s.GetObject(ctx, id)
				expectCode(t, e, "OBJECT_MISSING")
			}
			if e = s.PutObject(ctx, id, digest, data); e != nil {
				t.Fatal(e)
			}
			submit(t, s, req("current", withObject(createAction("F", "R", "a"), id)))
			if _, e = s.Pool.Exec(ctx, "UPDATE upload_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE vault_id=$1", s.Config.VaultID); e != nil {
				t.Fatal(e)
			}
			collectNow(t, s)
			got, _, e := s.GetObject(ctx, id)
			if e != nil || !bytes.Equal(got, data) {
				t.Fatal("recovered current ciphertext lost", e)
			}
			files, e := os.ReadDir(filepath.Join(s.Config.ObjectDir, s.Config.VaultID))
			if e != nil {
				t.Fatal(e)
			}
			if len(files) != 1 || scalar(t, s, "SELECT count(*) FROM upload_attempts WHERE vault_id=$1", s.Config.VaultID) != 0 {
				t.Fatal("known orphan files/attempts leaked")
			}
		})
	}
}
