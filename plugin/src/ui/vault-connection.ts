import { Modal } from 'obsidian';
import type ObsidianSyncPlugin from '../sync-main';
import { connectionFailure, type ConnectionStep } from '../sync/connection-check';

/** The only unencrypted values here are display names and stable identities. Passwords never leave this form. */
export function vaultConnection(root: HTMLElement, plugin: ObsidianSyncPlugin): () => void {
 const t = plugin.i18n.t;
 let lastLanguage = plugin.i18n.language, lastContext = '';
 let mode: 'select' | 'create' | 'unlock' = 'select', selected = '', busy = false, closed = false, signature = '';
 const redraw = (): void => { signature = ''; render(); };
 function render(): void {
  const current = JSON.stringify([plugin.accessSaved, plugin.boundVaultId, plugin.engine?.unlocked, plugin.accessUser?.id, plugin.accessibleVaults.map(v => [v.id, v.name]), mode, selected]);
  if (closed || current === signature && (busy || lastLanguage === plugin.i18n.language)) return;
  const retained = lastContext === current && lastLanguage !== plugin.i18n.language ? [...root.querySelectorAll<HTMLInputElement>('input')].map(field => ({ value: field.value, checked: field.checked })) : [];
  lastContext = current; lastLanguage = plugin.i18n.language; signature = current;
  try {
   root.hidden = !plugin.accessSaved; root.empty(); if (root.hidden) return;
   const card = root.createDiv('card'), head = card.createDiv('card-head'), intro = head.createDiv();
   const body = card.createDiv('fields');
   if (plugin.boundVaultId && plugin.engine?.unlocked) {
    intro.createEl('h2', { text: t("当前同步库") });
    intro.createEl('p', { cls: 'card-subtitle', text: t("本地「{0}」已绑定「{1}」。", plugin.localVaultName, plugin.vaultName) });
    head.createSpan({ cls: 'tag', text: t("已连接") });
    body.createEl('strong', { text: plugin.vaultName }); body.createEl('p', { cls: 'hint mono', text: plugin.boundVaultId });
    const field = body.createDiv(); field.createEl('p', { cls: 'field-label', text: t("库加密密码") });
    field.createEl('input', { type: 'password', attr: { readonly: '', placeholder: '••••••••••••', 'aria-label': t("已安全保存的库加密密码占位") } });
    field.createEl('p', { cls: 'hint', text: t("解锁材料由系统安全存储保护，管理员无法查看。刷新访问 key 不改变库密码。") });
    const change = body.createEl('button', { text: t("更换同步库"), attr: { type: 'button' } });
    change.onclick = async () => {
     change.disabled = true;
     try {
      const status = await plugin.engine?.status();
      const guide = new Modal(plugin.app);
      guide.contentEl.createEl('h2', { text: t("更换同步库") });
      guide.contentEl.createEl('p', { text: status && (status.outbox || status.inbox || status.conflicts) ? t("原库有未完成任务，请先处理。当前绑定、文件和凭据保持不变。") : t("当前绑定和文件保持不变。请在新的空白 Obsidian 库接入目标同步库，避免将本地内容意外带入另一个库。") });
      guide.contentEl.createEl('button', { text: t("保留当前绑定"), attr: { type: 'button' } }).onclick = () => guide.close();
      guide.open();
     } finally { if (change.isConnected) change.disabled = false; }
    };
    return;
   }
   if (mode === 'select' && !plugin.boundVaultId) {
    intro.createEl('h2', { text: t("选择同步库") }); intro.createEl('p', { cls: 'card-subtitle', text: plugin.accessUser ? t("已授权为「{0}」。", plugin.accessUser.name) : t("加载或创建你的同步库。") });
    if (!plugin.accessibleVaults.length) body.createEl('p', { cls: 'hint', text: t("还没有同步库。创建第一个库，再开始首次上传。") });
    for (const vault of plugin.accessibleVaults) {
     const button = body.createEl('button', { cls: 'oss-vault-choice', attr: { type: 'button' } });
     button.createSpan({ text: vault.name }); button.createSpan({ cls: 'hint', text: t("{0} 台设备 · 接入 →", vault.devices) });
     button.onclick = () => { selected = vault.id; mode = 'unlock'; redraw(); };
    }
    const create = body.createEl('button', { cls: 'primary', text: t("＋ 创建同步库"), attr: { type: 'button' } }); create.onclick = () => { mode = 'create'; redraw(); }; return;
   }
   const creating = mode === 'create';
   const vault = plugin.accessibleVaults.find(vault => vault.id === (plugin.boundVaultId || selected));
   intro.createEl('h2', { text: creating ? t("创建同步库") : t("解锁「{0}」", vault?.name ?? plugin.vaultName) });
   intro.createEl('p', { cls: 'card-subtitle', text: creating ? t("先在本机设置加密密码，再开始首次上传。") : t("输入创建此库时设置的加密密码，密码不发送到服务器。") });
   const form = body.createEl('form', { cls: 'oss-vault-fields' });
   const id = `vault-${Math.random().toString(36).slice(2)}`;
   const input = (label: string, type: string, suffix: string): HTMLInputElement => {
    const group = form.createDiv(); group.createEl('label', { cls: 'field-label', text: label, attr: { for: `${id}-${suffix}` } });
    return group.createEl('input', { type, attr: { id: `${id}-${suffix}`, autocomplete: 'off' } });
   };
   const name = creating ? input(t("同步库名称"), 'text', 'name') : undefined;
   if (name) { name.value = plugin.localVaultName; name.maxLength = 80; }
   const password = input(t("库加密密码"), 'password', 'password');
   const confirmation = creating ? input(t("确认加密密码"), 'password', 'confirmation') : undefined;
   form.createEl('p', { cls: 'hint', text: creating ? t("请单独备份加密密码。所有设备的解密材料及密码都丢失后，管理员也无法恢复笔记。") : t("本地已有文件会保留。重叠修改需要审阅，不会自动覆盖某一端。") });
   const consent = form.createEl('label', { cls: 'oss-vault-consent' });
   const checked = consent.createEl('input', { type: 'checkbox' });
   consent.createSpan({ text: creating ? t("我已妥善保存库加密密码。") : t("确认连接「{0}」，核对本地与远端文件。", vault?.name ?? plugin.vaultName) });
   const feedback = form.createEl('p', { cls: 'feedback', attr: { role: 'status', 'aria-live': 'polite' } });
   const actions = form.createDiv('input-line');
   if (!plugin.boundVaultId) { const back = actions.createEl('button', { text: t("返回选库"), attr: { type: 'button' } }); back.onclick = () => { mode = 'select'; redraw(); }; }
   actions.createEl('button', { cls: 'primary', text: creating ? t("创建并开始同步") : t("解锁并开始同步"), attr: { type: 'submit' } });
   form.onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    if (!checked.checked) { feedback.setText(creating ? t("请确认已妥善保存加密密码。") : t("请先确认目标同步库。")); return; }
    if (creating && (password.value.length < 8 || password.value !== confirmation?.value)) { feedback.setText(t("密码至少 8 个字符，两次输入需一致。")); return; }
    busy = true; for (const field of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) field.disabled = true;
    let stage: ConnectionStep = 'key';
    try { await plugin.connectManagedVault(vault?.id ?? '', password.value, creating ? name!.value : undefined, next => { stage = next; }); if (!closed) redraw(); }
    catch (error) {
     const code = error instanceof Error ? error.message : '';
     let message: string;
     if (code === 'NAME_TAKEN') message = t("已有同名库，请返回选库接入，或使用其他名称。");
     else if (code === 'VAULT_NAME_INVALID') message = t("库名称需为 1–80 个字符。");
     else if (stage === 'key') message = t("库加密密码校验失败，请确认密码正确。");
     else message = connectionFailure(error, stage, t).message;
     if (!closed) feedback.setText(message);
    } finally { password.value = ''; if (confirmation) confirmation.value = ''; busy = false; if (!closed) { for (const field of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) field.disabled = false; render(); } }
   };
  } finally {
   const fields = root.querySelectorAll<HTMLInputElement>('input');
   retained.forEach((value, index) => { const field = fields[index]; if (field) { field.value = value.value; field.checked = value.checked; } });
  }
 }
 const unsubscribe = plugin.subscribe(render); render();
 if (plugin.accessSaved) void plugin.refreshVaults().then(redraw, () => { if (!closed) root.createEl('p', { cls: 'feedback', text: t("库列表暂不可用，请检查网络或重新保存访问 key。") }); });
 return () => { closed = true; unsubscribe(); root.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(field => { field.value = ''; }); };
}
