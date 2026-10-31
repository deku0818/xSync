import type { DiffRow } from "./diff-lines";

/** Copy source text only: aligned gaps and line numbers are presentation, not note content. */
export function selectedSourceText(pane: HTMLElement): string {
  const selection = pane.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const range = selection.getRangeAt(0);
  if (!pane.contains(range.startContainer) || !pane.contains(range.endContainer)) return "";
  const spans = pane.querySelectorAll<HTMLElement>(".code-text");
  if (!spans.length) return selection.toString();
  const lines: string[] = [];
  for (const span of spans) {
    if (!span.dataset.line || !range.intersectsNode(span)) continue;
    const part = pane.ownerDocument.createRange(); part.selectNodeContents(span);
    if (part.compareBoundaryPoints(range.START_TO_START, range) < 0) part.setStart(range.startContainer, range.startOffset);
    if (part.compareBoundaryPoints(range.END_TO_END, range) > 0) part.setEnd(range.endContainer, range.endOffset);
    lines.push(part.toString());
  }
  return lines.join("\n");
}

/** Keeps wrapped lines aligned, scroll positions linked and difference navigation in one place. */
export class DiffPanes {
  private view: NonNullable<Document["defaultView"]>;
  private observer: ResizeObserver;
  private frame?: number;
  private scrollFrame?: number;
  private scrolling?: HTMLElement;
  private groups: number[][] = [];
  private current = 0;
  private onScroll = (event: Event): void => {
    const pane = event.currentTarget as HTMLElement;
    if (this.scrolling && this.scrolling !== pane) return;
    this.scrolling = pane;
    this.panes.find(other => other !== pane)!.scrollTop = pane.scrollTop;
    this.view.cancelAnimationFrame(this.scrollFrame ?? 0);
    this.scrollFrame = this.view.requestAnimationFrame(() => { this.scrolling = undefined; });
  };
  private onCopy = (event: ClipboardEvent): void => {
    const text = selectedSourceText(event.currentTarget as HTMLElement);
    if (text && event.clipboardData) { event.clipboardData.setData("text/plain", text); event.preventDefault(); }
  };
  constructor(private panes: [HTMLElement, HTMLElement], private changed: (current: number, total: number) => void) {
    this.view = panes[0].ownerDocument.defaultView!;
    this.observer = new this.view.ResizeObserver(() => this.layout());
    for (const pane of panes) {
      this.observer.observe(pane);
      pane.addEventListener("scroll", this.onScroll, { passive: true });
      pane.addEventListener("copy", this.onCopy);
    }
  }
  render(rows: DiffRow[]): void {
    this.clear();
    rows.forEach((row, index) => {
      if (row.type !== "same") {
        if (!index || rows[index - 1]!.type === "same") this.groups.push([]);
        this.groups.at(-1)!.push(index);
      }
      for (const [side, pane] of this.panes.entries()) {
        const key = side === 0 ? "a" : "b", number = row[`${key}Line`];
        const line = pane.createDiv("code-row" + (number === undefined ? " blank" : row.type === "same" ? "" : side === 0 ? " changed-left" : " changed-right"));
        line.createSpan({ cls: "line-number", text: String(number ?? "") }).setAttribute("aria-hidden", "true");
        const text = line.createSpan({ cls: "code-text" });
        text.append(pane.ownerDocument.createTextNode(row[key] ?? ""));
        text.dataset.line = String(number ?? "");
      }
    });
    this.mark(); this.layout();
  }
  clear(): void {
    this.groups = []; this.current = 0;
    for (const pane of this.panes) pane.replaceChildren();
    this.changed(0, 0);
  }
  layout(): void {
    this.view.cancelAnimationFrame(this.frame ?? 0);
    this.frame = this.view.requestAnimationFrame(() => {
      const rows = this.panes.map(pane => [...pane.querySelectorAll<HTMLElement>(".code-row")]);
      for (const side of rows) for (const row of side) row.setCssProps({ "min-height": "" });
      const heights = rows[0]!.map((row, index) => Math.max(row.getBoundingClientRect().height, rows[1]![index]!.getBoundingClientRect().height));
      rows[0]!.forEach((row, index) => {
        const height = { "min-height": `${heights[index]}px` };
        row.setCssProps(height); rows[1]![index]!.setCssProps(height);
      });
    });
  }
  navigate(delta: number): void {
    if (!this.groups.length) return;
    this.current = (this.current + delta + this.groups.length) % this.groups.length;
    this.mark();
    const row = this.panes[0].children[this.groups[this.current]![0]!] as HTMLElement;
    for (const pane of this.panes) pane.scrollTop = Math.max(0, row.offsetTop - 12);
  }
  private mark(): void {
    for (const pane of this.panes) {
      for (const row of pane.querySelectorAll(".is-current")) row.classList.remove("is-current");
      for (const index of this.groups[this.current] ?? []) pane.children[index]!.classList.add("is-current");
    }
    this.changed(this.current + 1, this.groups.length);
  }
  dispose(): void {
    this.observer.disconnect();
    this.view.cancelAnimationFrame(this.frame ?? 0); this.view.cancelAnimationFrame(this.scrollFrame ?? 0);
    for (const pane of this.panes) { pane.removeEventListener("scroll", this.onScroll); pane.removeEventListener("copy", this.onCopy); }
  }
}
