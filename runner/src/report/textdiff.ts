export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** Plain LCS line diff — prompts are small, O(n·m) is fine. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return out;
}

/** Compact rendering: changed lines with a little context, long same runs elided. */
export function renderDiff(before: string, after: string, context = 2): string {
  const lines = diffLines(before, after);
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind !== 'same') {
      for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep.add(k);
    }
  });
  const out: string[] = [];
  let skipping = false;
  lines.forEach((line, index) => {
    if (!keep.has(index)) {
      if (!skipping) out.push('  …');
      skipping = true;
      return;
    }
    skipping = false;
    out.push(`${line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  '}${line.text}`);
  });
  return out.join('\n');
}
