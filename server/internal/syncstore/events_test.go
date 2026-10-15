package syncstore

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestEventTicketsAndDurableHints(t *testing.T) {
	s := contractStore(t)
	defer s.CloseEvents()
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, _ := http.NewRequest("POST", server.URL+"/events/tickets", nil)
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 64))
	response, e := http.DefaultClient.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	var auth struct {
		Ticket string `json:"ticket"`
	}
	e = json.NewDecoder(response.Body).Decode(&auth)
	response.Body.Close()
	if e != nil || len(auth.Ticket) != 48 {
		t.Fatal("missing ticket")
	}
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/events"
	headers := http.Header{"Origin": []string{"app://obsidian.md"}}
	conn, _, e := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: headers})
	if e != nil {
		t.Fatal(e)
	}
	defer conn.CloseNow()
	body, _ := json.Marshal(auth)
	if e = conn.Write(ctx, websocket.MessageText, body); e != nil {
		t.Fatal(e)
	}
	read := func() eventHint {
		t.Helper()
		_, b, e := conn.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		var hint eventHint
		if e = json.Unmarshal(b, &hint); e != nil {
			t.Fatal(e)
		}
		return hint
	}
	if hint := read(); hint.Type != "ready" || hint.Seq != 0 {
		t.Fatal("invalid ready boundary")
	}
	submit(t, s, req("create", createAction("F", "A", "a")))
	if hint := read(); hint.Type != "changed" || hint.Seq != 1 {
		t.Fatal("missing commit hint")
	}
	s.Fault = func(point string) error {
		if point == "after-sql-commit" {
			return code("lost-response")
		}
		return nil
	}
	_, e = s.Commit(ctx, req("edit", editAction("F", "B", "A", "file")))
	expectCode(t, e, "lost-response")
	s.Fault = nil
	if hint := read(); hint.Seq != 2 {
		t.Fatal("lost receipt suppressed durable notification")
	}
	changes, e := s.Pull(ctx, "epoch-1", 0)
	if e != nil || len(changes) != 2 {
		t.Fatal("HTTP history not authoritative")
	}
	replay, _, e := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: headers})
	if e != nil {
		t.Fatal(e)
	}
	defer replay.CloseNow()
	_ = replay.Write(ctx, websocket.MessageText, body)
	_, _, e = replay.Read(ctx)
	if websocket.CloseStatus(e) != websocket.StatusPolicyViolation {
		t.Fatal("reused ticket accepted")
	}
	_, resp, e := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"https://untrusted.example"}}})
	if e == nil || resp == nil || resp.StatusCode != 401 {
		t.Fatal("untrusted browser origin accepted")
	}
}
func TestEventHubCoalescingAndDisconnect(t *testing.T) {
	h := newEventHub()
	ch, remove := h.subscribe()
	for i := int64(1); i <= 1000; i++ {
		h.publish(Receipt{"E", i, "op"})
	}
	if hint := <-ch; hint.Seq != 1000 {
		t.Fatal("hint queue did not coalesce")
	}
	remove()
	remove()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, done := h.subscribe(); h.publish(Receipt{"E", 1001, "op"}); done() }()
	}
	wg.Wait()
	ticket, e := h.ticket("device")
	if e != nil {
		t.Fatal(e)
	}
	h.mu.Lock()
	h.tickets[ticket] = eventTicket{"device", time.Now().Add(-time.Second)}
	h.mu.Unlock()
	if h.consume(ticket) {
		t.Fatal("expired ticket accepted")
	}
}
