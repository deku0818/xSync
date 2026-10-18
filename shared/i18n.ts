export type LanguagePreference = 'auto' | 'zh' | 'en';
export type UiLanguage = 'zh' | 'en';
export type Translator = (source: string, ...values: unknown[]) => string;

function format(source: string, values: unknown[]): string {
 return source.replace(/\{(\d+)\}/g, (token, index: string) => values[Number(index)] === undefined ? token : String(values[Number(index)]));
}
export const chinese: Translator = (source, ...values) => format(source, values);
/** UI language and interpolation shared by the plugin and the administration page. */
export class I18n {
 private reverse: Map<string, string>;
 private patterns: { source: string; indexes: number[]; pattern: RegExp }[];
 constructor(private english: Readonly<Record<string, string>>, public preference: LanguagePreference = 'auto', private hostLanguage: () => string = () => 'en') {
  this.reverse = new Map(Object.entries(english).map(([source, translated]) => [translated, source]));
  this.patterns = Object.entries(english).flatMap(([source, translated]) => {
   if (!/\{\d+\}/.test(source)) return [];
   return [source, translated].filter(form => form.replace(/\{\d+\}/g, "").trim()).map(form => {
    const indexes: number[] = [];
    const pattern = form.split(/(\{\d+\})/).map(part => {
     if (/^\{\d+\}$/.test(part)) { indexes.push(Number(part.slice(1, -1))); return '([\\s\\S]*?)'; }
     return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { source, indexes, pattern: new RegExp('^' + pattern + '$') };
   });
  });
 }

 get language(): UiLanguage {
  if (this.preference !== 'auto') return this.preference;
  return this.hostLanguage().toLowerCase().startsWith('zh') ? 'zh' : 'en';
 }
 get locale(): string { return this.language === 'zh' ? 'zh-CN' : 'en-US'; }
 readonly t: Translator = (source, ...values) => {
  const key = Object.hasOwn(this.english, source) ? source : this.reverse.get(source);
  if (key !== undefined) return format(this.language === 'en' ? this.english[key]! : key, values);
  if (!values.length) {
   if (source.startsWith('Error: ')) return 'Error: ' + this.t(source.slice(7));
   for (const entry of this.patterns) {
    const match = entry.pattern.exec(source); if (!match) continue;
    const arguments_: string[] = []; entry.indexes.forEach((index, position) => { arguments_[index] = match[position + 1]!; });
    return format(this.language === 'en' ? this.english[entry.source]! : entry.source, arguments_);
   }
  }
  return format(source, values);
 };
}

/** Capture only repository template text. User values and dynamically replaced nodes are never captured. */
export function templateLocalizer(root: HTMLElement, i18n: Pick<I18n, 'language' | 't'>): () => boolean {
 const bindings: { source: string; previous: string; read(): string | null; write(value: string): void; present(): boolean; active: boolean }[] = [];
 const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
 let node: Node | null;
 while ((node = walker.nextNode())) {
  const text = node as Text, source = text.nodeValue ?? '';
  if (/\p{Script=Han}/u.test(source)) bindings.push({ source, previous: source, read: () => text.nodeValue, write: value => { text.nodeValue = value; }, present: () => root.contains(text), active: true });
 }
 for (const element of root.querySelectorAll('*')) for (const attr of ['placeholder', 'title', 'aria-label']) {
  const source = element.getAttribute(attr);
  if (source && /\p{Script=Han}/u.test(source)) bindings.push({ source, previous: source, read: () => element.getAttribute(attr), write: value => { element.setAttribute(attr, value); }, present: () => root.contains(element), active: true });
 }
 let language: UiLanguage | undefined;
 return () => {
  if (language === i18n.language) return false;
  language = i18n.language;
  for (const binding of bindings) {
   if (!binding.active) continue;
   if (!binding.present() || binding.read() !== binding.previous) { binding.active = false; continue; }
   const trimmed = binding.source.trim();
   const translated = binding.source.replace(trimmed, i18n.t(trimmed));
   binding.write(translated); binding.previous = translated;
  }
  return true;
 };
}
