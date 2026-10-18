import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
const source = (await build({ entryPoints: ['server/admin/app.ts'], bundle: true, write: false, format: 'iife', target: 'es2022' })).outputFiles[0]!.text;
let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());
it('distinguishes a wrong login password from an expired admin session and permits a successful retry', async () => {
 const html = await readFile('server/internal/syncstore/admin/index.html', 'utf8');
 dom = new JSDOM(html, { url: 'https://sync.example.com/admin/', runScripts: 'outside-only', beforeParse: window => { Object.defineProperty(window.navigator, 'language', { value: 'zh-CN' }); } });
 const window = dom.window, document = window.document;
 window.HTMLDialogElement.prototype.close = function () { this.open = false; };
 let authenticated = false;
 Object.assign(window, { fetch: async (url: string, options?: { body?: string }) => {
  if (url.endsWith('/login')) authenticated = JSON.parse(options!.body!).password === 'test-admin-password';
  const value = authenticated ? { users: [] } : { code: 'UNAUTHORIZED' };
  return { ok: authenticated, status: authenticated ? 200 : 401, json: async () => value };
 } });
 window.eval(source);
 const password = document.getElementById('admin-password') as HTMLInputElement;
 const submit = document.querySelector<HTMLButtonElement>('#login-form button')!;
 await vi.waitFor(() => expect(document.getElementById('login-view')!.hidden).toBe(false));
 password.value = 'wrong-password'; submit.click();
 await vi.waitFor(() => expect(document.getElementById('login-error')!.textContent).toBe('管理密码错误，请重试。'));
 expect(document.getElementById('admin-view')!.hidden).toBe(true);
 expect(submit.disabled).toBe(false);
 password.value = 'test-admin-password'; submit.click();
 await vi.waitFor(() => expect(document.getElementById('create-user')).not.toBeNull());
 expect(password.value).toBe('');
 expect(document.getElementById('login-error')!.textContent).toBe('');
 authenticated = false;
 document.querySelector<HTMLButtonElement>('[data-nav="vaults"]')!.click();
 await vi.waitFor(() => expect(document.getElementById('page-error')!.textContent).toBe('登录已失效，请重新登录。'));
 expect(document.getElementById('login-view')!.hidden).toBe(false);
});
it.each(['zh-CN', 'en'])('renders untrusted names and removes the once-issued key when closing in %s', async language => {
 const html = await readFile('server/internal/syncstore/admin/index.html', 'utf8');
 dom = new JSDOM(html, { url: 'https://sync.example.com/admin/', runScripts: 'outside-only', beforeParse: window => { Object.defineProperty(window.navigator, 'language', { value: language }); } });
 const window = dom.window;
 window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
 window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
 const name = '<img src=x onerror=alert(1)>', secret = 'xsk_' + 'e'.repeat(64);
 const users: unknown[] = [];
 const fetch = async (url: string, options?: { method?: string }) => {
  let value: unknown = {};
  if (url.endsWith('/users') && options?.method === 'POST') { const user = { id: 'a'.repeat(64), name, active: true, keyTail: 'eeeeee', keyRevision: 1, vaults: 0 }; users.push(user); value = { user, key: secret }; }
  else if (url.endsWith('/users')) value = { users };
  return { ok: true, status: 200, json: async () => value };
 };
 Object.assign(window, { fetch }); window.eval(source);
 const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
 const document = window.document;
 await vi.waitFor(() => expect(document.getElementById('create-user')).not.toBeNull());
 document.getElementById('create-user')!.click();
 (document.getElementById('user-name') as HTMLInputElement).value = name;
 const create = [...document.querySelectorAll<HTMLButtonElement>('#modal-actions button')].find(button => button.textContent === (language === 'en' ? 'Create and generate key' : '创建并生成 key'))!;
 create.click(); await vi.waitFor(() => expect(document.getElementById('one-time-key')).not.toBeNull());
 expect(document.getElementById('one-time-key')?.textContent).toBe(secret);
 expect(document.querySelector('img')).toBeNull();
 const close = document.getElementById('close-key') as HTMLButtonElement; expect(close.disabled).toBe(true);
 const checkbox = document.getElementById('key-saved') as HTMLInputElement; checkbox.checked = true; checkbox.dispatchEvent(new window.Event('change'));
 expect(close.disabled).toBe(false); close.click(); await flush();
 expect(document.body.textContent).not.toContain(secret);
 expect(JSON.stringify(window.localStorage)).not.toContain(secret);
 expect(document.getElementById('rows')!.textContent).toContain(name);
 expect(document.querySelector('img')).toBeNull();
});

async function languagePage(authenticated = false, saved?: string): Promise<Document> {
 const html = await readFile('server/internal/syncstore/admin/index.html', 'utf8');
 dom = new JSDOM(html, { url: 'https://sync.example.com/admin/', runScripts: 'outside-only' });
 const { window } = dom;
 if (saved) window.localStorage.setItem('xsync.admin.language', saved);
 window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
 window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
 Object.assign(window, { fetch: async (url: string) => {
  let value: unknown = {};
  if (!authenticated) value = { code: 'UNAUTHORIZED' };
  else if (url.endsWith('/users')) value = { users: [{ id: 'a'.repeat(64), name: '已启用', active: true, keyTail: 'abc123', keyRevision: 2, vaults: 1 }] };
  else if (url.endsWith('/audit')) value = { entries: [{ at: '2026-10-18T00:00:00Z', message: '创建用户「已启用」并生成访问 key' }] };
  else if (url.endsWith('/vaults')) value = { vaults: [{ id: 'b'.repeat(64), name: '中文知识库', userName: '已启用', userId: 'a'.repeat(64), devices: 2, active: true }] };
  return { ok: authenticated, status: authenticated ? 200 : 401, json: async () => value };
 } });
 window.eval(source);
 await vi.waitFor(() => expect(window.document.getElementById(authenticated ? 'create-user' : 'login-view')).not.toBeNull());
 if (!authenticated) await vi.waitFor(() => expect(window.document.getElementById('login-view')!.hidden).toBe(false));
 return window.document;
}
async function chooseLanguage(document: Document, language: string): Promise<void> {
 const selector = document.querySelector<HTMLSelectElement>('[data-language]')!;
 selector.value = language; selector.dispatchEvent(new dom!.window.Event('change'));
 await vi.waitFor(() => expect(document.documentElement.lang).toBe(language === 'en' ? 'en-US' : 'zh-CN'));
}

it('defaults to browser English and changes login language without clearing the password or its error', async () => {
 const document = await languagePage(), password = document.getElementById('admin-password') as HTMLInputElement;
 expect(document.querySelector('#login-view h1')!.textContent).toBe('Manage your sync service');
 password.value = 'unsaved-admin-password'; document.querySelector<HTMLButtonElement>('#login-form button')!.click();
 await vi.waitFor(() => expect(document.getElementById('login-error')!.textContent).toBe('Incorrect admin password. Try again.'));
 await chooseLanguage(document, 'zh');
 expect(password.value).toBe('unsaved-admin-password'); expect(document.getElementById('login-error')!.textContent).toBe('管理密码错误，请重试。');
 expect(document.title).toBe('xSync · 管理后台'); expect(dom!.window.localStorage.getItem('xsync.admin.language')).toBe('zh');
});

it('honors stored language, preserves search text and leaves user/vault names untouched', async () => {
 const document = await languagePage(true, 'zh');
 expect(document.querySelector('#content h1')!.textContent).toBe('用户与访问 key');
 const search = document.getElementById('search') as HTMLInputElement; search.value = '已启用'; search.dispatchEvent(new dom!.window.Event('input'));
 await chooseLanguage(document, 'en');
 await vi.waitFor(() => expect(document.querySelector('#content h1')!.textContent).toBe('Users and access keys'));
 expect((document.getElementById('search') as HTMLInputElement).value).toBe('已启用');
 expect(document.querySelector('.user-cell')!.textContent).toContain('已启用'); expect(document.querySelector('.tag.green')!.textContent).toBe('Enabled');
 document.querySelector<HTMLButtonElement>('[data-nav="vaults"]')!.click();
 await vi.waitFor(() => expect(document.querySelector('#content h1')!.textContent).toBe('Sync vaults'));
 expect(document.getElementById('content')!.textContent).toContain('中文知识库'); expect(document.querySelector('tbody td:nth-child(3)')!.textContent).toBe('2');
 document.querySelector<HTMLButtonElement>('[data-nav="audit"]')!.click();
 await vi.waitFor(() => expect(document.querySelector('.log-row')!.textContent).toContain('Created user “已启用” and generated an access key'));
});

it('translates management confirmations while still requiring the exact original user name', async () => {
 const document = await languagePage(true, 'en');
 document.querySelector<HTMLButtonElement>('[data-action="rotate"]')!.click();
 expect(document.getElementById('modal-title')!.textContent).toBe('Rotate the key for “已启用”?');
 expect(document.getElementById('modal-body')!.textContent).toContain('old key and device authorizations');
 (document.getElementById('modal') as HTMLDialogElement).close();
 document.querySelector<HTMLButtonElement>('[data-action="delete"]')!.click();
 const confirm = document.getElementById('delete-user') as HTMLButtonElement, name = document.getElementById('delete-name') as HTMLInputElement;
 expect(confirm.textContent).toBe('Delete user and remote data'); expect(confirm.disabled).toBe(true);
 name.value = 'Enabled'; name.dispatchEvent(new dom!.window.Event('input')); expect(confirm.disabled).toBe(true);
 name.value = '已启用'; name.dispatchEvent(new dom!.window.Event('input')); expect(confirm.disabled).toBe(false);
});

it('sanitizes admin template boundaries while retaining form controls, labels and action hooks', async () => {
 const sanitizerSource = (await build({ entryPoints: ['server/admin/dom.ts'], bundle: true, write: false, format: 'iife', globalName: 'adminHTML', target: 'es2022' })).outputFiles[0]!.text;
 dom = new JSDOM('', { runScripts: 'outside-only' });
 const window = dom.window;
 const renderer = window.eval(sanitizerSource + '\nadminHTML;') as { setHTML(target: HTMLElement, markup: string): void };
 const target = window.document.createElement('div'); window.document.body.append(target);
 renderer.setHTML(target, '<script>alert(1)</script><img src=x onerror="alert(1)"><svg onload="alert(1)"></svg><a href="javascript:alert(1)">unsafe</a><label for="key">Access key</label><input id="key" type="password" autocomplete="off"><input type="checkbox" checked><button data-action="detail" data-id="fixture">Details</button>');
 expect(target.querySelector('script,svg,[onerror],[onload],[href^="javascript:"]')).toBeNull();
 expect(target.querySelector('label')!.htmlFor).toBe('key'); expect(target.querySelector<HTMLInputElement>('#key')!.type).toBe('password');
 expect(target.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
 expect(target.querySelector('button')!.dataset).toMatchObject({ action: 'detail', id: 'fixture' });
});
