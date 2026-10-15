import { beforeEach, expect, it, vi } from "vitest";
import type { App, Setting } from "obsidian";
import type ObsidianSyncPlugin from "../../plugin/src/sync-main";

const form = vi.hoisted(() => ({ mount: vi.fn(), disposals: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("obsidian", () => ({ PluginSettingTab: class {} }));
vi.mock("../../plugin/src/ui/connection-form", () => ({ connectionForm: (container: unknown, plugin: unknown) => {
  form.mount(container, plugin);
  const dispose = vi.fn(); form.disposals.push(dispose); return dispose;
} }));
import { SyncSettingTab } from "../../plugin/src/ui/settings-tab";

beforeEach(() => { form.mount.mockClear(); form.disposals = []; });

it("indexes connection and exclusion terms without reading protected settings or mounting a form", () => {
  const plugin = new Proxy({}, { get: () => { throw new Error("SEARCH_MUST_NOT_READ_CREDENTIALS"); } }) as ObsidianSyncPlugin;
  const tab = new SyncSettingTab({} as App, plugin);
  const definitions = tab.getSettingDefinitions();
  expect(definitions).toHaveLength(1);
  expect(definitions[0]).toMatchObject({ name: "同步连接与本机规则", aliases: expect.arrayContaining(["server", "key", "pause", "exclude", "regex", "密钥"]) });
  expect(form.mount).not.toHaveBeenCalled();
});

it("releases the old form on rerender and hides once without letting stale teardown close the new form", () => {
  const plugin = {} as ObsidianSyncPlugin, tab = new SyncSettingTab({} as App, plugin);
  const row = { addClass: vi.fn(), empty: vi.fn(), createDiv: vi.fn(() => ({})) };
  const definition = tab.getSettingDefinitions()[0];
  if (!definition || !("render" in definition) || !definition.render) throw new Error("Missing form definition");
  const teardown = definition.render({ settingEl: row } as unknown as Setting, {} as never);
  expect(form.mount).toHaveBeenCalledWith(expect.anything(), plugin);
  const first = form.disposals[0]!;
  definition.render({ settingEl: row } as unknown as Setting, {} as never);
  expect(first).toHaveBeenCalledTimes(1);
  if (typeof teardown === "function") teardown();
  expect(form.disposals[1]).not.toHaveBeenCalled();
  tab.hide(); tab.hide();
  expect(form.disposals[1]).toHaveBeenCalledTimes(1);
});
