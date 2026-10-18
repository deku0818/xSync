import { I18n } from "../../plugin/src/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { App } from "obsidian";
import type ObsidianSyncPlugin from "../../plugin/src/sync-main";
import type { Review, EngineStatus } from "../../plugin/src/sync/engine";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const host = vi.hoisted(() => ({ close: [] as (() => void)[], notices: [] as string[] }));
vi.mock("obsidian", async () => {
  const { default: createDOMPurify } = await import("dompurify");
  return {
    Modal: class {
      containerEl = document.createElement("div"); modalEl = document.createElement("div"); contentEl = document.createElement("div");
      constructor(public app: App) { this.containerEl.className = "modal-container"; this.modalEl.className = "modal"; this.contentEl.className = "modal-content"; this.containerEl.append(this.modalEl); const close = document.createElement('button'); close.className = 'modal-close-button'; close.onclick = () => this.close(); this.modalEl.append(close, this.contentEl); host.close.push(() => this.close()); }
      open() { document.body.append(this.containerEl); (this as unknown as { onOpen(): void }).onOpen(); }
      close() { (this as unknown as { onClose(): void }).onClose(); this.containerEl.remove(); }
    },
    Notice: class { constructor(text: string) { host.notices.push(text); } },
    sanitizeHTMLToDom: (markup: string) => createDOMPurify(window).sanitize(markup, { RETURN_DOM_FRAGMENT: true }),
  };
});
import { connectionForm } from "../../plugin/src/ui/connection-form";
import { vaultConnection } from "../../plugin/src/ui/vault-connection";
import { defaultRules } from "../../plugin/src/sync/policy";
import { ConflictReview, SyncOverview } from "../../plugin/src/ui/sync-panels";

let browser: JSDOM, listeners: Set<() => void>, pending: boolean, latest: Review, plugin: ObsidianSyncPlugin, currentStatus: EngineStatus;
function element(this: HTMLElement, tag: string, options: { cls?: string; text?: string; type?: string; attr?: Record<string, string> } = {}): HTMLElement {
  const node = this.ownerDocument.createElement(tag);
  if (options.cls) node.className = options.cls;
  if (options.type) node.setAttribute("type", options.type);
  if (options.text) node.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) node.setAttribute(key, value);
  this.append(node); return node;
}
const review = (id: string, text: string): Review => ({
  fileId: "F", path: "note.md", heads: [id, "phone"], location: { revision: "L", pathKey: "fixture", encryptedPath: "fixture" },
  versions: [{ revision: id, device: "MacBook Pro", deviceId: "local", kind: "file", text, bytes: new TextEncoder().encode(text), fingerprint: "fixture" },
    { revision: "phone", device: "iPhone 15", deviceId: "remote", kind: "file", text: "phone content", bytes: new TextEncoder().encode("phone content"), fingerprint: "fixture" }],
});
const query = (id: string): HTMLElement => document.querySelector(`[data-ui="${id}"]`)!;
const button = (id: string): HTMLButtonElement => query(id) as HTMLButtonElement;
const emit = () => { for (const listener of listeners) listener(); };

it.each(['zh', 'en'] as const)('shows pending connection and the old-state failure in %s, then permits a retry', async language => {
  plugin.i18n.preference = language;
  let rejectConnection!: (error: Error) => void;
  Object.assign(plugin, {
    accessSaved: true, boundVaultId: '', engine: undefined, accessibleVaults: [], localVaultName: 'Rabbit Hole',
    refreshVaults: async () => {},
    connectManagedVault: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectConnection = reject; })),
  });
  const root = document.body.createDiv(), dispose = vaultConnection(root, plugin);
  try {
    await vi.waitFor(() => expect(root.querySelector('button')).not.toBeNull());
    // Let the initial server refresh finish before opening a form.
    await Promise.resolve();
    root.querySelector('button')!.click();
    const form = root.querySelector('form')!, passwords = [...form.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    passwords.forEach(input => { input.value = 'public-test-password'; });
    form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = true;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.click(); expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe(language === 'zh' ? '正在连接…' : 'Connecting…');
    expect(root.querySelector('[role="status"]')!.textContent).toContain(language === 'zh' ? '请稍候' : 'Please wait');
    rejectConnection(new Error('LOCAL_SYNC_STATE_EXISTS'));
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    expect(root.querySelector('[role="status"]')!.textContent).toContain(language === 'zh' ? '重复输入密码无法解决' : 'Re-entering the password');
    expect(passwords.every(input => input.value === '')).toBe(true);
    expect(submit.textContent).toBe(language === 'zh' ? '创建并开始同步' : 'Create and start syncing');
  } finally { dispose(); }
});
beforeEach(() => {
  browser = new JSDOM("", { url: "https://fixture.invalid" }); vi.stubGlobal("window", browser.window); vi.stubGlobal("document", browser.window.document);
  Object.assign(browser.window.HTMLElement.prototype, {
    createEl: element,
    createDiv(this: HTMLElement, options: string | { cls?: string } = {}) { return element.call(this, "div", typeof options === "string" ? { cls: options } : options); },
    createSpan(this: HTMLElement, options: { cls?: string; text?: string } = {}) { return element.call(this, "span", options); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    addClass(this: HTMLElement, name: string) { this.classList.add(name); },
    empty(this: HTMLElement) { this.replaceChildren(); },
  });
  host.close.length = 0; host.notices.length = 0; listeners = new Set(); pending = false; latest = review("computer-1", "computer first content");
  currentStatus = { state: "complete", outbox: 0, inbox: 0, conflicts: 0, errors: [] };
  plugin = {
    i18n: new I18n("zh"), deviceName: "MacBook Pro", autoSync: true, syncing: false, localPending: false, hostError: "", policy: { reason: () => null },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    sync: vi.fn(async () => {}),
    setAutoSync: vi.fn(async (enabled: boolean) => { plugin.autoSync = enabled; emit(); }),
    resolveConflict: vi.fn(async () => {}),
    engine: { unlocked: true, deviceId: "local", status: async () => currentStatus, db: { skipped: { toArray: async () => [] }, conflicts: { toArray: async () => [] } },
      review: vi.fn(async (_id: string, previous?: Review) => { if (pending) throw new Error("REVIEW_LOCAL_CHANGES_PENDING"); return previous?.heads[0] === latest.heads[0] ? previous : latest; }),
      loadMergeDraft: async () => null, saveMergeDraft: vi.fn(async () => {}),
    },
  } as unknown as ObsidianSyncPlugin;
});
afterEach(() => { for (const close of host.close) close(); browser.window.close(); vi.unstubAllGlobals(); });

async function savePreview(name: string): Promise<void> {
  const target = process.env.OBSIDIAN_SYNC_UI_PREVIEW_DIR; if (!target) return;
  await mkdir(target, { recursive: true });
  const css = await readFile("plugin/styles.css", "utf8");
  const baseline = `:root{--background-primary:#202020;--background-secondary:#262626;--background-modifier-border:#373737;--background-modifier-hover:#303030;--text-normal:#e6e4e9;--text-muted:#aaa6b0;--text-faint:#86818d;--text-accent:#af91ef;--interactive-accent:#8660d4;--interactive-accent-hover:#9671e1;--text-warning:#ddbd7b;--text-error:#ee939b}body{margin:0;background:#171717;color:var(--text-normal);font:14px/1.6 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}.modal-container{display:flex;align-items:center;justify-content:center;min-height:100vh}.modal{background:#202020;border:1px solid #373737;border-radius:12px;max-height:94vh;overflow:auto}.modal-content{padding:0}button,input,textarea{font:inherit}[hidden]{display:none!important}`;
  await writeFile(join(target, name + ".html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>xSync 实际组件 · 宿主 DOM 模拟</title><style>${baseline}\n${css}</style>${document.body.innerHTML}</html>`);
}

it("shows compact, quiet status without queue counters and keeps pause/configure available", async () => {
  const configure = vi.fn(); new SyncOverview({} as App, plugin, configure).open();
  await vi.waitFor(() => expect(query("status-title").textContent).toBe("已同步"));
  expect(document.querySelector(".metrics,.status-card")).toBeNull(); expect(query("diagnostics").hidden).toBe(true); expect(host.notices).toEqual([]);
  await savePreview("status"); button("pause").click(); await vi.waitFor(() => expect(query("status-title").textContent).toBe("已暂停"));
  button("configure").click(); expect(configure).toHaveBeenCalledOnce();
});
it("uses only the host close control and unsubscribes when it closes the status panel", async () => {
  new SyncOverview({} as App, plugin, () => {}).open();
  await vi.waitFor(() => expect(query('status-title').textContent).toBe('已同步'));
  expect(document.querySelector('#close-status,[data-ui="close-status"]')).toBeNull();
  expect(document.querySelectorAll('.modal-close-button')).toHaveLength(1); expect(listeners.size).toBe(1);
  (document.querySelector('.modal-close-button') as HTMLButtonElement).click();
  expect(listeners.size).toBe(0); expect(document.querySelector('.modal-container')).toBeNull(); emit();
});
it.each(['zh', 'en'] as const)("shows live progress and exact problem paths safely in %s", async language => {
  plugin.i18n.preference = language; plugin.syncing = true;
  const path = '资料/<script>alert(1)</script>?.md';
  currentStatus = { state: 'pending', outbox: 3, inbox: 1, conflicts: 0, errors: ['UNSUPPORTED_PATH'],
    activity: 'uploading', progress: { phase: 'uploading', completed: 2, total: 5, path: '附件/image.png', bytesDone: 1048576, bytesTotal: 2097152 },
    issues: [{ path, phase: 'checking', code: 'UNSUPPORTED_PATH' }] };
  new SyncOverview({} as App, plugin, () => {}).open();
  await vi.waitFor(() => expect(query('progress-count').textContent).toContain('2 / 5'));
  expect((query('progress-bar') as HTMLProgressElement).value).toBe(2);
  expect((query('progress-bar') as HTMLProgressElement).max).toBe(5);
  expect(query('progress-path').textContent).toBe('附件/image.png');
  expect(query('transfer-progress').textContent).toContain('1.0 / 2.0 MB');
  expect(query('file-issues').querySelector('.quiet-file-directory')!.textContent! + query('file-issues').querySelector('strong')!.textContent!).toBe(path);
  expect(query('file-issues').querySelector('script')).toBeNull();
  expect(query('file-issues').textContent).toContain(language === 'zh' ? '重命名后同步' : 'Rename it in Obsidian');
  expect(query('queue-summary').textContent).toContain(language === 'zh' ? '待上传 3' : 'Pending upload 3');
  plugin.syncing = false; currentStatus = { state: 'needs-attention', outbox: 0, inbox: 0, conflicts: 0, errors: ['UNSUPPORTED_PATH'], issues: currentStatus.issues };
  emit(); await vi.waitFor(() => expect(query('sync-progress').hidden).toBe(true));
  expect(query('diagnostics').hidden).toBe(true); expect(query('file-issues').querySelector('strong')!.textContent).toBe('script>?.md');
  expect(query('unsynced-files').hidden).toBe(false); expect(query('file-issues').closest('details')).toBeNull();
});
it.each(['zh', 'en'] as const)('shows rule skips and failures together, retains focus during progress, and removes cleared entries in %s', async language => {
  plugin.i18n.preference = language;
  const path = '资料/bad?.md';
  currentStatus = { state: 'needs-attention', outbox: 1, inbox: 0, conflicts: 0, errors: ['UNSUPPORTED_PATH'], issues: [{ path, code: 'UNSUPPORTED_PATH', phase: 'checking' }] };
  let skips = [{ id: 'large.bin', path: 'large.bin', reason: '超过 50 MB' }, { id: path, path, reason: '临时跳过' }, { id: '.obsidian/obsidian-sync-local/device.json', path: '.obsidian/obsidian-sync-local/device.json', reason: '内部状态' }];
  Object.assign(plugin.engine!.db.skipped, { toArray: async () => skips });
  const writeText = vi.fn(async (_path: string) => {}); vi.stubGlobal('navigator', { clipboard: { writeText } });
  const openFile = vi.fn(async () => {}), file = { path }, app = { vault: { configDir: '.obsidian', getFileByPath: vi.fn(() => file) }, workspace: { getLeaf: () => ({ openFile }) } } as unknown as App;
  new SyncOverview(app, plugin, () => {}).open();
  await vi.waitFor(() => expect(query('unsynced-count').textContent).toBe('2'));
  expect(query('file-issues').textContent).toContain('large.bin'); expect(query('file-issues').textContent).not.toContain('device.json');
  expect(query('file-issues').querySelectorAll('strong')).toHaveLength(2);
  expect(query('file-issues').textContent).toContain(language === 'zh' ? '超过 50 MB' : 'Exceeds 50 MB');
  const buttons = query('file-issues').querySelectorAll('button'), copy = buttons[1] as HTMLButtonElement;
  copy.focus(); copy.click(); await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(path));
  emit(); await new Promise(resolve => setTimeout(resolve, 0)); expect(query('file-issues').querySelectorAll('button')[1]).toBe(copy); expect(document.activeElement).toBe(copy);
  currentStatus = { state: 'complete', outbox: 0, inbox: 0, conflicts: 0, errors: [], issues: [] }; skips = []; emit();
  await vi.waitFor(() => expect(query('unsynced-files').hidden).toBe(true));
  currentStatus = { ...currentStatus, state: 'needs-attention', errors: ['UNSUPPORTED_PATH'], issues: [{ path, code: 'UNSUPPORTED_PATH', phase: 'checking' }] }; emit();
  await vi.waitFor(() => expect(query('unsynced-count').textContent).toBe('1'));
  (query('file-issues').querySelector('button') as HTMLButtonElement).click(); await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(file));
  expect(document.querySelector('.modal-container')).toBeNull(); expect(listeners.size).toBe(0);
});
it("automatically waits for post-conflict edits and only enables choices after latest content is ready", async () => {
  pending = true; new ConflictReview({} as App, plugin, "F", "note.md").open();
  await vi.waitFor(() => expect(query("review-description").textContent).toContain("最新修改"));
  expect(query("comparison").hidden).toBe(true); expect(button("confirm").disabled).toBe(true); expect(plugin.sync).toHaveBeenCalledOnce();
  emit(); emit(); await vi.waitFor(() => expect(plugin.engine!.review).toHaveBeenCalledTimes(3)); expect(plugin.sync).toHaveBeenCalledOnce();
  pending = false; latest = review("computer-2", "newest saved edit"); emit();
  await vi.waitFor(() => expect(query("pane-a").textContent).toContain("newest saved edit"));
  expect(button("confirm").disabled).toBe(true); expect(query("comparison").hidden).toBe(false);
  await savePreview("conflict"); button("choice-both").click(); expect(button("confirm").textContent).toBe("确认保留双方");
  button("confirm").click(); await vi.waitFor(() => expect(plugin.resolveConflict).toHaveBeenCalledWith(latest, "computer-2", "note（iPhone 15）.md", undefined));
});
it("clears a stale selection, preserves merge drafts and refreshes automatically when local edits finish uploading", async () => {
  new ConflictReview({} as App, plugin, "F", "note.md").open();
  await vi.waitFor(() => expect(query("comparison").hidden).toBe(false)); button("manual-merge").click();
  const editor = query("merge-editor") as HTMLTextAreaElement; editor.value = "keep my merge draft"; editor.dispatchEvent(new browser.window.Event("input"));
  await vi.waitFor(() => expect(plugin.engine!.saveMergeDraft).toHaveBeenCalledWith("F", "keep my merge draft"));
  pending = true; emit(); await vi.waitFor(() => expect(query("comparison").hidden).toBe(true)); expect(button("confirm").disabled).toBe(true);
  latest = { ...review("computer-3", "later local edits"), path: "renamed.md" }; pending = false; emit();
  await vi.waitFor(() => expect(query("pane-a").textContent).toContain("later local edits")); expect(button("confirm").disabled).toBe(true);
  expect(query("review-title").textContent).toBe("renamed.md");
  button("manual-merge").click(); expect((query("merge-editor") as HTMLTextAreaElement).value).toBe("keep my merge draft");
  button("confirm").click(); await vi.waitFor(() => expect(plugin.resolveConflict).toHaveBeenCalledWith(latest, "", undefined, new TextEncoder().encode("keep my merge draft")));
});
it("keeps transient failures quiet and does not expose arbitrary error text or paths in problem details", async () => {
  currentStatus = { ...currentStatus, state: "needs-attention", errors: ["NETWORK_TIMEOUT"] }; new SyncOverview({} as App, plugin, () => {}).open();
  await vi.waitFor(() => expect(query("status-title").textContent).toBe("等待连接")); expect(query("retry").hidden).toBe(true);
  currentStatus = { ...currentStatus, errors: ["UPLOAD_STAGE_UNAVAILABLE: private/note.md", "unexpected secret value"] }; emit();
  await vi.waitFor(() => expect(query("status-title").textContent).toBe("同步未完成"));
  expect(query("diagnostic-message").textContent).toBe("UPLOAD_STAGE_UNAVAILABLE\nSYNC_INCOMPLETE"); expect(query("diagnostics").hasAttribute("open")).toBe(false);
  await savePreview("problem"); expect(host.notices).toEqual([]);
});

it("allows binary version selection and keep-both without enabling text merge", async () => {
  latest = { ...latest, path: "attachment.bin", versions: latest.versions.map(version => ({ ...version, text: null, bytes: new Uint8Array(), length: 80000 })) };
  new ConflictReview({} as App, plugin, "F", latest.path).open();
  await vi.waitFor(() => expect(button("choice-a").disabled).toBe(false));
  expect(button("manual-merge").disabled).toBe(true); expect(query("pane-a").textContent).toContain("80000");
  await savePreview("binary-conflict"); button("choice-both").click();
  expect(button("confirm").disabled).toBe(false); button("confirm").click();
  await vi.waitFor(() => expect(plugin.resolveConflict).toHaveBeenCalledWith(latest,"computer-1","attachment（iPhone 15）.bin",undefined));
});

it("allows an explicit choice among three heads and retains the complete observed set", async () => {
  latest = { ...latest, heads: [...latest.heads,"third"], versions: [...latest.versions,{ ...latest.versions[0]!,revision:"third",device:"Tablet",deviceId:"third",text:"third content" }] };
  new ConflictReview({} as App, plugin,"F",latest.path).open();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-mode="version:third"]')).not.toBeNull());
  expect(button("choice-both").disabled).toBe(true); expect(button("manual-merge").disabled).toBe(true);
  await savePreview("three-head-conflict"); document.querySelector<HTMLButtonElement>('[data-mode="version:third"]')!.click();
  expect(button("confirm").disabled).toBe(false); button("confirm").click();
  await vi.waitFor(() => expect(plugin.resolveConflict).toHaveBeenCalledWith(latest,"third",undefined,undefined));
});

it('changes overview language live, including pause state and accessible controls', async () => {
 new SyncOverview({} as App, plugin, () => {}).open();
 await vi.waitFor(() => expect(query('status-title').textContent).toBe('已同步'));
 plugin.i18n.preference = 'en'; emit();
 await vi.waitFor(() => expect(query('status-title').textContent).toBe('Synced'));
 expect(query('progress-bar').getAttribute('aria-label')).toBe('Sync progress');
 button('pause').click(); await vi.waitFor(() => expect(query('status-title').textContent).toBe('Paused'));
 expect(query('pause').textContent).toBe('Resume sync');
});

it('preserves merge decisions and draft contents across a live language switch', async () => {
 latest.versions[0]!.text = '已同步'; latest.versions[0]!.device = '我的电脑';
 new ConflictReview({} as App, plugin, 'F', '中文笔记.md').open();
 await vi.waitFor(() => expect(query('comparison').hidden).toBe(false)); button('manual-merge').click();
 const editor = query('merge-editor') as HTMLTextAreaElement;
 editor.value = '已同步：用户合并的中文内容'; editor.dispatchEvent(new browser.window.Event('input'));
 await vi.waitFor(() => expect(plugin.engine!.saveMergeDraft).toHaveBeenCalledOnce());
 plugin.i18n.preference = 'en'; emit();
 await vi.waitFor(() => expect(button('confirm').textContent).toBe('Confirm merged result'));
 expect(editor.value).toBe('已同步：用户合并的中文内容'); expect(query('version-a-name').textContent).toBe('我的电脑');
 expect(query('pane-a').textContent).toContain('已同步'); expect(button('confirm').disabled).toBe(false);
 button('confirm').click();
 await vi.waitFor(() => expect(plugin.resolveConflict).toHaveBeenCalledWith(latest, '', undefined, new TextEncoder().encode('已同步：用户合并的中文内容')));
});

it('keeps the chosen companion path when translating a conflict comparison', async () => {
 new ConflictReview({} as App, plugin, 'F', 'note.md').open();
 await vi.waitFor(() => expect(query('comparison').hidden).toBe(false)); button('choice-both').click();
 const field = query('companion-path') as HTMLInputElement; field.value = '用户选的文件.md'; field.dispatchEvent(new browser.window.Event('input'));
 plugin.i18n.preference = 'en'; emit();
 await vi.waitFor(() => expect(button('confirm').textContent).toBe('Confirm keeping both'));
 expect(field.value).toBe('用户选的文件.md'); expect(button('choice-both').getAttribute('aria-pressed')).toBe('true');
});

it('switches the connection form without clearing unsaved names, keys, rules or vault passwords', async () => {
 Object.assign(plugin, {
  rules: defaultRules(), clients: [], deviceName: '我的电脑', endpoint: '', accessSaved: true, boundVaultId: '', accessibleVaults: [],
  localVaultName: '中文知识库', syncStatus: { label: '已同步' }, configurationReloadNeeded: false,
  inventory: async () => [], refreshVaults: async () => {},
  setLanguage: vi.fn(async language => { plugin.i18n.preference = language; emit(); }),
 });
 const root = document.body.createDiv(); const dispose = connectionForm(root, plugin);
 try {
  await vi.waitFor(() => expect(root.textContent).toContain('＋ 创建同步库'));
  [...root.querySelectorAll('button')].find(button => button.textContent === '＋ 创建同步库')!.click();
  const endpoint = query('endpoint') as HTMLInputElement, key = query('key') as HTMLInputElement, folder = query('folder-input') as HTMLInputElement;
  endpoint.value = 'https://unsaved.example'; key.value = 'unsaved-access-key'; folder.value = '中文附件';
  let password = root.querySelector<HTMLInputElement>('.oss-vault-fields input[type="password"]')!;
  password.value = '尚未提交的密码';
  const consent = root.querySelector<HTMLInputElement>('.oss-vault-consent input')!; consent.checked = true;
  const language = query('language') as HTMLSelectElement; language.value = 'en'; language.dispatchEvent(new browser.window.Event('change'));
  await vi.waitFor(() => expect(language.disabled).toBe(false));
  expect(plugin.setLanguage).toHaveBeenCalledWith('en'); expect(query('save-connection').textContent).toBe('Save and test');
  expect(endpoint.value).toBe('https://unsaved.example'); expect(key.value).toBe('unsaved-access-key'); expect(folder.value).toBe('中文附件');
  password = root.querySelector<HTMLInputElement>('.oss-vault-fields input[type="password"]')!;
  expect(password.value).toBe('尚未提交的密码'); expect(root.querySelector<HTMLInputElement>('.oss-vault-consent input')!.checked).toBe(true);
  expect(root.textContent).toContain('Create and start syncing'); expect(root.textContent).toContain('我的电脑');
  expect(root.querySelector<HTMLInputElement>('.oss-vault-fields input[type="text"]')!.value).toBe('中文知识库');
  plugin.i18n.preference = 'zh'; emit(); expect(query('save-connection').textContent).toBe('保存并测试');
  expect(root.querySelector<HTMLInputElement>('.oss-vault-fields input[type="password"]')!.value).toBe('尚未提交的密码');
 } finally { dispose(); }
});
