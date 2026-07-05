import { describe, expect, it } from 'vitest';
import { diffLines, renderDiff } from '../src/report/textdiff.js';

describe('diffLines', () => {
  it('marks removed and added lines around unchanged context', () => {
    const before = 'a\nb\nc';
    const after = 'a\nB\nc';
    expect(diffLines(before, after)).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
    ]);
  });
});

describe('renderDiff', () => {
  it('elides long unchanged runs', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', 'old', '9'].join('\n');
    const after = ['1', '2', '3', '4', '5', '6', '7', 'new', '9'].join('\n');
    const rendered = renderDiff(before, after, 1);
    expect(rendered).toContain('- old');
    expect(rendered).toContain('+ new');
    expect(rendered).toContain('…');
    expect(rendered).not.toContain('  2');
  });
});
