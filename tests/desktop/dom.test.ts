import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
const sanitizerFixture = vi.hoisted(() => ({ close: () => {} }));
// A DOMPurify-backed fixture implements the host sanitizer contract; real host installation remains separate.
vi.mock("obsidian", async () => {
  const { default: createDOMPurify } = await import("dompurify");
  const { JSDOM } = await import("jsdom");
  const host = new JSDOM(""); sanitizerFixture.close = () => host.window.close();
  const purify = createDOMPurify(host.window);
  return { sanitizeHTMLToDom: (html: string) => purify.sanitize(html, { RETURN_DOM_FRAGMENT: true }) };
});
import { mountTemplate, updateIcon } from "../../plugin/src/ui/dom";
import { settingsTemplate, overviewTemplate, reviewTemplate } from "../../plugin/src/ui/templates";

let browser: JSDOM;
let document: Document;
beforeEach(() => { browser = new JSDOM(""); document = browser.window.document; });
afterEach(() => { browser.window.close(); });
afterAll(() => { sanitizerFixture.close(); });
it.each([settingsTemplate, overviewTemplate, reviewTemplate])("preserves form controls and approved icons while isolating repeated template IDs", template => {
  const a = document.createElement("div"), b = document.createElement("div"); document.body.append(a,b);
  mountTemplate(a,template); mountTemplate(b,template);
  const ids = [...document.querySelectorAll("[id]")].map(node => node.id);
  expect(new Set(ids).size).toBe(ids.length); expect(ids.every(id=>id.startsWith("oss-ui-"))).toBe(true);
  for (const root of [a,b]) {
    for (const label of root.querySelectorAll("label[for]")) expect(root.querySelector(`[id="${label.getAttribute("for")}"]`)).not.toBeNull();
    for (const node of root.querySelectorAll("[aria-describedby],[aria-labelledby],[aria-controls]")) {
      for (const attribute of ["aria-describedby","aria-labelledby","aria-controls"]) for (const id of node.getAttribute(attribute)?.split(/\s+/)??[]) expect(root.querySelector(`[id="${id}"]`)).not.toBeNull();
    }
    expect(root.querySelectorAll("button,input,textarea").length).toBeGreaterThan(0);
    for (const svg of root.querySelectorAll("svg")) { expect(svg.getAttribute("viewBox")).toBe("0 0 24 24"); expect(svg.querySelector("path,rect"), svg.outerHTML).not.toBeNull(); }
    expect(root.querySelector("use")).toBeNull();
  }
});
it("retains empty password value and clickable labels after sanitization", () => {
  const root=document.createElement("div"); const query=mountTemplate(root,settingsTemplate);
  const key=query<HTMLInputElement>("key"); expect(key.type).toBe("password"); expect(key.value).toBe("");
  expect(root.querySelector(`label[for="${key.id}"]`)).not.toBeNull(); expect(query("save-connection").getAttribute("type")).toBe("submit");
});
it("switches overview status icons without missing symbols or unsafe SVG references", () => {
  const root=document.createElement("div"); const query=mountTemplate(root,overviewTemplate);
  for (const id of ["status-symbol"]) {
    const target=query(id); const original=target.textContent;
    updateIcon(target,"check"); expect(target.querySelector("path")?.getAttribute("d")).toBe("m5 12 4 4L19 6");
    updateIcon(target,"alert"); expect(target.querySelector("path")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(target.textContent).toBe(original); expect(target.querySelector("use")).toBeNull();
  }
});
it("sanitizes active markup before attaching it and adopts nodes into the owning document", () => {
  const other=new JSDOM("");
  try {
    const root=other.window.document.createElement("div");
    const query=mountTemplate(root,'<p id="safe">safe text</p><script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad link</a>');
    expect(query("safe").textContent).toBe("safe text"); expect(query("safe").ownerDocument).toBe(other.window.document);
    expect(root.querySelector("script,[onerror],[href^='javascript:']")).toBeNull();
  } finally { other.window.close(); }
});
