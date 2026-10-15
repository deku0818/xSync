package syncstore

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func enrollmentStore(t *testing.T) (*Store, ed25519.PrivateKey) {
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	s := contractStore(t, func(c *Config) { c.Devices = nil; c.EnrollmentPublicKey = hex.EncodeToString(public) })
	return s, private
}
func signedEnrollment(t *testing.T, s *Store, key ed25519.PrivateKey, id, name, token string) Enrollment {
	t.Helper()
	challenge, e := s.NewChallenge(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	hash := sha256.Sum256([]byte(token))
	in := Enrollment{1, s.Config.VaultID, s.Config.Epoch, challenge, id, name, hex.EncodeToString(hash[:]), ""}
	in.Signature = hex.EncodeToString(ed25519.Sign(key, enrollmentMessage(in)))
	return in
}
func TestEnrollmentLostReceiptRestartAndRevocation(t *testing.T) {
	s, key := enrollmentStore(t)
	ctx := context.Background()
	token := strings.Repeat("c", 64)
	in := signedEnrollment(t, s, key, "new-phone", "手机 <&> 😀", token)
	if e := s.Enroll(ctx, in); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Authorize(ctx, token); e != nil {
		t.Fatal(e)
	}
	// Successful receipts remain retriable even after expiry and closing the window.
	if _, e := s.Pool.Exec(ctx, "UPDATE enrollment_challenges SET expires_at=clock_timestamp()-interval '1 day'"); e != nil {
		t.Fatal(e)
	}
	if e := s.Enroll(ctx, in); e != nil {
		t.Fatal(e)
	}
	altered := in
	altered.Name = "different"
	altered.Signature = hex.EncodeToString(ed25519.Sign(key, enrollmentMessage(altered)))
	expectCode(t, s.Enroll(ctx, altered), "ENROLLMENT_REPLAY")
	_, e := s.NewChallenge(ctx)
	expectCode(t, e, "ENROLLMENT_CLOSED")
	if e := s.RevokeDevice(ctx, in.DeviceID); e != nil {
		t.Fatal(e)
	}
	expectCode(t, s.Enroll(ctx, in), "DEVICE_REVOKED")
	reopened, e := Open(ctx, s.Config)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Pool.Close()
	_, e = reopened.Authorize(ctx, token)
	expectCode(t, e, "UNAUTHORIZED")
	if e = reopened.OpenEnrollment(ctx, time.Minute); e != nil {
		t.Fatal(e)
	}
	blocked := signedEnrollment(t, reopened, key, in.DeviceID, in.Name, strings.Repeat("d", 64))
	expectCode(t, reopened.Enroll(ctx, blocked), "DEVICE_REVOKED")
}
func TestEnrollmentTamperExpiryAndConcurrentNames(t *testing.T) {
	s, key := enrollmentStore(t)
	ctx := context.Background()
	in := signedEnrollment(t, s, key, "one", "电脑 A", strings.Repeat("a", 64))
	altered := in
	altered.TokenHash = strings.Repeat("b", 64)
	expectCode(t, s.Enroll(ctx, altered), "UNAUTHORIZED")
	altered = in
	altered.Epoch = "wrong"
	expectCode(t, s.Enroll(ctx, altered), "INVALID_REQUEST")
	_, e := s.Pool.Exec(ctx, "UPDATE enrollment_challenges SET expires_at=clock_timestamp()-interval '1 second'")
	if e != nil {
		t.Fatal(e)
	}
	expectCode(t, s.Enroll(ctx, in), "ENROLLMENT_EXPIRED")
	if e = s.OpenEnrollment(ctx, time.Minute); e != nil {
		t.Fatal(e)
	}
	a := signedEnrollment(t, s, key, "a", "Ａ", strings.Repeat("a", 64))
	b := signedEnrollment(t, s, key, "b", "a", strings.Repeat("b", 64))
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for _, request := range []Enrollment{a, b} {
		wg.Add(1)
		go func(in Enrollment) { defer wg.Done(); errors <- s.Enroll(ctx, in) }(request)
	}
	wg.Wait()
	close(errors)
	passed, rejected := 0, 0
	for e := range errors {
		if e == nil {
			passed++
		} else if e.Error() == "DEVICE_NAME_TAKEN" {
			rejected++
		} else {
			t.Fatal(e)
		}
	}
	if passed != 1 || rejected != 1 {
		t.Fatalf("passed=%d rejected=%d", passed, rejected)
	}
	if e = s.OpenEnrollment(ctx, 0); e != nil {
		t.Fatal(e)
	}
	_, e = s.NewChallenge(ctx)
	expectCode(t, e, "ENROLLMENT_CLOSED")
}
func TestEnrollmentRotationCannotReplayOldToken(t *testing.T) {
	s, key := enrollmentStore(t)
	ctx := context.Background()
	a := strings.Repeat("a", 64)
	b := strings.Repeat("b", 64)
	old := signedEnrollment(t, s, key, "one", "电脑", a)
	if e := s.Enroll(ctx, old); e != nil {
		t.Fatal(e)
	}
	if e := s.OpenEnrollment(ctx, time.Minute); e != nil {
		t.Fatal(e)
	}
	next := signedEnrollment(t, s, key, "one", "电脑", b)
	if e := s.Enroll(ctx, next); e != nil {
		t.Fatal(e)
	}
	_, e := s.Authorize(ctx, a)
	expectCode(t, e, "UNAUTHORIZED")
	if _, e = s.Authorize(ctx, b); e != nil {
		t.Fatal(e)
	}
	expectCode(t, s.Enroll(ctx, old), "ENROLLMENT_EXPIRED")
	if _, e = s.Authorize(ctx, b); e != nil {
		t.Fatal(e)
	}
}
func TestEnrollmentPublicSurfaceAndCapacity(t *testing.T) {
	s, _ := enrollmentStore(t)
	handler := s.Handler()
	request := httptest.NewRequest("GET", "/onboarding", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var body map[string]any
	if e := json.Unmarshal(response.Body.Bytes(), &body); e != nil {
		t.Fatal(e)
	}
	if len(body) != 5 || body["publicKey"] != s.Config.EnrollmentPublicKey {
		t.Fatal(body)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/handshake", nil))
	if response.Code != 401 {
		t.Fatal(response.Code)
	}
	for i := 0; i < 128; i++ {
		if _, e := s.NewChallenge(context.Background()); e != nil {
			t.Fatal(e)
		}
	}
	_, e := s.NewChallenge(context.Background())
	expectCode(t, e, "ENROLLMENT_BUSY")
	request = httptest.NewRequest("POST", "/enroll", strings.NewReader(`{"format":1,"format":1}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 400 {
		t.Fatal(response.Code)
	}
}

func TestFirstEnrollmentSerialGate(t *testing.T) {
	s, key := enrollmentStore(t)
	ctx := context.Background()
	a := signedEnrollment(t, s, key, "a", "电脑", strings.Repeat("a", 64))
	b := signedEnrollment(t, s, key, "b", "手机", strings.Repeat("b", 64))
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, in := range []Enrollment{a, b} {
		wg.Add(1)
		go func(in Enrollment) { defer wg.Done(); results <- s.Enroll(ctx, in) }(in)
	}
	wg.Wait()
	close(results)
	accepted, closed := 0, 0
	for e := range results {
		if e == nil {
			accepted++
		} else if e.Error() == "ENROLLMENT_CLOSED" {
			closed++
		} else {
			t.Fatal(e)
		}
	}
	if accepted != 1 || closed != 1 {
		t.Fatalf("accepted=%d closed=%d", accepted, closed)
	}
	rows, e := s.Devices(ctx)
	if e != nil || len(rows) != 1 {
		t.Fatal("first-device gate failed", e)
	}
	if e = s.RevokeDevice(ctx, rows[0].ID); e != nil {
		t.Fatal(e)
	}
	_, e = s.NewChallenge(ctx)
	expectCode(t, e, "ENROLLMENT_CLOSED")
}
