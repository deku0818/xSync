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
  }, 30000);
  afterEach(async () => { await browser?.close(); await fixture?.close(); }, 15000);
  it.each(["before-snapshot-commit", "after-snapshot-commit", "before-outbox-commit", "after-outbox-commit", "after-object-upload", "after-remote-commit", "after-outbox-ack"])("survives an actual client process kill at %s", async point => {
    await browser.files.edit("note.md", "native outbound crash proof"); await browser.crash(point); await browser.start(120000);
    expect((await browser.evaluate<EngineStatus>("recovery.sync()")).errors).toEqual([]);
    const a = fixture.clients[0]!; expect((await a.engine.sync()).errors).toEqual([]); expect(await a.files.text("note.md")).toBe("native outbound crash proof");
    const s = await fixture.transport(0).snapshot(); expect(s.revisions).toHaveLength(1); expect(s.files).toHaveLength(1);
    expect(await browser.evaluate("recovery.summary('note.md').then(s => s.status.state)")).toBe("complete");
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
