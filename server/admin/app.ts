interface User { id: string; name: string; active: boolean; keyTail: string; keyRevision: number; vaults: number }
interface Vault { userId: string; id: string; name: string; userName: string; devices: number; active: boolean }
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const messages: Record<string, string> = { UNAUTHORIZED: '登录已失效，请重新登录。', NAME_TAKEN: '这个名称已使用，请换一个名称。', INVALID_REQUEST: '请检查填写的内容。', LOGIN_RATE_LIMITED: '登录尝试过多，请稍后再试。', USER_NOT_FOUND: '用户已不存在，请刷新列表。', DELETE_CONFIRMATION_REQUIRED: '请输入准确的用户名称。' };
let users: User[] = [], tab = 'users', busy = false, toastTimer: ReturnType<typeof setTimeout>;
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
 const response = await fetch('/admin/api/' + path, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
 const value = await response.json();
 if (!response.ok) {
  if (response.status === 401 && path !== 'login') showLogin();
  if (path === 'login' && value.code === 'UNAUTHORIZED') throw new Error('管理密码错误，请重试。');
  throw new Error(messages[value.code] ?? '操作未完成，请稍后重试。');
 }
 return value as T;
}
function toast(text: string): void { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500); }
function showLogin(): void { $('admin-view').hidden = true; $('login-view').hidden = false; closeModal(); }
function closeModal(): void { $<HTMLDialogElement>('modal').close(); $('modal-body').replaceChildren(); $('modal-actions').replaceChildren(); }
function modal(title: string, body: string, actions: { text: string; run(): void | Promise<void>; className?: string; id?: string; disabled?: boolean }[]): void {
 $('modal-body').innerHTML = `<h2 id="modal-title">${esc(title)}</h2>${body}<p id="modal-error" class="admin-error" role="alert"></p>`;
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
 modal('保存这一次展示的 key', `<p class="dialog-lead">把它交给「${esc(name)}」。关闭后无法再次查看，遗忘后可以刷新。</p><div class="key-box"><code id="one-time-key">${esc(key)}</code><div class="row"><button id="copy-key">复制访问 key</button><span id="copy-status" class="small muted" role="status"></span></div></div><p class="hint">只用于服务授权。用户在 Obsidian 中设置自己的库加密密码，服务器不会得到密码原文。</p><label class="consent"><input id="key-saved" type="checkbox"><span>我已保存访问 key。</span></label>`, [{ text: '已保存，关闭', id: 'close-key', disabled: true, run: closeModal }]);
 $('key-saved').onchange = () => { $<HTMLButtonElement>('close-key').disabled = !$<HTMLInputElement>('key-saved').checked; };
 $('copy-key').onclick = async () => { try { await navigator.clipboard.writeText(key); $('copy-status').textContent = '已复制'; } catch { $('copy-status').textContent = '请选中上方 key 手动复制'; } };
}
function heading(title: string, description: string, action = ''): string { return `<div class="page-head"><div><h1>${title}</h1><p>${description}</p></div>${action}</div>`; }
function renderRows(): void {
 const query = $<HTMLInputElement>('search').value.trim().toLocaleLowerCase();
 $('rows').innerHTML = users.filter(user => (user.name + user.id).toLocaleLowerCase().includes(query)).map(user => `<tr><td><div class="user-cell"><span class="avatar">${esc(Array.from(user.name)[0]!)}</span><div>${esc(user.name)}<small class="mono" title="${esc(user.id)}">${esc(user.id.slice(0, 8))}…</small></div></div></td><td><span class="tag ${user.active ? 'green' : 'amber'}">${user.active ? '已启用' : '已停用'}</span></td><td><span class="mono">•••••• …${esc(user.keyTail)}</span><small>第 ${user.keyRevision} 版 · 仅展示末尾</small></td><td>${user.vaults} 个</td><td><div class="table-actions"><button data-id="${user.id}" data-action="detail">详情</button><button data-id="${user.id}" data-action="rotate">刷新 key</button><button data-id="${user.id}" data-action="toggle">${user.active ? '停用' : '恢复'}</button><button data-id="${user.id}" data-action="delete" class="danger">删除</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无用户。创建用户后，将访问 key 交给对方。</td></tr>';
 $('rows').querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => { button.onclick = () => { const user = users.find(item => item.id === button.dataset.id)!; act(user, button.dataset.action!); }; });
}
async function render(): Promise<void> {
 $('page-error').textContent = '';
 document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => button.setAttribute('aria-current', button.dataset.nav === tab ? 'page' : 'false'));
 $('breadcrumb').textContent = { users: '用户与访问 key', vaults: '同步库', audit: '操作记录' }[tab]!;
 try {
  if (tab === 'users') {
   users = (await api<{ users: User[] }>('users')).users;
   $('content').innerHTML = heading('用户与访问 key', '为每位用户发放独立访问凭据，统一管理同步权限。', '<button id="create-user" class="primary">＋ 创建用户</button>') + `<div class="stats"><div class="stat"><label>用户总数</label><strong>${users.length}</strong><small>${users.filter(user => user.active).length} 位启用 · ${users.filter(user => !user.active).length} 位停用</small></div><div class="stat"><label>同步库</label><strong>${users.reduce((sum, user) => sum + user.vaults, 0)}</strong><small>由用户在 Obsidian 中创建</small></div><div class="stat"><label>内容保护</label><strong>端到端加密</strong><small>管理员无法查看加密密码</small></div></div><section class="card"><div class="card-head"><div><h2>所有用户</h2><p>每位用户一个有效 key，刷新后原 key 及旧设备授权失效。</p></div><input id="search" class="search" aria-label="搜索用户" placeholder="搜索用户名或 ID"></div><div class="table-scroll"><table><thead><tr><th>用户</th><th>状态</th><th>访问 key</th><th>同步库</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table></div><div class="card-foot">key 仅在生成时展示一次。刷新不影响库的加密密码与已有内容。</div></section><aside class="note purple"><strong>访问权限与内容解密分开管理。</strong><br>访问 key 允许用户与 xSync 通信；库加密密码由用户在插件中设置。</aside>`;
   renderRows(); $('search').oninput = renderRows;
   $('create-user').onclick = () => {
    modal('创建用户', '<p class="dialog-lead">填写备注名，生成独立访问 key。</p><label class="field" for="user-name">用户名称</label><input id="user-name" maxlength="80" autocomplete="off">', [{ text: '取消', run: closeModal }, { text: '创建并生成 key', className: 'primary', run: async () => {
     const name = $<HTMLInputElement>('user-name').value.trim(); if (!name) throw new Error('请输入用户名称。');
     const result = await api<{ user: User; key: string }>('users', 'POST', { name }); await render(); oneTimeKey(result.user.name, result.key);
    } }]);
   };
  } else if (tab === 'vaults') {
   const { vaults } = await api<{ vaults: Vault[] }>('vaults');
   $('content').innerHTML = heading('同步库', '查看用户所属库与设备接入记录。') + `<section class="card"><div class="table-scroll"><table><thead><tr><th>同步库</th><th>所属用户</th><th>已接入设备</th><th>访问状态</th></tr></thead><tbody>${vaults.map(vault => `<tr><td>${esc(vault.name)}<small class="mono" title="${esc(vault.id)}">${esc(vault.id.slice(0, 8))}…</small></td><td>${esc(vault.userName)}</td><td>${vault.devices} 台</td><td><span class="tag ${vault.active ? 'green' : 'amber'}">${vault.active ? '允许同步' : '用户已停用'}</span></td></tr>`).join('') || '<tr><td colspan="4" class="empty">暂无同步库。用户连接插件后可创建。</td></tr>'}</tbody></table></div><div class="card-foot">设备接入记录不代表当前在线或已经完成同步。</div></section><div class="note">后台不会展示笔记内容、文件路径或库加密密码。</div>`;
  } else {
   const { entries } = await api<{ entries: { at: string; message: string }[] }>('audit');
   $('content').innerHTML = heading('操作记录', '最近的用户与访问权限管理操作。') + `<section class="card">${entries.map(entry => `<div class="log-row"><time>${esc(new Date(entry.at).toLocaleString())}</time><span>${esc(entry.message)}</span></div>`).join('') || '<div class="empty">暂无操作记录。</div>'}</section>`;
  }
 } catch (error) { $('page-error').textContent = (error as Error).message; }
}
function act(user: User, action: string): void {
 if (action === 'detail') {
  modal(user.name, `<p class="dialog-lead">用户详情</p><div class="detail-row"><span>用户 ID</span><span class="mono">${esc(user.id)}</span></div><div class="detail-row"><span>状态</span><span>${user.active ? '已启用' : '已停用'}</span></div><div class="detail-row"><span>访问 key</span><span>第 ${user.keyRevision} 版 · …${esc(user.keyTail)}</span></div><div class="detail-row"><span>同步库</span><span>${user.vaults} 个</span></div><div id="owned-vaults" class="note">正在读取所属库…</div><div class="note">完整 key 无法再次查看。库加密密码不由后台保存。</div>`, [{ text: '关闭', run: closeModal }]);
  const owned = $('owned-vaults');
  void api<{ vaults: Vault[] }>('vaults').then(({ vaults }) => { if (owned.isConnected) owned.textContent = '所属库：' + (vaults.filter(vault => vault.userId === user.id).map(vault => vault.name).join('、') || '尚未创建'); }, () => { if (owned.isConnected) owned.textContent = '所属库暂时无法读取。'; });
  return;
 }
 if (action === 'rotate') {
  modal(`刷新「${user.name}」的 key？`, `<p class="dialog-lead">旧 key 及旧设备授权失效，各设备需要填写新 key 才能继续同步。</p><div class="note purple">${user.vaults} 个库及加密密码保留。${user.active ? '' : '用户仍保持停用。'}</div>`, [{ text: '取消', run: closeModal }, { text: '刷新并使旧授权失效', className: 'primary', run: async () => {
   const { key } = await api<{ key: string }>(`users/${user.id}/key`, 'POST'); await render(); oneTimeKey(user.name, key);
  } }]); return;
 }
 if (action === 'toggle') {
  modal(`${user.active ? '停用' : '恢复'}「${user.name}」？`, `<p class="dialog-lead">${user.active ? '所有设备将停止与服务通信，远端库和本地文件保留。' : '重新允许持当前有效 key 授权的设备连接。'}</p>`, [{ text: '取消', run: closeModal }, { text: user.active ? '确认停用' : '恢复访问', className: user.active ? 'danger' : 'primary', run: async () => { await api(`users/${user.id}`, 'PUT', { active: !user.active }); closeModal(); await render(); } }]); return;
 }
 modal('删除用户与所有远端库？', `<p class="dialog-lead">将删除「${esc(user.name)}」及其 ${user.vaults} 个远端库，全部访问凭据失效。</p><div class="note amber">删除无法撤销。设备上的本地笔记保留，不会远程擦除。</div><label class="field" for="delete-name">输入用户名称以确认</label><input id="delete-name" autocomplete="off">`, [{ text: '取消', run: closeModal }, { text: '删除用户及远端数据', id: 'delete-user', disabled: true, className: 'danger primary', run: async () => {
  const result = await api<{ cleanupPending: boolean }>(`users/${user.id}`, 'DELETE', { name: $<HTMLInputElement>('delete-name').value }); closeModal(); await render(); toast(result.cleanupPending ? '删除已生效，远端数据清理将在后台重试。' : '用户及远端库已删除，本地笔记保留。');
 } }]);
 $('delete-name').oninput = () => { $<HTMLButtonElement>('delete-user').disabled = $<HTMLInputElement>('delete-name').value !== user.name; };
}
$('login-form').onsubmit = async event => {
 event.preventDefault(); const button = $('login-form').querySelector('button')!; button.disabled = true; $('login-error').textContent = '';
 try { await api('login', 'POST', { password: $<HTMLInputElement>('admin-password').value }); $<HTMLInputElement>('admin-password').value = ''; $('login-view').hidden = true; $('admin-view').hidden = false; await render(); }
 catch (error) { $('login-error').textContent = (error as Error).message; } finally { button.disabled = false; }
};
$('logout').onclick = async () => { try { await api('logout', 'POST'); showLogin(); } catch (error) { $('page-error').textContent = (error as Error).message; } };
$('theme').onclick = () => { const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('theme').textContent = dark ? '浅色' : '深色'; };
document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => { button.onclick = () => { tab = button.dataset.nav!; void render(); }; });
void api('session').then(async () => { $('admin-view').hidden = false; await render(); }, showLogin);
