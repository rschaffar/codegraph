import { describe, expect, it } from 'vitest';
import { sourceFoldRows, type SourceFold } from '../ui/src/lib/source-folds';
const fold: SourceFold = { id: 'method', start: 12, end: 15, label: 'Owner.read()' };
describe('source display folds', () => {
  it('leaves existing source readers and original line numbers unchanged by default', () => {
    expect(sourceFoldRows(10, 4)).toEqual([{ line: 10 }, { line: 11 }, { line: 12 }, { line: 13 }]);
  });
  it('replaces only the selected range with a labelled original-line placeholder', () => {
    expect(sourceFoldRows(10, 8, [fold])).toEqual([{ line: 10 }, { line: 11 }, { line: 12, fold }, { line: 16 }, { line: 17 }]);
    expect(fold).toEqual({ id: 'method', start: 12, end: 15, label: 'Owner.read()' });
  });
  it('keeps one truthful placeholder when a function spans source pages', () => {
    expect(sourceFoldRows(14, 4, [fold])).toEqual([{ line: 12, fold }, { line: 16 }, { line: 17 }]);
    expect(sourceFoldRows(13, 2, [fold])).toEqual([{ line: 12, fold }]);
    expect(sourceFoldRows(16, 2, [fold])).toEqual([{ line: 16 }, { line: 17 }]);
  });
  it('does not hide bytes on overlapping, nested, duplicate or invalid fold proposals', () => {
    const original = sourceFoldRows(10, 8);
    for (const other of [{ ...fold }, { ...fold, id: 'other', start: 15, end: 16 }, { ...fold, id: 'inner', start: 13, end: 14 }]) {
      expect(sourceFoldRows(10, 8, [fold, other])).toEqual(original);
    }
    for (const change of [{ start: 0 }, { start: 1.5 }, { end: 11 }, { end: NaN }, { id: '' }]) expect(sourceFoldRows(10, 8, [{ ...fold, ...change }])).toEqual(original);
  });
  it('orders independent folds and restores the exact rows simply by removing them', () => {
    const next = { ...fold, id: 'next', start: 17, end: 18 };
    expect(sourceFoldRows(10, 10, [next, fold])).toEqual([{ line: 10 }, { line: 11 }, { line: 12, fold }, { line: 16 }, { line: 17, fold: next }, { line: 19 }]);
    expect(sourceFoldRows(10, 10, [])).toHaveLength(10);
  });
});
