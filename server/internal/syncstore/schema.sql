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
