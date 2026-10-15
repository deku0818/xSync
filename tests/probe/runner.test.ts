import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { ProbeStore } from "../../plugin/src/probe/store";

vi.mock("obsidian", () => ({ apiVersion: "test", Platform: { isMobile: true, isIosApp: true, isAndroidApp: false } }));
vi.mock("../../plugin/src/probe/worker-client", () => ({ runWorkerProbe: vi.fn(async () => ({ syntheticWorker: true })) }));
import { ProbeRunner, LOCAL_NAME, type ProbeOptions } from "../../plugin/src/probe/runner";

function testApp() {
  const files = new Map<string, string | ArrayBuffer>();
  const folders = new Set(["custom-config"]);
  const secrets = new Map<string, string>();
  const adapter = {
    exists: async (path: string) => files.has(path) || folders.has(path),
    mkdir: async (path: string) => { folders.add(path); },
    read: async (path: string) => { const data = files.get(path); if (typeof data !== "string") throw new Error("missing text"); return data; },
    write: async (path: string, data: string) => { files.set(path, data); },
    readBinary: async (path: string) => { const data = files.get(path); if (!(data instanceof ArrayBuffer)) throw new Error("missing binary"); return data.slice(0); },
    writeBinary: async (path: string, data: ArrayBuffer) => { files.set(path, data.slice(0)); },
  };
  const app = {
    vault: {
      configDir: "custom-config", adapter,
      createFolder: async (path: string) => { folders.add(path); },
      getFolderByPath: (path: string) => folders.has(path),
      create: async (path: string, data: string) => { await adapter.write(path, data); return { path }; },
      read: async (file: { path: string }) => adapter.read(file.path),
      process: async (file: { path: string }, fn: (current: string) => string) => { await adapter.write(file.path, fn(await adapter.read(file.path))); },
      createBinary: async (path: string, data: ArrayBuffer) => { await adapter.writeBinary(path, data); return { path }; },
      readBinary: async (file: { path: string }) => adapter.readBinary(file.path),
    },
    secretStorage: { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } },
  } as unknown as App;
  return { app, files };
}

it("probe touches only synthetic fixtures/local reports, honours configDir, persists stage and reads previous-session marker", async () => {
  vi.stubGlobal("navigator", { userAgent: "unit-test-not-ios" });
  const { app, files } = testApp();
  const root = `custom-config/${LOCAL_NAME}`;
  try {
    const first = await new ProbeRunner(app, "session-1").run({ deviceLabel: "iPhone", model: "test", osVersion: "test", sizeMiB: 1 }, () => {});
    expect(first.report.steps.filter(s => s.status === "fail")).toEqual([]);
    expect(first.report.steps.at(-1)?.status).toBe("unverified");
    expect(first.report.environment.sourceReadMode).toContain("not streaming");
    expect(first.report.environment.platform).toBe("iOS");
    const second = await new ProbeRunner(app, "session-2").run({ deviceLabel: "iPhone", model: "test", osVersion: "test", sizeMiB: 1 }, () => {});
    expect(second.report.steps[0]?.details?.previousSessionMarkers).toBe(1);
    expect(second.report.interruption).toBe("finished");
    expect(JSON.parse(files.get(second.path) as string).finished).toBeDefined();
    expect([...files.keys()].every(path => path.startsWith(`${root}/`) || /^ObsidianSync-Probe-[a-f0-9]{32}\//.test(path))).toBe(true);
  } finally {
    const identity = JSON.parse(files.get(`${root}/identity.json`) as string) as { databaseId: string };
    await new ProbeStore(`obsidian-sync-probe-${identity.databaseId}`).delete(); vi.unstubAllGlobals();
  }
});

it("freezes run options and cancellation skips file/secret work after the current step", async () => {
  vi.stubGlobal("navigator", { userAgent: "unit-test" });
  const { app, files } = testApp();
  const runner = new ProbeRunner(app, "cancel-session");
  const options: ProbeOptions = { deviceLabel: "iPhone", model: "test", osVersion: "test", sizeMiB: 1 };
  try {
    const result = await runner.run(options, () => { options.sizeMiB = 128; runner.cancel(); });
    expect(result.report.options.sizeMiB).toBe(1);
    expect(result.report.interruption).toBe("cancelled");
    expect([...files.keys()].some(path => path.startsWith("ObsidianSync-Probe-"))).toBe(false);
    expect([...files.keys()].some(path => path.endsWith(".bin"))).toBe(false);
  } finally {
    const identity = JSON.parse(files.get(`custom-config/${LOCAL_NAME}/identity.json`) as string) as { databaseId: string };
    await new ProbeStore(`obsidian-sync-probe-${identity.databaseId}`).delete(); vi.unstubAllGlobals();
  }
});
