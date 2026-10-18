package syncstore

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"log"
	"net/netip"
	"sync"
	"time"
	"unicode/utf8"
)

type ManagedServer struct {
	Pool           *pgxpool.Pool
	config         Config
	password       [32]byte
	mu             sync.Mutex
	stores         map[string]*Store
	attempts       map[string]loginAttempt
	trustedProxies []netip.Prefix
}
type loginAttempt struct {
	at    time.Time
	count int
}
type User struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Active   bool   `json:"active"`
	KeyTail  string `json:"keyTail"`
	Revision int64  `json:"keyRevision"`
	Vaults   int    `json:"vaults"`
}
type ManagedVault struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	UserID     string          `json:"userId"`
	UserName   string          `json:"userName"`
	Epoch      string          `json:"epoch"`
	KeyPackage json.RawMessage `json:"keyPackage"`
	Devices    int             `json:"devices"`
	Active     bool            `json:"active"`
}
type NewVault struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Epoch      string          `json:"epoch"`
	KeyPackage json.RawMessage `json:"keyPackage"`
}

func NewManagedServer(ctx context.Context, c Config, password string) (*ManagedServer, error) {
	if utf8.RuneCountInString(password) < 12 {
		return nil, errors.New("XSYNC_ADMIN_PASSWORD must contain at least 12 characters")
	}
	if c.VaultID != "" || c.Epoch != "" || len(c.KeyPackage) > 0 || len(c.Devices) > 0 {
		return nil, errors.New("managed mode requires a fresh server configuration without vault credentials")
	}
	if c.ObjectDir == "" {
		return nil, code("INVALID_CONFIG")
	}
	trustedProxies := make([]netip.Prefix, 0, len(c.TrustedProxies))
	for _, value := range c.TrustedProxies {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			return nil, errors.New("invalid trusted proxy CIDR")
		}
		trustedProxies = append(trustedProxies, prefix.Masked())
	}
	p, e := pgxpool.New(ctx, c.DSN)
	if e != nil {
		return nil, e
	}
	if _, e = p.Exec(ctx, schema); e != nil {
		p.Close()
		return nil, e
	}
	var old bool
	if e = p.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM vaults v WHERE NOT EXISTS(SELECT 1 FROM vault_owners o WHERE o.vault_id=v.id))`).Scan(&old); e != nil || old {
		p.Close()
		return nil, errors.New("managed mode requires an empty database; legacy vault migration is not supported")
	}
	if _, e = p.Exec(ctx, "DELETE FROM admin_sessions"); e != nil {
		p.Close()
		return nil, e
	}
	return &ManagedServer{Pool: p, config: c, password: sha256.Sum256([]byte(password)), stores: map[string]*Store{}, attempts: map[string]loginAttempt{}, trustedProxies: trustedProxies}, nil
}

func (m *ManagedServer) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.stores {
		s.CloseEvents()
	}
	m.Pool.Close()
}

func (m *ManagedServer) Maintain(ctx context.Context) {
	audited := map[string]bool{}
	run := func() {
		if e := m.purgeDeleted(ctx); e != nil && ctx.Err() == nil {
			log.Print("deleted user cleanup pending; will retry")
		}
		vaults, e := m.Vaults(ctx, "")
		if e != nil {
			return
		}
		for _, v := range vaults {
			if ctx.Err() != nil {
				return
			}
			s, e := m.store(ctx, v.ID)
			if e != nil {
				continue
			}
			if !audited[v.ID] {
				if e = s.AuditHeads(ctx); e != nil {
					log.Print("vault cleanup refused: object audit failed")
					continue
				}
				audited[v.ID] = true
			}
			if _, e = s.Collect(ctx, DefaultCleanupPolicy()); e != nil && ctx.Err() == nil {
				log.Print("vault cleanup incomplete; will retry")
			}
		}
	}
	run()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}
