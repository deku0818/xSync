package syncstore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type eventHint struct {
	Type  string `json:"type"`
	Epoch string `json:"epoch"`
	Seq   int64  `json:"seq"`
}
type eventTicket struct {
	device  string
	expires time.Time
}
type eventHub struct {
	mu        sync.Mutex
	tickets   map[string]eventTicket
	listeners map[chan eventHint]bool
	closed    bool
}

func newEventHub() *eventHub {
	return &eventHub{tickets: map[string]eventTicket{}, listeners: map[chan eventHint]bool{}}
}
func (h *eventHub) ticket(device string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	for t, v := range h.tickets {
		if now.After(v.expires) {
			delete(h.tickets, t)
		}
	}
	if h.closed || len(h.tickets) >= 256 {
		return "", code("EVENTS_UNAVAILABLE")
	}
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	ticket := hex.EncodeToString(b)
	h.tickets[ticket] = eventTicket{device, now.Add(time.Minute)}
	return ticket, nil
}
func (h *eventHub) consume(ticket string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	v, ok := h.tickets[ticket]
	delete(h.tickets, ticket)
	return ok && !h.closed && v.device != "" && time.Now().Before(v.expires)
}
func (h *eventHub) subscribe() (chan eventHint, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch := make(chan eventHint, 1)
	if h.closed {
		close(ch)
		return ch, func() {}
	}
	h.listeners[ch] = true
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.listeners[ch] {
			delete(h.listeners, ch)
			close(ch)
		}
	}
}
func (h *eventHub) publish(r Receipt) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.listeners {
		hint := eventHint{"changed", r.Epoch, r.Seq}
		// Coalesce hints only. HTTP changes remain authoritative and never share this lossy queue.
		select {
		case ch <- hint:
		default:
			select {
			case <-ch:
			default:
			}
			ch <- hint
		}
	}
}
func (s *Store) CloseEvents() {
	h := s.events
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	h.tickets = map[string]eventTicket{}
	for ch := range h.listeners {
		close(ch)
		delete(h.listeners, ch)
	}
}
func (s *Store) eventsHandler(w http.ResponseWriter, r *http.Request) {
	// Ticket is sent in the first frame, never in URLs, browser history, or access logs.
	origin := r.Header.Get("Origin")
	if origin != "" && origin != "app://obsidian.md" && origin != "capacitor://localhost" && origin != "http://"+r.Host && origin != "https://"+r.Host {
		writeError(w, code("UNAUTHORIZED"))
		return
	}
	conn, e := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if e != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1024)
	authCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	typ, body, e := conn.Read(authCtx)
	cancel()
	var auth struct {
		Ticket string `json:"ticket"`
	}
	if e != nil || typ != websocket.MessageText || json.Unmarshal(body, &auth) != nil || !s.events.consume(auth.Ticket) {
		_ = conn.Close(websocket.StatusPolicyViolation, "invalid event ticket")
		return
	}
	notifications, unsubscribe := s.events.subscribe()
	defer unsubscribe()
	ctx := conn.CloseRead(context.Background())
	var epoch string
	var seq int64
	if e = s.Pool.QueryRow(ctx, "SELECT epoch,seq FROM vaults WHERE id=$1", s.Config.VaultID).Scan(&epoch, &seq); e != nil {
		return
	}
	send := func(h eventHint) error {
		data, err := json.Marshal(h)
		if err != nil {
			return err
		}
		writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
		defer done()
		return conn.Write(writeCtx, websocket.MessageText, data)
	}
	if e = send(eventHint{"ready", epoch, seq}); e != nil {
		return
	}
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case hint, ok := <-notifications:
			if !ok {
				return
			}
			if e = send(hint); e != nil {
				return
			}
		case <-ticker.C:
			pingCtx, done := context.WithTimeout(ctx, 5*time.Second)
			e = conn.Ping(pingCtx)
			done()
			if e != nil {
				return
			}
		}
	}
}
