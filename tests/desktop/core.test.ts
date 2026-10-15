import "fake-indexeddb/auto";
import Dexie from "dexie";
import { expect, it, vi } from "vitest";
import type { App } from "obsidian";
vi.mock("obsidian", () => ({ TFile: class {} }));
import { ObsidianVaultPort } from "../../plugin/src/sync/vault-port";
import { VaultCrypto, canonicalPath, fingerprint, randomId } from "../../plugin/src/sync/crypto";
import { SyncDB } from "../../plugin/src/sync/store";
import { textDiff } from "../../plugin/src/sync/diff";
import { commitSchema } from "../../protocol/src/wire";

it("authenticates file identity, exact parents, device and selected snapshot in manifests", async () => {
  const created = await VaultCrypto.create("test-vault", "public-test-passphrase");
  const second = await VaultCrypto.unlock("test-vault", created.keyPackage, "public-test-passphrase");
  try {
    const bytes = new TextEncoder().encode("synthetic note 🐇"); const obj = created.crypto.object(bytes);
    expect(second.decryptObject(obj.id, obj.bytes)).toEqual(bytes);
    expect(() => second.decryptObject(randomId(), obj.bytes)).toThrow();
    const base = { id: "R", fileId: "F", parents: ["A"], deviceId: "computer-a", selectedFrom: "A" };
    const payload = await created.crypto.payload(base, bytes, "file", [obj.id]); const r = { ...base, payload };
    expect(second.manifest(r).fingerprint).toBe(await fingerprint(bytes));
    expect(() => second.manifest({ ...r, fileId: "G" })).toThrow();
    expect(() => second.manifest({ ...r, parents: ["B"] })).toThrow();
    expect(() => second.manifest({ ...r, deviceId: "computer-b" })).toThrow();
    expect(() => second.manifest({ ...r, selectedFrom: "B" })).toThrow();
    expect(() => second.manifest({ ...r, payload: { ...payload, objects: [] } })).toThrow();
    const damaged = new Uint8Array(obj.bytes); damaged[30] = damaged[30]! ^ 1;
    expect(() => second.decryptObject(obj.id, damaged)).toThrow();
    const encryptedLocal = created.crypto.localSeal("local-snapshot", bytes);
    expect(second.localOpen("local-snapshot", encryptedLocal)).toEqual(bytes);
    expect(() => second.localOpen("different-task", encryptedLocal)).toThrow();
  } finally { created.crypto.close(); second.close(); }
});
it("authenticates location versions and refuses unsafe/colliding path candidates", async () => {
  const { crypto } = await VaultCrypto.create("path-vault", "public-test");
  try {
    expect(canonicalPath(".obsidian/appearance.json")).toBe(".obsidian/appearance.json");
    const l = crypto.location("F", "笔记/Hello.md"); expect(crypto.path("F", l)).toBe("笔记/Hello.md");
    expect(crypto.pathKey("笔记/HELLO.md")).toBe(l.pathKey);
    expect(() => crypto.path("G", l)).toThrow(); expect(() => crypto.path("F", { ...l, revision: "other-location" })).toThrow();
    for (const path of ["../secret.md", "/outside.md", ".hidden/data.json", "A/../B.md", "CON.txt", "folder/a\\b.md", "trailing. "]) expect(() => canonicalPath(path)).toThrow();
  } finally { crypto.close(); }
});
it("bounds KDF parameters before expensive work and refuses unknown wire fields", async () => {
  const created = await VaultCrypto.create("bounded", "public-test"); created.crypto.close();
  await expect(VaultCrypto.unlock("bounded", { ...created.keyPackage, memory: 2 ** 40 }, "public-test")).rejects.toThrow();
  await expect(VaultCrypto.unlock("other-vault", created.keyPackage, "public-test")).rejects.toThrow("WRONG_VAULT");
  expect(() => commitSchema.parse({ protocol: 0, vaultId: "V", epoch: "E", deviceId: "D", opId: "O", requiredFeatures: [], actions: [], extra: true })).toThrow();
});
it("upgrades existing local schema without clearing inbox/outbox state", async () => {
  const name = `upgrade-${randomId()}`; const old = new Dexie(name);
  old.version(1).stores({ progress: "id", localFiles: "id,&path", remoteFiles: "id", revisions: "id", outbox: "++queueId,&opId", inbox: "seq", conflicts: "id", applyTasks: "id", leases: "id" });
  await old.open(); await old.table("inbox").put({ seq: 7, fileIds: ["F"], done: false }); old.close();
  const next = new SyncDB(name);
  try { await next.open(); expect((await next.inbox.get(7))?.done).toBe(false); expect(await next.rejectedOutbox.count()).toBe(0); }
  finally { await next.delete(); }
});
it("diff exposes a replacement while retaining common context", () => {
  expect(textDiff("header\n电脑 A\nfooter", "header\n电脑 B\nfooter")).toEqual({ prefix: ["header"], removed: ["电脑 A"], added: ["电脑 B"], suffix: ["footer"] });
});
it("maps the actual configDir into shared configuration while excluding credentials and staging", async () => {
  const app = { vault: { configDir: "custom-config", adapter: { exists: async () => true, list: async () => ({ files: ["custom-config/appearance.json", "custom-config/core-plugins.json"], folders: ["custom-config/obsidian-sync-local"] }), stat: async () => ({ type: "file", size: 10 }) }, getFiles: () => [
    "note.md", "folder/note.md", "custom-config/obsidian-sync-local/device.json", "custom-config/obsidian-sync-local/staging/ciphertext", ".obsidian/data.json", ".trash/note.md", "custom-config-public/note.md",
  ].map(path => ({ path })) } } as unknown as App;
  const port = new ObsidianVaultPort(app, "custom-config/obsidian-sync-local");
  expect(await port.list()).toEqual([".obsidian/appearance.json", "custom-config-public/note.md", "folder/note.md", "note.md"]);
  expect(port.inScope("custom-config/core-plugins.json")).toBe(false);
  expect((await port.inventory()).find(e => e.path === ".obsidian/core-plugins.json")?.reason).toContain("每台设备独立");
  await expect(port.read(".obsidian/core-plugins.json")).rejects.toThrow("DEVICE_LOCAL_PATH");
  await expect(port.write(".obsidian/core-plugins.json", new Uint8Array(), null)).rejects.toThrow("DEVICE_LOCAL_PATH");
  await expect(port.remove(".obsidian/core-plugins.json", new Uint8Array())).rejects.toThrow("DEVICE_LOCAL_PATH");
});
it("honours the host trash preference only after verifying the exact file bytes", async () => {
  const expected=new TextEncoder().encode("reviewed bytes"); const file={path:"note.md",stat:{size:expected.length}};
  let current=expected.slice();
  const trashFile=vi.fn(async()=>{}), directTrash=vi.fn(async()=>{});
  const app={vault:{configDir:".obsidian",getFileByPath:()=>file,readBinary:async()=>current.slice().buffer,trash:directTrash},fileManager:{trashFile}} as unknown as App;
  const port=new ObsidianVaultPort(app,".obsidian/obsidian-sync-local");
  current=new TextEncoder().encode("unreviewed change"); await expect(port.remove(file.path,expected)).rejects.toThrow("LOCAL_CHANGED_DURING_DELETE"); expect(trashFile).not.toHaveBeenCalled();
  current=expected.slice(); await port.remove(file.path,expected); expect(trashFile).toHaveBeenCalledWith(file); expect(directTrash).not.toHaveBeenCalled();
});
