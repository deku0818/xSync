package syncstore

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func streamFor(t *testing.T, s *Store) RequestStream {
	t.Helper()
	stream, e := s.OpenRequestStream(context.Background(), "computer-a")
	if e != nil {
		t.Fatal(e)
	}
	return stream
}
func tracked(t *testing.T, s *Store, c Commit, stream RequestStream, number int64, bases ...BaseProof) TrackedResult {
	t.Helper()
	r, e := s.CommitTracked(context.Background(), c, RequestTracking{stream.ID, number, bases})
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func TestAcceptedBaseCertificatesBindIdentityAndOriginalRevision(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	submit(t, s, req("create", createAction("F", "A", "a")))
	snap, e := s.Snapshot(ctx)
	if e != nil {
		t.Fatal(e)
	}
	r := snap.Revisions[0]
	anchor, e := s.CertifyBase(ctx, r)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.verifyProof(anchor.Proof, "F", "A", anchor.Proof.Boundary); e != nil {
		t.Fatal(e)
	}
	bad := r
	bad.Payload.Manifest = "different"
	_, e = s.CertifyBase(ctx, bad)
	expectCode(t, e, "BASE_NOT_ACCEPTED")
	for _, change := range []func(*BaseProof){func(p *BaseProof) { p.FileID = "other" }, func(p *BaseProof) { p.Digest = opaqueID() }, func(p *BaseProof) { p.Epoch = "other" }, func(p *BaseProof) { p.Token = opaqueID() }} {
		p := anchor.Proof
		change(&p)
		expectCode(t, s.verifyProof(p, "F", "A", p.Boundary), "BASE_PROOF_INVALID")
	}
	stream := streamFor(t, s)
	edit := req("edit", editAction("F", "B", "A", "file"))
	_, e = s.CommitTracked(ctx, edit, RequestTracking{stream.ID, 1, nil})
	expectCode(t, e, "BASE_PROOF_REQUIRED")
	result := tracked(t, s, edit, stream, 1, anchor.Proof)
	if len(result.Bases) != 1 || result.Bases[0].Proof.RevisionID != "B" {
		t.Fatal("accepted revision proof missing")
	}
}

func TestTrackedAcknowledgementsPreserveHolesAndFenceRetiredRequests(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	stream := streamFor(t, s)
	c2 := req("two", createAction("F2", "B", "b"))
	two := tracked(t, s, c2, stream, 2)
	again := tracked(t, s, c2, stream, 2)
	a, _ := json.Marshal(two)
	b, _ := json.Marshal(again)
	if string(a) != string(b) {
		t.Fatal("cached tracked result changed")
	}
	wrong := c2
	wrong.OpID = "different"
	_, e := s.CommitTracked(ctx, wrong, RequestTracking{stream.ID, 2, nil})
	expectCode(t, e, "OP_ID_REUSED")
	ack := RequestAck{stream.ID, 2, c2.OpID, two.Receipt}
	if e = s.AcknowledgeRequest(ctx, "computer-a", ack); e != nil {
		t.Fatal(e)
	}
	if scalar(t, s, "SELECT retired FROM request_streams WHERE vault_id=$1 AND device_id='computer-a'", s.Config.VaultID) != 0 {
		t.Fatal("unsubmitted hole was retired")
	}
	_, e = s.CommitTracked(ctx, c2, RequestTracking{stream.ID, 2, nil})
	expectCode(t, e, "OPERATION_RETIRED")
	c1 := req("one", createAction("F1", "A", "a"))
	one := tracked(t, s, c1, stream, 1)
	invalid := RequestAck{stream.ID, 1, "wrong", one.Receipt}
	expectCode(t, s.AcknowledgeRequest(ctx, "computer-a", invalid), "REQUEST_ACK_INVALID")
	if e = s.AcknowledgeRequest(ctx, "computer-a", RequestAck{stream.ID, 1, c1.OpID, one.Receipt}); e != nil {
		t.Fatal(e)
	}
	if scalar(t, s, "SELECT retired FROM request_streams WHERE vault_id=$1 AND device_id='computer-a'", s.Config.VaultID) != 2 {
		t.Fatal("contiguous confirmed prefix not merged")
	}
	if scalar(t, s, "SELECT count(*) FROM acknowledged_ranges WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("merged ranges leaked")
	}
	// 3A deliberately retains source evidence until the later compaction migration is validated.
	if scalar(t, s, "SELECT count(*) FROM operations WHERE vault_id=$1", s.Config.VaultID) != 2 || scalar(t, s, "SELECT count(*) FROM revisions WHERE vault_id=$1", s.Config.VaultID) != 2 {
		t.Fatal("foundation prematurely compacted old metadata")
	}
}

func TestTrackedCommitAndAckRecoverAcrossStoreReopen(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	stream := streamFor(t, s)
	c := req("once", createAction("F", "A", "a"))
	s.Fault = func(point string) error {
		if point == "after-sql-commit" {
			return code("lost-result")
		}
		return nil
	}
	_, e := s.CommitTracked(ctx, c, RequestTracking{stream.ID, 1, nil})
	expectCode(t, e, "lost-result")
	s = reopenRecoveryStore(t, s)
	r := tracked(t, s, c, stream, 1)
	if scalar(t, s, "SELECT seq FROM vaults WHERE id=$1", s.Config.VaultID) != 1 {
		t.Fatal("retry duplicated revision")
	}
	s.Fault = func(point string) error {
		if point == "before-request-ack-commit" {
			return code("ack-rollback")
		}
		return nil
	}
	ack := RequestAck{stream.ID, 1, c.OpID, r.Receipt}
	expectCode(t, s.AcknowledgeRequest(ctx, "computer-a", ack), "ack-rollback")
	if scalar(t, s, "SELECT retired FROM request_streams WHERE vault_id=$1 AND device_id='computer-a'", s.Config.VaultID) != 0 {
		t.Fatal("partial acknowledgement")
	}
	s.Fault = func(point string) error {
		if point == "after-request-ack-commit" {
			return code("lost-ack")
		}
		return nil
	}
	expectCode(t, s.AcknowledgeRequest(ctx, "computer-a", ack), "lost-ack")
	s = reopenRecoveryStore(t, s)
	if e = s.AcknowledgeRequest(ctx, "computer-a", ack); e != nil {
		t.Fatal(e)
	}
	if e = s.verifyProof(r.Bases[0].Proof, "F", "A", r.Receipt.Seq); e != nil {
		t.Fatal("proof key changed after restart")
	}
}

func TestMissingInitializedProofKeyDoesNotRegenerate(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	if _, e := s.Pool.Exec(ctx, "DELETE FROM metadata_auth WHERE vault_id=$1", s.Config.VaultID); e != nil {
		t.Fatal(e)
	}
	next, e := Open(ctx, s.Config)
	if next != nil {
		next.Pool.Close()
	}
	expectCode(t, e, "PROOF_KEY_UNAVAILABLE")
	if scalar(t, s, "SELECT count(*) FROM metadata_auth WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("missing key silently replaced")
	}
}

func TestTrackedOldReceiptPrecedesBaseValidation(t *testing.T) {
	s := contractStore(t)
	ctx := context.Background()
	submit(t, s, req("a", createAction("F", "A", "a")))
	c := req("b", editAction("F", "B", "A", "file"))
	receipt := submit(t, s, c)
	stream := streamFor(t, s)
	r, e := s.CommitTracked(ctx, c, RequestTracking{stream.ID, 1, nil})
	if e != nil || r.Receipt != receipt {
		t.Fatalf("old accepted request required a base again: %v", e)
	}
}
func TestOversizedTrackedResponseRollsBackTheMutation(t *testing.T) {
	s := contractStore(t)
	stream := streamFor(t, s)
	actions := []Action{}
	for _, id := range []string{"a", "b", "c"} {
		a := createAction("F-"+id, "R-"+id, id)
		a.Payload.Manifest = strings.Repeat("<", 2<<20)
		actions = append(actions, a)
	}
	_, e := s.CommitTracked(context.Background(), req("large", actions...), RequestTracking{stream.ID, 1, nil})
	expectCode(t, e, "RESULT_TOO_LARGE")
	if scalar(t, s, "SELECT seq FROM vaults WHERE id=$1", s.Config.VaultID) != 0 || scalar(t, s, "SELECT count(*) FROM revisions WHERE vault_id=$1", s.Config.VaultID) != 0 {
		t.Fatal("oversized response left accepted mutation")
	}
}

func TestMetadataHTTPGatesAndImmutableEnvelopeValidation(t *testing.T) {
	s := contractStore(t)
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	post := func(path, body, token, content, metadata string) (int, []byte) {
		t.Helper()
		request, e := http.NewRequest("POST", server.URL+path, strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		request.Header.Set("X-Sync-Content", content)
		request.Header.Set("X-Sync-Objects", ObjectCapability)
		request.Header.Set("X-Sync-Continuity", ContinuityCapability)
		continuityToken, err := s.Continuity(context.Background(), "computer-a")
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("X-Sync-Continuity-From", continuityToken)
		request.Header.Set("X-Sync-Continuity-Next", opaqueID())
		request.Header.Set("X-Sync-Metadata", metadata)
		response, e := http.DefaultClient.Do(request)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		encoded, e := io.ReadAll(response.Body)
		if e != nil {
			t.Fatal(e)
		}
		return response.StatusCode, encoded
	}
	token := strings.Repeat("a", 64)
	for _, headers := range []struct {
		token, content, metadata string
		status                   int
	}{
		{"", ContentCapability, MetadataCapability, 401},
		{token, "", MetadataCapability, http.StatusUpgradeRequired},
		{token, ContentCapability, "", http.StatusUpgradeRequired},
	} {
		status, _ := post("/metadata/stream", "{}", headers.token, headers.content, headers.metadata)
		if status != headers.status {
			t.Fatalf("capability/auth gate: got %d, want %d", status, headers.status)
		}
	}
	status, encoded := post("/metadata/stream", "{}", token, ContentCapability, MetadataCapability)
	var stream RequestStream
	if status != 200 || json.Unmarshal(encoded, &stream) != nil {
		t.Fatal("open stream failed")
	}
	c := req("once", createAction("F", "A", "a"))
	body, e := json.Marshal(TrackedCommit{c, RequestTracking{stream.ID, 1, nil}})
	if e != nil {
		t.Fatal(e)
	}
	for _, invalid := range []string{
		strings.Replace(string(body), `"protocol":0,`, "", 1),
		strings.Replace(string(body), `"protocol":0`, `"protocol":0,"protocol":0`, 1),
		strings.Replace(string(body), `"protocol":0`, `"protocol":0,"unknown":true`, 1),
	} {
		status, _ := post("/metadata/commits", invalid, token, ContentCapability, MetadataCapability)
		if status != 400 {
			t.Fatalf("invalid tracked body accepted: %d", status)
		}
	}
	status, _ = post("/metadata/commits", string(body), strings.Repeat("b", 64), ContentCapability, MetadataCapability)
	if status != 401 {
		t.Fatal("tracked device spoof accepted")
	}
	status, _ = post("/metadata/commits", string(body), token, ContentCapability, MetadataCapability)
	if status != 200 {
		t.Fatal("valid tracked commit failed")
	}
	if scalar(t, s, "SELECT seq FROM vaults WHERE id=$1", s.Config.VaultID) != 1 {
		t.Fatal("invalid requests mutated data")
	}
}
