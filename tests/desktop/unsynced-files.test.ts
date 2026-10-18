import { expect, it } from 'vitest';
import { I18n } from '../../plugin/src/i18n';
import { unsyncedFiles } from '../../plugin/src/ui/unsynced-files';

it.each(['zh', 'en'] as const)('lists actionable failures before policy skips with localized reasons in %s', language => {
 const t = new I18n(language).t;
 const rows = unsyncedFiles([
  { path: 'notes/bad"?.md', code: 'UNSUPPORTED_PATH', phase: 'checking' },
  { path: 'attachment.bin', code: 'NETWORK_TIMEOUT', phase: 'uploading' },
 ], [
  { id: 'large', path: 'large.bin', reason: '超过 50 MB' },
  { id: 'folder', path: 'ignore/note.md', reason: '文件夹：ignore/' },
  { id: 'extension', path: 'archive.zip', reason: '后缀：.zip' },
  { id: 'pattern', path: 'logs/output.md', reason: '正则：^logs/' },
  { id: 'duplicate', path: 'notes/bad"?.md', reason: '旧跳过记录' },
 ], t);
 expect(rows).toHaveLength(6); expect(rows.slice(0, 2).every(row => !row.skipped)).toBe(true);
 const invalid = rows.find(row => row.path === 'notes/bad"?.md')!;
 expect(invalid.reason).toContain('「"」'); expect(invalid.reason).toContain('「?」');
 expect(invalid.tag).toBe(language === 'zh' ? '名称不支持' : 'Unsupported name');
 expect(rows.find(row => row.path === 'attachment.bin')!.reason).toContain('NETWORK_TIMEOUT');
 expect(rows.find(row => row.path === 'large.bin')!.reason).toBe(language === 'zh' ? '超过 50 MB' : 'Exceeds 50 MB');
 expect(rows.find(row => row.path === 'archive.zip')!.tag).toBe(language === 'zh' ? '后缀排除' : 'Extension excluded');
});

it('explains reserved names and keeps device-local internal files outside the unsynced list', () => {
 const rows = unsyncedFiles([
  { path: 'notes/CON.md', code: 'UNSUPPORTED_PATH', phase: 'checking' },
  { path: '.obsidian/obsidian-sync-local/device.json', code: 'INVALID_REQUEST', phase: 'checking' },
 ], [{ id: 'workspace', path: '.obsidian/workspace.json', reason: '窗口布局' }], new I18n('zh').t);
 expect(rows).toHaveLength(1); expect(rows[0]!.reason).toContain('保留名称');
 expect(unsyncedFiles([], [], new I18n('zh').t)).toEqual([]);
});
