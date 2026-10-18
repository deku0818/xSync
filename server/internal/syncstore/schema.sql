CREATE TABLE IF NOT EXISTS vaults (
 id text PRIMARY KEY, epoch text NOT NULL, seq bigint NOT NULL DEFAULT 0,
 min_seq bigint NOT NULL DEFAULT 0, key_package jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
 vault_id text REFERENCES vaults(id), id text, name text NOT NULL, token_hash bytea NOT NULL,
 PRIMARY KEY(vault_id,id), UNIQUE(token_hash)
);
CREATE TABLE IF NOT EXISTS objects (
 vault_id text REFERENCES vaults(id), id text, digest text NOT NULL, size bigint NOT NULL CHECK(size>=0),
 PRIMARY KEY(vault_id,id)
);
CREATE TABLE IF NOT EXISTS files (
 vault_id text REFERENCES vaults(id), id text, kind text NOT NULL, location jsonb NOT NULL, path_key text NOT NULL,
 PRIMARY KEY(vault_id,id), UNIQUE(vault_id,path_key) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS locations (
 vault_id text, id text, file_id text NOT NULL, value jsonb NOT NULL,
 PRIMARY KEY(vault_id,id), FOREIGN KEY(vault_id,file_id) REFERENCES files(vault_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS revisions (
 vault_id text, id text, file_id text NOT NULL, value jsonb NOT NULL,
 PRIMARY KEY(vault_id,id), FOREIGN KEY(vault_id,file_id) REFERENCES files(vault_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS heads (
 vault_id text, file_id text, revision_id text,
 PRIMARY KEY(vault_id,file_id,revision_id),
 FOREIGN KEY(vault_id,file_id) REFERENCES files(vault_id,id),
 FOREIGN KEY(vault_id,revision_id) REFERENCES revisions(vault_id,id)
);
CREATE TABLE IF NOT EXISTS revision_objects (
 vault_id text, revision_id text, object_id text,
 PRIMARY KEY(vault_id,revision_id,object_id),
 FOREIGN KEY(vault_id,revision_id) REFERENCES revisions(vault_id,id),
 FOREIGN KEY(vault_id,object_id) REFERENCES objects(vault_id,id)
);
CREATE TABLE IF NOT EXISTS operations (
 vault_id text, device_id text, op_id text, digest bytea NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY(vault_id,device_id,op_id), FOREIGN KEY(vault_id,device_id) REFERENCES devices(vault_id,id)
);
CREATE TABLE IF NOT EXISTS changes (
 vault_id text REFERENCES vaults(id), seq bigint, value jsonb NOT NULL,
 PRIMARY KEY(vault_id,seq)
);
CREATE TABLE IF NOT EXISTS snapshots (
 vault_id text REFERENCES vaults(id), id text, value jsonb NOT NULL,
 PRIMARY KEY(vault_id,id)
);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS name_key text;
CREATE UNIQUE INDEX IF NOT EXISTS devices_name_unique ON devices(vault_id,name_key);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS profile_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS profile_ciphertext text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS profile_reported_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS enrollment_key text NOT NULL DEFAULT '';
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS enrollment_until timestamptz;
CREATE TABLE IF NOT EXISTS enrollment_challenges (
 vault_id text REFERENCES vaults(id), id text, nonce text NOT NULL,
 expires_at timestamptz NOT NULL, accepted_digest bytea, device_id text,
 PRIMARY KEY(vault_id,id)
);
-- Revision/object identities remain immutable even after their ciphertext is retired.
ALTER TABLE objects ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ready';
ALTER TABLE objects ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
ALTER TABLE objects ADD COLUMN IF NOT EXISTS unreferenced_at timestamptz;
ALTER TABLE changes ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS content_leases (
 vault_id text REFERENCES vaults(id), id text, device_id text NOT NULL, kind text NOT NULL,
 request_key text NOT NULL, digest bytea NOT NULL, epoch text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '5 minutes'),
 PRIMARY KEY(vault_id,id), UNIQUE(vault_id,device_id,kind,request_key),
 FOREIGN KEY(vault_id,device_id) REFERENCES devices(vault_id,id)
);
CREATE TABLE IF NOT EXISTS lease_objects (
 vault_id text, lease_id text, object_id text, generation bigint,
 PRIMARY KEY(vault_id,lease_id,object_id),
 FOREIGN KEY(vault_id,lease_id) REFERENCES content_leases(vault_id,id) ON DELETE CASCADE
);
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS lease_id text;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS device_id text;
CREATE TABLE IF NOT EXISTS object_gc_jobs (
 vault_id text, object_id text, generation bigint,
 PRIMARY KEY(vault_id,object_id,generation),
 FOREIGN KEY(vault_id,object_id) REFERENCES objects(vault_id,id)
);
CREATE TABLE IF NOT EXISTS upload_attempts (
 vault_id text REFERENCES vaults(id), id text, object_id text NOT NULL, generation bigint NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '5 minutes'),
 PRIMARY KEY(vault_id,id)
);
CREATE INDEX IF NOT EXISTS content_leases_expiry ON content_leases(vault_id,expires_at);
CREATE INDEX IF NOT EXISTS lease_objects_lookup ON lease_objects(vault_id,object_id);
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS proof_key_initialized boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS metadata_auth (
 vault_id text PRIMARY KEY REFERENCES vaults(id), secret bytea NOT NULL CHECK(octet_length(secret)=32)
);
CREATE TABLE IF NOT EXISTS request_streams (
 vault_id text, device_id text, id text NOT NULL, maximum bigint NOT NULL DEFAULT 0, retired bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(vault_id,device_id), UNIQUE(vault_id,id),
 FOREIGN KEY(vault_id,device_id) REFERENCES devices(vault_id,id)
);
CREATE TABLE IF NOT EXISTS tracked_operations (
 vault_id text, device_id text, stream_id text, number bigint CHECK(number>0), op_id text NOT NULL,
 digest bytea NOT NULL, result jsonb NOT NULL, acknowledged boolean NOT NULL DEFAULT false,
 PRIMARY KEY(vault_id,device_id,stream_id,number), UNIQUE(vault_id,device_id,op_id)
);
CREATE TABLE IF NOT EXISTS acknowledged_ranges (
 vault_id text, device_id text, stream_id text, first bigint, last bigint CHECK(last>=first),
 PRIMARY KEY(vault_id,device_id,stream_id,first)
);
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS metadata_checkpoint bigint NOT NULL DEFAULT -1;
ALTER TABLE operations ADD COLUMN IF NOT EXISTS legacy boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS legacy_revisions (
 vault_id text REFERENCES vaults(id), id text, file_id text NOT NULL, digest text NOT NULL,
 PRIMARY KEY(vault_id,id)
);
CREATE TABLE IF NOT EXISTS legacy_locations (
 vault_id text REFERENCES vaults(id), id text, PRIMARY KEY(vault_id,id)
);
CREATE TABLE IF NOT EXISTS legacy_migrations (
 vault_id text, device_id text, digest text NOT NULL, PRIMARY KEY(vault_id,device_id),
 FOREIGN KEY(vault_id,device_id) REFERENCES devices(vault_id,id)
);
CREATE TABLE IF NOT EXISTS legacy_intents (
 vault_id text, device_id text, op_id text, digest bytea NOT NULL, PRIMARY KEY(vault_id,device_id,op_id),
 FOREIGN KEY(vault_id,device_id) REFERENCES devices(vault_id,id)
);
CREATE TABLE IF NOT EXISTS change_revisions (
 vault_id text, seq bigint, revision_id text, PRIMARY KEY(vault_id,seq,revision_id),
 FOREIGN KEY(vault_id,seq) REFERENCES changes(vault_id,seq) ON DELETE CASCADE
);
ALTER TABLE objects ADD COLUMN IF NOT EXISTS storage_token text NOT NULL DEFAULT '';
ALTER TABLE lease_objects ADD COLUMN IF NOT EXISTS storage_token text;
ALTER TABLE object_gc_jobs ADD COLUMN IF NOT EXISTS storage_token text NOT NULL DEFAULT '';
ALTER TABLE upload_attempts ADD COLUMN IF NOT EXISTS storage_token text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS legacy_object_migrations (
 vault_id text, device_id text, digest text NOT NULL, PRIMARY KEY(vault_id,device_id),
 FOREIGN KEY(vault_id,device_id) REFERENCES devices(vault_id,id)
);
CREATE TABLE IF NOT EXISTS legacy_object_intents (
 vault_id text, device_id text, op_id text, digest bytea NOT NULL, PRIMARY KEY(vault_id,device_id,op_id),
 FOREIGN KEY(vault_id,device_id) REFERENCES devices(vault_id,id)
);
CREATE TABLE IF NOT EXISTS device_continuity (
 vault_id text, device_id text, token text NOT NULL,
 PRIMARY KEY(vault_id,device_id), FOREIGN KEY(vault_id,device_id) REFERENCES devices(vault_id,id)
);

-- Frozen snapshots are assembled in bounded batches rather than one large JSON value.
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS paged boolean NOT NULL DEFAULT false;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS entry_count bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS snapshot_items (
 vault_id text NOT NULL, snapshot_id text NOT NULL, position bigint NOT NULL, kind text NOT NULL, value jsonb NOT NULL,
 PRIMARY KEY(vault_id,snapshot_id,position),
 FOREIGN KEY(vault_id,snapshot_id) REFERENCES snapshots(vault_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS snapshot_item_file_lookup ON snapshot_items(vault_id,snapshot_id,(value->>'id')) WHERE kind='files';

-- The control plane owns users; cryptographic material remains independent of access credentials.
CREATE TABLE IF NOT EXISTS sync_users (
 id text PRIMARY KEY, name text NOT NULL, name_key text NOT NULL UNIQUE,
 key_hash bytea UNIQUE, key_tail text NOT NULL, key_revision bigint NOT NULL DEFAULT 1,
 active boolean NOT NULL DEFAULT true, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vault_owners (
 vault_id text PRIMARY KEY REFERENCES vaults(id), user_id text NOT NULL REFERENCES sync_users(id),
 name text NOT NULL, name_key text NOT NULL, UNIQUE(user_id,name_key)
);
CREATE TABLE IF NOT EXISTS device_access (
 vault_id text NOT NULL, device_id text NOT NULL, key_revision bigint NOT NULL,
 PRIMARY KEY(vault_id,device_id), FOREIGN KEY(vault_id,device_id) REFERENCES devices(vault_id,id)
);
CREATE TABLE IF NOT EXISTS admin_sessions (
 token_hash bytea PRIMARY KEY, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), message text NOT NULL
);
