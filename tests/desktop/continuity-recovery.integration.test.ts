import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RecoveryFixture } from "./recovery-support";
import { VaultCrypto, fingerprint, randomId } from "../../plugin/src/sync/crypto";
import { legacyObject } from "./legacy-object-fixture";

describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("continuity, legacy baseline and completed migration recovery regressions", () => {
  let fixture: RecoveryFixture;
  afterEach(async () => { await fixture?.close(); });
  async function open(full = false, count = 2) {
    fixture = new RecoveryFixture(); await fixture.open(false, full ? "full" : undefined, count);
    for (let i = 0; i < count; i++) await fixture.client(i);
    return fixture.clients;
  }
  async function upgrade() {
    await fixture.killServer(); const path = join(fixture.root, "server.json"), cfg = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...cfg, metadataMode: "compact" }), { mode: 0o600 }); await fixture.startServer(true);
  }
  const docker = (args: string[], input?: Uint8Array) => execFileSync("docker", ["compose", "-f", "server/compose.dev.yaml", "exec", "-T", "postgres", ...args], { input, timeout: 15000 });
  async function backup() {
    await fixture.killServer();
    await writeFile(join(fixture.root, "joint.dump"), docker(["pg_dump", "-U", "syncdev", "-d", "obsidiansync", "-n", fixture.schema, "-Fc"]), { mode: 0o600 });
    await cp(join(fixture.root, "objects"), join(fixture.root, "backup-objects"), { recursive: true }); await fixture.startServer(true);
  }
  async function restore() {
    await fixture.killServer(); await fixture.sql(`DROP SCHEMA ${fixture.schema} CASCADE`);
    docker(["pg_restore", "-U", "syncdev", "-d", "obsidiansync"], new Uint8Array(await readFile(join(fixture.root, "joint.dump"))));
    await rm(join(fixture.root, "objects"), { recursive: true, force: true });
    await cp(join(fixture.root, "backup-objects"), join(fixture.root, "objects"), { recursive: true }); await fixture.startServer(true);
  }

  it.each([0, 1])("retains device %s's accepted bytes after a joint old backup catches up beyond its cursor", async observer => {
    const [a,b,c] = await open(false, 3); await a!.files.edit("note.md", "common backup base"); await a!.engine.sync(); await b!.engine.sync(); await c!.engine.sync(); await backup();
    await a!.files.edit("note.md", "accepted content after backup"); expect((await a!.engine.sync()).errors).toEqual([]);
    if (observer === 1) expect((await b!.engine.sync()).errors).toEqual([]);
    const target = fixture.clients[observer]!, local = (await target.db.localFiles.toArray())[0]!, previous = await target.db.continuity.get("continuity");
    await restore();
    await c!.files.edit("note.md", "restored fork 1"); expect((await c!.engine.sync()).errors).toEqual([]);
    await c!.files.edit("note.md", "restored fork 2"); expect((await c!.engine.sync()).errors).toEqual([]); await fixture.retireLogs();
    expect((await fixture.transport(0).handshake()).seq).toBe(3);
    const status = await target.engine.sync(); expect(status.errors).toContain("RECOVERY_RECONCILIATION_REQUIRED"); expect(status.state).toBe("needs-attention");
    expect(await target.files.text("note.md")).toBe("accepted content after backup");
    expect(await target.db.revisions.get(local.revision)).toBeDefined(); expect(await target.db.baseProofs.get(local.revision)).toBeDefined();
    expect(await target.db.continuity.get("continuity")).toEqual(previous);
  }, 30000);

  it("backfills actual v4-style displayed baselines before applying a newer compact snapshot", async () => {
    const [a,b] = await open(true); await a!.files.edit("note.md", "old displayed version"); await a!.engine.sync(); await b!.engine.sync();
    const local = (await b!.db.localFiles.toArray())[0]!;
    // v4 has the displayed revision and cursor, but none of the later protocol tables' records.
    await b!.db.baseProofs.clear(); await b!.db.writerState.clear(); await b!.db.metadataMigration.clear(); await b!.db.continuity.clear();
    await a!.files.edit("note.md", "new remote version"); await a!.engine.sync(); await upgrade();
    const certified: string[] = [];
    fixture.httpHook = async (request,next) => { if (request.url.endsWith("/metadata/base")) certified.push(JSON.parse(new TextDecoder().decode(request.body)).revision.id); return next(); };
    expect((await b!.engine.sync()).errors).toEqual([]); expect(certified).toContain(local.revision);
    expect(await b!.files.text("note.md")).toBe("new remote version"); expect((await b!.engine.status()).state).toBe("complete");
  });

  it("preserves unknown legacy baselines instead of accepting a bootstrap from a restored fork", async () => {
    const [a,b,c] = await open(true, 3); await a!.files.edit("note.md", "backup base"); await a!.engine.sync(); await b!.engine.sync(); await c!.engine.sync(); await backup();
    await a!.files.edit("note.md", "legacy accepted future"); await a!.engine.sync(); await b!.engine.sync();
    await b!.db.baseProofs.clear(); await b!.db.writerState.clear(); await b!.db.metadataMigration.clear(); await b!.db.continuity.clear();
    await restore(); await c!.files.edit("note.md", "new fork 1"); await c!.engine.sync(); await c!.files.edit("note.md", "new fork 2"); await c!.engine.sync(); await upgrade();
    expect((await b!.engine.sync()).errors).toContain("RECOVERY_RECONCILIATION_REQUIRED");
    expect(await b!.files.text("note.md")).toBe("legacy accepted future"); expect((await b!.db.continuity.get("continuity"))?.bootstrap).toBe(true);
  }, 30000);

  it.each(["matching", "diverged"])("recovers a new local database after nonempty migration with %s filesystem bytes", async kind => {
    const [a] = await open(true); await a!.engine.sync();
    const keys = await VaultCrypto.restore(fixture.config.vaultId, a!.material.session), bytes = new TextEncoder().encode("old captured note"), object = await legacyObject(a!.material.session, bytes);
    const base = { id: randomId(), fileId: randomId(), parents: [], deviceId: a!.engine.deviceId }, payload = await keys.payload(base, bytes, "file", [object.id]), location = keys.location(base.fileId, "note.md"), opId = randomId(); keys.close();
    await a!.files.stageWrite(object.id, object.bytes); await a!.files.edit("note.md", "old captured note");
    await a!.db.revisions.put({ ...base, payload }); await a!.db.localFiles.put({ id: base.fileId, path: "note.md", location, revision: base.id, fingerprint: await fingerprint(bytes), deleted: false });
    await a!.db.outbox.add({ opId, objects: [{ id: object.id, stage: object.id }], request: { protocol: 0, vaultId: fixture.config.vaultId, epoch: fixture.config.epoch, deviceId: a!.engine.deviceId, opId, requiredFeatures: ["causal-heads", "atomic-groups"], actions: [{ type: "create", fileId: base.fileId, revisionId: base.id, payload, location }] } });
    await upgrade(); expect((await a!.engine.sync()).errors).toEqual([]);
    if (kind === "diverged") await a!.files.edit("note.md", "untracked bytes after database loss");
    a!.engine.lock(); await a!.db.delete(); const fresh = await fixture.client(0);
    const status = await fresh.engine.sync(); expect(status.errors).toEqual([]); expect(await fresh.db.metadataMigration.get("migration")).toMatchObject({ complete: true, requests: [] });
    expect(await fresh.db.metadataMigration.get("objects")).toMatchObject({ complete: true, requests: [] });
    if (kind === "matching") expect(status.state).toBe("complete");
    else { expect(status.conflicts).toBe(1); expect(await fresh.files.text("note.md")).toBe("untracked bytes after database loss"); }
    // Recovery reads closed registration state; it must not reopen or replace the original bundle.
    await expect(fixture.transport(0).registerLegacy([])).rejects.toThrow("LEGACY_MIGRATION_CHANGED");
    await expect(fixture.transport(0).registerLegacyObjects([])).rejects.toThrow("LEGACY_OBJECT_MIGRATION_CHANGED");
  });

  it.each(["/changes", "/metadata/commits"])("recovers a committed continuity response lost at %s without duplicate operations", async endpoint => {
    const [a] = await open(); await a!.files.edit("note.md", "exact captured bytes"); let lose = true;
    fixture.httpHook = async (request,next) => { const response = await next(); if (lose && new URL(request.url).pathname === endpoint && response.status === 200) { lose = false; throw new Error("LOST_CONTINUITY_RESPONSE"); } return response; };
    expect((await a!.engine.sync()).errors).toContain("LOST_CONTINUITY_RESPONSE"); fixture.httpHook = undefined;
    const restored = await fixture.reopen(0); expect((await restored.engine.sync()).errors).toEqual([]);
    expect(await restored.files.text("note.md")).toBe("exact captured bytes"); expect((await fixture.transport(0).handshake()).seq).toBe(1);
    expect((await restored.db.continuity.get("continuity"))?.pending).toBeUndefined();
  });
});
