import { z } from "zod";
import { RE2JS } from "re2js";

export const HARD_FILE_BYTES = 100_000_000;
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const rulesSchema = z.strictObject({ maxMB: z.number().int().min(1).max(100), suffixes: z.array(z.string().min(2).max(33)).max(64),
  folders: z.array(z.string().min(1).max(1024)).max(64), regexes: z.array(z.strictObject({ source: z.string().min(1).max(256), flags: z.enum(["", "i"]) })).max(64) });
export type SyncRules = z.infer<typeof rulesSchema>;
export const defaultRules = (): SyncRules => ({ maxMB: 100, suffixes: [], folders: [], regexes: [] });
export interface FileEntry { path: string; size: number; directory?: boolean; reason?: string }
export function folderPath(input: string): string {
  const path = input.trim().normalize("NFC").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === ".." || /[\x00-\x1f<>:"|?*]/.test(p))) throw new Error("请输入有效的仓库相对目录");
  return path;
}
export function parseSuffixes(input: string): string[] {
  return [...new Set(input.split(/[\s,，;；]+/).filter(Boolean).map(s => {
    const suffix = (s.startsWith(".") ? s : `.${s}`).toLowerCase();
    if (!/^\.[a-z0-9][a-z0-9._+-]{0,31}$/.test(suffix) || suffix.includes("..")) throw new Error("请输入有效后缀，例如 .pdf 或 .tar.gz");
    return suffix;
  }))];
}
export function validateRules(input: unknown): SyncRules {
  const rules = rulesSchema.parse(input);
  rules.folders = [...new Set(rules.folders.map(folderPath))];
  rules.suffixes = parseSuffixes(rules.suffixes.join(","));
  for (const r of rules.regexes) { try { RE2JS.compile(r.source, r.flags === "i" ? RE2JS.CASE_INSENSITIVE : 0); } catch { throw new Error(`无效或不受支持的 RE2 正则：${r.source}`); } }
  return rules;
}
export function fixedExclusion(path: string): string | undefined {
  const p = path.toLowerCase();
  if (/^\.obsidian\/(obsidian-sync-local|plugins\/obsidian-sync-dev)(\/|$)/.test(p)) return "同步凭据、设备身份与内部状态";
  if (/^\.obsidian\/(workspace(?:-mobile|s)?\.json|obsidian-sync-development\.json)$/.test(p)) return "窗口布局或本机开发标记";
  if (p.split("/").some((part, i) => part.startsWith(".") && !(i === 0 && part === ".obsidian"))) return "隐藏文件或缓存";
  if (/^\.obsidian\/(cache|logs?|backups?|trash)(\/|$)/.test(p) || /^\.obsidian\/.*(?:credential|secret|token|device-identity|private-key)[^/]*\.(json|ya?ml|txt)$/i.test(p) || /^\.obsidian\/.*\.(pem|key|p12|pfx)$/.test(p)) return "本机凭据、缓存或备份";
  return undefined;
}
export class SyncPolicy {
  readonly rules: SyncRules;
  private patterns: { source: string; pattern: RE2JS }[];
  constructor(input: SyncRules = defaultRules()) { this.rules = validateRules(input); this.patterns = this.rules.regexes.map(r => ({ source: r.source, pattern: RE2JS.compile(r.source, r.flags === "i" ? RE2JS.CASE_INSENSITIVE : 0) })); }
  get maxBytes(): number { return this.rules.maxMB * 1_000_000; }
  reason(path: string, size?: number, directory = false): string | undefined {
    const fixed = fixedExclusion(path); if (fixed) return fixed;
    const p = path.normalize("NFC").toLowerCase();
    const folder = this.rules.folders.find(f => p === f.toLowerCase() || p.startsWith(`${f.toLowerCase()}/`));
    if (folder) return `文件夹：${folder}/`;
    const normalized = path.normalize("NFC"); const parts = normalized.split("/"); const candidates = [normalized];
    for (let i = 1; i < parts.length; i++) { const dir = parts.slice(0, i).join("/"); candidates.push(dir, `${dir}/`); }
    if (directory) candidates.push(`${normalized}/`);
    for (const r of this.patterns) if (candidates.some(c => r.pattern.test(c))) return `正则：${r.source}`;
    if (!directory) {
      const suffix = this.rules.suffixes.find(s => p.endsWith(s)); if (suffix) return `后缀：${suffix}`;
      if (size !== undefined && size > this.maxBytes) return `超过 ${this.rules.maxMB} MB`;
    }
    return undefined;
  }
}
