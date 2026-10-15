import { Modal, Notice, type App } from "obsidian";
import type ObsidianSyncPlugin from "../sync-main";
import type { Review } from "../sync/engine";
import { canonicalPath } from "../sync/crypto";
import { mountTemplate, icon } from "./dom";
import { overviewTemplate, reviewTemplate } from "./templates";
import { compareLines } from "./diff-lines";

export class SyncOverview extends Modal {
  private unsubscribe?: () => void;
  private closed = false;
  private rendering = false;
  private again = false;
  constructor(app: App, private plugin: ObsidianSyncPlugin, private configure: () => void) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("oss-overview-host"); const root = this.contentEl.createDiv("oss-app"); const shell = root.createDiv("shell"); const q = mountTemplate(shell, overviewTemplate);
    q("status-title").setText("正在读取同步状态…"); for (const id of ["metric-upload", "metric-apply", "metric-conflict"]) q(id).setText("—"); q("attention-section").hidden = true; q("resolved-section").hidden = true;
    const subtitle = shell.querySelector<HTMLElement>(".brand .subtitle"); if (subtitle) subtitle.setText(`${this.plugin.deviceName} · 当前客户端`);
    const configure = shell.querySelector<HTMLAnchorElement>(".heading-actions a")!; configure.href = "#"; configure.onclick = e => { e.preventDefault(); this.close(); this.configure(); };
    q("pause").onclick = async () => { try { await this.plugin.setAutoSync(!this.plugin.autoSync); } catch { new Notice("无法保存同步状态。"); } };
    const diagnostics = shell.createEl("details", { cls: "design-note" }); diagnostics.createEl("summary", { text: "同步诊断" }); const diagnosticText = diagnostics.createEl("p"); diagnostics.hidden = true;
    const parent = q("attention-section"); parent.querySelector(".conflict-item")?.remove(); const list = parent.createDiv("conflict-list");
    const render = async () => {
      if (this.rendering) { this.again = true; return; } this.rendering = true;
      try {
        const status = await this.plugin.engine?.status(); if (this.closed) return;
        q("pause").setText(this.plugin.autoSync ? "暂停同步" : "恢复同步");
        const ready = !!this.plugin.engine?.unlocked;
        const disconnected = this.plugin.eventState === "retrying" || this.plugin.eventState === "connecting";
        const needs = (status?.conflicts ?? 0) > 0 || status?.state === "needs-attention";
        q("status-title").setText(!ready ? "请先配置同步" : !this.plugin.autoSync ? "同步已暂停" : needs ? `${status?.conflicts ? `${status.conflicts} 个文件` : "有文件"}需要处理` : status?.state === "pending" || this.plugin.localPending ? "正在同步文件" : this.plugin.hostError ? "客户端配置快照待更新" : "所选范围已同步");
        q("status-description").setText(!ready ? "保存服务器地址、客户端名称与同步密钥后自动开始。" : !this.plugin.autoSync ? "配置与密钥已保留，恢复后会自动补齐。" : needs ? "冲突版本与恢复任务保留，其他文件继续自动同步。" : this.plugin.configurationReloadNeeded ? "主题或插件配置已同步，重载 Obsidian 后生效。" : status?.skipped ? `按本机规则跳过 ${status.skipped} 项，未删除原文件。` : "文件更改后自动同步，无需手动操作。");
        q("status-icon").dataset.tone = needs ? "attention" : this.plugin.autoSync ? "success" : "neutral";
        q("status-symbol").setAttribute("href", `#${q(needs ? "alert" : "check").id}`);
        q("connection-state").setText(!this.plugin.autoSync ? "已暂停连接" : disconnected ? "等待连接恢复" : this.plugin.eventState === "connected" ? "连接正常" : "未连接");
        q("connection-dot").className = `dot${this.plugin.eventState === "connected" ? "" : " offline"}`;
        q("metric-upload").setText(String(status?.outbox ?? 0)); q("metric-apply").setText(String(status?.inbox ?? 0)); q("metric-conflict").setText(String(status?.conflicts ?? 0));
        const skips = new Set((await this.plugin.engine?.db.skipped.toArray() ?? []).map(r => r.path));
        const conflicts = (await this.plugin.engine?.db.conflicts.toArray() ?? []).filter(c => !this.plugin.policy.reason(c.path) && !skips.has(c.path)); if (this.closed) return;
        list.empty();
        for (const conflict of conflicts) {
          const row = list.createDiv("conflict-item"); icon(row.createDiv("file-icon"), "file"); const body = row.createDiv("conflict-body"); body.createEl("strong", { text: conflict.path }); body.createSpan({ cls: "status-chip", text: "需处理" });
          body.createEl("p", { text: conflict.reason === "CONCURRENT_REVISIONS" ? "多台设备修改了同一文件，双方内容均保留。" : "本地内容或位置已变化，原文件和恢复记录仍保留。" });
          row.createEl("button", { cls: "primary", text: "查看差异", attr: { type: "button" } }).onclick = async () => { try { const review = await this.plugin.engine!.review(conflict.id); this.close(); new ConflictReview(this.app, this.plugin, review, () => new SyncOverview(this.app, this.plugin, this.configure).open()).open(); } catch { new Notice("这项需要人工核对，原数据和恢复记录保留。"); } };
        }
        q("attention-section").hidden = !conflicts.length; q("resolved-section").hidden = !!conflicts.length;
        q("result-symbol").setAttribute("href", `#${q(needs ? "alert" : "check").id}`);
        q("result-title").setText(needs ? "部分文件需要人工核对" : !this.plugin.autoSync ? "同步已暂停" : "当前同步状态");
        q("result-description").setText(needs ? "恢复日志保留，尚未完成同步。请在配置页检查排除项及当前状态。" : status?.state === "pending" || this.plugin.localPending ? "更改正在上传或应用。" : "没有当前范围内的未处理冲突。");
        diagnostics.hidden = !status?.errors.length;
        diagnosticText.setText((status?.errors ?? []).map(error => error === "PATH_OCCUPIED" ? "同一路径存在两个初始化来源，队列和原文件保留。" : error.includes("APPLY_RECOVERY_FAILED") ? "一项文件恢复任务未完成，其他文件继续同步。" : error.includes("ConstraintError") ? "本机索引存在路径身份冲突，恢复记录保留。" : error.includes("CONFIG_DELETE_HAS_DEVICE_FIELDS") ? "配置包含本机凭据，远端删除已暂停以保留这些字段。" : error === "SERVER_UPGRADE_REQUIRED" ? "服务端需要升级到兼容的版本。" : "一项持久化、校验或网络操作未完成；原记录保留。").join("\n"));
        q("activity-state").setText(this.plugin.lastSyncAt ? `最后核对：${this.plugin.lastSyncAt}` : "尚未完成首次核对");
      } finally { this.rendering = false; if (this.again && !this.closed) { this.again = false; void render(); } }
    };
    this.unsubscribe = this.plugin.subscribe(() => { void render(); }); void render();
  }
  onClose(): void { this.closed = true; this.unsubscribe?.(); this.contentEl.empty(); }
}

export class ConflictReview extends Modal {
  private cleanup?: () => void;
  constructor(app: App, private plugin: ObsidianSyncPlugin, private review: Review, private back: () => void) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("oss-review-host"); const root = this.contentEl.createDiv("oss-app"); const shell = root.createDiv("review-modal"); const q = mountTemplate(shell, reviewTemplate); q("close-review").hidden = true;
    let closed = false, submitting = false, refreshing = false, again = false, mode = "", original = "", companion = "", draft = "", draftInitialized = false, scrolling = false;
    let selectedHeads = ""; let draftWrites: Promise<unknown> = Promise.resolve();
    const input = (id: string) => q<HTMLInputElement>(id);
    const versions = () => this.review.versions;
    const heads = () => [...this.review.heads].sort().join("|") + this.review.location.revision;
    const comparable = () => versions().length === 2 && versions().every(v => v.text !== null && v.bytes.length <= 65536);
    const companionError = () => { if (!companion.trim()) return "请填写另一份文件名。"; try { canonicalPath(companion.trim()); } catch { return "请输入有效的仓库相对文件名。"; } if (companion.trim().normalize("NFC").toLowerCase() === this.review.path.normalize("NFC").toLowerCase()) return "另一份文件名不能与原文件相同。"; return this.plugin.policy.reason(companion, versions().find(v => v.revision !== original)?.bytes.length) ? "这个文件名被本机规则排除，请换一个路径。" : ""; };
    const canConfirm = () => comparable() && this.plugin.autoSync && !submitting && !!mode && selectedHeads === heads() && (mode !== "both" || !!original && !companionError()) && (mode !== "merge" || draftInitialized && new TextEncoder().encode(draft).length <= 65536);
    const updateFooter = () => {
      const choice = mode === "a" ? versions()[0] : mode === "b" ? versions()[1] : undefined;
      q<HTMLButtonElement>("confirm").disabled = !canConfirm();
      q("confirm").setText(submitting ? "正在提交…" : mode === "both" ? "确认保留两份" : mode === "merge" ? "确认合并结果" : choice ? choice.kind === "deleted" ? `确认采用「${choice.device}」的删除` : `确认使用「${choice.device}」版本` : "请先选择处理方式");
      q("footer-summary").setText(!comparable() ? "完整附件或多版本预览待支持，所有版本保留待处理。" : !this.plugin.autoSync ? "同步已暂停，恢复后才能提交。" : !mode ? "尚未选择处理方式，暂不处理保留双方版本。" : mode === "both" && !original ? "请选择哪份版本沿用原路径。" : mode === "both" ? companionError() || "确认后保留上方两份文件，其他设备同步同一结果。" : mode === "merge" && !draftInitialized ? "请载入内容或编写合并结果。" : choice?.kind === "deleted" ? "确认后将删除原路径的文件。" : "请核对准确内容与最终结果后确认。");
    };
    const refreshChoices = () => {
      for (const choice of shell.querySelectorAll<HTMLElement>("[data-mode]")) {
        const id = choice.dataset.mode!; const disabled = !comparable() || id === "both" && versions().some(v => v.kind === "deleted"); choice.dataset.selected = String(id === mode); choice.dataset.disabled = String(disabled);
        const radio = choice.querySelector<HTMLInputElement>("input")!; radio.checked = id === mode; radio.disabled = disabled || submitting;
        if (id === "a" || id === "b") choice.querySelector("strong")!.textContent = `使用「${versions()[id === "a" ? 0 : 1]?.device ?? "设备"}」版本${versions()[id === "a" ? 0 : 1]?.kind === "deleted" ? "（删除）" : ""}`;
      }
      q("both-detail").hidden = mode !== "both"; q("merge-detail").hidden = mode !== "merge"; q("single-detail").hidden = mode !== "a" && mode !== "b";
      for (const radio of shell.querySelectorAll<HTMLInputElement>('input[name="original"]')) { const version = versions()[radio.value === "a" ? 0 : 1]; radio.checked = original === version?.revision; radio.disabled = submitting; const text = radio.parentElement!.lastChild; if (text?.nodeType === Node.TEXT_NODE) text.textContent = version?.device ?? "设备"; }
      q("both-files").hidden = !original;
      if (original) { const keep = versions().find(v => v.revision === original)!; const other = versions().find(v => v.revision !== original)!; q("original-label").setText(keep.device); q("original-path").setText(this.review.path); q("companion-label").setText(other.device); input("companion-path").value = companion; q("companion-error").setText(companionError()); }
      q<HTMLTextAreaElement>("merge-editor").value = draft; q<HTMLTextAreaElement>("merge-editor").disabled = submitting; input("companion-path").disabled = submitting; for (const id of ["load-a", "load-b", "restore-draft"]) q<HTMLButtonElement>(id).disabled = submitting;
      const selected = mode === "a" ? versions()[0] : versions()[1]; if (selected) q("single-summary").setText(`${this.review.path} 将采用「${selected.device}」的准确版本 ${selected.revision.slice(0, 12)}${selected.kind === "deleted" ? "（删除文件）" : ""}。`);
      updateFooter();
    };
    const choose = (value: string) => { if (submitting) return; mode = value; original = ""; companion = ""; selectedHeads = heads(); refreshChoices(); };
    const renderCompare = () => {
      q("review-title").setText(this.review.path); q("review-description").setText(comparable() ? "对比设备的准确版本，再决定如何保留。" : "完整附件或多版本审阅尚未支持，所有版本保持待处理。");
      for (const [side, version] of [["a", versions()[0]], ["b", versions()[1]]] as const) {
        const pane = q(`pane-${side}`); pane.empty(); q(`version-${side}-id`).setText(version ? `版本 ${version.revision.slice(0, 12)}` : "");
        const header = pane.previousElementSibling!; header.querySelector(".version-name > span")!.textContent = version?.device ?? "设备"; const tag = header.querySelector<HTMLElement>(".tiny-tag") ?? header.querySelector<HTMLElement>(".version-name")!.createSpan({ cls: "tiny-tag", text: "此设备" }); tag.hidden = version?.deviceId !== this.plugin.engine?.deviceId;
        q(`version-${side}-foot`).setText(version?.kind === "deleted" ? "删除版本" : version?.text !== null && version?.text !== undefined ? `${version.text.split("\n").length} 行 · 完整文本` : `${version?.length ?? version?.bytes.length ?? 0} 字节 · 完整预览待支持`);
        if (!comparable() || version?.kind === "deleted") { const placeholder = pane.createDiv("binary-placeholder"); icon(placeholder, "file"); placeholder.createEl("strong", { text: version?.kind === "deleted" ? "此版本删除了文件" : "完整预览尚未支持" }); placeholder.createEl("p", { text: `此文件共 ${versions().length} 份版本，内容仍保留。` }); }
      }
      if (!comparable()) return;
      const rows = compareLines(versions()[0]!.text!, versions()[1]!.text!).filter(r => !input("diff-only").checked || r.type !== "same");
      for (const row of rows) for (const side of ["a", "b"] as const) {
        if (versions()[side === "a" ? 0 : 1]!.kind === "deleted") continue;
        const line = q(`pane-${side}`).createDiv(`code-row${row[`${side}Line`] === undefined ? " blank" : row.type !== "same" ? side === "a" ? " changed-left" : " changed-right" : ""}`);
        line.createSpan({ cls: "line-number", text: String(row[`${side}Line`] ?? "") }); line.createSpan({ cls: "code-text", text: row[side] ?? " " });
      }
    };
    const persistDraft = () => { const text = draft; draftWrites = draftWrites.catch(() => {}).then(() => this.plugin.engine!.saveMergeDraft(this.review.fileId, text)); void draftWrites.catch(() => { if (!closed) q("footer-summary").setText("合并草稿尚未安全保存，请保留此窗口或复制草稿。"); }); };
    for (const radio of shell.querySelectorAll<HTMLInputElement>('input[name="decision"]')) radio.onchange = () => choose(radio.value);
    for (const radio of shell.querySelectorAll<HTMLInputElement>('input[name="original"]')) radio.onchange = () => { original = versions()[radio.value === "a" ? 0 : 1]!.revision; const other = versions().find(v => v.revision !== original)!; companion = this.review.path.replace(/(\.[^/.]+)?$/, `（${other.device.replace(/[<>:"/\\|?*]/g, "-")}）$1`); refreshChoices(); };
    input("companion-path").oninput = () => { companion = input("companion-path").value; q("companion-error").setText(companionError()); updateFooter(); };
    q<HTMLTextAreaElement>("merge-editor").oninput = () => { draft = q<HTMLTextAreaElement>("merge-editor").value; draftInitialized = true; persistDraft(); updateFooter(); };
    for (const [side, index] of [["a", 0], ["b", 1]] as const) q(`load-${side}`).onclick = () => { draft = versions()[index]?.text ?? ""; draftInitialized = true; q<HTMLTextAreaElement>("merge-editor").value = draft; persistDraft(); updateFooter(); };
    q("load-a").setText(`替换为「${versions()[0]?.device ?? "设备"}」的内容`); q("load-b").setText(`替换为「${versions()[1]?.device ?? "设备"}」的内容`);
    q("restore-draft").onclick = () => { choose("merge"); q("merge-editor").focus(); };
    q("close-review").onclick = () => this.close(); q("defer").onclick = () => this.close(); input("diff-only").onchange = renderCompare;
    for (const side of ["a", "b"]) q(`pane-${side}`).onscroll = () => { if (scrolling || !input("sync-scroll").checked) return; scrolling = true; q(`pane-${side === "a" ? "b" : "a"}`).scrollTop = q(`pane-${side}`).scrollTop; requestAnimationFrame(() => { scrolling = false; }); };
    const refresh = async () => {
      if (closed || submitting || !this.plugin.engine) return; if (refreshing) { again = true; return; } refreshing = true;
      try { const file = await this.plugin.engine.db.remoteFiles.get(this.review.fileId); if (file && (file.location.revision !== this.review.location.revision || [...file.heads].sort().join("|") !== [...this.review.heads].sort().join("|"))) {
        if (file.heads.length < 2) { q("update-banner").hidden = false; q("update-message").setText("此冲突已在其他设备处理，请返回同步概览。"); mode = ""; selectedHeads = ""; updateFooter(); return; }
        const latest = await this.plugin.engine.review(this.review.fileId); if (closed || submitting) return;
        this.review = latest; mode = ""; original = ""; companion = ""; selectedHeads = "";
        q("update-banner").hidden = false; q("update-message").setText(`发现新版本，对比已更新，旧选择已清除。${draftInitialized ? "合并草稿已保留。" : "请重新核对并选择。"}`); q("restore-draft").hidden = !draftInitialized; renderCompare(); refreshChoices();
      } else updateFooter(); } catch { if (!closed) { q("update-banner").hidden = false; q("update-message").setText("新版本获取失败，请稍后核对；双方内容和草稿仍保留。"); selectedHeads = ""; updateFooter(); } }
      finally { refreshing = false; if (again && !closed) { again = false; void refresh(); } }
    };
    q("confirm").onclick = async () => {
      if (!canConfirm()) return;
      const frozenReview = structuredClone(this.review);
      const selected = mode === "both" ? original : mode === "a" ? versions()[0]!.revision : mode === "b" ? versions()[1]!.revision : "";
      const frozenCompanion = mode === "both" ? companion.trim() : undefined;
      const frozenMerge = mode === "merge" ? new TextEncoder().encode(draft) : undefined;
      submitting = true; refreshChoices();
      try { await draftWrites; await this.plugin.resolveConflict(frozenReview, selected, frozenCompanion, frozenMerge); const showBack = !closed; this.close(); if (showBack) this.back(); }
      catch (e) { q("update-banner").hidden = false; q("update-message").setText((e as Error).message === "REVIEW_STALE" ? "审阅期间出现新版本，请重新对比后选择。" : `提交未完成：${(e as Error).message}；版本和草稿仍保留。`); mode = ""; selectedHeads = ""; }
      finally { submitting = false; if (!closed) { refreshChoices(); void refresh(); } }
    };
    const unsubscribe = this.plugin.subscribe(() => { void refresh(); });
    this.cleanup = () => { closed = true; unsubscribe(); };
    renderCompare(); refreshChoices(); q("update-banner").hidden = true;
    void this.plugin.engine?.loadMergeDraft(this.review.fileId).then(text => { if (!closed && !draftInitialized && text !== null) { draft = text; draftInitialized = true; q("update-banner").hidden = false; q("update-message").setText("本机保留了一份加密合并草稿，可以继续编辑。请核对当前版本后再确认。"); q("restore-draft").hidden = false; } }, () => { if (!closed) new Notice("本机草稿无法解锁，原记录保留。"); });
  }
  onClose(): void { this.cleanup?.(); this.contentEl.empty(); }
}
