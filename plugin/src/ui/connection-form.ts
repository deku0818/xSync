import { Notice } from "obsidian";
import type ObsidianSyncPlugin from "../sync-main";
import { mountTemplate, icon } from "./dom";
import { settingsTemplate } from "./templates";
import { SyncPolicy, folderPath, parseSuffixes, validateRules, type FileEntry } from "../sync/policy";
import { clientName } from "../../../protocol/src/client-profile";
import type { ConnectionCheck, ConnectionStep } from "../sync/connection-check";

const labels: Record<ConnectionStep, string> = { server: "服务器连接", name: "名称唯一", authorization: "设备授权", key: "密钥校验", storage: "安全保存" };
export function connectionForm(container: HTMLElement, plugin: ObsidianSyncPlugin): () => void {
  container.addClass("oss-app", "oss-settings-host");
  const shell = container.createDiv("shell"); const q = mountTemplate(shell, settingsTemplate);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false, busy = false, draftRules = structuredClone(plugin.rules), inventory: FileEntry[] = [], selectedClient = "", dirty = false;
  const input = (id: string) => q<HTMLInputElement>(id);
  input("client-name").value = plugin.deviceName; input("endpoint").value = plugin.endpoint; input("max-size").value = String(draftRules.maxMB);
  const renderKeyState = () => {
    const field = input("key"), saved = plugin.hasSavedKey;
    field.dataset.savedKey = String(saved);
    field.placeholder = saved ? "••••••••••••" : "请输入同步密钥";
    let hint = saved ? "密钥已保存，留空复用；输入新密钥可替换。由系统安全存储保护。" : "尚未保存密钥，请输入同步密钥。密钥仅在本机校验。";
    if (field.value) hint = saved ? "新密钥将在保存并测试通过后替换现有密钥。" : "保存并测试通过后，密钥由系统安全存储保护。";
    q("key-hint").setText(hint);
  };
  q("connection-badge").setText(plugin.hasSavedKey ? "已保存" : "未配置");
  q("current-name").setText(plugin.deviceName || "当前客户端");
  const meta = q("sync-state").nextElementSibling; if (meta) meta.textContent = "· 当前设备";
  const error = (id: string, message: string) => { q(id).setText(message); q(id).hidden = !message; };
  const resetChecks = () => { for (const step of Object.keys(labels)) { const row = shell.querySelector<HTMLElement>(`[data-step="${step}"]`)!; row.dataset.state = "pending"; row.firstElementChild!.textContent = "○"; } };
  const update = (check: ConnectionCheck) => {
    if (closed) return;
    const row = shell.querySelector<HTMLElement>(`[data-step="${check.step}"]`)!; row.dataset.state = check.state;
    row.firstElementChild!.textContent = check.state === "passed" ? "✓" : check.state === "failed" ? "×" : "";
    row.setAttribute("aria-label", `${labels[check.step]}：${check.state === "passed" ? "通过" : check.state === "failed" ? "失败" : "进行中"}`);
    if (check.state === "running") q("connection-feedback").setText(`正在检查${labels[check.step]}…`);
    if (check.state === "failed") { q("connection-badge").setText("测试失败"); q("connection-badge").dataset.state = "failed"; q("connection-feedback").dataset.state = "failed"; q("connection-feedback").setText(check.message ?? "无法完成测试，请重试。"); }
  };
  const renderStatus = () => {
    renderKeyState();
    q("current-name").setText(plugin.deviceName || "当前客户端");
    const count = q("tab-clients").querySelector(".count"); if (count) count.textContent = plugin.clients.length ? String(plugin.clients.length) : "—";
    q("pause").setText(plugin.autoSync ? "暂停同步" : "恢复同步");
    q("sync-state").setText(!plugin.autoSync ? "同步已暂停" : !plugin.engine?.unlocked ? "等待配置" : plugin.eventState === "retrying" ? "等待连接恢复" : "自动同步已开启");
    q("sync-dot").className = `dot${!plugin.autoSync ? " paused" : plugin.eventState !== "connected" ? " offline" : ""}`;
    if (plugin.configurationReloadNeeded) q("rules-feedback").setText("配置文件已同步；重载 Obsidian 后应用主题或插件更新。");
  };
  const canonicalName = (name: string) => name.normalize("NFKC").trim().toLowerCase();
  const validateName = () => {
    let message = "";
    try { const name = clientName(input("client-name").value); if (plugin.clients.some(c => c.id !== plugin.engine?.deviceId && canonicalName(c.name) === canonicalName(name))) message = "这个客户端名称已被占用，请换一个名称。"; }
    catch (e) { message = String((e as Error).message); }
    q("name-hint").setText(message || "同一同步库内唯一，保存时由服务器最终确认。"); q("name-hint").className = `hint${message ? " error" : ""}`; input("client-name").setAttribute("aria-invalid", String(!!message));
    return !message;
  };
  const renderTree = () => {
    const host = q("excluded-tree"); const opened = new Set([...host.querySelectorAll<HTMLElement>("details[open]")].map(e => e.dataset.path)); host.empty();
    let policy: SyncPolicy;
    try { const maxMB = Number(input("max-size").value); if (!Number.isInteger(maxMB) || maxMB < 1 || maxMB > 100) { error("size-error", "请输入 1–100 之间的整数，不能超过 100 MB。"); throw new Error("INVALID_SIZE"); } policy = new SyncPolicy({ ...draftRules, maxMB }); error("size-error", ""); }
    catch { host.createEl("p", { cls: "tree-empty", text: "请先修正大小上限或排除规则。" }); q("excluded-count").setText("待统计"); return; }
    type Tree = { name: string; path: string; children: Map<string, Tree>; entry?: FileEntry; count: number; excluded: number; reason?: string; unknown?: boolean; hasExcluded?: boolean; unknownCount?: number };
    const root: Tree = { name: "", path: "", children: new Map(), count: 0, excluded: 0 }; let fileCount = 0, unknown = 0;
    for (const entry of inventory) {
      let node = root; const reason = policy.reason(entry.path, entry.size, entry.directory); if (reason && !entry.directory) fileCount++;
      if (entry.directory && reason) unknown++;
      for (const part of entry.path.split("/")) {
        const path = node.path ? `${node.path}/${part}` : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), count: 0, excluded: 0 });
        node = node.children.get(part)!; if (!entry.directory) node.count++; if (reason) { node.hasExcluded = true; if (!entry.directory) node.excluded++; else node.unknownCount = (node.unknownCount ?? 0) + 1; }
      }
      node.entry = entry; node.reason = reason; node.unknown = entry.directory && !!reason;
    }
    q("excluded-count").setText(`${fileCount} 个文件${unknown ? ` + ${unknown} 个目录` : ""}`);
    q("tree-description").setText(dirty ? "按当前填写规则统计 · 尚未保存" : "按本机已保存规则统计");
    q("tree-summary").setText("只读取文件索引，不读取正文");
    if (!fileCount && !unknown) { host.createEl("p", { cls: "tree-empty", text: "当前仓库没有被排除的文件。" }); return; }
    const renderChildren = (parent: Tree, target: HTMLElement) => {
      const nodes = [...parent.children.values()].filter(n => n.hasExcluded || n.excluded || n.unknown).sort((a, b) => Number(!!a.entry && !a.entry.directory) - Number(!!b.entry && !b.entry.directory) || a.name.localeCompare(b.name)); let shown = 0;
      const batch = () => { for (const end = Math.min(shown + 50, nodes.length); shown < end; shown++) renderNode(nodes[shown]!, target); if (shown < nodes.length) { const li = target.createEl("li"); li.createEl("button", { cls: "tree-more", text: `显示更多（剩余 ${nodes.length - shown} 项）`, attr: { type: "button" } }).onclick = () => { li.remove(); batch(); }; } }; batch();
    };
    const renderNode = (node: Tree, target: HTMLElement) => {
      const li = target.createEl("li"); const file = node.entry && !node.entry.directory;
      const details = file ? undefined : li.createEl("details", { cls: "tree-folder" }); if (details) details.dataset.path = node.path;
      const row = details ? details.createEl("summary", { cls: "tree-row" }) : li.createDiv("tree-row tree-file");
      const arrow = row.createSpan({ cls: "tree-chevron" }); if (!file) icon(arrow, "chevron");
      icon(row, file ? "file" : "folder"); row.createSpan({ cls: "tree-name", text: node.name + (file ? "" : "/") });
      const meta = row.createSpan({ cls: "tree-meta" }); const whole = !file ? policy.reason(node.path, undefined, true) : undefined;
      if (file) meta.setText(node.reason ?? "随目录排除");
      else if (whole) { meta.createSpan({ cls: "tree-tag whole", text: "整个目录已排除" }); if (!node.unknown) meta.createSpan({ text: `${node.count} 个文件` }); }
      else meta.setText(`${node.excluded} / ${node.count} 个文件排除${node.unknownCount ? ` · 另有 ${node.unknownCount} 个目录` : ""}`);
      row.title = node.reason ?? whole ?? node.path;
      if (details) {
        let loaded = false;
        const load = async () => {
          if (loaded) return; loaded = true; const list = details.createEl("ul");
          if (node.unknown) {
            try { const children = await plugin.excludedChildren(node.path); if (closed || !details.isConnected) return; for (const e of children) { const child: Tree = { name: e.path.split("/").at(-1)!, path: e.path, children: new Map(), entry: e, count: e.directory ? 0 : 1, excluded: 1, unknown: !!e.directory, reason: policy.reason(e.path, e.size, e.directory) }; node.children.set(child.name, child); } }
            catch { list.createEl("li", { cls: "tree-empty", text: "目录读取失败，仍保持整目录排除。" }); return; }
          }
          renderChildren(node, list);
        };
        details.addEventListener("toggle", () => { if (details.open) void load(); }); if (opened.has(node.path)) { details.open = true; void load(); }
      }
    };
    renderChildren(root, host.createEl("ul"));
  };
  const markDirty = () => { dirty = true; q("rules-badge").setText("有未保存的修改"); q("rules-feedback").setText("仅本机生效，不会修改其他客户端。"); renderTree(); };
  const renderRules = () => {
    for (const [id, values] of [["folders", draftRules.folders], ["suffixes", draftRules.suffixes]] as const) {
      const root = q(id); root.empty(); if (!values.length) root.createEl("p", { cls: "empty-suffix", text: id === "folders" ? "未排除文件夹" : "未排除后缀" });
      values.forEach(value => { const chip = root.createSpan({ cls: "chip", text: value + (id === "folders" ? "/" : "") }); chip.createEl("button", { text: "×", attr: { type: "button", "aria-label": `移除 ${value}` } }).onclick = () => { const key = id === "folders" ? "folders" : "suffixes"; draftRules[key] = draftRules[key].filter(item => item !== value); renderRules(); markDirty(); }; });
    }
    const root = q("regexes"); root.empty(); if (!draftRules.regexes.length) root.createEl("p", { cls: "empty-suffix", text: "未设置正则排除规则" });
    draftRules.regexes.forEach((r, index) => { const line = root.createDiv("regex-entry"); line.createEl("code", { text: `/${r.source}/${r.flags}` }); line.createEl("button", { text: "×", attr: { type: "button", "aria-label": `移除 ${r.source}` } }).onclick = () => { draftRules.regexes.splice(index, 1); renderRules(); markDirty(); }; });
  };
  const add = (kind: "folder" | "suffix" | "regex"): boolean => {
    const field = input(`${kind}-input`);
    try {
      if (kind === "folder") { const value = folderPath(field.value); if (!draftRules.folders.includes(value)) draftRules.folders.push(value); }
      else if (kind === "suffix") { const values = parseSuffixes(field.value); if (!values.length) throw new Error("请填写后缀"); draftRules.suffixes = [...new Set([...draftRules.suffixes, ...values])]; }
      else { const rule = { source: field.value.trim(), flags: input("regex-ignore-case").checked ? "i" as const : "" as const }; draftRules = validateRules({ ...draftRules, regexes: [...draftRules.regexes, rule] }); }
      error(`${kind}-error`, ""); field.value = ""; renderRules(); markDirty(); return true;
    } catch (e) { error(`${kind}-error`, (e as Error).message); return false; }
  };
  for (const kind of ["folder", "suffix", "regex"] as const) { q(`add-${kind}`).onclick = () => add(kind); input(`${kind}-input`).onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); add(kind); } }; }
  q("regex-hint").setText("RE2 正则；不支持回溯引用和前后查找，路径用 /。");
  input("max-size").oninput = markDirty;
  q("rules-form").onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    for (const kind of ["folder", "suffix", "regex"] as const) if (input(`${kind}-input`).value.trim() && !add(kind)) return;
    try { const rules = validateRules({ ...draftRules, maxMB: Number(input("max-size").value) }); await plugin.setRules(rules); if (closed) return; draftRules = structuredClone(rules); renderRules(); dirty = false; q("rules-badge").setText("仅本机生效"); q("rules-feedback").setText("已在本机保存；加密配置快照会在联网后上报。"); inventory = await plugin.inventory(); renderTree(); }
    catch (e) { q("rules-feedback").setText(`保存失败：${(e as Error).name === "ZodError" ? "大小需为 1–100 MB，每类规则最多 64 条。" : (e as Error).message}`); }
  };
  const renderClients = () => {
    const clients = plugin.clients; const root = q("client-list"); root.empty(); if (!selectedClient || !clients.some(c => c.id === selectedClient)) selectedClient = clients.find(c => c.id !== plugin.engine?.deviceId)?.id ?? clients[0]?.id ?? "";
    const count = q("tab-clients").querySelector(".count"); if (count) count.textContent = String(clients.length);
    for (const c of clients) { const button = root.createEl("button", { cls: "client-item", attr: { type: "button", "aria-pressed": String(c.id === selectedClient) } }); const mark = button.createSpan({ cls: "client-icon" }); icon(mark, "file"); const body = button.createSpan({ cls: "client-body" }); body.createSpan({ cls: "client-name", text: c.name }); body.createEl("p", { cls: "client-platform", text: c.configuration?.platform ?? "尚未上报配置" }); body.createEl("p", { cls: "client-state", text: c.reportedAt ? new Date(c.reportedAt).toLocaleString() : "无配置快照" }); button.onclick = () => { selectedClient = c.id; renderClients(); }; }
    const detail = q("client-detail"); detail.empty(); const client = clients.find(c => c.id === selectedClient); if (!client) { detail.createEl("p", { cls: "tree-empty", text: "暂无客户端配置，请连接服务器后刷新。" }); return; }
    const head = detail.createDiv("detail-head"); head.createEl("h3", { text: client.name }); head.createEl("p", { text: client.reportedAt ? `最近上报：${new Date(client.reportedAt).toLocaleString()}` : "该客户端尚未上报配置" });
    const profile = client.configuration; if (!profile) { detail.createEl("p", { cls: "tree-empty", text: client.error ?? "没有可查看的配置快照。" }); return; }
    const list = detail.createEl("dl", { cls: "detail-body" });
    const row = (label: string, value: string) => { const r = list.createDiv("detail-row"); r.createEl("dt", { text: label }); r.createEl("dd", { text: value }); };
    row("插件版本", profile.pluginVersion); row("同步状态", profile.autoSync ? "最近上报为开启" : "最近上报为暂停"); row("单文件上限", `${profile.rules.maxMB} MB`); row("排除后缀", profile.rules.suffixes.join("、") || "无"); row("排除文件夹", profile.rules.folders.join("、") || "无"); row("正则规则", profile.rules.regexes.map(r => `/${r.source}/${r.flags}`).join("；") || "无"); row("规则作用范围", "仅此客户端");
    detail.createEl("p", { cls: "detail-footer", text: "本机解密的只读快照。查看不会修改任何客户端配置。" });
  };
  const chooseTab = async (tab: "local" | "clients") => {
    for (const name of ["local", "clients"]) { q(`tab-${name}`).setAttribute("aria-selected", String(tab === name)); q(`tab-${name}`).tabIndex = tab === name ? 0 : -1; q(`panel-${name}`).hidden = tab !== name; }
    if (tab === "clients") { q("client-detail").setText("正在读取配置快照…"); try { await plugin.refreshClients(); if (!closed) renderClients(); } catch (e) { if (!closed) q("client-detail").setText(`无法获取配置快照：${(e as Error).message}`); } }
  };
  for (const tab of ["local", "clients"] as const) { q(`tab-${tab}`).onclick = () => { void chooseTab(tab); }; q(`tab-${tab}`).onkeydown = e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); const next = tab === "local" ? "clients" : "local"; void chooseTab(next); q(`tab-${next}`).focus(); } }; }
  for (const id of ["client-name", "endpoint", "key"]) input(id).oninput = () => { if (id === "key") renderKeyState(); resetChecks(); validateName(); q("connection-badge").setText("未保存"); q("connection-feedback").setText("连接配置有修改，请保存并测试。"); };
  q("connection-form").onsubmit = async event => {
    event.preventDefault(); if (busy || !validateName()) return; busy = true; resetChecks();
    for (const id of ["client-name", "endpoint", "key", "save-connection", "pause"]) q<HTMLInputElement | HTMLButtonElement>(id).disabled = true;
    q("save-connection").setText("测试中…");
    try { await plugin.saveConnection(input("endpoint").value, input("key").value, update, input("client-name").value); if (closed) return; input("key").value = ""; renderKeyState(); input("endpoint").value = plugin.endpoint; input("client-name").value = plugin.deviceName; q("connection-badge").setText("验证通过"); q("connection-badge").dataset.state = "passed"; q("connection-feedback").setText(plugin.autoSync ? "连接、名称和密钥校验通过，配置已安全保存。" : "配置已安全保存，同步保持暂停。"); }
    catch { /* The host reports the exact failed boundary through update(). */ }
    finally { busy = false; if (!closed) { for (const id of ["client-name", "endpoint", "key", "save-connection", "pause"]) q<HTMLInputElement | HTMLButtonElement>(id).disabled = false; q("save-connection").setText("保存并测试"); renderStatus(); } }
  };
  q("pause").onclick = async () => { if (busy) return; try { await plugin.setAutoSync(!plugin.autoSync); renderStatus(); } catch { new Notice("无法保存暂停状态，请检查本机存储。"); } };
  resetChecks(); renderStatus(); renderRules(); renderTree(); const unsubscribe = plugin.subscribe(() => {
    renderStatus(); clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void plugin.inventory().then(entries => { if (!closed && JSON.stringify(inventory) !== JSON.stringify(entries)) { inventory = entries; renderTree(); } }, () => {}); }, 200);
  });
  void plugin.inventory().then(entries => { if (!closed) { inventory = entries; renderTree(); } }, () => { if (!closed) q("excluded-tree").setText("仓库索引读取失败，未把缺失内容当成删除。"); });
  return () => { closed = true; clearTimeout(refreshTimer); input("key").value = ""; unsubscribe(); };
}
