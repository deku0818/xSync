import { expect, it } from "vitest";
import { VaultCrypto, fingerprint } from "../../plugin/src/sync/crypto";
import { objectIDSchema } from "../../protocol/src/objects";
import { legacyObject } from "./legacy-object-fixture";

it("addresses randomized v1 ciphertext with independent SHA256 while keeping its identity out of AEAD context", async () => {
  const keys = (await VaultCrypto.create("vault", "public-format-test")).crypto;
  try {
    const bytes = new TextEncoder().encode("same content"), a = keys.object(bytes), b = keys.object(bytes);
    expect(a.id).toBe(`c_${await fingerprint(a.bytes)}`); expect(a.id).not.toBe(b.id);
    expect(JSON.parse(new TextDecoder().decode(a.bytes)).v).toBe(1);
    expect(keys.decryptObject(a.id, a.bytes)).toEqual(bytes);
    expect(() => keys.decryptObject(b.id, a.bytes)).toThrow("OBJECT_DIGEST_MISMATCH");
    const changed = a.bytes.slice(); changed[changed.length - 5] = changed[changed.length - 5]! ^ 1;
    const forgedID = `c_${await fingerprint(changed)}`;
    expect(() => keys.decryptObject(forgedID, changed)).toThrow();
  } finally { keys.close(); }
});
it("reads genuine v0 ciphertext and refuses format promotion or downgrade by changing only the object ID", async () => {
  const keys = (await VaultCrypto.create("vault", "public-legacy-test")).crypto;
  try {
    const bytes = new TextEncoder().encode("captured before the upgrade"), old = await legacyObject(keys.sessionMaterial(), bytes), current = keys.object(bytes);
    expect(keys.decryptObject(old.id, old.bytes)).toEqual(bytes);
    expect(() => keys.decryptObject(`c_${"0".repeat(64)}`, old.bytes)).toThrow();
    const promoted = `c_${await fingerprint(old.bytes)}`;
    expect(() => keys.decryptObject(promoted, old.bytes)).toThrow();
    expect(() => keys.decryptObject(current.id.slice(2), current.bytes)).toThrow();
    for (const id of ["../outside", "c_" + "a".repeat(63), "c_" + "A".repeat(64), "c_" + "a".repeat(64) + "/x"]) expect(objectIDSchema.safeParse(id).success).toBe(false);
  } finally { keys.close(); }
});
it("binds v1 objects to the vault/key and authenticates the addressed IDs in the revision manifest", async () => {
  const a = (await VaultCrypto.create("A", "public-a")).crypto, b = (await VaultCrypto.create("B", "public-b")).crypto;
  try {
    const bytes = new TextEncoder().encode("protected"), object = a.object(bytes);
    expect(() => b.decryptObject(object.id, object.bytes)).toThrow();
    const base = { id: "R", fileId: "F", parents: [], deviceId: "D" };
    const revision = { ...base, payload: await a.payload(base, bytes, "file", [object.id]) };
    expect(a.manifest(revision).fingerprint).toBe(await fingerprint(bytes));
    expect(() => a.manifest({ ...revision, payload: { ...revision.payload, objects: [a.object(bytes).id] } })).toThrow();
  } finally { a.close(); b.close(); }
});
