package syncstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func reopenRecoveryStore(t *testing.T, s *Store) *Store {
	t.Helper()
	s.Pool.Close()
	next, err := Open(context.Background(), s.Config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(next.Pool.Close)
	return next
}

func TestObjectRecoveryAcrossStoreReopen(t *testing.T) {
	for _, point := range []string{"after-object-reserve", "after-object-fsync", "after-object-publish", "after-object-finalize"} {
		t.Run(point, func(t *testing.T) {
			s := contractStore(t)
			ctx := context.Background()
			id := strings.Repeat("a", 64)
			data := []byte("synthetic ciphertext recovery fixture")
			hash := sha256.Sum256(data)
			digest := hex.EncodeToString(hash[:])
			s.Fault = func(current string) error {
				if current == point {
					return code("injected-interruption")
				}
				return nil
			}
			expectCode(t, s.PutObject(ctx, id, digest, data), "injected-interruption")
			s = reopenRecoveryStore(t, s)
			action := createAction("F", "R", "b")
			action.Payload.Objects = []string{id}
			request := req("durable-object-op", action)
			if point != "after-object-finalize" {
				_, err := s.Commit(ctx, request)
				expectCode(t, err, "OBJECT_MISSING")
			}
			if err := s.PutObject(ctx, id, digest, data); err != nil {
				t.Fatal(err)
			}
			receipt := submit(t, s, request)
			if receipt.Seq != 1 || submit(t, s, request) != receipt {
				t.Fatal("retry did not preserve the original receipt")
			}
			got, storedDigest, err := s.GetObject(ctx, id)
			if err != nil || !bytes.Equal(got, data) || storedDigest != digest {
				t.Fatalf("durable object changed: %v", err)
			}
			changed := []byte("other ciphertext")
			otherHash := sha256.Sum256(changed)
			expectCode(t, s.PutObject(ctx, id, hex.EncodeToString(otherHash[:]), changed), "OBJECT_IMMUTABLE")
		})
	}
}

func TestCommitRecoveryAcrossStoreReopen(t *testing.T) {
	for _, point := range []string{"before-sql-commit", "after-sql-commit"} {
		t.Run(point, func(t *testing.T) {
			s := contractStore(t)
			request := req("reopen-op", createAction("F", "R", "a"))
			s.Fault = func(current string) error {
				if current == point {
					return code("injected-interruption")
				}
				return nil
			}
			_, err := s.Commit(context.Background(), request)
			expectCode(t, err, "injected-interruption")
			s = reopenRecoveryStore(t, s)
			snapshot, err := s.Snapshot(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if point == "before-sql-commit" && (snapshot.Boundary != 0 || len(snapshot.Files) != 0 || len(snapshot.Revisions) != 0) {
				t.Fatal("aborted transaction leaked state")
			}
			if point == "after-sql-commit" && (snapshot.Boundary != 1 || len(snapshot.Files) != 1 || len(snapshot.Revisions) != 1) {
				t.Fatal("committed transaction disappeared")
			}
			first := submit(t, s, request)
			if first.Seq != 1 || submit(t, s, request) != first {
				t.Fatal("reopened retry duplicated a revision")
			}
		})
	}
}
