import sodium from "libsodium-wrappers-sumo";

/** Probe with public fixtures only. Does NOT define the product's key package/AEAD format. */
export async function cryptoProbe(): Promise<Record<string, unknown>> {
  const start = performance.now();
  await sodium.ready;
  const initializationMs = performance.now() - start;
  const password = new TextEncoder().encode("obsidian-sync-public-probe-password");
  const salt = new Uint8Array(sodium.crypto_pwhash_SALTBYTES).fill(7);
  const kdfStart = performance.now();
  const key = sodium.crypto_pwhash(32, password, salt, 2, 64 * 1024 * 1024, sodium.crypto_pwhash_ALG_ARGON2ID13);
  const kdfMs = performance.now() - kdfStart;
  try {
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const aad = "public-probe-aad";
    const message = "synthetic probe content";
    const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(message, aad, null, nonce, key);
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, cipher, aad, nonce, key, "text");
    if (plain !== message) throw new Error("AEAD roundtrip mismatch");
    const rejects = (data: Uint8Array, auth: string, k: Uint8Array) => {
      try { sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, data, auth, nonce, k); return false; }
      catch { return true; }
    };
    const wrongKey = new Uint8Array(key); wrongKey[0] = wrongKey[0]! ^ 1;
    const damaged = new Uint8Array(cipher); damaged[0] = damaged[0]! ^ 1;
    const wrongKeyRejected = rejects(cipher, aad, wrongKey);
    const corruptRejected = rejects(damaged, aad, key);
    const aadRejected = rejects(cipher, "different-aad", key);
    sodium.memzero(wrongKey);
    if (!wrongKeyRejected || !corruptRejected || !aadRejected) throw new Error("AEAD accepted invalid input");
    return {
      initializationMs, kdfMs, algorithm: "Argon2id13", memoryBytes: 64 * 1024 * 1024, opsLimit: 2,
      roundtrip: true, wrongKeyRejected, corruptRejected, aadRejected,
      backend: "libsodium default (WASM/JS fallback not distinguished)",
    };
  } finally { sodium.memzero(key); sodium.memzero(password); }
}
