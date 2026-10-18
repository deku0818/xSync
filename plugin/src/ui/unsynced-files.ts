import type { Translator } from '../i18n';
import type { FileIssue, SkippedFile } from '../sync/store';
import { fixedExclusion } from '../sync/policy';

export interface UnsyncedFile { path: string; skipped: boolean; tag: string; reason: string }

/** File-level results only; internal credentials and workspace files are outside sync scope. */
export function unsyncedFiles(issues: readonly FileIssue[], skipped: readonly SkippedFile[], t: Translator): UnsyncedFile[] {
 const files = new Map<string, UnsyncedFile>();
 for (const file of skipped) {
  if (fixedExclusion(file.path)) continue;
  let tag = t("按规则跳过");
  if (file.reason.startsWith('超过 ')) tag = t("超过大小限制");
  else if (file.reason.startsWith('文件夹：')) tag = t("文件夹排除");
  else if (file.reason.startsWith('后缀：')) tag = t("后缀排除");
  else if (file.reason.startsWith('正则：')) tag = t("正则排除");
  files.set(file.path, { path: file.path, skipped: true, tag, reason: t(file.reason) });
 }
 const tags = { checking: t("检查失败"), uploading: t("上传失败"), downloading: t("下载失败"), applying: t("应用失败") };
 for (const issue of issues) {
  if (fixedExclusion(issue.path)) continue;
  let tag = tags[issue.phase], reason = t("本次同步未完成，将在后续同步中重试。错误：{0}", issue.code);
  if (issue.code === 'UNSUPPORTED_PATH' || issue.code === 'UNSAFE_PATH') {
   tag = t("名称不支持");
   const characters = [...new Set(issue.path.match(/[<>:"|?*]/g) ?? [])];
   reason = characters.length
    ? t("文件名含不支持的字符：{0}。请在 Obsidian 中重命名后同步。", characters.map(char => `「${char}」`).join('、'))
    : t("路径或文件名不受支持，请检查保留名称、末尾空格或句点，以及路径长度；在本机重命名后重试。");
  }
  files.set(issue.path, { path: issue.path, skipped: false, tag, reason });
 }
 return [...files.values()].sort((left, right) => Number(left.skipped) - Number(right.skipped) || left.path.localeCompare(right.path));
}
