export interface DiffRow {
  type: "same" | "change" | "remove" | "add";
  a?: string; b?: string; aLine?: number; bLine?: number;
}
export function compareLines(left: string, right: string): DiffRow[] {
  const a = left.split("\n");
  const b = right.split("\n");
  // Large line counts keep exact prefix/suffix context without a quadratic matrix.
  if (a.length * b.length > 1_000_000) {
    const rows: DiffRow[] = [];
    let start = 0;
    while (start < Math.min(a.length, b.length) && a[start] === b[start]) {
      rows.push({ type: "same", a: a[start], b: b[start], aLine: start + 1, bLine: start + 1 });
      start++;
    }
    let suffix = 0;
    while (suffix < Math.min(a.length, b.length) - start && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
    for (let index = start; index < Math.max(a.length - suffix, b.length - suffix); index++) {
      const hasA = index < a.length - suffix, hasB = index < b.length - suffix;
      rows.push({ type: "change", a: hasA ? a[index] : undefined, b: hasB ? b[index] : undefined,
        aLine: hasA ? index + 1 : undefined, bLine: hasB ? index + 1 : undefined });
    }
    for (let index = 0; index < suffix; index++) {
      rows.push({ type: "same", a: a[a.length - suffix + index], b: b[b.length - suffix + index],
        aLine: a.length - suffix + index + 1, bLine: b.length - suffix + index + 1 });
    }
    return rows;
  }
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      if (a[i] === b[j]) lengths[i]![j] = lengths[i + 1]![j + 1]! + 1;
      else lengths[i]![j] = Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const operations: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      operations.push({ type: "same", a: a[i], b: b[j], aLine: ++i, bLine: ++j });
    } else if (i < a.length && (j === b.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
      operations.push({ type: "remove", a: a[i], aLine: ++i });
    } else {
      operations.push({ type: "add", b: b[j], bLine: ++j });
    }
  }
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < operations.length) {
    if (operations[index]!.type === "same") {
      rows.push(operations[index++]!);
      continue;
    }
    const removed: DiffRow[] = [];
    const added: DiffRow[] = [];
    while (index < operations.length && operations[index]!.type !== "same") {
      const operation = operations[index++]!;
      if (operation.type === "remove") removed.push(operation);
      else added.push(operation);
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      let type: DiffRow["type"] = "change";
      if (!removed[k]) type = "add";
      else if (!added[k]) type = "remove";
      rows.push({ type, a: removed[k]?.a, b: added[k]?.b, aLine: removed[k]?.aLine, bLine: added[k]?.bLine });
    }
  }
  return rows;
}
