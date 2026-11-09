import type { BoardRelation, BoardSymbol } from './board-model';
import { verifiedBoardSourceSymbol } from './board-source-model';

const safeLine = (line: number | undefined): line is number => Number.isSafeInteger(line) && line! > 0;
const containsLine = (symbol: BoardSymbol, line: number) => safeLine(symbol.line) && safeLine(symbol.endLine) &&
  line >= symbol.line && line <= symbol.endLine;

function uniqueSymbols(symbols: readonly BoardSymbol[]): Map<string, BoardSymbol> {
  const groups = new Map<string, BoardSymbol[]>();
  for (const symbol of symbols) groups.set(symbol.id, [...(groups.get(symbol.id) ?? []), symbol]);
  return new Map([...groups].flatMap(([id, items]) => items.length === 1 && !id.startsWith('missing:') ? [[id, items[0]!] as const] : []));
}

/** Navigation reuses proven source ownership; it never creates a detachment. */
export function boardSourceDestination(target: BoardSymbol, symbols: readonly BoardSymbol[], open: readonly BoardSymbol[], line = target.line): BoardSymbol | null {
  const byId = uniqueSymbols(symbols);
  const fresh = byId.get(target.id);
  if (!fresh || !verifiedBoardSourceSymbol(target, [fresh]) || !containsLine(fresh, line)) return null;
  const cards = new Map(open.flatMap((expected) => {
    const symbol = byId.get(expected.id);
    return symbol && verifiedBoardSourceSymbol(expected, [symbol]) && symbol.file === fresh.file && containsLine(symbol, line)
      ? [[symbol.id, symbol] as const] : [];
  }));
  if (cards.has(fresh.id)) return cards.get(fresh.id)!;
  const path: BoardSymbol[] = []; const seen = new Set([fresh.id]);
  let child = fresh;
  while (child.ownerId) {
    if (seen.has(child.ownerId)) { path.length = 0; break; }
    seen.add(child.ownerId);
    const parent = byId.get(child.ownerId);
    if (!parent) break;
    if (parent.file !== fresh.file || !containsLine(parent, child.line) || !safeLine(child.endLine) || !containsLine(parent, child.endLine)) break;
    path.push(parent); child = parent;
  }
  for (const parent of path) if (cards.has(parent.id)) return cards.get(parent.id)!;
  // A file card represents these exact bytes even when extraction has no
  // contains edge from a top-level declaration to its file node.
  const files = [...cards.values()].filter((symbol) => symbol.kind === 'file');
  return files.length === 1 ? files[0]! : null;
}

export interface BoardConnectionDestination {
  symbol: BoardSymbol;
  /** A verified occurrence line for the source, or the target declaration. */
  line?: number;
  col?: number;
  file?: string;
}

/** Choose distinct destinations, not an arbitrary first edge of an aggregate. */
export function boardConnectionDestinations(relation: BoardRelation, direction: 'source' | 'target', symbols: readonly BoardSymbol[]): BoardConnectionDestination[] {
  const byId = uniqueSymbols(symbols);
  const destinations = new Map<string, BoardConnectionDestination>();
  const sourceLayer = relation.source.startsWith('code:') && relation.target.startsWith('code:');
  for (const edge of relation.evidence) {
    // A parameter/local value can originate a call outside its own declaration
    // range. Source arrows already prove the displayed source scope and site.
    const symbol = byId.get(sourceLayer && direction === 'source' ? relation.source.slice(5) : edge[direction]);
    if (!symbol) continue;
    const site = sourceLayer ? relation.sourceLine : edge.line;
    const occurrence = direction === 'source' && edge.file === symbol.file && safeLine(site) && site === edge.line && containsLine(symbol, site);
    const line = direction === 'target' ? symbol.line : occurrence ? site : undefined;
    const col = occurrence && Number.isSafeInteger(edge.col) && edge.col! >= 0 ? edge.col : undefined;
    const file = occurrence ? edge.file : symbol.file;
    const key = JSON.stringify([symbol.id, line ?? null, col ?? null]);
    destinations.set(key, { symbol, line, col, file });
  }
  return [...destinations.values()].sort((a, b) => a.symbol.file.localeCompare(b.symbol.file) ||
    (a.line ?? a.symbol.line) - (b.line ?? b.symbol.line) || (a.col ?? 0) - (b.col ?? 0) || a.symbol.id.localeCompare(b.symbol.id));
}
