import "fake-indexeddb/auto"; // Node peer only. The spawned Chrome client uses native IndexedDB.
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { fingerprint } from "../../plugin/src/sync/crypto";
import type { EngineStatus } from "../../plugin/src/sync/engine";
import { RecoveryFixture } from "./recovery-support";
import { NativeRecoveryBrowser } from "./recovery-browser-support";

const chrome = process.env.OBSIDIAN_SYNC_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
describe.skipIf(process.env.OBSIDIAN_SYNC_BROWSER_TEST !== "1")("native IndexedDB + private headless Chrome SIGKILL + real files/Go/Docker PG", () => {
  let fixture: RecoveryFixture, browser: NativeRecoveryBrowser;
  beforeEach(async () => {
    if (!existsSync(chrome)) throw new Error("Set OBSIDIAN_SYNC_CHROME to an installed Chrome/Chromium executable");
    fixture = new RecoveryFixture(); await fixture.open(); await fixture.client(0);
    browser = new NativeRecoveryBrowser(fixture, chrome); await browser.open();
  }, 60000);
  afterEach(async () => { await browser?.close(); await fixture?.close(); }, 15000);
  it.each(["before-baseline-bootstrap-commit", "after-baseline-bootstrap-commit"])("retries a legacy baseline migration after actual process kill at %s", async point => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "old displayed baseline"); await a.engine.sync();
    expect((await browser.evaluate<EngineStatus>("recovery.sync()")).errors).toEqual([]);
    await browser.evaluate("recovery.legacyCheckpoint()"); await a.files.edit("note.md", "new remote bytes"); await a.engine.sync();
    await browser.crash(point); await browser.start(120000);
    expect((await browser.evaluate<EngineStatus>("recovery.sync()")).errors).toEqual([]);
    expect(await browser.files.text("note.md")).toBe("new remote bytes");
    expect(await browser.evaluate("recovery.summary('note.md').then(s => s.status.state)")).toBe("complete");
  }, 30000);
  it("preserves native offline edits after real server ciphertext and log retirement", async () => {
    const a = fixture.clients[0]!; await a.files.edit("note.md", "common native base"); await a.engine.sync();
    expect((await browser.evaluate<EngineStatus>("recovery.sync()")).errors).toEqual([]);
    await browser.files.edit("note.md", "native offline edit");
    await a.files.edit("note.md", "peer concurrent edit"); await a.engine.sync();
    await fixture.collectExpired(); await fixture.retireLogs(); await browser.kill(); await browser.start(120000);
    const status = await browser.evaluate<EngineStatus>("recovery.sync()");
    expect(status.errors).toEqual([]); expect(status.conflicts).toBe(1);
    expect(await browser.files.text("note.md")).toBe("native offline edit");
    const remote = fixture.transport(0); expect((await remote.snapshot()).files[0]!.heads).toHaveLength(2); await remote.releaseSnapshots();
  }, 30000);
  it.each(["before-snapshot-commit", "after-snapshot-commit", "after-continuity-intent-commit", "after-continuity-response", "before-continuity-confirm-commit", "after-continuity-confirm-commit", "before-outbox-commit", "after-outbox-commit", "after-object-upload", "after-remote-commit", "after-outbox-ack", "before-local-request-ack-commit", "after-local-request-ack-commit", "before-request-ack-send", "after-request-ack-send", "after-legacy-registration-response", "before-local-migration-commit", "after-local-migration-commit", "after-object-registration-response", "before-local-object-migration-commit", "after-local-object-migration-commit", "before-local-metadata-cleanup-commit", "after-local-metadata-cleanup-commit", "before-local-cleanup-commit", "after-local-cleanup-commit", "before-stage-remove", "after-stage-remove"])("survives an actual client process kill at %s", async point => {
    await browser.files.edit("note.md", "native outbound crash proof"); await browser.crash(point); await browser.start(120000);
    expect((await browser.evaluate<EngineStatus>("recovery.sync()")).errors).toEqual([]);
    const a = fixture.clients[0]!; expect((await a.engine.sync()).errors).toEqual([]); expect(await a.files.text("note.md")).toBe("native outbound crash proof");
    const s = await fixture.transport(0).snapshot(); expect(s.revisions).toHaveLength(1); expect(s.files).toHaveLength(1);
    expect(await browser.evaluate("recovery.summary('note.md').then(s => s.status.state)")).toBe("complete");
    expect(await browser.files.stageList()).toEqual([]);
    expect(await browser.evaluate("recovery.summary('note.md').then(s => s.requestAcks)")).toBe(0);
    expect(await browser.evaluate("recovery.summary('note.md').then(s => s.inbox)")).toBe(0);
  }, 30000);
  it.each(["before-inbox-commit", "after-inbox-commit", "after-apply-prepare", "after-vault-write", "before-apply-ack", "after-apply-ack", "before-applied-cursor-commit", "after-applied-cursor-commit", "rename", "delete"])("recovers received data after a real process kill at %s", async point => {
    const a = fixture.clients[0]!; await a.files.edit("old.md", "native initial bytes"); await a.engine.sync();
    expect((await browser.evaluate<EngineStatus>("recovery.sync()")).errors).toEqual([]);
    if (point === "rename") { await rename(a.files.path("old.md"), a.files.path("new.md")); await a.engine.rename("old.md", "new.md"); }
    else if (point === "delete") await unlink(a.files.path("old.md")); else await a.files.edit("old.md", "native updated bytes");
    await a.engine.sync(); await browser.crash(point === "rename" ? "after-vault-rename" : point === "delete" ? "after-vault-write" : point); await browser.start(120000);
    expect((await browser.evaluate<EngineStatus>("recovery.sync()")).errors).toEqual([]);
    const path = point === "rename" ? "new.md" : "old.md";
    const summary = await browser.evaluate<{ hash: string | null; tasks: number; status: EngineStatus; progress: { applied: number; received: number } }>(`recovery.summary(${JSON.stringify(path)})`);
    expect(summary.tasks).toBe(0); expect(summary.status.state).toBe("complete"); expect(summary.progress.applied).toBe(summary.progress.received);
    expect(summary.hash).toBe(point === "delete" ? null : await fingerprint(new TextEncoder().encode(point === "rename" ? "native initial bytes" : "native updated bytes")));
    if (point === "rename") expect(await browser.files.text("old.md")).toBeNull();
  }, 30000);
});
