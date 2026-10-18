import DOMPurify from 'dompurify';

/** Sanitize admin templates before inserting them into the document. */
export function setHTML(target: HTMLElement, markup: string): void {
 target.replaceChildren(DOMPurify.sanitize(markup, { RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true } }));
}
