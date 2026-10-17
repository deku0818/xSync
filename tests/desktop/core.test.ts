import "fake-indexeddb/auto";
import Dexie from "dexie";
import { expect, it, vi } from "vitest";
import type { App } from "obsidian";
vi.mock("obsidian", () => ({ TFile: class {}, MarkdownView: class {} }));
import { MarkdownView } from "obsidian";
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
  const app={workspace:{getLeavesOfType:()=>[]},vault:{configDir:".obsidian",getFileByPath:()=>file,readBinary:async()=>current.slice().buffer,trash:directTrash},fileManager:{trashFile}} as unknown as App;
  const port=new ObsidianVaultPort(app,".obsidian/obsidian-sync-local");
  current=new TextEncoder().encode("unreviewed change"); await expect(port.remove(file.path,expected)).rejects.toThrow("LOCAL_CHANGED_DURING_DELETE"); expect(trashFile).not.toHaveBeenCalled();
  current=expected.slice(); await port.remove(file.path,expected); expect(trashFile).toHaveBeenCalledWith(file); expect(directTrash).not.toHaveBeenCalled();
});
it("only enumerates direct private stages and permanently removes validated files, leaving notes, secrets and host trash alone", async () => {
  const root = ".custom-config/obsidian-sync-local/staging", id = randomId();
  const remove = vi.fn(async () => {}), trashLocal = vi.fn(async () => {});
  const adapter = { exists: async () => true, list: async () => ({ files: [
    `${root}/${id}`, `${root}/nested/${randomId()}`, `${root}/../${randomId()}`,
    `${root}-other/${randomId()}`, `${root}/device.json`, "note.md", ".trash/note.md",
  ], folders: [`${root}/${randomId()}`] }), stat: vi.fn(async () => ({ type: "file" })), remove, trashLocal };
  const port = new ObsidianVaultPort({ vault: { adapter } } as unknown as App, ".custom-config/obsidian-sync-local");
  expect(await port.stageList()).toEqual([id]);
  for (const invalid of ["../note.md", "device.json", "", `${id}/child`]) await expect(port.stageRemove(invalid)).rejects.toThrow("INVALID_STAGE_ID");
  expect(adapter.stat).not.toHaveBeenCalled();
  await port.stageRemove(id); expect(remove).toHaveBeenCalledExactlyOnceWith(`${root}/${id}`); expect(trashLocal).not.toHaveBeenCalled();
  adapter.stat.mockResolvedValueOnce({ type: "folder" });
  await expect(port.stageRemove(randomId())).rejects.toThrow("EXPECTED_STAGE_FILE"); expect(remove).toHaveBeenCalledTimes(1);
});

it("flushes the host editor buffer without asking for a manual save", async () => {
  const save = vi.fn(async () => {}), previewSave = vi.fn(async () => {});
  const source = Object.assign(Object.create(MarkdownView.prototype), { file: { path: "note.md" }, data: "saved", getViewData: () => "new editor content", editor: { getValue: () => "new editor content" }, getMode: () => "source", save });
  const preview = Object.assign(Object.create(MarkdownView.prototype), { file: { path: "other.md" }, getMode: () => "preview", save: previewSave });
  const app = { vault: { configDir: ".obsidian", readBinary: async () => new TextEncoder().encode("new editor content").buffer }, workspace: { getLeavesOfType: () => [{ view: source }, { view: preview }] } } as unknown as App;
  await new ObsidianVaultPort(app, ".obsidian/obsidian-sync-local").flushEdits("note.md");
  expect(save).toHaveBeenCalledOnce(); expect(previewSave).not.toHaveBeenCalled();
});
it("refuses to overwrite or delete text still waiting in the editor auto-save buffer", async () => {
  let saved = "reviewed content", buffer = "new typing before auto-save";
  const file = { path: "note.md", stat: { size: saved.length } }, encoder = new TextEncoder();
  const view = Object.assign(Object.create(MarkdownView.prototype), { file, data: saved, getViewData: () => buffer, getMode: () => "source", editor: { getValue: () => buffer }, save: async () => { saved = buffer; view.data = saved; } });
  const trashFile = vi.fn(async () => {});
  const app = { workspace: { getLeavesOfType: () => [{ view }] }, fileManager: { trashFile }, vault: { configDir: ".obsidian", getFileByPath: () => file,
    readBinary: async () => encoder.encode(saved).buffer, process: async (_file: unknown, fn: (text: string) => string) => { saved = fn(saved); } } } as unknown as App;
  const port = new ObsidianVaultPort(app, ".obsidian/obsidian-sync-local");
  await expect(port.write("note.md", encoder.encode("selected phone content"), encoder.encode(saved))).rejects.toThrow("LOCAL_CHANGED_DURING_APPLY");
  await expect(port.remove("note.md", encoder.encode(saved))).rejects.toThrow("LOCAL_CHANGED_DURING_APPLY");
  expect(saved).toBe("reviewed content"); expect(buffer).toBe("new typing before auto-save"); expect(trashFile).not.toHaveBeenCalled();
  await port.flushEdits("note.md"); expect(saved).toBe("new typing before auto-save");
  buffer = saved; await port.write("note.md", encoder.encode("explicitly chosen result"), encoder.encode(saved));
  expect(saved).toBe("explicitly chosen result");
});
it("waits when the host save call returns before an existing save reaches the file", async () => {
  const encoder = new TextEncoder(); let disk = "old saved file";
  const view = Object.assign(Object.create(MarkdownView.prototype), { file: { path: "note.md" }, getMode: () => "source", editor: { getValue: () => "new editor buffer" }, save: async () => {} });
  const app = { workspace: { getLeavesOfType: () => [{ view }] }, vault: { configDir: ".obsidian", readBinary: async () => encoder.encode(disk).buffer } } as unknown as App;
  const port = new ObsidianVaultPort(app, ".obsidian/obsidian-sync-local");
  await expect(port.flushEdits("note.md")).rejects.toThrow("LOCAL_EDITOR_CHANGES_PENDING");
  expect(disk).toBe("old saved file"); disk = "new editor buffer"; await expect(port.flushEdits("note.md")).resolves.toBeUndefined();
});
it("checks only the requested editor and accepts unchanged CRLF text without hiding new typing", async () => {
  const encoder = new TextEncoder(); let buffer = "first\nsecond\n";
  const file = { path: "note.md", stat: { size: 15 } }, save = vi.fn(async () => {}), otherSave = vi.fn(async () => { throw new Error("OTHER_SAVE_PENDING"); });
  const view = Object.assign(Object.create(MarkdownView.prototype), { file, getMode: () => "source", editor: { getValue: () => buffer }, save });
  const other = Object.assign(Object.create(MarkdownView.prototype), { file: { path: "other.md" }, getMode: () => "source", save: otherSave });
  const process = vi.fn(async (_file: unknown, fn: (value: string) => string) => { fn("first\r\nsecond\r\n"); });
  const app = { workspace: { getLeavesOfType: () => [{ view }, { view: other }] }, vault: { configDir: ".obsidian", getFileByPath: () => file,
    readBinary: async () => encoder.encode("first\r\nsecond\r\n").buffer, process } } as unknown as App;
  const port = new ObsidianVaultPort(app, ".obsidian/obsidian-sync-local");
  await port.flushEdits("note.md"); expect(save).toHaveBeenCalledOnce(); expect(otherSave).not.toHaveBeenCalled();
  await port.write("note.md", encoder.encode("remote choice"), encoder.encode("first\r\nsecond\r\n"));
  buffer += "new typing";
  await expect(port.flushEdits("note.md")).rejects.toThrow("LOCAL_EDITOR_CHANGES_PENDING");
  await expect(port.write("note.md", encoder.encode("remote choice"), encoder.encode("first\r\nsecond\r\n"))).rejects.toThrow("LOCAL_CHANGED_DURING_APPLY");
});
