import { Modal, Notice, type App } from "obsidian";

import type ObsidianSyncPlugin from "../sync-main.js";
import { canonicalPath } from "../sync/crypto.js";
import type { Review } from "../sync/engine.js";
import { compareLines } from "./diff-lines.js";
import { mountTemplate, updateIcon } from "./dom.js";
import { syncPresentation } from "./sync-status.js";
import { unsyncedFiles } from "./unsynced-files.js";
import { isSharedConfigPath, SHARED_CONFIG_PREFIX } from "../sync/config-path.js";
import { overviewTemplate, reviewTemplate } from "./templates.js";

/** Compact status on demand; no routine notifications or permanent dashboard. */
export class SyncOverview extends Modal {
  private unsubscribe?: () => void;
  private closed = false;
  constructor(app: App, private plugin: ObsidianSyncPlugin, private configure: () => void, private anchor?: HTMLElement) { super(app); }
  onOpen(): void {
    const t = this.plugin.i18n.t;
    this.modalEl.addClass("oss-overview-host");
    if (this.anchor) {
      this.containerEl.addClass("oss-status-container");
      const rect = this.anchor.getBoundingClientRect(), view = this.anchor.ownerDocument.defaultView!;
      this.modalEl.style.setProperty("--oss-status-right", `${Math.max(8, view.innerWidth - rect.right)}px`);
      this.modalEl.style.setProperty("--oss-status-bottom", `${Math.max(8, view.innerHeight - rect.top + 6)}px`);
    }
    const root = this.contentEl.createDiv("oss-app"), q = mountTemplate(root, overviewTemplate, this.plugin.i18n);
    q("device-name").setText(this.plugin.deviceName);
    q("configure").onclick = () => { this.close(); this.configure(); };
    q("pause").onclick = async () => { try { await this.plugin.setAutoSync(!this.plugin.autoSync); } catch { new Notice(t("同步设置未保存，请重试。")); } };
    q("retry").onclick = () => { void this.plugin.sync(false).catch(() => {}); };
    let rendering = false, again = false, fileSignature = "";
    const render = async (): Promise<void> => {
      if (rendering) { again = true; return; } rendering = true;
      try {
        q.localize();
        const status = await this.plugin.engine?.status(); if (this.closed) return;
        const display = syncPresentation(status, !!this.plugin.engine?.unlocked, this.plugin.autoSync, this.plugin.syncing, this.plugin.localPending, t);
        q("status-title").setText(display.label); q("status-description").setText(display.message);
        const progress = status?.progress;
        q("sync-progress").hidden = !status?.activity || !this.plugin.autoSync || !progress;
        if (progress) {
          q("progress-count").setText(progress.total ? t("已处理 {0} / {1} 项", progress.completed, progress.total) : t("正在获取任务…"));
          const bar = q<HTMLProgressElement>("progress-bar");
          bar.max = Math.max(1, progress.total);
          if (progress.total) bar.value = Math.min(progress.completed, progress.total); else bar.removeAttribute("value");
          q("progress-path").setText(progress.path ?? "");
          const transfer = q("transfer-progress"); transfer.hidden = progress.bytesTotal === undefined;
          if (progress.bytesTotal !== undefined) {
            const scale = progress.bytesTotal >= 1048576 ? 1048576 : progress.bytesTotal >= 1024 ? 1024 : 1;
            const unit = scale === 1048576 ? "MB" : scale === 1024 ? "KB" : "B";
            transfer.setText(t("本文件 {0} / {1} {2}", ((progress.bytesDone ?? 0) / scale).toFixed(scale === 1 ? 0 : 1), (progress.bytesTotal / scale).toFixed(scale === 1 ? 0 : 1), unit));
          }
        }
        q("queue-summary").hidden = !status || !this.plugin.engine?.unlocked;
        if (status) q("queue-summary").setText(t("待上传 {0} · 待应用 {1} · 需处理 {2}", status.outbox, status.inbox, status.issues?.length ?? 0));
        root.dataset.state = display.state;
        let statusIcon = "cloud";
        if (display.state === "complete") statusIcon = "check";
        else if (["conflict", "attention"].includes(display.state)) statusIcon = "alert";
        updateIcon(q("status-symbol"), statusIcon);
        q("pause").setText(this.plugin.autoSync ? t("暂停同步") : t("恢复同步"));
        q<HTMLButtonElement>("pause").disabled = !this.plugin.engine;
        q("retry").hidden = display.state !== "attention";
        q<HTMLButtonElement>("retry").disabled = this.plugin.syncing || !this.plugin.autoSync;
        const skipped = await this.plugin.engine?.db.skipped.toArray() ?? [];
        const skips = new Set(skipped.map(row => row.path));
        const conflicts = (await this.plugin.engine?.db.conflicts.toArray() ?? []).filter(row => !this.plugin.policy.reason(row.path) && !skips.has(row.path));
        if (this.closed) return;
        const files = unsyncedFiles(status?.issues ?? [], skipped, t);
        const failures = files.filter(file => !file.skipped);
        const knownCodes = new Set(status?.issues?.map(issue => issue.code));
        const errors = [...(status?.errors ?? []), ...(this.plugin.hostError ? [this.plugin.hostError] : [])].filter(error => !knownCodes.has(error));
        q("diagnostics").hidden = !errors.length;
        // Codes only: paths, note text and credentials are not needed for a short diagnostic.
        q("diagnostic-message").setText([...new Set(errors.map(error => /^(?:Error: )?([A-Z][A-Z0-9_]{2,79})(?=$|[:\s])/.exec(error)?.[1] ?? "SYNC_INCOMPLETE"))].join("\n"));
        q("unsynced-files").hidden = files.length === 0;
        q("unsynced-count").setText(String(files.length));
        q("retry").setText(failures.length ? t("重新检查") : t("重试"));
        q("retry").hidden = failures.length === 0 && display.state !== "attention";
        const nextSignature = JSON.stringify([files, this.plugin.i18n.language]);
        if (fileSignature !== nextSignature) {
          fileSignature = nextSignature;
          const list = q("file-issues"); list.empty();
          let skippedHeading = false;
          for (const file of files) {
            if (file.skipped && !skippedHeading) { list.createEl("p", { cls: "quiet-skipped-heading", text: t("按本机规则跳过 · {0}", files.length - failures.length) }); skippedHeading = true; }
            const row = list.createDiv("quiet-file-issue"), head = row.createDiv("quiet-file-head"), names = head.createDiv("quiet-file-names");
            const slash = file.path.lastIndexOf("/");
            names.createEl("strong", { text: file.path.slice(slash + 1) });
            if (slash >= 0) names.createEl("span", { cls: "quiet-file-directory", text: file.path.slice(0, slash + 1) });
            head.createEl("span", { cls: file.skipped ? "quiet-file-tag quiet-file-skipped" : "quiet-file-tag", text: file.tag });
            row.createEl("p", { text: file.reason });
            const actions = row.createDiv("quiet-file-actions");
            actions.createEl("button", { text: t("定位文件"), attr: { type: "button" } }).onclick = async () => {
              const path = isSharedConfigPath(file.path) ? `${this.app.vault.configDir}/${file.path.slice(SHARED_CONFIG_PREFIX.length)}` : file.path;
              const target = this.app.vault.getFileByPath(path);
              if (!target) { new Notice(t("本机找不到此文件；文件可能尚未下载或已改名。")); return; }
              try { await this.app.workspace.getLeaf("tab").openFile(target); this.close(); }
              catch { new Notice(t("无法定位此文件，请复制路径后检查。")); }
            };
            actions.createEl("button", { text: t("复制路径"), attr: { type: "button" } }).onclick = async () => {
              try { await navigator.clipboard.writeText(file.path); new Notice(t("已复制文件路径")); }
              catch { new Notice(t("无法复制路径，请手动选中文件路径。")); }
            };
          }
        }
        const list = q("conflict-list"); list.empty();
        for (const conflict of conflicts) {
          const row = list.createDiv("quiet-conflict-row"); row.createSpan({ text: conflict.path });
          if (conflict.reason === "CONCURRENT_REVISIONS") row.createEl("button", { text: t("查看差异"), cls: "primary", attr: { type: "button" } }).onclick = () => {
            this.close(); new ConflictReview(this.app, this.plugin, conflict.id, conflict.path).open();
          };
          else row.createSpan({ cls: "muted", text: t("内容已保留，将自动重试") });
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
    const t = this.plugin.i18n.t;
    this.modalEl.addClass("oss-review-host");
    const root = this.contentEl.createDiv("oss-app"), shell = root.createDiv("review-modal"), q = mountTemplate(shell, reviewTemplate, this.plugin.i18n);
    q("review-title").setText(this.path);
    let review: Review | undefined, closed = false, submitting = false, refreshing = false, again = false, ready = false, syncRequested = false;
    let mode = "", original = "", companion = "", draft = "", draftInitialized = false;
    let updateMessage = (): string => '';
    const showUpdate = (message: () => string): void => { updateMessage = message; q("update-message").setText(message()); };
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
      try { canonicalPath(companion); } catch { return t("请填写有效的文件名。"); }
      if (companion.normalize("NFC").toLowerCase() === this.path.normalize("NFC").toLowerCase()) return t("另一份文件名不能与原文件相同。");
      const other = versions().find(version => version.revision !== original);
      return this.plugin.policy.reason(companion, other?.length ?? other?.bytes.length) ? t("这个文件名不在同步范围内。") : "";
    };
    const updateFooter = (): void => {
      const choice = chosenVersion();
      const allowed = ready && !refreshing && !submitting && this.plugin.autoSync && !!mode &&
        (!!choice || mode === "both" && versions().length === 2 || mode === "merge" && comparable()) &&
        (mode !== "both" || !companionError()) && (mode !== "merge" || draftInitialized && new TextEncoder().encode(draft).length <= 65536);
      q<HTMLButtonElement>("confirm").disabled = !allowed;
      let label = t("确认");
      if (submitting) label = t("正在处理…");
      else if (mode === "both") label = t("确认保留双方");
      else if (mode === "merge") label = t("确认合并结果");
      else if (choice) label = choice.kind === "deleted" ? t("确认删除文件") : t("确认用「{0}」这份", choice.device);
      q("confirm").setText(label);
      let footerSummary = t("其他文件继续同步");
      if (!this.plugin.autoSync) footerSummary = t("同步已暂停，恢复后才能确认。");
      else if (!ready) footerSummary = t("正在等待最新内容，原文件与草稿均保留。");
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
      let summary = t("没有默认选择，也可以稍后再处理。");
      if (mode === "both") summary = t("双方都保留，另一份保存为「{0}」。", companion);
      else if (mode === "merge") summary = t("原文件将使用下方的合并结果。");
      else {
        const chosen = chosenVersion();
        if (chosen) summary = chosen.kind === "deleted" ? t("确认后会删除当前文件。") : t("原文件将使用「{0}」的内容。", chosen.device);
      }
      q("choice-summary").setText(summary); updateFooter();
    };
    const renderCompare = (): void => {
      for (const [side, version] of [["a", versions()[0]], ["b", versions()[1]]] as const) {
        q(`version-${side}-name`).setText(version?.device ?? t("设备"));
        q(`version-${side}-tag`).setText(version?.deviceId === this.plugin.engine?.deviceId ? t("此设备") : t("另一台设备"));
        q(`choice-${side}`).setText(t("用「{0}」这份{1}", version?.device ?? t("设备"), version?.kind === "deleted" ? t("（删除）") : ""));
        q(`pane-${side}`).empty();
      }
      for (const node of extraElements) node.remove();
      extraElements.length = 0;
      for (const version of versions().slice(2)) {
        const choice = q("choice-b").parentElement!.createEl("button", { text: t("用「{0}」这份{1}", version.device, version.kind === "deleted" ? t("（删除）") : ""), attr: { type: "button", "data-mode": `version:${version.revision}`, "aria-pressed": "false" } });
        choice.onclick = () => choose(`version:${version.revision}`); extraElements.push(choice);
        const section = q("comparison").createDiv("version"), header = section.createDiv("version-head");
        header.createSpan({ text: version.device }); header.createEl("small", { text: version.deviceId === this.plugin.engine?.deviceId ? t("此设备") : t("另一台设备") });
        section.createDiv("code-pane").setText(version.text ?? t("{0} · {1} 字节", version.kind === "deleted" ? t("删除文件") : t("文件内容"), version.length ?? version.bytes.length));
        extraElements.push(section);
      }
      if (!comparable()) {
        for (const [index, side] of ["a", "b"].entries()) {
          const version = versions()[index];
          q(`pane-${side}`).setText(version?.text ?? t("{0} · {1} 字节", version?.kind === "deleted" ? t("删除文件") : t("文件内容"), version?.length ?? version?.bytes.length ?? 0));
        }
        return;
      }
      for (const row of compareLines(versions()[0]!.text!, versions()[1]!.text!)) for (const side of ["a", "b"] as const) {
        const version = versions()[side === "a" ? 0 : 1]!;
        if (version.kind === "deleted") { q(`pane-${side}`).setText(t("这份修改删除了文件。")); continue; }
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
      void draftWrites.catch(() => { if (!closed) q("footer-summary").setText(t("草稿暂未保存，请先保留此窗口。")); }); updateFooter();
    };
    q("defer").onclick = () => this.close();
    q("close-review").onclick = () => this.close();
    const refresh = async (): Promise<void> => {
      if (closed || submitting || !this.plugin.engine) return;
      if (refreshing) { again = true; return; }
      if (q.localize()) {
        if (review) renderCompare();
        q("update-message").setText(updateMessage());
      }
      refreshing = true; updateFooter();
      try {
        const latest = await this.plugin.engine.review(this.fileId, review);
        if (closed || submitting) return;
        if (latest !== review) {
          const changed = !!review; review = latest; mode = ""; original = ""; companion = "";
          this.path = latest.path; q("review-title").setText(this.path);
          q("update-banner").hidden = !changed;
          showUpdate(() => t("内容已更新，请重新选择。{0}", draftInitialized ? t("合并草稿仍保留。") : ""));
          renderCompare();
        } else if (!ready) { q("update-banner").hidden = false; showUpdate(() => t("最新内容已就绪，请重新选择。")); }
        ready = versions().length >= 2; syncRequested = false;
        q("comparison").hidden = !ready; q("decisions").hidden = !ready;
        q("review-description").setText(comparable() ? t("双方内容均保留，请对比后选择。") : t("所有版本均保留，可选择一份；两个文件版本也可都保留。"));
      } catch (error) {
        if (closed) return;
        ready = false; mode = "";
        q("comparison").hidden = true; q("decisions").hidden = true;
        const code = error instanceof Error ? error.message : "";
        const localPending = code === "REVIEW_LOCAL_CHANGES_PENDING" || code === "LOCAL_EDITOR_CHANGES_PENDING";
        let message = t("暂时无法读取最新内容，正在等待重试。原文件与草稿均保留。");
        if (localPending) message = t("正在同步这篇笔记的最新修改，完成后将自动更新对比。");
        else if (code === "NO_REMOTE_CONFLICT") message = t("这篇笔记的冲突已处理，可以关闭此窗口。");
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
        showUpdate(() => ["REVIEW_STALE", "REVIEW_LOCAL_CHANGES_PENDING", "LOCAL_EDITOR_CHANGES_PENDING"].includes(code) ? t("笔记有新修改，正在更新对比。合并草稿仍保留。") : t("暂时没有处理成功，原文件与草稿均保留。"));
        mode = ""; ready = false;
      } finally { submitting = false; if (!closed) { refreshChoices(); void refresh(); } }
    };
    const unsubscribe = this.plugin.subscribe(() => { void refresh(); });
    this.cleanup = () => { closed = true; unsubscribe(); };
    void this.plugin.engine?.loadMergeDraft(this.fileId).then(text => {
      if (!closed && !draftInitialized && text !== null) { draft = text; draftInitialized = true; refreshChoices(); }
    }, () => { if (!closed) q("footer-summary").setText(t("草稿暂时无法读取，原记录仍保留。")); });
    refreshChoices(); void refresh();
  }
  onClose(): void { this.cleanup?.(); this.contentEl.empty(); }
}
