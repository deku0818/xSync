import { expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import { enrollmentMessage, enrollmentSchema } from "../../protocol/src/enrollment";
import { SYNC_FEATURES } from "../../protocol/src/wire";
import { RememberedUnlock } from "../../plugin/src/desktop/remembered-unlock";
import { enrollConnection } from "../../plugin/src/sync/enrollment";
import { VaultCrypto, randomId } from "../../plugin/src/sync/crypto";
import { Transport, type HTTPRequest } from "../../plugin/src/sync/transport";

async function fixture() {
  const vaultId = randomId(); const created = await VaultCrypto.create(vaultId,"test-only-key");
  const publicKey = created.crypto.enrollmentPublicKey(); created.crypto.close();
  const files = new Map<string,string>(); const requests: HTTPRequest[] = [];
  let failProtect = false; let loseReceipt = false; let enrolled = false;
  const machineKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 },false,["encrypt","decrypt"]);
  const protector = { name: "encrypted-test-only",
    async protect(value: string) {
      if (failProtect) throw new Error("OS_STORE_FAILED");
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name:"AES-GCM",iv:nonce },machineKey,new TextEncoder().encode(value)));
      const bytes = new Uint8Array(12+cipher.length); bytes.set(nonce); bytes.set(cipher,12); return bytes;
    },
    async unprotect(bytes: Uint8Array) { return new TextDecoder().decode(await crypto.subtle.decrypt({ name:"AES-GCM",iv:bytes.slice(0,12) },machineKey,bytes.slice(12))); },
  };
  const store = new RememberedUnlock({ exists: async p => files.has(p), read: async p => files.get(p)!, write: async (p,v) => { files.set(p,v); } },"pending",{ vaultId,deviceId:"phone",databaseId:"local",endpoint:"https://sync.example.com" },protector);
  const challenge = { id:randomId(),nonce:randomId() };
  const remote = new Transport("https://sync.example.com","",async request => {
    requests.push(request); let value: unknown;
    switch (new URL(request.url).pathname) {
      case "/onboarding": value = { format:1,vaultId,epoch:"epoch",keyPackage:created.keyPackage,publicKey }; break;
      case "/enroll/challenges": value = challenge; break;
      case "/enroll": {
        const input = enrollmentSchema.parse(JSON.parse(new TextDecoder().decode(request.body)));
        expect(sodium.crypto_sign_verify_detached(sodium.from_hex(input.signature),enrollmentMessage(input),sodium.from_hex(publicKey))).toBe(true);
        enrolled = true;
        if (loseReceipt) { loseReceipt = false; throw new Error("RECEIPT_LOST"); }
        value = { enrolled:true }; break;
      }
      case "/handshake": value = { protocol:0,vaultId,epoch:"epoch",seq:0,features:[...SYNC_FEATURES],continuity:true,keyPackage:created.keyPackage,devices:[{id:"phone",name:"手机"}],maxObjectBytes:8388608 }; break;
      default: throw new Error("UNEXPECTED_REQUEST");
    }
    return { status:200,headers:{},bytes:new TextEncoder().encode(JSON.stringify(value)) };
  });
  const options = { remote,deviceId:"phone",vaultId:"",name:"手机",key:"test-only-key",pendingStore:async () => store,stage:() => {},validate:async () => {},assertActive:() => {} };
  return { options,requests,files,store,enrolled:() => enrolled, failProtection:() => { failProtect = true; }, loseReceipt:() => { loseReceipt = true; } };
}
it("persists an encrypted exact request before enrollment and recovers a lost receipt without issuing a second token",async () => {
  const f = await fixture(); f.loseReceipt();
  await expect(enrollConnection(f.options)).rejects.toThrow("RECEIPT_LOST"); expect(f.enrolled()).toBe(true);
  const pending = await f.store.load(); const disk = f.files.get("pending")!;
  expect(disk).not.toContain(pending!.token); expect(disk).not.toContain(pending!.session.metadata); expect(disk).not.toContain("test-only-key");
  const result = await enrollConnection({...f.options,name:"改过的新名称"});
  expect(result.material.token).toBe(pending!.token);
  const enrolls = f.requests.filter(r => r.url.endsWith("/enroll")); expect(enrolls).toHaveLength(2); expect(enrolls[0]!.body).toEqual(enrolls[1]!.body);
  expect(f.requests.filter(r => r.url.endsWith("/enroll/challenges"))).toHaveLength(1);
  expect(f.requests.every(r => !r.headers.Authorization)).toBe(true);
  expect(enrolls.every(r => !new TextDecoder().decode(r.body).includes(pending!.token!))).toBe(true);
});
it("does not enroll when the native protector fails or a key/identity/local anchor cannot be verified",async () => {
  const f = await fixture(); f.failProtection();
  await expect(enrollConnection(f.options)).rejects.toThrow("OS_STORE_FAILED"); expect(f.enrolled()).toBe(false);
  await expect(enrollConnection({...f.options,key:"wrong"})).rejects.toThrow(); expect(f.enrolled()).toBe(false);
  await expect(enrollConnection({...f.options,vaultId:"wrong"})).rejects.toThrow("HANDSHAKE_MISMATCH");
  await expect(enrollConnection({...f.options,validate:async () => { throw new Error("LOCAL_KEY_ANCHOR_MISMATCH"); }})).rejects.toThrow("LOCAL_KEY_ANCHOR_MISMATCH");
  expect(f.requests.filter(r => r.url.endsWith("/enroll"))).toHaveLength(0);
});
it("reuses an authorized protected token without reopening enrollment",async () => {
  const f = await fixture(); const first = await enrollConnection(f.options); const count = f.requests.length;
  const restored = await enrollConnection({...f.options,key:"",previous:first.material,vaultId:first.vaultId});
  expect(restored.material.token).toBe(first.material.token);
  expect(f.requests.slice(count).map(r => new URL(r.url).pathname)).toEqual(["/onboarding","/handshake"]);
  expect(f.requests.at(-1)!.headers.Authorization).toBe(`Bearer ${first.material.token}`);
});
