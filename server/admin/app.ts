import { setHTML } from './dom';
import { I18n, templateLocalizer, type LanguagePreference } from '../../shared/i18n';
import { english } from './translations';

const languageKey = 'xsync.admin.language';
let preference: LanguagePreference = 'auto';
try { const saved = localStorage.getItem(languageKey); if (saved === 'zh' || saved === 'en') preference = saved; } catch { /* Browser storage may be disabled. The interface still follows the browser. */ }
const i18n = new I18n(english, preference, () => navigator.language), t = i18n.t;
const localize = templateLocalizer(document.body, i18n);
function updateLanguage(): void {
 localize(); document.documentElement.lang = i18n.locale; document.title = t('xSync · 管理后台');
 document.querySelectorAll<HTMLSelectElement>('[data-language]').forEach(field => { field.value = i18n.preference; });
 $('theme').textContent = t(document.documentElement.dataset.theme === 'dark' ? '浅色' : '深色');
 for (const id of ['login-error', 'page-error', 'toast']) $(id).textContent = t($(id).textContent ?? '');
}
interface User { id: string; name: string; active: boolean; keyTail: string; keyRevision: number; vaults: number }
interface Vault { userId: string; id: string; name: string; userName: string; devices: number; active: boolean }
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const messages: Record<string, string> = { UNAUTHORIZED: '登录已失效，请重新登录。', NAME_TAKEN: '这个名称已使用，请换一个名称。', INVALID_REQUEST: '请检查填写的内容。', LOGIN_RATE_LIMITED: '登录尝试过多，请稍后再试。', USER_NOT_FOUND: '用户已不存在，请刷新列表。', DELETE_CONFIRMATION_REQUIRED: '请输入准确的用户名称。' };
let users: User[] = [], tab = 'users', busy = false, toastTimer: number | undefined;
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
 const response = await fetch('/admin/api/' + path, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
 const value: unknown = await response.json();
 if (!response.ok) {
  const code = typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string' ? value.code : '';
  if (response.status === 401 && path !== 'login') showLogin();
  if (path === 'login' && code === 'UNAUTHORIZED') throw new Error(t("管理密码错误，请重试。"));
  throw new Error(t(messages[code] ?? '操作未完成，请稍后重试。'));
 }
 return value as T;
}
function toast(text: string): void { window.clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 3500); }
function showLogin(): void { $('admin-view').hidden = true; $('login-view').hidden = false; closeModal(); }
function closeModal(): void { $<HTMLDialogElement>('modal').close(); $('modal-body').replaceChildren(); $('modal-actions').replaceChildren(); }
function modal(title: string, body: string, actions: { text: string; run(): void | Promise<void>; className?: string; id?: string; disabled?: boolean }[]): void {
 setHTML($('modal-body'), `<h2 id="modal-title">${esc(title)}</h2>${body}<p id="modal-error" class="admin-error" role="alert"></p>`);
 $('modal-actions').replaceChildren();
 for (const action of actions) {
  const button = document.createElement('button'); button.textContent = action.text; button.className = action.className ?? ''; if (action.id) button.id = action.id; button.disabled = !!action.disabled;
  button.onclick = async () => { if (busy) return; busy = true; button.disabled = true; try { await action.run(); } catch (error) { if ($('modal-error')) $('modal-error').textContent = (error as Error).message; } finally { busy = false; if (button.isConnected) button.disabled = !!action.disabled; } };
  $('modal-actions').append(button);
 }
 if (!$<HTMLDialogElement>('modal').open) $<HTMLDialogElement>('modal').showModal();
}
$<HTMLDialogElement>('modal').addEventListener('close', () => { if (!$<HTMLDialogElement>('modal').open) { $('modal-body').replaceChildren(); $('modal-actions').replaceChildren(); } });
function oneTimeKey(name: string, key: string): void {
 modal(t("保存这一次展示的 key"), `<p class="dialog-lead">${t("把它交给「{0}」。关闭后无法再次查看，遗忘后可以刷新。", esc(name))}</p><div class="key-box"><code id="one-time-key">${esc(key)}</code><div class="row"><button id="copy-key">${t("复制访问 key")}</button><span id="copy-status" class="small muted" role="status"></span></div></div><p class="hint">${t("只用于服务授权。用户在 Obsidian 中设置自己的库加密密码，服务器不会得到密码原文。")}</p><label class="consent"><input id="key-saved" type="checkbox"><span>${t("我已保存访问 key。")}</span></label>`, [{ text: t("已保存，关闭"), id: 'close-key', disabled: true, run: closeModal }]);
 $('key-saved').onchange = () => { $<HTMLButtonElement>('close-key').disabled = !$<HTMLInputElement>('key-saved').checked; };
 $('copy-key').onclick = async () => { try { await navigator.clipboard.writeText(key); $('copy-status').textContent = t("已复制"); } catch { $('copy-status').textContent = t("请选中上方 key 手动复制"); } };
}
function heading(title: string, description: string, action = ''): string { return `<div class="page-head"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`; }
function renderRows(): void {
 const query = $<HTMLInputElement>('search').value.trim().toLocaleLowerCase();
 setHTML($('rows'), users.filter(user => (user.name + user.id).toLocaleLowerCase().includes(query)).map(user => `<tr><td><div class="user-cell"><span class="avatar">${esc(Array.from(user.name)[0]!)}</span><div>${esc(user.name)}<small class="mono" title="${esc(user.id)}">${esc(user.id.slice(0, 8))}…</small></div></div></td><td><span class="tag ${user.active ? 'green' : 'amber'}">${user.active ? t("已启用") : t("已停用")}</span></td><td><span class="mono">•••••• …${esc(user.keyTail)}</span><small>${t("第 {0} 版 · 仅展示末尾", user.keyRevision)}</small></td><td>${t("{0} 个", user.vaults)}</td><td><div class="table-actions"><button data-id="${user.id}" data-action="detail">${t("详情")}</button><button data-id="${user.id}" data-action="rotate">${t("刷新 key")}</button><button data-id="${user.id}" data-action="toggle">${user.active ? t("停用") : t("恢复")}</button><button data-id="${user.id}" data-action="delete" class="danger">${t("删除")}</button></div></td></tr>`).join('') || `<tr><td colspan="5" class="empty">${t("暂无用户。创建用户后，将访问 key 交给对方。")}</td></tr>`);
 $('rows').querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => { button.onclick = () => { const user = users.find(item => item.id === button.dataset.id)!; act(user, button.dataset.action!); }; });
}
async function render(): Promise<void> {
 const search = $('search') ? $<HTMLInputElement>('search').value : '';
 $('page-error').textContent = '';
 document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => button.setAttribute('aria-current', button.dataset.nav === tab ? 'page' : 'false'));
 $('breadcrumb').textContent = { users: t("用户与访问 key"), vaults: t("同步库"), audit: t("操作记录") }[tab]!;
 try {
  if (tab === 'users') {
   users = (await api<{ users: User[] }>('users')).users;
   setHTML($('content'), heading(t("用户与访问 key"), t("为每位用户发放独立访问凭据，统一管理同步权限。"), `<button id="create-user" class="primary">${t("＋ 创建用户")}</button>`) + `<div class="stats"><div class="stat"><label>${t("用户总数")}</label><strong>${users.length}</strong><small>${t("{0} 位启用 · {1} 位停用", users.filter(user => user.active).length, users.filter(user => !user.active).length)}</small></div><div class="stat"><label>${t("同步库")}</label><strong>${users.reduce((sum, user) => sum + user.vaults, 0)}</strong><small>${t("由用户在 Obsidian 中创建")}</small></div><div class="stat"><label>${t("内容保护")}</label><strong>${t("端到端加密")}</strong><small>${t("管理员无法查看加密密码")}</small></div></div><section class="card"><div class="card-head"><div><h2>${t("所有用户")}</h2><p>${t("每位用户一个有效 key，刷新后原 key 及旧设备授权失效。")}</p></div><input id="search" class="search" aria-label="${t("搜索用户")}" placeholder="${t("搜索用户名或 ID")}"></div><div class="table-scroll"><table><thead><tr><th>${t("用户")}</th><th>${t("状态")}</th><th>${t("访问 key")}</th><th>${t("同步库")}</th><th>${t("操作")}</th></tr></thead><tbody id="rows"></tbody></table></div><div class="card-foot">${t("key 仅在生成时展示一次。刷新不影响库的加密密码与已有内容。")}</div></section><aside class="note purple"><strong>${t("访问权限与内容解密分开管理。")}</strong><br>${t("访问 key 允许用户与 xSync 通信；库加密密码由用户在插件中设置。")}</aside>`);
   $<HTMLInputElement>('search').value = search; renderRows(); $('search').oninput = renderRows;
   $('create-user').onclick = () => {
    modal(t("创建用户"), `<p class="dialog-lead">${t("填写备注名，生成独立访问 key。")}</p><label class="field" for="user-name">${t("用户名称")}</label><input id="user-name" maxlength="80" autocomplete="off">`, [{ text: t("取消"), run: closeModal }, { text: t("创建并生成 key"), className: 'primary', run: async () => {
     const name = $<HTMLInputElement>('user-name').value.trim(); if (!name) throw new Error(t("请输入用户名称。"));
     const result = await api<{ user: User; key: string }>('users', 'POST', { name }); await render(); oneTimeKey(result.user.name, result.key);
    } }]);
   };
  } else if (tab === 'vaults') {
   const { vaults } = await api<{ vaults: Vault[] }>('vaults');
   setHTML($('content'), heading(t("同步库"), t("查看用户所属库与设备接入记录。")) + `<section class="card"><div class="table-scroll"><table><thead><tr><th>${t("同步库")}</th><th>${t("所属用户")}</th><th>${t("已接入设备")}</th><th>${t("访问状态")}</th></tr></thead><tbody>${vaults.map(vault => `<tr><td>${esc(vault.name)}<small class="mono" title="${esc(vault.id)}">${esc(vault.id.slice(0, 8))}…</small></td><td>${esc(vault.userName)}</td><td>${t("{0} 台", vault.devices)}</td><td><span class="tag ${vault.active ? 'green' : 'amber'}">${vault.active ? t("允许同步") : t("用户已停用")}</span></td></tr>`).join('') || `<tr><td colspan="4" class="empty">${t("暂无同步库。用户连接插件后可创建。")}</td></tr>`}</tbody></table></div><div class="card-foot">${t("设备接入记录不代表当前在线或已经完成同步。")}</div></section><div class="note">${t("后台不会展示笔记内容、文件路径或库加密密码。")}</div>`);
  } else {
   const { entries } = await api<{ entries: { at: string; message: string }[] }>('audit');
   setHTML($('content'), heading(t("操作记录"), t("最近的用户与访问权限管理操作。")) + `<section class="card">${entries.map(entry => `<div class="log-row"><time>${esc(new Date(entry.at).toLocaleString(i18n.locale))}</time><span>${esc(t(entry.message))}</span></div>`).join('') || `<div class="empty">${t("暂无操作记录。")}</div>`}</section>`);
  }
 } catch (error) { $('page-error').textContent = (error as Error).message; }
}
function act(user: User, action: string): void {
 if (action === 'detail') {
  modal(user.name, `<p class="dialog-lead">${t("用户详情")}</p><div class="detail-row"><span>${t("用户 ID")}</span><span class="mono">${esc(user.id)}</span></div><div class="detail-row"><span>${t("状态")}</span><span>${user.active ? t("已启用") : t("已停用")}</span></div><div class="detail-row"><span>${t("访问 key")}</span><span>${t("第 {0} 版 · …{1}", user.keyRevision, esc(user.keyTail))}</span></div><div class="detail-row"><span>${t("同步库")}</span><span>${t("{0} 个", user.vaults)}</span></div><div id="owned-vaults" class="note">${t("正在读取所属库…")}</div><div class="note">${t("完整 key 无法再次查看。库加密密码不由后台保存。")}</div>`, [{ text: t("关闭"), run: closeModal }]);
  const owned = $('owned-vaults');
  void api<{ vaults: Vault[] }>('vaults').then(({ vaults }) => { if (owned.isConnected) owned.textContent = t("所属库：") + (vaults.filter(vault => vault.userId === user.id).map(vault => vault.name).join(', ') || t("尚未创建")); }, () => { if (owned.isConnected) owned.textContent = t("所属库暂时无法读取。"); });
  return;
 }
 if (action === 'rotate') {
  modal(t("刷新「{0}」的 key？", user.name), `<p class="dialog-lead">${t("旧 key 及旧设备授权失效，各设备需要填写新 key 才能继续同步。")}</p><div class="note purple">${t("{0} 个库及加密密码保留。{1}", user.vaults, user.active ? '' : t("用户仍保持停用。"))}</div>`, [{ text: t("取消"), run: closeModal }, { text: t("刷新并使旧授权失效"), className: 'primary', run: async () => {
   const { key } = await api<{ key: string }>(`users/${user.id}/key`, 'POST'); await render(); oneTimeKey(user.name, key);
  } }]); return;
 }
 if (action === 'toggle') {
  modal(t('{0}「{1}」？', user.active ? t('停用') : t('恢复'), user.name), `<p class="dialog-lead">${user.active ? t("所有设备将停止与服务通信，远端库和本地文件保留。") : t("重新允许持当前有效 key 授权的设备连接。")}</p>`, [{ text: t("取消"), run: closeModal }, { text: user.active ? t("确认停用") : t("恢复访问"), className: user.active ? 'danger' : 'primary', run: async () => { await api(`users/${user.id}`, 'PUT', { active: !user.active }); closeModal(); await render(); } }]); return;
 }
 modal(t("删除用户与所有远端库？"), `<p class="dialog-lead">${t("将删除「{0}」及其 {1} 个远端库，全部访问凭据失效。", esc(user.name), user.vaults)}</p><div class="note amber">${t("删除无法撤销。设备上的本地笔记保留，不会远程擦除。")}</div><label class="field" for="delete-name">${t("输入用户名称以确认")}</label><input id="delete-name" autocomplete="off">`, [{ text: t("取消"), run: closeModal }, { text: t("删除用户及远端数据"), id: 'delete-user', disabled: true, className: 'danger primary', run: async () => {
  const result = await api<{ cleanupPending: boolean }>(`users/${user.id}`, 'DELETE', { name: $<HTMLInputElement>('delete-name').value }); closeModal(); await render(); toast(result.cleanupPending ? t("删除已生效，远端数据清理将在后台重试。") : t("用户及远端库已删除，本地笔记保留。"));
 } }]);
 $('delete-name').oninput = () => { $<HTMLButtonElement>('delete-user').disabled = $<HTMLInputElement>('delete-name').value !== user.name; };
}
$('login-form').onsubmit = async event => {
 event.preventDefault(); const button = $('login-form').querySelector('button')!; button.disabled = true; $('login-error').textContent = '';
 try { await api('login', 'POST', { password: $<HTMLInputElement>('admin-password').value }); $<HTMLInputElement>('admin-password').value = ''; $('login-view').hidden = true; $('admin-view').hidden = false; await render(); }
 catch (error) { $('login-error').textContent = (error as Error).message; } finally { button.disabled = false; }
};
$('logout').onclick = async () => { try { await api('logout', 'POST'); showLogin(); } catch (error) { $('page-error').textContent = (error as Error).message; } };
$('theme').onclick = () => { const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('theme').textContent = dark ? t("浅色") : t("深色"); };
document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => { button.onclick = () => { tab = button.dataset.nav!; void render(); }; });
document.querySelectorAll<HTMLSelectElement>('[data-language]').forEach(field => {
 field.onchange = async () => {
  try { localStorage.setItem(languageKey, field.value); }
  catch { field.value = i18n.preference; toast(t('语言设置未保存，请检查浏览器存储权限。')); return; }
  i18n.preference = field.value as LanguagePreference; updateLanguage();
  if (!$('admin-view').hidden) await render();
 };
});
updateLanguage();
void api('session').then(async () => { $('admin-view').hidden = false; await render(); }, showLogin);
