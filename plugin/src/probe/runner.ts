import { timerHost } from "../runtime/timers";
import { apiVersion, Platform, type App } from "obsidian";
import { ALLOWED_SIZES, fixture, verifyFixture } from "./fixtures";
import { ProbeStore } from "./store";
import { runWorkerProbe } from "./worker-client";

export interface ProbeOptions { deviceLabel: string; model: string; osVersion: string; sizeMiB: number }
export interface ProbeStep {
  name: string;
  status: "running" | "pass" | "fail" | "unverified";
  elapsedMs?: number;
  details?: Record<string, unknown>;
}
export interface ProbeReport {
  format: 1;
  build: "0.0.1";
  runId: string;
  session: string;
  started: string;
  finished?: string;
  options: ProbeOptions;
  environment: Record<string, unknown>;
  steps: ProbeStep[];
  interruption: "running-or-interrupted" | "finished" | "cancelled";
  maxTimerGapMs?: number;
}
export const LOCAL_NAME = "obsidian-sync-probe-local";
export const uid = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
};
async function mkdir(app: App, path: string): Promise<void> {
  if (!await app.vault.adapter.exists(path)) await app.vault.adapter.mkdir(path);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function platformName(): string {
  if (Platform.isIosApp) return "iOS";
  if (Platform.isAndroidApp) return "Android";
  return "Desktop";
}

export class ProbeRunner {
  private abort = new AbortController();
  private stopped = false;
  constructor(private app: App, readonly session: string) {}
  cancel(): void { this.stopped = true; this.abort.abort(); }

  async run(options: ProbeOptions, progress: (step: ProbeStep) => void): Promise<{ report: ProbeReport; path: string }> {
    options = structuredClone(options);
    if (!(ALLOWED_SIZES as readonly number[]).includes(options.sizeMiB)) throw new Error("Unsupported fixture size");
    const app = this.app;
    const root = `${app.vault.configDir}/${LOCAL_NAME}`;
    await mkdir(app, root); await mkdir(app, `${root}/reports`);
    const identityPath = `${root}/identity.json`;
    let databaseId: string;
    if (await app.vault.adapter.exists(identityPath)) {
      databaseId = (JSON.parse(await app.vault.adapter.read(identityPath)) as { databaseId: string }).databaseId;
      if (!/^[a-f0-9]{32}$/.test(databaseId)) throw new Error("Invalid probe identity; preserve files and inspect manually");
    } else {
      databaseId = uid(); await app.vault.adapter.write(identityPath, JSON.stringify({ databaseId }));
    }
    const runId = uid();
    const path = `${root}/reports/${runId}.json`;
    const report: ProbeReport = {
      format: 1, build: "0.0.1", runId, session: this.session, started: new Date().toISOString(), options,
      environment: {
        apiVersion, isMobile: Platform.isMobile, isIosApp: Platform.isIosApp, isAndroidApp: Platform.isAndroidApp,
        platform: platformName(),
        peakProcessMemory: "unmeasured: requires native profiler; JS heap samples are not process peak memory",
        sourceReadMode: "whole-file ArrayBuffer (not streaming)",
      }, steps: [], interruption: "running-or-interrupted",
    };
    const persist = () => app.vault.adapter.write(path, JSON.stringify(report, null, 2));
    await persist();
    await app.vault.adapter.write(`${root}/last-run.json`, JSON.stringify({ path }));
    const step = async (name: string, task: () => Promise<Record<string, unknown>>) => {
      if (this.stopped) return;
      const row: ProbeStep = { name, status: "running" }; report.steps.push(row);
      await persist(); progress(row);
      const start = performance.now();
      try { row.details = await task(); row.status = this.stopped || row.details.available === false ? "unverified" : "pass"; }
      catch (error) { row.status = "fail"; row.details = { error: message(error) }; }
      row.elapsedMs = performance.now() - start; await persist(); progress(row);
    };
    let previous = performance.now(); let maxGap = 0;
    const timer = timerHost().setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; }, 100);
    const store = new ProbeStore(`obsidian-sync-probe-${databaseId}`);
    const fixtureRoot = `ObsidianSync-Probe-${runId}`;
    try {
      await step("IndexedDB: transaction rollback + commit + previous-session marker", async () => {
        await store.open();
        const transactions = await store.verifyTransactions();
        const markers = await store.markers.toArray();
        const previousSession = markers.filter(m => m.session !== this.session);
        await store.markers.put({ id: runId, session: this.session, created: new Date().toISOString(), token: `public-probe-${runId}` });
        return { ...transactions, previousSessionMarkers: previousSession.length,
          restartPersistence: previousSession.length ? "previous plugin session marker readable; confirm app was force-quit" : "unverified: force-quit and rerun" };
      });
      await step("Worker + minimal WASM execution", () => runWorkerProbe("ping", this.abort.signal));
      await step("Worker: Argon2id 64 MiB + XChaCha20-Poly1305", () => runWorkerProbe("crypto", this.abort.signal));
      await step("Vault API: synthetic text + guarded process", async () => {
        await app.vault.createFolder(fixtureRoot);
        const original = "# 同步探针 🐇\nOnly synthetic data.\n";
        const file = await app.vault.create(`${fixtureRoot}/probe.md`, original);
        let changed = false;
        await app.vault.process(file, current => {
          if (current !== original) throw new Error("Unexpected concurrent change; preserve current bytes");
          changed = true; return `${current}Guarded update.\n`;
        });
        if (!changed || await app.vault.read(file) !== `${original}Guarded update.\n`) throw new Error("Vault.process roundtrip mismatch");
        return { guardedProcess: true };
      });
      await step(`Vault API: ${options.sizeMiB} MiB binary whole-file write/read`, async () => {
        // Sequential write/read; the source is still a whole-file buffer, with platform-internal copies unknown.
        if (!app.vault.getFolderByPath(fixtureRoot)) await app.vault.createFolder(fixtureRoot);
        let source: ArrayBuffer | undefined = fixture(options.sizeMiB);
        const writeStart = performance.now();
        const file = await app.vault.createBinary(`${fixtureRoot}/synthetic.bin`, source);
        const writeMs = performance.now() - writeStart; source = undefined;
        const readStart = performance.now();
        const read = await app.vault.readBinary(file); const readMs = performance.now() - readStart;
        verifyFixture(read, options.sizeMiB);
        return { sizeMiB: options.sizeMiB, writeMs, readMs, verifiedEveryByte: true, streaming: false };
      });
      await step(`Adapter: ${options.sizeMiB} MiB hidden local write/read`, async () => {
        const localPath = `${root}/synthetic-${runId}.bin`;
        let source: ArrayBuffer | undefined = fixture(options.sizeMiB);
        const writeStart = performance.now(); await app.vault.adapter.writeBinary(localPath, source);
        const writeMs = performance.now() - writeStart; source = undefined;
        const readStart = performance.now(); const read = await app.vault.adapter.readBinary(localPath);
        const readMs = performance.now() - readStart; verifyFixture(read, options.sizeMiB);
        return { writeMs, readMs, verifiedEveryByte: true, streaming: false, retainedForInspection: true };
      });
      await step("SecretStorage: synthetic token only", async () => {
        const storage = app.secretStorage;
        if (!storage || typeof storage.setSecret !== "function" || typeof storage.getSecret !== "function") {
          return { available: false, rememberUnlock: "unverified / unavailable; product remains session-only" };
        }
        const secretId = "obsidian-sync-probe-synthetic";
        // Fixed PUBLIC marker, never a real passphrase/key. Inspect only our single ID.
        const previous = storage.getSecret(secretId);
        const token = "PUBLIC-TEST-TOKEN-NO-SECRET";
        if (previous !== null && previous !== token) throw new Error("Probe token ID already occupied; existing value preserved");
        storage.setSecret(secretId, token);
        if (storage.getSecret(secretId) !== token) throw new Error("SecretStorage immediate roundtrip failed");
        return { available: true, roundtrip: true, previousPublicMarker: previous === token,
          rememberUnlock: "unverified: API success proves neither iOS Keychain protection nor device-local storage",
          cleanup: "public marker retained for restart check; remove in Settings > Keychain after test" };
      });
      report.steps.push({ name: "Native memory / iOS locked-device key protection / force-quit recovery", status: "unverified",
        details: { next: "Follow docs/testing/mobile-probe.md; attach native memory evidence and restart report" } });
    } finally {
      timerHost().clearInterval(timer); store.close(); report.maxTimerGapMs = maxGap;
      report.finished = new Date().toISOString(); report.interruption = this.stopped ? "cancelled" : "finished";
      await persist();
    }
    return { report, path };
  }
}
