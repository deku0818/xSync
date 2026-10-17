import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RecoveryFixture, type RecoveryClient } from "./recovery-support.js";
import { SyncPolicy, defaultRules } from "../../plugin/src/sync/policy";

const execute = promisify(execFile);
let fixture: RecoveryFixture;
describe.skipIf(process.env.OBSIDIAN_SYNC_DESKTOP_TEST !== "1")("repository lifecycle regressions", () => {
  beforeEach(async () => { fixture = new RecoveryFixture(); await fixture.open(); await fixture.client(0); await fixture.client(1); });
  afterEach(async () => { await fixture?.close(); });
  async function query(sql: string): Promise<string> {
    const result = await execute("docker", ["compose", "-f", "server/compose.dev.yaml", "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "syncdev", "-d", "obsidiansync", "-At", "-c", sql]);
    return result.stdout.trim();
  }
  async function conflict(path = "note.md", base = "base", first = "first", second = "second"): Promise<{ a: RecoveryClient; b: RecoveryClient; id: string }> {
    const a = fixture.clients[0]!, b = fixture.clients[1]!;
    await a.files.edit(path, base); expect((await a.engine.sync()).errors).toEqual([]); await b.engine.sync();
    await a.files.edit(path, first); await a.engine.sync(); await b.files.edit(path, second); await b.engine.sync();
    await a.engine.sync(); expect(await a.db.conflicts.count()).toBe(1);
    return { a, b, id: (await a.db.conflicts.toArray())[0]!.id };
  }

  it("only rewrites the affected file and its heads for a one-file edit", async () => {
    const a = fixture.clients[0]!, s = fixture.schema;
    for (let i = 0; i < 5; i++) await a.files.edit(`file-${i}.md`, `initial-${i}`);
    expect((await a.engine.sync()).errors).toEqual([]);
    await fixture.sql(`CREATE TABLE ${s}.review_mutations (kind text);
      CREATE FUNCTION ${s}.review_count() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${s}.review_mutations VALUES(TG_TABLE_NAME || ':' || TG_OP); RETURN NULL; END $$;
      CREATE TRIGGER review_files AFTER UPDATE ON ${s}.files FOR EACH ROW EXECUTE FUNCTION ${s}.review_count();
      CREATE TRIGGER review_heads AFTER INSERT OR DELETE ON ${s}.heads FOR EACH ROW EXECUTE FUNCTION ${s}.review_count();`);
    await a.files.edit("file-0.md", "one change"); expect((await a.engine.sync()).errors).toEqual([]);
    const counts = await query(`SELECT kind,count(*) FROM ${s}.review_mutations GROUP BY kind ORDER BY kind`);

    expect(counts).not.toContain("files:UPDATE"); expect(counts).toContain("heads:DELETE|1"); expect(counts).toContain("heads:INSERT|1");
  });

  it("compacts completed unrelated inbox events behind an unresolved conflict", async () => {
    const { a, b } = await conflict();
    const baseline = await a.db.inbox.count();
    for (let i = 0; i < 8; i++) {
      await b.files.edit("healthy.md", `healthy-${i}`); await b.engine.sync();
      expect((await a.engine.sync()).errors).toEqual([]);
    }
    const rows = await a.db.inbox.toArray();
    expect(rows.filter(r => r.done && r.change)).toEqual([]); expect(rows.length).toBeLessThanOrEqual(baseline + 1);
    const latest = await a.engine.review((await a.db.conflicts.toArray())[0]!.id);
    await a.engine.resolve(latest, latest.versions[0]!.revision);
    expect(await a.db.inbox.count()).toBe(0);
    expect(await a.files.text("healthy.md")).toBe("healthy-7");
  }, 15000);

  it.each(["normal", "before-apply-ack", "after-apply-ack"])("retires a rejected merge with %s recovery only after the replacement is applied", async boundary => {
    const { a, b, id } = await conflict();
    const review = await a.engine.review(id);
    let raced = false;
    fixture.httpHook = async (request, next) => {
      if (!raced && request.url.endsWith("/metadata/commits")) {
        const c = JSON.parse(new TextDecoder().decode(request.body!));
        if (c.request.actions[0]?.type === "resolve") { raced = true; await b.files.edit("note.md", "third head"); await b.engine.sync(); }
      }
      return next();
    };
    await expect(a.engine.resolve(review, "", undefined, new TextEncoder().encode("first attempted merge"))).rejects.toThrow("REVIEW_STALE");
    fixture.httpHook = undefined;
    const rejected = (await a.db.rejectedOutbox.toArray())[0]!; expect(rejected).toBeDefined();
    await a.engine.sync(); const fresh = await a.engine.review(id);
    if (boundary === "normal") await a.engine.resolve(fresh, "", undefined, new TextEncoder().encode("final explicit merge"));
    else {
      a.engine.fault=point=>{ if(point===boundary) throw new Error("REPLACEMENT_INTERRUPTED"); };
      await expect(a.engine.resolve(fresh,"",undefined,new TextEncoder().encode("final explicit merge"))).rejects.toThrow("REPLACEMENT_INTERRUPTED");
      expect(await a.db.rejectedOutbox.count()).toBe(1);
      expect(await a.files.stageList()).toContain(rejected.objects[0]!.stage);
    }
    const restarted=await fixture.reopen(0);
    expect((await restarted.engine.sync()).errors).toEqual([]); expect(await restarted.db.conflicts.count()).toBe(0);
    expect(await restarted.db.rejectedOutbox.count()).toBe(0);
    expect(await restarted.files.stageList()).not.toContain(rejected.objects[0]!.stage);
    expect(await restarted.files.text("note.md")).toBe("final explicit merge");
  });

  async function rejectedMerge(): Promise<{ a: RecoveryClient; b: RecoveryClient; id: string; stage: string }> {
    const { a, b, id } = await conflict();
    const review = await a.engine.review(id); let raced = false;
    fixture.httpHook = async (request, next) => {
      if (!raced && request.url.endsWith("/metadata/commits") && JSON.parse(new TextDecoder().decode(request.body!)).request.actions[0]?.type === "resolve") {
        raced = true; await b.files.edit("note.md", "new peer branch"); await b.engine.sync();
      }
      return next();
    };
    await expect(a.engine.resolve(review, "", undefined, new TextEncoder().encode("rejected draft"))).rejects.toThrow("REVIEW_STALE");
    fixture.httpHook = undefined; await a.engine.sync();
    return { a, b, id, stage: (await a.db.rejectedOutbox.toArray())[0]!.objects[0]!.stage };
  }

  it.each(["normal", "before-local-cleanup-commit", "after-local-cleanup-commit", "before-stage-remove", "after-stage-remove"])("retires an overtaken replacement across %s without changing the newer file", async boundary => {
    const { a, b, id, stage } = await rejectedMerge();
    const review = await a.engine.review(id); let advanced = false, interrupted = false;
    fixture.httpHook = async (request, next) => {
      const response = await next();
      if (!advanced && request.url.endsWith("/metadata/commits") && JSON.parse(new TextDecoder().decode(request.body!)).request.actions[0]?.type === "resolve" && response.status === 200) {
        advanced = true; await b.engine.sync(); await b.files.edit("note.md", "newer peer content after replacement"); await b.engine.sync();
        await a.engine.saveMergeDraft(id, "new draft from another review");
        if (boundary !== "normal") a.engine.fault = point => { if (!interrupted && point === boundary) { interrupted = true; throw new Error("RETIREMENT_INTERRUPTED"); } };
      }
      return response;
    };
    const operation = a.engine.resolve(review, "", undefined, new TextEncoder().encode("accepted replacement"));
    if (boundary === "normal") await operation; else await expect(operation).rejects.toThrow("RETIREMENT_INTERRUPTED");
    expect(advanced).toBe(true); expect(interrupted).toBe(boundary !== "normal"); fixture.httpHook = undefined;
    const reopened = await fixture.reopen(0); expect((await reopened.engine.sync()).errors).toEqual([]);
    expect(await reopened.files.text("note.md")).toBe("newer peer content after replacement");
    expect(await reopened.engine.loadMergeDraft(id)).toBe("new draft from another review");
    expect(await reopened.db.rejectedOutbox.count()).toBe(0); expect(await reopened.files.stageList()).not.toContain(stage);
    expect((await reopened.engine.status()).state).toBe("complete");
  });

  it("keeps rejected bytes while their replacement is unaccepted, and recovers its immutable request after restart", async () => {
    const { a, id, stage } = await rejectedMerge(); const review = await a.engine.review(id);
    fixture.httpHook = async (request, next) => {
      if (request.url.endsWith("/metadata/commits") && JSON.parse(new TextDecoder().decode(request.body!)).request.actions[0]?.type === "resolve")
        return { status: 429, headers: {}, bytes: new TextEncoder().encode('{"code":"CONTENT_BUSY"}') };
      return next();
    };
    await expect(a.engine.resolve(review, "", undefined, new TextEncoder().encode("unaccepted replacement"))).rejects.toThrow("CONTENT_BUSY");
    const pending = (await a.db.outbox.toArray())[0]!.request;
    const reopened = await fixture.reopen(0); await reopened.engine.sync();
    expect(await reopened.db.rejectedOutbox.count()).toBe(1); expect(await reopened.files.stageList()).toContain(stage);
    expect((await reopened.db.outbox.toArray())[0]!.request).toEqual(pending);
    fixture.httpHook = undefined; expect((await reopened.engine.sync()).errors).toEqual([]);
    expect(await reopened.files.text("note.md")).toBe("unaccepted replacement");
    expect(await reopened.db.rejectedOutbox.count()).toBe(0); expect(await reopened.files.stageList()).not.toContain(stage);
  });

  it("does not retire rejected bytes just because another device settled the file while the replacement was rejected", async () => {
    const { a, b, id, stage } = await rejectedMerge(); const review = await a.engine.review(id); let settled = false;
    fixture.httpHook = async (request, next) => {
      if (!settled && request.url.endsWith("/metadata/commits") && JSON.parse(new TextDecoder().decode(request.body!)).request.actions[0]?.type === "resolve") {
        settled = true; await b.engine.sync(); const peer = await b.engine.review(id);
        const choice = peer.versions.find(version => version.deviceId === b.engine.deviceId)!;
        await b.engine.resolve(peer, choice.revision);
      }
      return next();
    };
    await expect(a.engine.resolve(review, "", undefined, new TextEncoder().encode("also rejected replacement"))).rejects.toThrow("REVIEW_STALE");
    fixture.httpHook = undefined; expect((await a.engine.sync()).errors).toEqual([]);
    expect(await a.db.outbox.count()).toBe(0); expect(await a.db.conflicts.count()).toBe(0);
    expect(await a.db.rejectedOutbox.count()).toBe(2); expect(await a.files.stageList()).toContain(stage);
    expect(await a.files.text("note.md")).toBe("new peer branch");
  });

  it("preserves a concurrent local edit, its pending upload and new draft until a fresh explicit decision", async () => {
    const { a, b, id, stage } = await rejectedMerge(); const review = await a.engine.review(id); let advanced = false;
    fixture.httpHook = async (request, next) => {
      const response = await next();
      if (!advanced && request.url.endsWith("/metadata/commits") && JSON.parse(new TextDecoder().decode(request.body!)).request.actions[0]?.type === "resolve" && response.status === 200) {
        advanced = true; await b.engine.sync(); await b.files.edit("note.md", "peer descendant"); await b.engine.sync();
        await a.files.edit("note.md", "latest local typing"); await a.engine.saveMergeDraft(id, "latest draft");
      }
      return response;
    };
    await a.engine.resolve(review, "", undefined, new TextEncoder().encode("accepted replacement"));
    fixture.httpHook = async (request, next) => request.url.endsWith("/content/upload")
      ? { status: 429, headers: {}, bytes: new TextEncoder().encode('{"code":"CONTENT_BUSY"}') } : next();
    const reopened = await fixture.reopen(0); await reopened.engine.sync();
    expect(await reopened.db.outbox.count()).toBe(1); expect(await reopened.db.rejectedOutbox.count()).toBe(1);
    expect(await reopened.files.text("note.md")).toBe("latest local typing"); expect(await reopened.files.stageList()).toContain(stage);
    fixture.httpHook = undefined; await reopened.engine.sync();
    const latest = await reopened.engine.review(id);
    expect(latest.versions.map(v => v.text).sort()).toEqual(["latest local typing", "peer descendant"]);
    expect(await reopened.engine.loadMergeDraft(id)).toBe("latest draft"); expect(await reopened.db.rejectedOutbox.count()).toBe(1);
    const local = latest.versions.find(v => v.text === "latest local typing")!;
    await reopened.engine.resolve(latest, local.revision); await b.engine.sync();
    expect(await reopened.files.text("note.md")).toBe("latest local typing"); expect(await b.files.text("note.md")).toBe("latest local typing");
    expect(await reopened.db.rejectedOutbox.count()).toBe(0); expect(await reopened.files.stageList()).not.toContain(stage);
  });

  it("pages more than 10,000 retained identities without blocking log or object collection", async () => {
    const a = fixture.clients[0]!, s = fixture.schema;
    await a.files.edit("note.md", "old bytes"); await a.engine.sync();
    await a.files.edit("note.md", "new bytes"); await a.engine.sync(); await fixture.collect();
    // Synthetic opaque metadata exercises the transport/PG count boundary, not Vault decryption.
    await fixture.sql(`UPDATE ${s}.objects SET unreferenced_at=clock_timestamp()-interval '2 hours' WHERE state='candidate';
      UPDATE ${s}.changes SET created_at=clock_timestamp()-interval '8 days';
      INSERT INTO ${s}.files(vault_id,id,kind,location,path_key)
      SELECT vault_id,'synthetic_'||n,kind,location,md5(n::text)||md5(n::text) FROM ${s}.files CROSS JOIN generate_series(1,10000) n LIMIT 10000;
      INSERT INTO ${s}.revisions(vault_id,id,file_id,value)
      SELECT f.vault_id,f.id||'_r',f.id,jsonb_set(jsonb_set(r.value,'{id}',to_jsonb(f.id||'_r')),'{fileId}',to_jsonb(f.id))
      FROM ${s}.files f CROSS JOIN (SELECT value FROM ${s}.revisions ORDER BY id DESC LIMIT 1) r WHERE f.id LIKE 'synthetic_%';
      INSERT INTO ${s}.heads SELECT vault_id,id,id||'_r' FROM ${s}.files WHERE id LIKE 'synthetic_%';`);
    const remote = fixture.transport(0), frozen = await remote.snapshot();
    expect(frozen.files.length).toBe(10001); expect(frozen.revisions.length).toBe(10001); expect(frozen.bases?.length).toBe(10001);
    await remote.releaseSnapshots(); await fixture.collect();
    expect(await query(`SELECT count(*) FROM ${s}.objects WHERE state='candidate'`)).toBe("0");
    expect(await query(`SELECT count(*) FROM ${s}.changes`)).toBe("0");
  }, 30000);

  it.each(["attachment.bin", "large.md"])("resolves %s by lazily authenticating the chosen bytes", async path => {
    const first = "first".repeat(path.endsWith(".md") ? 14000 : 1), second = "second".repeat(path.endsWith(".md") ? 12000 : 1);
    const { a, b, id } = await conflict(path,"base",first,second);
    const review = await a.engine.review(id);
    expect(review.versions.every(v => v.text === null && v.bytes.length === 0)).toBe(true);
    const selected = review.versions.find(v => v.deviceId === b.engine.deviceId)!;
    let reads = 0;
    fixture.httpHook = async (request, next) => { if (request.url.endsWith("/content/read")) reads++; return next(); };
    await a.engine.resolve(review,selected.revision); expect(reads).toBe(1);
    expect(await a.files.text(path)).toBe(second); expect(await a.db.conflicts.count()).toBe(0);
  });

  it("preserves both binary attachments with lazy downloads", async () => {
    const { a, id } = await conflict("attachment.bin"); const review=await a.engine.review(id); let reads = 0;
    fixture.httpHook = async (request, next) => { if (request.url.endsWith("/content/read")) reads++; return next(); };
    await a.engine.resolve(review,review.versions[0]!.revision,"attachment-copy.bin"); expect(reads).toBe(2);
    expect([await a.files.text("attachment.bin"),await a.files.text("attachment-copy.bin")].sort()).toEqual(["first","second"]);
  });

  it("does not commit a binary choice until its selected ciphertext has been authenticated", async () => {
    const { a, id } = await conflict("attachment.bin"); const review = await a.engine.review(id); let commits = 0;
    fixture.httpHook = async (request, next) => {
      if (request.url.endsWith("/metadata/commits") && JSON.parse(new TextDecoder().decode(request.body!)).request.actions[0]?.type === "resolve") commits++;
      const response = await next();
      if (request.method === "GET" && request.url.includes("/objects/")) { const bytes = response.bytes.slice(); bytes[bytes.length - 1]! ^= 1; return { ...response, bytes }; }
      return response;
    };
    await expect(a.engine.resolve(review, review.versions[0]!.revision)).rejects.toThrow(/MISMATCH/);
    expect(commits).toBe(0); expect(await a.files.text("attachment.bin")).toBe("first");
    expect(await a.db.outbox.count()).toBe(0); expect(await a.db.conflicts.count()).toBe(1);
  });

  it.each(["selected", "companion"])("checks the actual %s attachment size before committing a selection", async kind => {
    const large="x".repeat(1_000_001);
    const {a,b,id}=await conflict("attachment.bin","base",large,"small");
    const review=await a.engine.review(id), before=await fixture.transport(0).handshake();
    a.engine.setPolicy(new SyncPolicy({...defaultRules(),maxMB:1}));
    const selected=review.versions.find(version=>version.deviceId===(kind==="selected"?a.engine.deviceId:b.engine.deviceId))!;
    await expect(a.engine.resolve(review,selected.revision,kind==="companion"?"copy.bin":undefined)).rejects.toThrow(kind==="selected"?"FILE_EXCLUDED":"COMPANION_PATH_UNAVAILABLE");
    expect((await fixture.transport(0).handshake()).seq).toBe(before.seq);
    expect(await a.files.text("attachment.bin")).toBe(large); expect(await a.files.text("copy.bin")).toBeNull();
    expect(await a.db.outbox.count()).toBe(0); expect(await a.db.conflicts.count()).toBe(1);
  });

  it("reuses verified capture baselines on an idle sync without a second full read", async () => {
    const a = fixture.clients[0]!;
    for (let i = 0; i < 5; i++) await a.files.edit(`idle-${i}.md`, "unchanged");
    expect((await a.engine.sync()).errors).toEqual([]);
    a.files.stat = async path => { const value = await stat(a.files.path(path)); return { size: value.size }; };
    let reads = 0; a.files.hook = async operation => { if (operation === "read") reads++; };
    const seq = (await fixture.transport(0).handshake()).seq;
    expect((await a.engine.sync()).errors).toEqual([]);
    expect((await fixture.transport(0).handshake()).seq).toBe(seq); expect(reads).toBe(5);
  });
});
