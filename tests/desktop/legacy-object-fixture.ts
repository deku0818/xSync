import sodium from "libsodium-wrappers-sumo";
import { canonical } from "../../protocol/src/model";
import { randomId, type SessionMaterial } from "../../plugin/src/sync/crypto";

/** Only compatibility fixtures produce v0 objects; production always captures v1. */
export async function legacyObject(session: SessionMaterial, plaintext: Uint8Array, id = randomId()) {
  await sodium.ready;
  const key = sodium.from_hex(session.content), nonce = sodium.randombytes_buf(24);
  try {
    const context = { purpose: "object-v0", vaultId: session.vaultId, keyEpoch: 1, blobId: id };
    const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, canonical(context), null, nonce, key);
    const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
    return { id, bytes: new TextEncoder().encode(JSON.stringify({ v: 0, n: b64(nonce), c: b64(encrypted) })) };
  } finally { sodium.memzero(key); }
}
