import { sanitizeHTMLToDom } from "obsidian";
let instance = 0;
const iconMarkup = new Map([
  ["cloud", "<path d=\"M7 18H6a4 4 0 0 1-.6-7.95A6.5 6.5 0 0 1 18 8.5a4.75 4.75 0 0 1 0 9.5h-1M12 20V11m-3 3 3-3 3 3\"/>"],
  ["monitor", "<rect x=\"3\" y=\"4\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M8 21h8m-4-4v4\"/>"],
  ["lock", "<rect x=\"5\" y=\"10\" width=\"14\" height=\"11\" rx=\"2\"/><path d=\"M8 10V7a4 4 0 0 1 8 0v3m-4 5v2\"/>"],
  ["alert", "<path d=\"M10.3 3.5 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0zM12 9v4m0 4h.01\"/>"],
  ["check", "<path d=\"m5 12 4 4L19 6\"/>"],
  ["close", "<path d=\"m6 6 12 12M6 18 18 6\"/>"],
  ["file", "<path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6\"/>"],
]);
/** Templates are static repository markup. All server/user values are assigned via textContent/value. */
export function mountTemplate(root: HTMLElement, template: string): <T extends HTMLElement = HTMLElement>(id: string) => T {
  // Inline known repository icon paths: sanitizers intentionally remove SVG <use> references.
  const markup = template.replace(/<use\b([^>]*)\/>/g, (_match, attributes: string) => {
    const name = /\bhref="#([a-z]+)"/.exec(attributes)?.[1];
    const id = /\bid="([a-z-]+)"/.exec(attributes)?.[1];
    const shape = name ? iconMarkup.get(name) ?? "" : "";
    return id ? `<g id="${id}">${shape}</g>` : shape;
  });
  root.replaceChildren(root.ownerDocument.importNode(sanitizeHTMLToDom(markup), true));
  for (const svg of root.querySelectorAll("svg")) if (!svg.hasAttribute("viewBox")) svg.setAttribute("viewBox", "0 0 24 24");
  const prefix = `oss-ui-${++instance}-`; const ids = new Map<string, string>();
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) { const id = element.id; element.dataset.ui = id; ids.set(id, prefix + id); element.id = prefix + id; }
  for (const element of root.querySelectorAll<HTMLElement>("[for],[aria-labelledby],[aria-describedby],[aria-controls]")) for (const attr of ["for", "aria-labelledby", "aria-describedby", "aria-controls"]) {
    const value = element.getAttribute(attr); if (value) element.setAttribute(attr, value.split(/\s+/).map(id => ids.get(id) ?? id).join(" "));
  }
  return <T extends HTMLElement = HTMLElement>(id: string): T => { const node = root.querySelector<T>(`[data-ui="${id}"]`); if (!node) throw new Error(`MISSING_UI_ELEMENT: ${id}`); return node; };
}
export function updateIcon(target: Element, name: string): void {
  const markup = iconMarkup.get(name); if (!markup) throw new Error("UNKNOWN_UI_ICON");
  const svg = sanitizeHTMLToDom(`<svg>${markup}</svg>`).querySelector("svg");
  if (!svg) throw new Error("MISSING_UI_ICON");
  target.replaceChildren(...Array.from(svg.childNodes, node => target.ownerDocument.importNode(node, true)));
}
export function icon(root: HTMLElement, name: string): HTMLElement {
  const svg = root.createSvg("svg", { attr: { "aria-hidden": "true", viewBox: "0 0 24 24" } });
  const path = svg.createSvg("path");
  const paths: Record<string, string> = { folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z", file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6", chevron: "m9 6 6 6-6 6" };
  path.setAttribute("d", paths[name] ?? paths.file!); return root;
}
