/** Display-only ranges; original source, tokens and file line numbers stay intact. */
export interface SourceFold { id: string; start: number; end: number; label: string }
export interface SourceFoldRow { line: number; fold?: SourceFold }

/** Overlapping/duplicate identities fail open: show bytes rather than hide the wrong range. */
export function sourceFoldRows(from: number, count: number, folds: readonly SourceFold[] = []): SourceFoldRow[] {
  if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(count) || count < 0) return [];
  const valid = folds.filter((fold) => fold.id && Number.isSafeInteger(fold.start) && fold.start > 0 && Number.isSafeInteger(fold.end) && fold.end >= fold.start);
  const sorted = valid.filter((fold, index) => !valid.some((other, j) => j !== index &&
    (fold.id === other.id || (fold.start <= other.end && fold.end >= other.start))))
    .sort((a, b) => a.start - b.start);
  const to = from + count - 1; const rows: SourceFoldRow[] = [];
  let line = from;
  for (const fold of sorted) {
    if (fold.end < from || fold.start > to) continue;
    while (line < fold.start && line <= to) rows.push({ line: line++ });
    // The placeholder represents the original full range even on a later page.
    rows.push({ line: fold.start, fold });
    line = Math.min(to + 1, fold.end + 1);
  }
  while (line <= to) rows.push({ line: line++ });
  return rows;
}
