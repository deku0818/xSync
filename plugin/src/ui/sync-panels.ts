import { Modal, Notice, type App } from "obsidian";

import type ObsidianSyncPlugin from "../sync-main.js";
import { canonicalPath } from "../sync/crypto.js";
import type { Review } from "../sync/engine.js";
import { compareLines } from "./diff-lines.js";
import { mountTemplate, updateIcon } from "./dom.js";
import { syncPresentation } from "./sync-status.js";
import { overviewTemplate, reviewTemplate } from "./templates.js";

/** Compact status on demand; no routine notifications or permanent dashboard. */
export class SyncOverview extends Modal {
  private unsubscribe?: () => void;
  private closed = false;
  constructor(app: App, private plugin: ObsidianSyncPlugin, private configure: () => void, private anchor?: HTMLElement) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("oss-overview-host");
    if (this.anchor) {
      this.containerEl.addClass("oss-status-container");
      const rect = this.anchor.getBoundingClientRect(), view = this.anchor.ownerDocument.defaultView!;
      this.modalEl.style.setProperty("--oss-status-right", `${Math.max(8, view.innerWidth - rect.right)}px`);
      this.modalEl.style.setProperty("--oss-status-bottom", `${Math.max(8, view.innerHeight - rect.top + 6)}px`);
    }
    const root = this.contentEl.createDiv("oss-app"), q = mountTemplate(root, overviewTemplate);
    q("device-name").setText(this.plugin.deviceName);
    q("close-status").onclick = () => this.close();
    q("configure").onclick = () => { this.close(); this.configure(); };
    q("pause").onclick = async () => { try { await this.plugin.setAutoSync(!this.plugin.autoSync); } catch { new Notice("同步设置未保存，请重试。"); } };
    q("retry").onclick = () => { void this.plugin.sync(false).catch(() => {}); };
    let rendering = false, again = false;
    const render = async (): Promise<void> => {
      if (rendering) { again = true; return; } rendering = true;
      try {
        const status = await this.plugin.engine?.status(); if (this.closed) return;
        const display = syncPresentation(status, !!this.plugin.engine?.unlocked, this.plugin.autoSync, this.plugin.syncing, this.plugin.localPending);
        q("status-title").setText(display.label); q("status-description").setText(display.message);
        root.dataset.state = display.state;
        let statusIcon = "cloud";
        if (display.state === "complete") statusIcon = "check";
        else if (["conflict", "attention"].includes(display.state)) statusIcon = "alert";
        updateIcon(q("status-symbol"), statusIcon);
        q("pause").setText(this.plugin.autoSync ? "暂停同步" : "恢复同步");
        q<HTMLButtonElement>("pause").disabled = !this.plugin.engine;
        q("retry").hidden = display.state !== "attention";
        q<HTMLButtonElement>("retry").disabled = this.plugin.syncing || !this.plugin.autoSync;
        const errors = [...(status?.errors ?? []), ...(this.plugin.hostError ? [this.plugin.hostError] : [])];
        q("diagnostics").hidden = !errors.length;
        // Codes only: paths, note text and credentials are not needed for a short diagnostic.
        q("diagnostic-message").setText([...new Set(errors.map(error => /^(?:Error: )?([A-Z][A-Z0-9_]{2,79})(?=$|[:\s])/.exec(error)?.[1] ?? "SYNC_INCOMPLETE"))].join("\n"));
        const skips = new Set((await this.plugin.engine?.db.skipped.toArray() ?? []).map(row => row.path));
        const conflicts = (await this.plugin.engine?.db.conflicts.toArray() ?? []).filter(row => !this.plugin.policy.reason(row.path) && !skips.has(row.path));
        if (this.closed) return;
        const list = q("conflict-list"); list.empty();
        for (const conflict of conflicts) {
          const row = list.createDiv("quiet-conflict-row"); row.createSpan({ text: conflict.path });
          if (conflict.reason === "CONCURRENT_REVISIONS") row.createEl("button", { text: "查看差异", cls: "primary", attr: { type: "button" } }).onclick = () => {
            this.close(); new ConflictReview(this.app, this.plugin, conflict.id, conflict.path).open();
          };
          else row.createSpan({ cls: "muted", text: "内容已保留，将自动重试" });
        }
      } finally { rendering = false; if (again && !this.closed) { again = false; void render(); } }
    };
    this.unsubscribe = this.plugin.subscribe(() => { void render(); }); void render();
  }
  onClose(): void { this.closed = true; this.unsubscribe?.(); this.contentEl.empty(); }
}

/** Reuses accepted review bytes while unchanged. Local edits hide stale choices until sync catches up. */
export class ConflictReview extends Modal {
  private cleanup?: () => void;
  constructor(app: App, private plugin: ObsidianSyncPlugin, private fileId: string, private path: string) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("oss-review-host");
    const root = this.contentEl.createDiv("oss-app"), shell = root.createDiv("review-modal"), q = mountTemplate(shell, reviewTemplate);
    q("review-title").setText(this.path);
    let review: Review | undefined, closed = false, submitting = false, refreshing = false, again = false, ready = false, syncRequested = false;
    let mode = "", original = "", companion = "", draft = "", draftInitialized = false;
    let draftWrites: Promise<unknown> = Promise.resolve();
    function versions(): Review["versions"] { return review?.versions ?? []; }
    function chosenVersion(): Review["versions"][number] | undefined {
      if (mode === "a") return versions()[0];
      if (mode === "b") return versions()[1];
      return versions().find(version => mode === `version:${version.revision}`);
    }
    const extraElements: HTMLElement[] = [];
    function comparable(): boolean {
      return !!review && versions().length === 2 && versions().every(version => version.text !== null && version.bytes.length <= 65536);
    }
    const companionError = (): string => {
      try { canonicalPath(companion); } catch { return "请填写有效的文件名。"; }
      if (companion.normalize("NFC").toLowerCase() === this.path.normalize("NFC").toLowerCase()) return "另一份文件名不能与原文件相同。";
      const other = versions().find(version => version.revision !== original);
      return this.plugin.policy.reason(companion, other?.length ?? other?.bytes.length) ? "这个文件名不在同步范围内。" : "";
    };
    const updateFooter = (): void => {
      const choice = chosenVersion();
      const allowed = ready && !refreshing && !submitting && this.plugin.autoSync && !!mode &&
        (!!choice || mode === "both" && versions().length === 2 || mode === "merge" && comparable()) &&
        (mode !== "both" || !companionError()) && (mode !== "merge" || draftInitialized && new TextEncoder().encode(draft).length <= 65536);
      q<HTMLButtonElement>("confirm").disabled = !allowed;
      let label = "确认";
      if (submitting) label = "正在处理…";
      else if (mode === "both") label = "确认保留双方";
      else if (mode === "merge") label = "确认合并结果";
      else if (choice) label = choice.kind === "deleted" ? "确认删除文件" : `确认用「${choice.device}」这份`;
      q("confirm").setText(label);
      let footerSummary = "其他文件继续同步";
      if (!this.plugin.autoSync) footerSummary = "同步已暂停，恢复后才能确认。";
      else if (!ready) footerSummary = "正在等待最新内容，原文件与草稿均保留。";
      q("footer-summary").setText(footerSummary);
    };
    const refreshChoices = (): void => {
      for (const button of shell.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
        button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
        button.disabled = submitting || !ready || button.dataset.mode === "both" && (versions().length !== 2 || versions().some(version => version.kind === "deleted"));
      }
      q("both-detail").hidden = mode !== "both"; q("merge-detail").hidden = mode !== "merge";
      q<HTMLInputElement>("companion-path").value = companion;
      q<HTMLInputElement>("companion-path").disabled = submitting;
      q("companion-error").setText(mode === "both" ? companionError() : "");
      q<HTMLTextAreaElement>("merge-editor").value = draft; q<HTMLTextAreaElement>("merge-editor").disabled = submitting;
      q<HTMLButtonElement>("manual-merge").disabled = submitting || !ready || !comparable();
      let summary = "没有默认选择，也可以稍后再处理。";
      if (mode === "both") summary = `双方都保留，另一份保存为「${companion}」。`;
      else if (mode === "merge") summary = "原文件将使用下方的合并结果。";
      else {
        const chosen = chosenVersion();
        if (chosen) summary = chosen.kind === "deleted" ? "确认后会删除当前文件。" : `原文件将使用「${chosen.device}」的内容。`;
      }
      q("choice-summary").setText(summary); updateFooter();
    };
    const renderCompare = (): void => {
      for (const [side, version] of [["a", versions()[0]], ["b", versions()[1]]] as const) {
        q(`version-${side}-name`).setText(version?.device ?? "设备");
        q(`version-${side}-tag`).setText(version?.deviceId === this.plugin.engine?.deviceId ? "此设备" : "另一台设备");
        q(`choice-${side}`).setText(`用「${version?.device ?? "设备"}」这份${version?.kind === "deleted" ? "（删除）" : ""}`);
        q(`pane-${side}`).empty();
      }
      for (const node of extraElements) node.remove();
      extraElements.length = 0;
      for (const version of versions().slice(2)) {
        const choice = q("choice-b").parentElement!.createEl("button", { text: `用「${version.device}」这份${version.kind === "deleted" ? "（删除）" : ""}`, attr: { type: "button", "data-mode": `version:${version.revision}`, "aria-pressed": "false" } });
        choice.onclick = () => choose(`version:${version.revision}`); extraElements.push(choice);
        const section = q("comparison").createDiv("version"), header = section.createDiv("version-head");
        header.createSpan({ text: version.device }); header.createEl("small", { text: version.deviceId === this.plugin.engine?.deviceId ? "此设备" : "另一台设备" });
        section.createDiv("code-pane").setText(version.text ?? `${version.kind === "deleted" ? "删除文件" : "文件内容"} · ${version.length ?? version.bytes.length} 字节`);
        extraElements.push(section);
      }
      if (!comparable()) {
        for (const [index, side] of ["a", "b"].entries()) {
          const version = versions()[index];
          q(`pane-${side}`).setText(version?.text ?? `${version?.kind === "deleted" ? "删除文件" : "文件内容"} · ${version?.length ?? version?.bytes.length ?? 0} 字节`);
        }
        return;
      }
      for (const row of compareLines(versions()[0]!.text!, versions()[1]!.text!)) for (const side of ["a", "b"] as const) {
        const version = versions()[side === "a" ? 0 : 1]!;
        if (version.kind === "deleted") { q(`pane-${side}`).setText("这份修改删除了文件。"); continue; }
        let lineClass = "code-row";
        if (row[`${side}Line`] === undefined) lineClass += " blank";
        else if (row.type !== "same") {
          if (side === "a") lineClass += " changed-left";
          else lineClass += " changed-right";
        }
        const line = q(`pane-${side}`).createDiv(lineClass);
        line.createSpan({ cls: "line-number", text: String(row[`${side}Line`] ?? "") }); line.createSpan({ cls: "code-text", text: row[side] ?? " " });
      }
    };
    const choose = (value: string): void => {
      if (submitting || !ready) return;
      mode = value;
      if (mode === "both") {
        const local = versions().find(version => version.deviceId === this.plugin.engine?.deviceId) ?? versions()[0]!;
        original = local.revision;
        const other = versions().find(version => version.revision !== original)!;
        companion = this.path.replace(/(\.[^/.]+)?$/, `（${other.device.replace(/[<>:"/\\|?*]/g, "-")}）$1`);
      }
      refreshChoices();
    };
    for (const button of shell.querySelectorAll<HTMLButtonElement>("[data-mode]")) button.onclick = () => choose(button.dataset.mode!);
    q("manual-merge").onclick = () => { choose("merge"); q("merge-editor").focus(); };
    q<HTMLInputElement>("companion-path").oninput = () => { companion = q<HTMLInputElement>("companion-path").value; q("companion-error").setText(companionError()); updateFooter(); };
    q<HTMLTextAreaElement>("merge-editor").oninput = () => {
      draft = q<HTMLTextAreaElement>("merge-editor").value; draftInitialized = true;
      const text = draft; draftWrites = draftWrites.catch(() => {}).then(() => this.plugin.engine!.saveMergeDraft(this.fileId, text));
      void draftWrites.catch(() => { if (!closed) q("footer-summary").setText("草稿暂未保存，请先保留此窗口。"); }); updateFooter();
    };
    q("defer").onclick = () => this.close();
    q("close-review").onclick = () => this.close();
    const refresh = async (): Promise<void> => {
      if (closed || submitting || !this.plugin.engine) return;
      if (refreshing) { again = true; return; }
      refreshing = true; updateFooter();
      try {
        const latest = await this.plugin.engine.review(this.fileId, review);
        if (closed || submitting) return;
        if (latest !== review) {
          const changed = !!review; review = latest; mode = ""; original = ""; companion = "";
          this.path = latest.path; q("review-title").setText(this.path);
          q("update-banner").hidden = !changed;
          q("update-message").setText(`内容已更新，请重新选择。${draftInitialized ? "合并草稿仍保留。" : ""}`);
          renderCompare();
        } else if (!ready) { q("update-banner").hidden = false; q("update-message").setText("最新内容已就绪，请重新选择。"); }
        ready = versions().length >= 2; syncRequested = false;
        q("comparison").hidden = !ready; q("decisions").hidden = !ready;
        q("review-description").setText(comparable() ? "双方内容均保留，请对比后选择。" : "所有版本均保留，可选择一份；两个文件版本也可都保留。");
      } catch (error) {
        if (closed) return;
        ready = false; mode = "";
        q("comparison").hidden = true; q("decisions").hidden = true;
        const code = error instanceof Error ? error.message : "";
        const localPending = code === "REVIEW_LOCAL_CHANGES_PENDING" || code === "LOCAL_EDITOR_CHANGES_PENDING";
        let message = "暂时无法读取最新内容，正在等待重试。原文件与草稿均保留。";
        if (localPending) message = "正在同步这篇笔记的最新修改，完成后将自动更新对比。";
        else if (code === "NO_REMOTE_CONFLICT") message = "这篇笔记的冲突已处理，可以关闭此窗口。";
        q("review-description").setText(message);
        if (localPending && !syncRequested && this.plugin.autoSync) {
          syncRequested = true; void this.plugin.sync(false, false).catch(() => {});
        }
      } finally {
        refreshing = false;
        if (!closed) refreshChoices();
        if (again && !closed) { again = false; void refresh(); }
      }
    };
    q("confirm").onclick = async () => {
      if (q<HTMLButtonElement>("confirm").disabled || !review) return;
      const frozen = structuredClone(review), selected = mode === "both" ? original : chosenVersion()?.revision ?? "";
      const copyPath = mode === "both" ? companion : undefined, merged = mode === "merge" ? new TextEncoder().encode(draft) : undefined;
      submitting = true; refreshChoices();
      try { await draftWrites; await this.plugin.resolveConflict(frozen, selected, copyPath, merged); this.close(); }
      catch (error) {
        if (closed) return;
        const code = error instanceof Error ? error.message : "";
        q("update-banner").hidden = false;
        q("update-message").setText(["REVIEW_STALE", "REVIEW_LOCAL_CHANGES_PENDING", "LOCAL_EDITOR_CHANGES_PENDING"].includes(code) ? "笔记有新修改，正在更新对比。合并草稿仍保留。" : "暂时没有处理成功，原文件与草稿均保留。");
        mode = ""; ready = false;
      } finally { submitting = false; if (!closed) { refreshChoices(); void refresh(); } }
    };
    const unsubscribe = this.plugin.subscribe(() => { void refresh(); });
    this.cleanup = () => { closed = true; unsubscribe(); };
    void this.plugin.engine?.loadMergeDraft(this.fileId).then(text => {
      if (!closed && !draftInitialized && text !== null) { draft = text; draftInitialized = true; refreshChoices(); }
    }, () => { if (!closed) q("footer-summary").setText("草稿暂时无法读取，原记录仍保留。"); });
    refreshChoices(); void refresh();
  }
  onClose(): void { this.cleanup?.(); this.contentEl.empty(); }
}
