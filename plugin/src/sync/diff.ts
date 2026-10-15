/** A linear, conservative changed-range diff. Common prefix/suffix remain explicit context. */
export function textDiff(before: string, after: string): { prefix: string[]; removed: string[]; added: string[]; suffix: string[] } {
  const a = before.split("\n"); const b = after.split("\n"); let start = 0; let tail = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { prefix: a.slice(0, start), removed: a.slice(start, a.length - tail), added: b.slice(start, b.length - tail), suffix: tail ? a.slice(a.length - tail) : [] };
}
