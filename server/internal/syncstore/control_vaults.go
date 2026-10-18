package syncstore

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"strings"
)

func (m *ManagedServer) Vaults(ctx context.Context, user string) ([]ManagedVault, error) {
	rows, e := m.Pool.Query(ctx, `SELECT v.id,o.name,u.id,u.name,v.epoch,v.key_package,(SELECT count(*) FROM devices d WHERE d.vault_id=v.id AND d.revoked_at IS NULL),u.active FROM vaults v JOIN vault_owners o ON o.vault_id=v.id JOIN sync_users u ON u.id=o.user_id WHERE u.deleted_at IS NULL AND ($1='' OR u.id=$1) ORDER BY o.name,v.id`, user)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []ManagedVault{}
	for rows.Next() {
		var v ManagedVault
		if e = rows.Scan(&v.ID, &v.Name, &v.UserID, &v.UserName, &v.Epoch, &v.KeyPackage, &v.Devices, &v.Active); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func validKeyPackage(raw json.RawMessage, id string) bool {
	var p struct {
		Format  int    `json:"format"`
		Vault   string `json:"vaultId"`
		KDF     string `json:"kdf"`
		Memory  int    `json:"memory"`
		Ops     int    `json:"ops"`
		Salt    string `json:"salt"`
		Wrapped struct {
			V int    `json:"v"`
			N string `json:"n"`
			C string `json:"c"`
		} `json:"wrapped"`
	}
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	return len(raw) < 4096 && d.Decode(&p) == nil && p.Format == 0 && p.Vault == id && p.KDF == "Argon2id13" && p.Memory == 67108864 && p.Ops == 2 && len(p.Salt) > 0 && len(p.Salt) <= 64 && p.Wrapped.V == 0 && len(p.Wrapped.N) > 0 && len(p.Wrapped.C) > 0
}

func (m *ManagedServer) CreateVault(ctx context.Context, u User, in NewVault) (ManagedVault, error) {
	name, key, e := controlName(in.Name)
	if e != nil || !blobPattern.MatchString(in.ID) || !blobPattern.MatchString(in.Epoch) || !validKeyPackage(in.KeyPackage, in.ID) {
		return ManagedVault{}, code("INVALID_REQUEST")
	}
	tx, e := m.Pool.Begin(ctx)
	if e != nil {
		return ManagedVault{}, e
	}
	defer tx.Rollback(ctx)
	var rev int64
	if e = tx.QueryRow(ctx, "SELECT key_revision FROM sync_users WHERE id=$1 AND active AND deleted_at IS NULL FOR UPDATE", u.ID).Scan(&rev); e != nil || rev != u.Revision {
		return ManagedVault{}, code("UNAUTHORIZED")
	}
	var owner string
	var pkg []byte
	var epoch, priorName string
	e = tx.QueryRow(ctx, `SELECT o.user_id,v.key_package,v.epoch,o.name FROM vaults v JOIN vault_owners o ON o.vault_id=v.id WHERE v.id=$1`, in.ID).Scan(&owner, &pkg, &epoch, &priorName)
	if e == nil {
		a, _ := canonicalDigest(json.RawMessage(pkg))
		b, _ := canonicalDigest(in.KeyPackage)
		if owner != u.ID || a != b || epoch != in.Epoch || priorName != name {
			return ManagedVault{}, code("VAULT_EXISTS")
		}
		return ManagedVault{ID: in.ID, Name: name, UserID: u.ID, UserName: u.Name, Epoch: epoch, KeyPackage: pkg, Active: true}, nil
	}
	if e != pgx.ErrNoRows {
		return ManagedVault{}, e
	}

	if _, e = tx.Exec(ctx, "INSERT INTO vaults(id,epoch,key_package) VALUES($1,$2,$3)", in.ID, in.Epoch, in.KeyPackage); e != nil {
		return ManagedVault{}, controlError(e)
	}
	if _, e = tx.Exec(ctx, "INSERT INTO vault_owners(vault_id,user_id,name,name_key) VALUES($1,$2,$3,$4)", in.ID, u.ID, name, key); e != nil {
		return ManagedVault{}, controlError(e)
	}
	s := &Store{Pool: m.Pool, Config: Config{VaultID: in.ID, Epoch: in.Epoch}}
	if e = s.initializeProofKey(ctx, tx); e != nil {
		return ManagedVault{}, e
	}
	if e = s.initializeCompaction(ctx, tx); e != nil {
		return ManagedVault{}, e
	}
	if e = audit(ctx, tx, "用户「"+u.Name+"」创建同步库「"+name+"」"); e != nil {
		return ManagedVault{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return ManagedVault{}, e
	}
	return ManagedVault{ID: in.ID, Name: name, UserID: u.ID, UserName: u.Name, Epoch: in.Epoch, KeyPackage: in.KeyPackage, Active: true}, nil
}

func (m *ManagedServer) EnrollDevice(ctx context.Context, u User, vault, id, name, tokenHash string) error {
	name, nameKey, e := normalizedName(name)
	if e != nil || !validID(id) || !blobPattern.MatchString(tokenHash) {
		return code("INVALID_REQUEST")
	}
	tx, e := m.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var owner string
	var rev int64
	e = tx.QueryRow(ctx, `SELECT u.id,u.key_revision FROM vault_owners o JOIN sync_users u ON u.id=o.user_id WHERE o.vault_id=$1 AND u.active AND u.deleted_at IS NULL FOR UPDATE OF u`, vault).Scan(&owner, &rev)
	if e != nil || owner != u.ID || rev != u.Revision {
		return code("UNAUTHORIZED")
	}
	var revoked bool
	e = tx.QueryRow(ctx, "SELECT revoked_at IS NOT NULL FROM devices WHERE vault_id=$1 AND id=$2", vault, id).Scan(&revoked)
	if e != nil && e != pgx.ErrNoRows {
		return e
	}
	if revoked {
		return code("DEVICE_REVOKED")
	}
	_, e = tx.Exec(ctx, `INSERT INTO devices(vault_id,id,name,name_key,token_hash) VALUES($1,$2,$3,$4,decode($5,'hex')) ON CONFLICT(vault_id,id) DO UPDATE SET token_hash=excluded.token_hash`, vault, id, name, nameKey, tokenHash)
	if e != nil {
		return profileError(e)
	}
	_, e = tx.Exec(ctx, `INSERT INTO device_access(vault_id,device_id,key_revision) VALUES($1,$2,$3) ON CONFLICT(vault_id,device_id) DO UPDATE SET key_revision=excluded.key_revision`, vault, id, rev)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func (m *ManagedServer) store(ctx context.Context, id string) (*Store, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.stores[id]; s != nil {
		return s, nil
	}
	var epoch string
	var pkg []byte
	var proof []byte
	var checkpoint int64
	e := m.Pool.QueryRow(ctx, `SELECT v.epoch,v.key_package,a.secret,v.metadata_checkpoint FROM vaults v JOIN vault_owners o ON o.vault_id=v.id JOIN sync_users u ON u.id=o.user_id JOIN metadata_auth a ON a.vault_id=v.id WHERE v.id=$1 AND u.deleted_at IS NULL`, id).Scan(&epoch, &pkg, &proof, &checkpoint)
	if e != nil {
		return nil, code("VAULT_NOT_FOUND")
	}
	c := m.config
	c.Managed = true
	c.VaultID = id
	c.Epoch = epoch
	c.KeyPackage = pkg
	s := &Store{Pool: m.Pool, Config: c, compact: checkpoint >= 0, proofKey: proof, events: newEventHub()}
	m.stores[id] = s
	return s, nil
}

func (m *ManagedServer) storeForDeletion(ctx context.Context, id string) (*Store, error) {
	var epoch string
	var checkpoint int64
	e := m.Pool.QueryRow(ctx, "SELECT epoch,metadata_checkpoint FROM vaults WHERE id=$1", id).Scan(&epoch, &checkpoint)
	return &Store{Pool: m.Pool, Config: Config{VaultID: id, Epoch: epoch}, compact: checkpoint >= 0}, e
}
