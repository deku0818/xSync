import { beforeEach, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import type { EngineStatus, Review, SyncEngine } from "../../plugin/src/sync/engine";

const host = vi.hoisted(() => ({ labels: [] as string[] }));
vi.mock("obsidian", () => ({
  Plugin: class {
    constructor(public app: unknown) {}
    addStatusBarItem() { return { setText: (text: string) => { host.labels.push(text); } }; }
    addRibbonIcon() {} addCommand() {} addSettingTab() {}
  },
  Modal: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {}, requestUrl: vi.fn(),
}));
import ObsidianSyncPlugin from "../../plugin/src/sync-main";

beforeEach(() => { host.labels.length = 0; });
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
  instance.engine = { resolve, sync, status: async () => status } as unknown as SyncEngine;
  await instance.resolveConflict(review, "A", "copy.md");
  expect(resolve).toHaveBeenCalledWith(review, "A", "copy.md");
  expect(host.labels.at(-1)).toBe("ObsidianSync · 所选范围同步完成"); expect(sync).not.toHaveBeenCalled();
});
it("keeps needs-attention on stale choice and releases the host gate for later work", async () => {
  const instance = await plugin(); const stale = new Error("REVIEW_STALE");
  const resolve = vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce(undefined);
  const status: EngineStatus = { state: "needs-attention", outbox: 0, inbox: 2, conflicts: 1, errors: [] };
  instance.engine = { resolve, status: async () => status } as unknown as SyncEngine;
  await expect(instance.resolveConflict(review, "A")).rejects.toBe(stale);
  expect(host.labels.at(-1)).toBe("ObsidianSync · 需处理");
  status.state = "complete"; status.conflicts = 0; status.inbox = 0;
  await instance.resolveConflict(review, "B"); expect(host.labels.at(-1)).toBe("ObsidianSync · 所选范围同步完成");
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
  expect(instance.engine.unlocked).toBe(true); expect(host.labels.at(-1)).toBe("ObsidianSync · 已暂停同步");
  await instance.setAutoSync(true); expect(lock).not.toHaveBeenCalled(); expect(instance.autoSync).toBe(true);
});
