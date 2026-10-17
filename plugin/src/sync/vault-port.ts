import { MarkdownView, TFile, type App } from "obsidian";
import { bytesEqual, canonicalPath } from "./crypto";
import { fixedExclusion, HARD_FILE_BYTES, SyncPolicy, type FileEntry } from "./policy";
import { sharedConfig, mergeConfig, hasDeviceFields } from "./config-projection";
import type { FilePort } from "./engine";
import { SHARED_CONFIG_ROOT, SHARED_CONFIG_PREFIX, isSharedConfigPath } from "./config-path";

/** Vault API for visible files; Adapter for the actual Vault.configDir. No Node/Electron dependency. */
export class ObsidianVaultPort implements FilePort {
  private ownRenames = new Map<string, number>();
  private ownWrites = new Set<string>();
  configurationChanged = false;
  cachedInventory: FileEntry[] = [];
  constructor(private app: App, private localRoot: string, private policy: () => SyncPolicy = () => new SyncPolicy()) {}
  private editors(path: string): MarkdownView[] {
    return this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).filter((view): view is MarkdownView =>
      view instanceof MarkdownView && view.file?.path === path && view.getMode() === "source" && this.inScope(path));
  }
  private editorMatches(view: MarkdownView, bytes: Uint8Array): boolean {
    // CodeMirror uses LF even when an unchanged file still contains CRLF on disk.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n") === view.editor.getValue();
  }
  async flushEdits(path: string): Promise<void> {
    for (const view of this.editors(path)) {
      await view.save(); // The host skips unchanged data and may already have another save in flight.
      if (view.file && !this.editorMatches(view, new Uint8Array(await this.app.vault.readBinary(view.file)))) {
        throw new Error("LOCAL_EDITOR_CHANGES_PENDING");
      }
    }
  }
  private assertEditorUnchanged(path: string, expected: Uint8Array): void {
    for (const view of this.editors(path)) if (!this.editorMatches(view, expected)) throw new Error("LOCAL_CHANGED_DURING_APPLY");
  }
  logical(path: string): string { const dir = this.app.vault.configDir; return path === dir ? SHARED_CONFIG_ROOT : path.startsWith(`${dir}/`) ? `${SHARED_CONFIG_PREFIX}${path.slice(dir.length + 1)}` : path; }
  private physical(path: string): string { return path === SHARED_CONFIG_ROOT ? this.app.vault.configDir : isSharedConfigPath(path) ? `${this.app.vault.configDir}/${path.slice(SHARED_CONFIG_PREFIX.length)}` : path; }
  isOwnRename(from: string, to: string): boolean { const key = `${from}\0${to}`; const at = this.ownRenames.get(key); this.ownRenames.delete(key); return at !== undefined && Date.now() - at < 60000; }
  inScope(path: string): boolean { return !this.policy().reason(this.logical(path)); }
  isOwnWrite(path: string): boolean { return this.ownWrites.has(this.logical(path)); }
  private async writing(path: string, task: () => Promise<void>): Promise<void> { this.ownWrites.add(path); try { await task(); if (isSharedConfigPath(path)) this.configurationChanged = true; } finally { this.ownWrites.delete(path); } }
  async inventory(): Promise<FileEntry[]> {
    const dir = this.app.vault.configDir; const adapter = this.app.vault.adapter;
    const entries: FileEntry[] = this.app.vault.getFiles().filter(f => f.path !== dir && !f.path.startsWith(`${dir}/`) && !f.path.split("/").some(p => p.startsWith("."))).map(f => ({ path: f.path, size: f.stat?.size ?? 0 }));
    const walk = async (physical: string, depth: number): Promise<void> => {
      if (depth > 32 || entries.length > 100000) throw new Error("CONFIG_SCAN_LIMIT");
      const listing = await adapter.list(physical);
      for (const folder of listing.folders) {
        if (!folder.startsWith(`${physical}/`)) throw new Error("UNSAFE_ADAPTER_LIST");
        const path = this.logical(folder); canonicalPath(path);
        const reason = fixedExclusion(path);
        if (reason) entries.push({ path, size: 0, directory: true, reason }); else await walk(folder, depth + 1);
      }
      for (const file of listing.files) {
        if (!file.startsWith(`${physical}/`)) throw new Error("UNSAFE_ADAPTER_LIST");
        const path = this.logical(file);
        // Other hidden files remain device local and never reach path crypto.
        const fixed = fixedExclusion(path); if (fixed) { entries.push({ path, size: 0, reason: fixed }); continue; }
        canonicalPath(path); const stat = await adapter.stat(file); if (!stat || stat.type !== "file") throw new Error("CONFIG_SCAN_CHANGED");
        entries.push({ path, size: stat.size });
      }
    };
    if (await adapter.exists(dir)) await walk(dir, 0);
    this.cachedInventory = entries.map(e => ({ ...e, reason: e.reason ?? this.policy().reason(e.path, e.size, e.directory) }));
    return this.cachedInventory;
  }
  async excludedChildren(path: string): Promise<FileEntry[]> {
    canonicalPath(path); const physical = this.physical(path); const listing = await this.app.vault.adapter.list(physical);
    if ([...listing.folders, ...listing.files].some(p => !p.startsWith(`${physical}/`))) throw new Error("UNSAFE_ADAPTER_LIST");
    return [...listing.folders.map(p => ({ path: this.logical(p), size: 0, directory: true })), ...await Promise.all(listing.files.map(async p => ({ path: this.logical(p), size: (await this.app.vault.adapter.stat(p))?.size ?? 0 })))];
  }
  async configurationStamp(): Promise<string> {
    const inventory = await this.inventory(); const adapter = this.app.vault.adapter;
    const values = await Promise.all(inventory.filter(e => isSharedConfigPath(e.path) && !e.directory && !e.reason).map(async e => { const stat = await adapter.stat(this.physical(e.path)); return `${e.path}:${stat?.size}:${stat?.mtime}`; }));
    return values.sort().join("\n");
  }
  async list(): Promise<string[]> { return (await this.inventory()).filter(e => !e.directory && !fixedExclusion(e.path)).map(e => e.path).sort(); }
  async stat(path: string): Promise<{ size: number } | null> { canonicalPath(path); const stat = await this.app.vault.adapter.stat(this.physical(path)); return stat?.type === "file" ? { size: stat.size } : null; }
  private permitted(path: string): void { canonicalPath(path); if (fixedExclusion(path)) throw new Error("DEVICE_LOCAL_PATH"); }
  async read(path: string): Promise<Uint8Array | null> {
    this.permitted(path); const physical = this.physical(path);
    if (isSharedConfigPath(path)) {
      const stat = await this.app.vault.adapter.stat(physical); if (!stat) return null; if (stat.type !== "file") throw new Error("EXPECTED_FILE");
      if (stat.size > HARD_FILE_BYTES) throw new Error("FILE_TOO_LARGE");
      return sharedConfig(path, new Uint8Array(await this.app.vault.adapter.readBinary(physical)));
    }
    const file = this.app.vault.getFileByPath(path);
    if (!file) { if (await this.app.vault.adapter.exists(path)) throw new Error("VAULT_INDEX_NOT_READY"); return null; }
    if (file.stat.size > HARD_FILE_BYTES) throw new Error("FILE_TOO_LARGE");
    return new Uint8Array(await this.app.vault.readBinary(file));
  }
  private async parents(path: string): Promise<void> {
    const parts = this.physical(path).split("/"); parts.pop(); let parent = "";
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      if (isSharedConfigPath(path)) { if (!await this.app.vault.adapter.exists(parent)) await this.app.vault.adapter.mkdir(parent); }
      else if (!this.app.vault.getFolderByPath(parent)) await this.app.vault.createFolder(parent);
    }
  }
  async write(path: string, desired: Uint8Array, expected: Uint8Array | null): Promise<void> {
    this.permitted(path);
    await this.writing(path, async () => {
      await this.parents(path);
      if (isSharedConfigPath(path)) {
        const adapter = this.app.vault.adapter; const physical = this.physical(path);
        if (expected !== null && path.endsWith(".json") && typeof adapter.process === "function") {
          const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
          await adapter.process(physical, current => { const raw = encoder.encode(current); if (!bytesEqual(sharedConfig(path, raw), expected)) throw new Error("LOCAL_CHANGED_DURING_APPLY"); return decoder.decode(mergeConfig(path, raw, desired)); });
        } else {
          const raw = await adapter.exists(physical) ? new Uint8Array(await adapter.readBinary(physical)) : null;
          const current = raw ? sharedConfig(path, raw) : null;
          if (expected === null ? current !== null : current === null || !bytesEqual(current, expected)) throw new Error("LOCAL_CHANGED_DURING_APPLY");
          await adapter.writeBinary(physical, mergeConfig(path, raw, desired).slice().buffer);
        }
        if (!bytesEqual((await this.read(path))!, desired)) throw new Error("CONFIG_WRITE_CHANGED");
        return;
      }
      const file = this.app.vault.getFileByPath(path);
      if (expected === null) { if (file || await this.app.vault.adapter.exists(path)) throw new Error("TARGET_OCCUPIED"); await this.app.vault.createBinary(path, desired.slice().buffer); return; }
      if (!file) throw new Error("SOURCE_MISSING");
      if (/\.(md|txt|json|canvas|css|js|ts|yaml|yml|xml|html|csv)$/i.test(path)) {
        const decode = new TextDecoder("utf-8", { fatal: true }); const previous = decode.decode(expected); const next = decode.decode(desired);
        await this.app.vault.process(file, current => { if (current !== previous) throw new Error("LOCAL_CHANGED_DURING_APPLY"); this.assertEditorUnchanged(path, expected); return next; });
      } else { if (!bytesEqual(new Uint8Array(await this.app.vault.readBinary(file)), expected)) throw new Error("LOCAL_CHANGED_DURING_APPLY"); await this.app.vault.modifyBinary(file, desired.slice().buffer); }
    });
  }
  async rename(from: string, to: string, expected: Uint8Array): Promise<void> {
    this.permitted(from); this.permitted(to); await this.parents(to);
    if (!bytesEqual((await this.read(from)) ?? new Uint8Array(), expected)) throw new Error("LOCAL_CHANGED_DURING_RENAME");
    if (await this.app.vault.adapter.exists(this.physical(to))) throw new Error("TARGET_OCCUPIED");
    if (isSharedConfigPath(from) || isSharedConfigPath(to)) { if (!isSharedConfigPath(from) || !isSharedConfigPath(to)) throw new Error("CONFIG_MOVE_BOUNDARY"); await this.app.vault.adapter.rename(this.physical(from), this.physical(to)); this.configurationChanged = true; return; }
    const source = this.app.vault.getFileByPath(from); if (!source) throw new Error("SOURCE_MISSING");
    this.assertEditorUnchanged(from, expected);
    this.ownRenames.set(`${from}\0${to}`, Date.now()); await this.app.vault.rename(source, to);
  }
  async remove(path: string, expected: Uint8Array): Promise<void> {
    this.permitted(path);
    await this.writing(path, async () => {
      const current = await this.read(path); if (!current || !bytesEqual(current, expected)) throw new Error("LOCAL_CHANGED_DURING_DELETE");
      if (isSharedConfigPath(path)) {
        const physical = this.physical(path); const raw = new Uint8Array(await this.app.vault.adapter.readBinary(physical));
        if (hasDeviceFields(path, raw)) throw new Error("CONFIG_DELETE_HAS_DEVICE_FIELDS");
        await this.app.vault.adapter.trashLocal(physical); return;
      }
      const file = this.app.vault.getFileByPath(path); if (!file) throw new Error("SOURCE_MISSING"); this.assertEditorUnchanged(path, expected); await this.app.fileManager.trashFile(file);
    });
  }
  private stage(id: string): string { if (!/^(?:c_)?[a-f0-9]{64}$/.test(id)) throw new Error("INVALID_STAGE_ID"); return `${this.localRoot}/staging/${id}`; }
  async stageWrite(id: string, ciphertext: Uint8Array): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!await adapter.exists(`${this.localRoot}/staging`)) await adapter.mkdir(`${this.localRoot}/staging`);
    const path = this.stage(id); if (await adapter.exists(path)) { if (!bytesEqual(new Uint8Array(await adapter.readBinary(path)), ciphertext)) throw new Error("STAGE_IMMUTABLE"); return; }
    await adapter.writeBinary(path, ciphertext.slice().buffer); if (!bytesEqual(new Uint8Array(await adapter.readBinary(path)), ciphertext)) throw new Error("STAGE_WRITE_INCOMPLETE");
  }
  async stageRead(id: string): Promise<Uint8Array> { return new Uint8Array(await this.app.vault.adapter.readBinary(this.stage(id))); }
  async stageList(): Promise<string[]> {
    const root = `${this.localRoot}/staging`; const adapter = this.app.vault.adapter;
    if (!await adapter.exists(root)) return [];
    const listing = await adapter.list(root);
    return listing.files.flatMap(path => {
      const id = path.slice(root.length + 1);
      return /^(?:c_)?[a-f0-9]{64}$/.test(id) && path === this.stage(id) ? [id] : [];
    });
  }
  async stageRemove(id: string): Promise<void> {
    const path = this.stage(id); const adapter = this.app.vault.adapter;
    const stat = await adapter.stat(path);
    if (!stat) return;
    if (stat.type !== "file") throw new Error("EXPECTED_STAGE_FILE");
    await adapter.remove(path);
  }
  isFile(value: unknown): value is TFile { return value instanceof TFile; }
}
