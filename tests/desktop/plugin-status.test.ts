import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import type { EngineStatus, Review, SyncEngine } from "../../plugin/src/sync/engine";

const host = vi.hoisted(() => ({ labels: [] as string[], ribbon: { dataset: {} as Record<string, string>, addClass() {}, setAttribute: vi.fn() } }));
vi.mock("obsidian", () => ({
  Plugin: class {
    constructor(public app: unknown) {}
    addStatusBarItem() { return { addClass() {}, setAttribute() {}, dataset: {}, setText: (text: string) => { host.labels.push(text); } }; }
    addRibbonIcon() { return host.ribbon; } addCommand() {} addSettingTab() {} registerDomEvent() {}
  },
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {}, requestUrl: vi.fn(),
}));
import ObsidianSyncPlugin from "../../plugin/src/sync-main";

beforeEach(() => { host.labels.length = 0; host.ribbon.dataset = {}; host.ribbon.setAttribute.mockClear(); });
afterEach(() => { vi.useRealTimers(); });
const review = { fileId: "F", path: "test.md", heads: ["A", "B"], versions: [], location: { revision: "L", pathKey: "opaque", encryptedPath: "cipher" } } satisfies Review;
async function plugin() {
  const app = { vault: { configDir: ".obsidian", adapter: { read: async () => { throw new Error("no fixture config"); } } } } as unknown as App;
  const instance = new ObsidianSyncPlugin(app, { id: "test", name: "test", version: "0", minAppVersion: "1", description: "test", author: "test" } as PluginManifest);
  await instance.onload(); return instance;
}
it("publishes completion immediately after explicit resolution, without a second sync", async () => {
  const instance = await plugin();
  const resolve = vi.fn(async () => {}); const sync = vi.fn();
  const status: EngineStatus = { state: "complete", outbox: 0, inbox: 0, conflicts: 0, errors: [] };
  instance.engine = { unlocked: true, resolve, sync, status: async () => status } as unknown as SyncEngine;
  await instance.resolveConflict(review, "A", "copy.md");
  expect(resolve).toHaveBeenCalledWith(review, "A", "copy.md");
  expect(host.labels.at(-1)).toBe("xSync · 已同步"); expect(sync).not.toHaveBeenCalled();
});
it("keeps needs-attention on stale choice and releases the host gate for later work", async () => {
  const instance = await plugin(); const stale = new Error("REVIEW_STALE");
  const resolve = vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce(undefined);
  const status: EngineStatus = { state: "needs-attention", outbox: 0, inbox: 2, conflicts: 1, errors: [] };
  instance.engine = { unlocked: true, resolve, status: async () => status } as unknown as SyncEngine;
  await expect(instance.resolveConflict(review, "A")).rejects.toBe(stale);
  expect(host.labels.at(-1)).toBe("xSync · 1 个文件有冲突");
  status.state = "complete"; status.conflicts = 0; status.inbox = 0;
  await instance.resolveConflict(review, "B"); expect(host.labels.at(-1)).toBe("xSync · 已同步");
});
it("replaces the previous warning during a long upload and refreshes progress before the run ends", async () => {
  vi.useFakeTimers();
  const instance = await plugin();
  let status: EngineStatus = { state: "needs-attention", outbox: 313, inbox: 6, conflicts: 0, errors: ["OFFLINE"] };
  let finish!: (status: EngineStatus) => void;
  const sync = vi.fn(() => new Promise<EngineStatus>(resolve => { finish = resolve; }));
  instance.engine = { unlocked: true, sync, resolve: async () => {}, status: async () => status } as unknown as SyncEngine;
  await instance.resolveConflict(review, "A");
  expect(host.labels.at(-1)).toBe("xSync · 等待连接");
  const seen: number[] = []; instance.subscribe(() => { seen.push(status.outbox); });
  const run = instance.sync(false); await vi.advanceTimersByTimeAsync(0);
  expect(instance.syncing).toBe(true); expect(host.labels.at(-1)).toBe("xSync · 正在同步");
  status = { ...status, state: "pending", activity: "uploading", errors: [] };
  await vi.advanceTimersByTimeAsync(500);
  expect(host.labels.at(-1)).toBe("xSync · 正在同步");
  status = { ...status, outbox: 312 }; await vi.advanceTimersByTimeAsync(500);
  expect(seen.at(-1)).toBe(312); expect(instance.syncing).toBe(true);
  status = { state: "complete", outbox: 0, inbox: 0, conflicts: 0, errors: [] }; finish(status); await run;
  expect(instance.syncing).toBe(false); expect(host.labels.at(-1)).toBe("xSync · 已同步");
  expect(vi.getTimerCount()).toBe(0);
});
it("pause retains the active key and prevents queued sync and explicit resolution from reaching the engine", async () => {
  const instance = await plugin();
  const sync = vi.fn(); const resolve = vi.fn(); const lock = vi.fn();
  instance.engine = { unlocked: true, sync, resolve, lock, status: async () => ({ state: "complete", outbox: 0, inbox: 0, conflicts: 0, errors: [] }) } as unknown as SyncEngine;
  instance.saveData = vi.fn(async () => {});
  // A queued sync must recheck the pause flag when it gets its turn.
  const queued = instance.sync(false); await instance.setAutoSync(false); await queued;
  await instance.sync(false); await expect(instance.resolveConflict(review, "A")).rejects.toThrow("请先恢复同步");
  expect(sync).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled(); expect(lock).not.toHaveBeenCalled();
  expect(instance.engine.unlocked).toBe(true); expect(host.labels.at(-1)).toBe("xSync · 已暂停");
  await instance.setAutoSync(true); expect(lock).not.toHaveBeenCalled(); expect(instance.autoSync).toBe(true);
});
it("clears the active upload and its refresh timer when the engine unexpectedly rejects", async () => {
  vi.useFakeTimers(); const instance = await plugin();
  const status: EngineStatus = { state: "pending", activity: "uploading", outbox: 3, inbox: 0, conflicts: 0, errors: [] };
  let fail!: (error: Error) => void;
  instance.engine = { unlocked: true, status: async () => status, sync: () => new Promise<EngineStatus>((_resolve, reject) => { fail = reject; }) } as unknown as SyncEngine;
  const run = instance.sync(false); await vi.advanceTimersByTimeAsync(500);
  expect(host.labels.at(-1)).toBe("xSync · 正在同步");
  fail(new Error("INJECTED_DATABASE_CLOSED")); await run;
  expect(instance.syncing).toBe(false); expect(host.labels.at(-1)).toBe("xSync · 同步未完成");
  expect(vi.getTimerCount()).toBe(0);
});


it("marks the existing ribbon entry for conflicts so mobile users can find the decision without a popup", async () => {
  const instance = await plugin();
  const status: EngineStatus = { state: "needs-attention", outbox: 0, inbox: 1, conflicts: 1, errors: [] };
  instance.engine = { unlocked: true, resolve: async () => {}, status: async () => status } as unknown as SyncEngine;
  await instance.resolveConflict(review, "A");
  expect(host.ribbon.dataset).toMatchObject({ state: "conflict", count: "1" });
  expect(host.ribbon.setAttribute).toHaveBeenLastCalledWith("aria-label", "xSync · 1 个文件有冲突");
  status.state = "complete"; status.conflicts = 0; status.inbox = 0; await instance.resolveConflict(review, "B");
  expect(host.ribbon.dataset).toMatchObject({ state: "complete", count: "0" });
});
