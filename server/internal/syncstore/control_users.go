package syncstore

import (
	"context"
	"crypto/sha256"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

func controlName(name string) (string, string, error) {
	name = strings.TrimSpace(norm.NFKC.String(name))
	if name == "" || utf8.RuneCountInString(name) > 80 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", "", code("INVALID_REQUEST")
	}
	return name, cases.Fold().String(name), nil
}

func hashSecret(value string) []byte { h := sha256.Sum256([]byte(value)); return h[:] }

func controlError(e error) error {
	var pg *pgconn.PgError
	if errors.As(e, &pg) && pg.Code == "23505" {
		return code("NAME_TAKEN")
	}
	return e
}

func audit(ctx context.Context, tx pgx.Tx, message string) error {
	if _, e := tx.Exec(ctx, "INSERT INTO admin_audit(message) VALUES($1)", message); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "DELETE FROM admin_audit WHERE id NOT IN(SELECT id FROM admin_audit ORDER BY id DESC LIMIT 500)")
	return e
}

func (m *ManagedServer) Users(ctx context.Context) ([]User, error) {
	rows, e := m.Pool.Query(ctx, `SELECT u.id,u.name,u.active,u.key_tail,u.key_revision,(SELECT count(*) FROM vault_owners WHERE user_id=u.id) FROM sync_users u WHERE u.deleted_at IS NULL ORDER BY u.created_at,u.id`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	result := []User{}
	for rows.Next() {
		var u User
		if e = rows.Scan(&u.ID, &u.Name, &u.Active, &u.KeyTail, &u.Revision, &u.Vaults); e != nil {
			return nil, e
		}
		result = append(result, u)
	}
	return result, rows.Err()
}

func (m *ManagedServer) CreateUser(ctx context.Context, name string) (User, string, error) {
	name, key, e := controlName(name)
	if e != nil {
		return User{}, "", e
	}
	id, secret := opaqueID(), "xsk_"+opaqueID()
	tx, e := m.Pool.Begin(ctx)
	if e != nil {
		return User{}, "", e
	}
	defer tx.Rollback(ctx)
	_, e = tx.Exec(ctx, `INSERT INTO sync_users(id,name,name_key,key_hash,key_tail) VALUES($1,$2,$3,$4,$5)`, id, name, key, hashSecret(secret), secret[len(secret)-6:])
	if e != nil {
		return User{}, "", controlError(e)
	}
	if e = audit(ctx, tx, "创建用户「"+name+"」并生成访问 key"); e != nil {
		return User{}, "", e
	}
	if e = tx.Commit(ctx); e != nil {
		return User{}, "", e
	}
	return User{id, name, true, secret[len(secret)-6:], 1, 0}, secret, nil
}

func (m *ManagedServer) RotateKey(ctx context.Context, id string) (string, error) {
	secret := "xsk_" + opaqueID()
	tx, e := m.Pool.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	var name string
	e = tx.QueryRow(ctx, `UPDATE sync_users SET key_hash=$2,key_tail=$3,key_revision=key_revision+1 WHERE id=$1 AND deleted_at IS NULL RETURNING name`, id, hashSecret(secret), secret[len(secret)-6:]).Scan(&name)
	if e != nil {
		return "", code("USER_NOT_FOUND")
	}
	if e = audit(ctx, tx, "刷新用户「"+name+"」的访问 key，旧设备授权失效"); e != nil {
		return "", e
	}
	return secret, tx.Commit(ctx)
}

func (m *ManagedServer) SetUserActive(ctx context.Context, id string, active bool) error {
	tx, e := m.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	var name string
	if e = tx.QueryRow(ctx, "UPDATE sync_users SET active=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING name", id, active).Scan(&name); e != nil {
		return code("USER_NOT_FOUND")
	}
	action := "停用"
	if active {
		action = "恢复"
	}
	if e = audit(ctx, tx, action+"用户「"+name+"」"); e != nil {
		return e
	}
	return tx.Commit(ctx)
}

func (m *ManagedServer) access(ctx context.Context, key string) (User, error) {
	var u User
	e := m.Pool.QueryRow(ctx, "SELECT id,name,active,key_revision FROM sync_users WHERE key_hash=$1 AND deleted_at IS NULL", hashSecret(key)).Scan(&u.ID, &u.Name, &u.Active, &u.Revision)
	if e != nil {
		return u, code("UNAUTHORIZED")
	}
	if !u.Active {
		return u, code("USER_DISABLED")
	}
	return u, nil
}

func (m *ManagedServer) DeleteUser(ctx context.Context, id, name string) (bool, error) {
	tx, e := m.Pool.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	var actual string
	if e = tx.QueryRow(ctx, "SELECT name FROM sync_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", id).Scan(&actual); e != nil {
		return false, code("USER_NOT_FOUND")
	}
	if actual != name {
		return false, code("DELETE_CONFIRMATION_REQUIRED")
	}
	if _, e = tx.Exec(ctx, "UPDATE sync_users SET active=false,key_hash=NULL,deleted_at=now() WHERE id=$1", id); e != nil {
		return false, e
	}
	if e = audit(ctx, tx, "删除用户「"+actual+"」及其所属远端库"); e != nil {
		return false, e
	}
	if e = tx.Commit(ctx); e != nil {
		return false, e
	}
	return m.purgeDeleted(ctx) != nil, nil
}

// A durable user tombstone revokes access first. Interrupted data removal resumes on startup/maintenance.

func (m *ManagedServer) purgeDeleted(ctx context.Context) error {
	rows, e := m.Pool.Query(ctx, "SELECT o.vault_id FROM vault_owners o JOIN sync_users u ON u.id=o.user_id WHERE u.deleted_at IS NOT NULL")
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, id := range ids {
		s, e := m.storeForDeletion(ctx, id)
		if e != nil {
			return e
		}
		tx, e := s.locked(ctx)
		if e != nil {
			return e
		}
		if e = os.RemoveAll(filepath.Join(m.config.ObjectDir, id)); e == nil {
			e = syncDirectory(m.config.ObjectDir)
		}
		if e != nil {
			tx.Rollback(ctx)
			return e
		}
		tables := []string{"snapshot_items", "snapshots", "lease_objects", "content_leases", "tracked_operations", "acknowledged_ranges", "device_continuity", "request_streams", "legacy_intents", "legacy_migrations", "legacy_object_intents", "legacy_object_migrations", "device_access", "operations", "change_revisions", "changes", "heads", "revision_objects", "object_gc_jobs", "upload_attempts", "revisions", "locations", "files", "objects", "enrollment_challenges", "legacy_revisions", "legacy_locations", "metadata_auth", "devices", "vault_owners", "vaults"}
		for _, table := range tables {
			column := "vault_id"
			if table == "vaults" {
				column = "id"
			}
			_, e = tx.Exec(ctx, "DELETE FROM "+table+" WHERE "+column+"=$1", id)
			if e != nil {
				break
			}
		}
		if e != nil {
			tx.Rollback(ctx)
			return e
		}
		if e = tx.Commit(ctx); e != nil {
			return e
		}
		m.mu.Lock()
		if old := m.stores[id]; old != nil {
			old.CloseEvents()
			delete(m.stores, id)
		}
		m.mu.Unlock()
	}
	_, e = m.Pool.Exec(ctx, "DELETE FROM sync_users WHERE deleted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM vault_owners WHERE user_id=sync_users.id)")
	return e
}
