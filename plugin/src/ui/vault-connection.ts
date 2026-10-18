import { Modal } from 'obsidian';
import type ObsidianSyncPlugin from '../sync-main';
import { connectionFailure, type ConnectionStep } from '../sync/connection-check';

/** The only unencrypted values here are display names and stable identities. Passwords never leave this form. */
export function vaultConnection(root: HTMLElement, plugin: ObsidianSyncPlugin): () => void {
 let mode: 'select' | 'create' | 'unlock' = 'select', selected = '', busy = false, closed = false, signature = '';
 const redraw = (): void => { signature = ''; render(); };
 function render(): void {
  const current = JSON.stringify([plugin.accessSaved, plugin.boundVaultId, plugin.engine?.unlocked, plugin.accessUser?.id, plugin.accessibleVaults.map(v => [v.id, v.name]), mode, selected]);
  if (current === signature || closed) return; signature = current;
  root.hidden = !plugin.accessSaved; root.empty(); if (root.hidden) return;
  const card = root.createDiv('card'), head = card.createDiv('card-head'), intro = head.createDiv();
  const body = card.createDiv('fields');
  if (plugin.boundVaultId && plugin.engine?.unlocked) {
   intro.createEl('h2', { text: '当前同步库' });
   intro.createEl('p', { cls: 'card-subtitle', text: `本地「${plugin.localVaultName}」已绑定「${plugin.vaultName}」。` });
   head.createSpan({ cls: 'tag', text: '已连接' });
   body.createEl('strong', { text: plugin.vaultName }); body.createEl('p', { cls: 'hint mono', text: plugin.boundVaultId });
   const field = body.createDiv(); field.createEl('p', { cls: 'field-label', text: '库加密密码' });
   field.createEl('input', { type: 'password', attr: { readonly: '', placeholder: '••••••••••••', 'aria-label': '已安全保存的库加密密码占位' } });
   field.createEl('p', { cls: 'hint', text: '解锁材料由系统安全存储保护，管理员无法查看。刷新访问 key 不改变库密码。' });
   const change = body.createEl('button', { text: '更换同步库', attr: { type: 'button' } });
   change.onclick = async () => {
    change.disabled = true;
    try {
     const status = await plugin.engine?.status();
     const guide = new Modal(plugin.app);
     guide.contentEl.createEl('h2', { text: '更换同步库' });
     guide.contentEl.createEl('p', { text: status && (status.outbox || status.inbox || status.conflicts) ? '原库有未完成任务，请先处理。当前绑定、文件和凭据保持不变。' : '当前绑定和文件保持不变。请在新的空白 Obsidian 库接入目标同步库，避免将本地内容意外带入另一个库。' });
     guide.contentEl.createEl('button', { text: '保留当前绑定', attr: { type: 'button' } }).onclick = () => guide.close();
     guide.open();
    } finally { if (change.isConnected) change.disabled = false; }
   };
   return;
  }
  if (mode === 'select' && !plugin.boundVaultId) {
   intro.createEl('h2', { text: '选择同步库' }); intro.createEl('p', { cls: 'card-subtitle', text: plugin.accessUser ? `已授权为「${plugin.accessUser.name}」。` : '加载或创建你的同步库。' });
   if (!plugin.accessibleVaults.length) body.createEl('p', { cls: 'hint', text: '还没有同步库。创建第一个库，再开始首次上传。' });
   for (const vault of plugin.accessibleVaults) {
    const button = body.createEl('button', { cls: 'oss-vault-choice', attr: { type: 'button' } });
    button.createSpan({ text: vault.name }); button.createSpan({ cls: 'hint', text: `${vault.devices} 台设备 · 接入 →` });
    button.onclick = () => { selected = vault.id; mode = 'unlock'; redraw(); };
   }
   const create = body.createEl('button', { cls: 'primary', text: '＋ 创建同步库', attr: { type: 'button' } }); create.onclick = () => { mode = 'create'; redraw(); }; return;
  }
  const creating = mode === 'create';
  const vault = plugin.accessibleVaults.find(vault => vault.id === (plugin.boundVaultId || selected));
  intro.createEl('h2', { text: creating ? '创建同步库' : `解锁「${vault?.name ?? plugin.vaultName}」` });
  intro.createEl('p', { cls: 'card-subtitle', text: creating ? '先在本机设置加密密码，再开始首次上传。' : '输入创建此库时设置的加密密码，密码不发送到服务器。' });
  const form = body.createEl('form', { cls: 'oss-vault-fields' });
  const id = `vault-${Math.random().toString(36).slice(2)}`;
  const input = (label: string, type: string, suffix: string): HTMLInputElement => {
   const group = form.createDiv(); group.createEl('label', { cls: 'field-label', text: label, attr: { for: `${id}-${suffix}` } });
   return group.createEl('input', { type, attr: { id: `${id}-${suffix}`, autocomplete: 'off' } });
  };
  const name = creating ? input('同步库名称', 'text', 'name') : undefined;
  if (name) { name.value = plugin.localVaultName; name.maxLength = 80; }
  const password = input('库加密密码', 'password', 'password');
  const confirmation = creating ? input('确认加密密码', 'password', 'confirmation') : undefined;
  form.createEl('p', { cls: 'hint', text: creating ? '请单独备份加密密码。所有设备的解密材料及密码都丢失后，管理员也无法恢复笔记。' : '本地已有文件会保留。重叠修改需要审阅，不会自动覆盖某一端。' });
  const consent = form.createEl('label', { cls: 'oss-vault-consent' });
  const checked = consent.createEl('input', { type: 'checkbox' });
  consent.createSpan({ text: creating ? '我已妥善保存库加密密码。' : `确认连接「${vault?.name ?? plugin.vaultName}」，核对本地与远端文件。` });
  const feedback = form.createEl('p', { cls: 'feedback', attr: { role: 'status', 'aria-live': 'polite' } });
  const actions = form.createDiv('input-line');
  if (!plugin.boundVaultId) { const back = actions.createEl('button', { text: '返回选库', attr: { type: 'button' } }); back.onclick = () => { mode = 'select'; redraw(); }; }
  actions.createEl('button', { cls: 'primary', text: creating ? '创建并开始同步' : '解锁并开始同步', attr: { type: 'submit' } });
  form.onsubmit = async event => {
   event.preventDefault(); if (busy) return;
   if (!checked.checked) { feedback.setText(creating ? '请确认已妥善保存加密密码。' : '请先确认目标同步库。'); return; }
   if (creating && (password.value.length < 8 || password.value !== confirmation?.value)) { feedback.setText('密码至少 8 个字符，两次输入需一致。'); return; }
   busy = true; for (const field of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) field.disabled = true;
   let stage: ConnectionStep = 'key';
   try { await plugin.connectManagedVault(vault?.id ?? '', password.value, creating ? name!.value : undefined, next => { stage = next; }); if (!closed) redraw(); }
   catch (error) {
    const code = error instanceof Error ? error.message : '';
    let message: string;
    if (code === 'NAME_TAKEN') message = '已有同名库，请返回选库接入，或使用其他名称。';
    else if (code === 'VAULT_NAME_INVALID') message = '库名称需为 1–80 个字符。';
    else if (stage === 'key') message = '库加密密码校验失败，请确认密码正确。';
    else message = connectionFailure(error, stage).message;
    if (!closed) feedback.setText(message);
   } finally { password.value = ''; if (confirmation) confirmation.value = ''; busy = false; if (!closed) for (const field of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) field.disabled = false; }
  };
 }
 const unsubscribe = plugin.subscribe(render); render();
 if (plugin.accessSaved) void plugin.refreshVaults().then(redraw, () => { if (!closed) root.createEl('p', { cls: 'feedback', text: '库列表暂不可用，请检查网络或重新保存访问 key。' }); });
 return () => { closed = true; unsubscribe(); root.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(field => { field.value = ''; }); };
}
