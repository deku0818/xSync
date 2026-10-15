let instance = 0;
/** Templates are static repository markup. All server/user values are assigned via textContent/value. */
export function mountTemplate(root: HTMLElement, template: string): <T extends HTMLElement = HTMLElement>(id: string) => T {
  root.innerHTML = `<svg style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>
  <symbol id="cloud" viewBox="0 0 24 24"><path d="M7 18H6a4 4 0 0 1-.6-7.95A6.5 6.5 0 0 1 18 8.5a4.75 4.75 0 0 1 0 9.5h-1M12 20V11m-3 3 3-3 3 3"/></symbol>
  <symbol id="monitor" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></symbol>
  <symbol id="lock" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></symbol>
  <symbol id="alert" viewBox="0 0 24 24"><path d="M10.3 3.5 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0zM12 9v4m0 4h.01"/></symbol>
  <symbol id="check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol><symbol id="close" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></symbol>
  <symbol id="file" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6"/></symbol></defs></svg>` + template;
  const prefix = `oss-ui-${++instance}-`; const ids = new Map<string, string>();
  for (const element of root.querySelectorAll<HTMLElement>("[id]")) { const id = element.id; element.dataset.ui = id; ids.set(id, prefix + id); element.id = prefix + id; }
  for (const element of root.querySelectorAll<HTMLElement>("[for],[aria-labelledby],[aria-describedby],[aria-controls]")) for (const attr of ["for", "aria-labelledby", "aria-describedby", "aria-controls"]) {
    const value = element.getAttribute(attr); if (value) element.setAttribute(attr, value.split(/\s+/).map(id => ids.get(id) ?? id).join(" "));
  }
  for (const use of root.querySelectorAll("use[href]")) { const ref = use.getAttribute("href")!; if (ref.startsWith("#") && ids.has(ref.slice(1))) use.setAttribute("href", `#${ids.get(ref.slice(1))}`); }
  return <T extends HTMLElement = HTMLElement>(id: string): T => { const node = root.querySelector<T>(`[data-ui="${id}"]`); if (!node) throw new Error(`MISSING_UI_ELEMENT: ${id}`); return node; };
}
export function icon(root: HTMLElement, name: string): HTMLElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const paths: Record<string, string> = { folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z", file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6", chevron: "m9 6 6 6-6 6" };
  path.setAttribute("d", paths[name] ?? paths.file!); svg.appendChild(path); root.appendChild(svg); return root;
}
