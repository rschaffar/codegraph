import { isBoardEvidenceUncertain as boardEvidenceUncertain, type BoardEvidence, type BoardSymbol } from './board-model';
export { boardEvidenceUncertain };
import type { Token } from './highlight';
import { assignRefs, lastSegment, type LineRef } from './symbol-model';
import type { WireSource } from './wire';

export const BOARD_SOURCE_PAGE_LINES = 400;
export const BOARD_SOURCE_TARGET_PAGE = 8;
export const BOARD_SOURCE_EVIDENCE_PAGE = 40;

/** Line numbers are deliberately not identity: only the freshly verified range is used. */
export function verifiedBoardSourceSymbol(expected: BoardSymbol, items: readonly BoardSymbol[]): BoardSymbol | null {
  if (expected.id.startsWith('missing:')) return null;
  const matches = items.filter((item) => item.id === expected.id);
  const item = matches[0];
  return matches.length === 1 && item &&
    item.name === expected.name && item.qualifiedName === expected.qualifiedName &&
    item.kind === expected.kind && item.file === expected.file && item.signature === expected.signature &&
    Number.isSafeInteger(item.line) && item.line > 0 &&
    Number.isSafeInteger(item.endLine) && item.endLine! >= item.line ? item : null;
}

/** Even transient renders must not show one symbol's cached bytes under another identity. */
export function boardSourceForIdentity(expected: BoardSymbol, verified: BoardSymbol | null, source: WireSource | null): WireSource | null {
  return verified && verifiedBoardSourceSymbol(expected, [verified]) && source?.file === verified.file ? source : null;
}

const CONTAINERS = new Set(['file', 'module', 'namespace', 'class', 'struct', 'interface', 'trait',
  'protocol', 'enum', 'union', 'type_alias', 'component']);

/** A callable is always its own scope, even if it contains nested definitions. */
export function boardSourceWithMembers(symbol: BoardSymbol): boolean {
  if (symbol.kind === 'function' || symbol.kind === 'method') return false;
  return CONTAINERS.has(symbol.kind) || (symbol.memberCount ?? 0) > 0;
}

/** Every request is bounded; evidence focus chooses a page, not an enlarged request. */
export function boardSourceRange(symbol: BoardSymbol, opts: { current?: boolean; from?: number | null; highlight?: number | null } = {}): { from: number; to: number } {
  const first = opts.current ? 1 : symbol.line;
  const last = opts.current ? Number.MAX_SAFE_INTEGER : (symbol.endLine ?? symbol.line);
  const focus = opts.highlight;
  const initial = !opts.current && focus != null && Number.isSafeInteger(focus) && focus >= first && focus <= last
    ? first + Math.floor((focus - first) / BOARD_SOURCE_PAGE_LINES) * BOARD_SOURCE_PAGE_LINES : first;
  const requested = opts.from != null && Number.isSafeInteger(opts.from) ? opts.from : initial;
  const from = Math.max(first, Math.min(last, requested));
  return { from, to: Math.min(last, from + BOARD_SOURCE_PAGE_LINES - 1) };
}

export function boardSourceContinuation(symbol: BoardSymbol, source: WireSource | null, current = false): { previous: number | null; next: number | null } {
  if (!source?.lines || source.file !== symbol.file) return { previous: null, next: null };
  const first = current ? 1 : symbol.line;
  if (!source.lines.length) return { previous: (source.from ?? first) > first ? first : null, next: null };
  const last = current ? source.totalLines : Math.min(symbol.endLine ?? symbol.line, source.totalLines ?? Infinity);
  const from = source.from ?? first;
  const end = from + source.lines.length - 1;
  return {
    previous: from > first ? Math.max(first, from - BOARD_SOURCE_PAGE_LINES) : null,
    next: last != null && end < last ? end + 1 : null,
  };
}

/** Raw kind labels are intentional: imports/contains/returns are never called calls. */
export function boardSourceEvidenceTitle(edge: BoardEvidence, target: BoardSymbol): string {
  const site = edge.file ? `${edge.file}${edge.line ? `:${edge.line}` : ''}${edge.col != null ? ` (column ${edge.col}, zero-based)` : ''}` : 'no indexed source location';
  return `${edge.kind} ${target.qualifiedName} — ${target.file}:${target.line} · evidence ${site}` +
    (boardEvidenceUncertain(edge) ? ' · uncertain' : '') +
    (edge.confidence != null ? ` · confidence ${edge.confidence}` : '') +
    (edge.provenance ? ` · provenance ${edge.provenance}` : '') +
    (edge.synthesizedBy ? ` · synthesized by ${edge.synthesizedBy}` : '') +
    (edge.via ? ` · via ${edge.via}` : '') +
    (edge.registeredAt ? ` · wired at ${edge.registeredAt}` : '') +
    (edge.resolvedBy ? ` · resolved by ${edge.resolvedBy}` : '');
}

function inScope(id: string, symbol: BoardSymbol, byId: ReadonlyMap<string, BoardSymbol>): boolean {
  if (id === symbol.id) return true;
  if (!boardSourceWithMembers(symbol)) return false;
  const visited = new Set<string>();
  let cursor: string | undefined = id;
  while (cursor && !visited.has(cursor)) {
    if (cursor === symbol.id) return true;
    visited.add(cursor);
    cursor = byId.get(cursor)?.ownerId;
  }
  return false;
}

export interface BoardSourceRefsInput {
  expected: BoardSymbol;
  verified: BoardSymbol | null;
  source: WireSource | null;
  symbols: readonly BoardSymbol[];
  evidence: readonly BoardEvidence[];
  tokens: ReadonlyMap<number, readonly Token[]>;
}

/**
 * Original evidence only, on exactly matching indexed bytes. Reuse SourceBlock's
 * token matcher, but refuse ambiguous sites before giving it any refs: its
 * permissive fallback must not turn two same-named targets into a guessed link.
 * No identifier is cut out of a substring, and no missing column is invented.
 */
export function boardSourceRefs(input: BoardSourceRefsInput): Map<number, LineRef[]> {
  const { expected, verified, source, symbols, evidence, tokens } = input;
  const out = new Map<number, LineRef[]>();
  if (!verified || !boardSourceForIdentity(expected, verified, source) || !source?.lines?.length ||
    source.drift || source.showing !== 'indexed' || source.file !== verified.file) return out;
  const from = source.from ?? verified.line;
  const end = from + source.lines.length - 1;
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  byId.set(verified.id, verified);
  const proposals = new Map<number, Map<number, { ref: LineRef; targets: Set<string>; titles: Set<string> }>>();
  const seen = new Set<string>();
  for (const edge of evidence) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    if (edge.file !== source.file || !Number.isSafeInteger(edge.line) || edge.line! < from || edge.line! > end ||
      edge.line! < verified.line || edge.line! > verified.endLine! || !inScope(edge.source, verified, byId)) continue;
    const target = byId.get(edge.target);
    const origin = byId.get(edge.source);
    if (!target || !origin || origin.file !== source.file || target.id.startsWith('missing:')) continue;
    // A path/route is not an identifier: `file.ts` must never claim an unrelated
    // `ts` token just because lastSegment can find that suffix. Such evidence
    // remains fully readable/followable in the target list.
    if (target.kind === 'file' || !/^[A-Za-z_$À-￿][\w$À-￿]*(?:\.[A-Za-z_$À-￿][\w$À-￿]*)*$/.test(target.name)) continue;
    const ident = lastSegment(target.name);
    const lineTokens = tokens.get(edge.line!) ?? [];
    const candidates = lineTokens.map((token, i) => ({ token, i })).filter(({ token }) =>
      token.text === ident && token.cls !== 'comment' && token.cls !== 'string');
    const col = edge.col == null ? null : edge.col;
    if (col !== null && (!Number.isSafeInteger(col) || col < 0)) continue;
    if (col === null ? candidates.length !== 1 : !candidates.some(({ token }) => token.col + token.text.length > col)) continue;
    const title = boardSourceEvidenceTitle(edge, target);
    const ref: LineRef = { ident, col, targetId: target.id, uncertain: boardEvidenceUncertain(edge), outside: false, title };
    const index = assignRefs(lineTokens, [ref]).keys().next().value as number | undefined;
    if (index === undefined) continue;
    const line = proposals.get(edge.line!) ?? new Map();
    const previous = line.get(index);
    if (previous) {
      previous.targets.add(target.id);
      previous.titles.add(title);
      previous.ref.uncertain &&= ref.uncertain;
    } else line.set(index, { ref, targets: new Set([target.id]), titles: new Set([title]) });
    proposals.set(edge.line!, line);
  }
  for (const [line, proposed] of proposals) {
    const refs = [...proposed].sort(([a], [b]) => a - b).filter(([, item]) => item.targets.size === 1)
      .map(([, item]) => ({ ...item.ref, title: [...item.titles].join('\n') }));
    if (refs.length) out.set(line, refs);
  }
  return out;
}
