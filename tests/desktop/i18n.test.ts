import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { I18n, templateLocalizer } from '../../plugin/src/i18n';
import { I18n as SharedI18n } from '../../shared/i18n';
import { english as adminEnglish } from '../../server/admin/translations';
import { english } from '../../plugin/src/ui/translations';
import { overviewTemplate, reviewTemplate, settingsTemplate } from '../../plugin/src/ui/templates';
import { connectionSettings } from '../../plugin/src/sync/connection-settings';
import { SyncPolicy } from '../../plugin/src/sync/policy';
import { connectionFailure } from '../../plugin/src/sync/connection-check';
import { syncPresentation } from '../../plugin/src/ui/sync-status';

it('follows the host language unless this device has an explicit preference', () => {
 for (const host of ['zh', 'zh-CN', 'zh-TW']) expect(new I18n('auto', () => host).language).toBe('zh');
 for (const host of ['en', 'en-GB', 'fr']) expect(new I18n('auto', () => host).language).toBe('en');
 expect(new I18n('zh', () => 'en').t('已同步')).toBe('已同步');
 expect(new I18n('en', () => 'zh').t('已同步')).toBe('Synced');
 for (const language of ['auto', 'zh', 'en']) expect(connectionSettings({ language }, '').language).toBe(language);
 expect(connectionSettings(null, '').language).toBe('auto');
 expect(() => connectionSettings({ language: 'fr' }, '')).toThrow();
});

it('translates system messages and policy reasons without changing supplied user data', () => {
 const i18n = new I18n('en');
 expect(i18n.t('本地「{0}」已绑定「{1}」。', '已同步', '<笔记>{1}')).toBe('Local vault “已同步” is connected to “<笔记>{1}”.');
 const reason = new SyncPolicy({ maxMB: 10, folders: ['中文资料'], suffixes: [], regexes: [] }).reason('中文资料/笔记.md')!;
 expect(i18n.t(reason)).toBe('Folder: 中文资料/');
 expect(i18n.t('超过 10 MB')).toBe('Exceeds 10 MB');
 expect(connectionFailure(new Error('HTTPS_REQUIRED'), 'server', i18n.t).message).toBe('Use an HTTPS address. HTTP is allowed for local testing.');
 expect(syncPresentation(undefined, false, true, false, false, i18n.t).label).toBe('Connection required');
 expect(i18n.t('constructor')).toBe('constructor');
 i18n.preference = 'zh';
 expect(i18n.t('Folder: 中文资料/')).toBe(reason);
 expect(i18n.t('Could not save: SETTINGS_WRITE_FAILED')).toBe('保存失败：SETTINGS_WRITE_FAILED');
});

it('covers all source templates and UI translation calls with matching placeholders', async () => {
 for (const [source, value] of Object.entries({ ...english, ...adminEnglish })) {
  const tokens = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  expect(tokens(value), source).toEqual(tokens(source));
 }
 const browser = new JSDOM('');
 try {
  for (const template of [settingsTemplate, overviewTemplate, reviewTemplate, await readFile('server/internal/syncstore/admin/index.html', 'utf8')]) {
   const root = browser.window.document.createElement('div'); root.innerHTML = template;
   const walker = root.ownerDocument.createTreeWalker(root, 4); let node: Node | null;
   const sources: string[] = [];
   while ((node = walker.nextNode())) sources.push(node.nodeValue!.trim());
   for (const element of root.querySelectorAll('*')) for (const attr of ['placeholder', 'title', 'aria-label']) sources.push(element.getAttribute(attr) ?? '');
   for (const source of sources.filter(source => /\p{Script=Han}/u.test(source))) expect(Object.hasOwn(english, source) || Object.hasOwn(adminEnglish, source), source).toBe(true);
  }
 } finally { browser.window.close(); }
 for (const name of ['sync-main.ts', 'ui/connection-form.ts', 'ui/vault-connection.ts', 'ui/sync-panels.ts', 'ui/settings-tab.ts', 'ui/sync-status.ts', 'sync/connection-check.ts']) {
  const code = await readFile('plugin/src/' + name, 'utf8');
  for (const match of code.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
   const source = JSON.parse(match[1]!); expect(Object.hasOwn(english, source), source).toBe(true);
  }
 }
});

it('updates template text and accessible labels in place while preserving inputs and user content', () => {
 const browser = new JSDOM('');
 try {
  const root = browser.window.document.createElement('div');
  root.innerHTML = '<label>库加密密码</label><input type="password" placeholder="请输入访问 key" aria-label="界面语言"><span>已同步</span>';
  const field = root.querySelector('input')!; field.value = '中文密码';
  const i18n = new I18n('zh'), localize = templateLocalizer(root, i18n); localize();
  const user = browser.window.document.createElement('p'); user.textContent = '已同步'; root.append(user);
  root.querySelector('span')!.textContent = '用户笔记';
  i18n.preference = 'en'; expect(localize()).toBe(true);
  expect(root.querySelector('label')!.textContent).toBe('Vault encryption password');
  expect(field.placeholder).toBe('Enter access key'); expect(field.getAttribute('aria-label')).toBe('Language');
  expect(field.value).toBe('中文密码'); expect(root.querySelector('span')!.textContent).toBe('用户笔记'); expect(user.textContent).toBe('已同步');
  expect(localize()).toBe(false);
  i18n.preference = 'zh'; localize(); expect(root.querySelector('label')!.textContent).toBe('库加密密码'); expect(field.value).toBe('中文密码');
 } finally { browser.window.close(); }
});

it('does not treat count-only English translations as a match for arbitrary errors or audit text', () => {
 const i18n = new SharedI18n(adminEnglish, 'en');
 expect(i18n.t('{0} 个', 1)).toBe('1');
 expect(i18n.t('UNEXPECTED_ERROR')).toBe('UNEXPECTED_ERROR');
 i18n.preference = 'zh'; expect(i18n.t('UNEXPECTED_ERROR')).toBe('UNEXPECTED_ERROR');
});
