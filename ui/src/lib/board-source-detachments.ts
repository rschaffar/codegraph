import type { BoardSymbol } from './board-model';
import { verifiedBoardSourceSymbol } from './board-source-model';
import type { SourceFold } from './source-folds';

export interface BoardSourceDetachment {
  /** The containing open type source card, not necessarily the immediate owner. */
  owner: BoardSymbol;
  /** Fresh indexed fact, retaining its actual ownerId even for outer-type cards. */
  member: BoardSymbol;
  /** Absent means show an ownership link without replacing any source bytes.
   * Present: inclusive original lines and an owner/member ID stable across drift. */
  fold?: SourceFold;
  /** Fresh declaration line; insert/decorate here for an anchor-only entry. */
  anchorLine: number;
}

const TYPES = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'union', 'type_alias']);
const callable = (item: BoardSymbol): boolean => item.kind === 'method' || item.kind === 'function';
const safeLine = (line: number | undefined): line is number => Number.isSafeInteger(line) && line! > 0;
const validRange = (item: BoardSymbol): boolean => safeLine(item.line) && safeLine(item.endLine) && item.endLine >= item.line;
const contains = (parent: BoardSymbol, child: BoardSymbol): boolean =>
  validRange(parent) && validRange(child) && parent.file === child.file && parent.line <= child.line && parent.endLine! >= child.endLine!;
const sourceOrder = (a: BoardSymbol, b: BoardSymbol): number =>
  a.file.localeCompare(b.file) || a.line - b.line || (a.startColumn ?? 0) - (b.startColumn ?? 0) || a.id.localeCompare(b.id);

/**
 * Derive presentation only, including for saved boards that already have both
 * cards. `symbols` must be current indexed facts, not saved/discovery snapshots.
 * Callers must additionally gate rendering on verified, non-drifted indexed bytes.
 * Removing a method from openCards restores all class bytes on the next call;
 * no detachment state, recipe migration, pinning or geometry changes are needed.
 *
 * With no end columns or source text, neither method boundary line is safe to
 * replace (it can share another declaration or a class brace). Fold only the
 * strict interior. Conflicting unrelated declarations or overlapping folds on
 * one owner fail closed to anchor-only entries. Such entries preserve every
 * byte: consumers may add an ownership link at anchorLine, NEVER replace it.
 */
export function boardSourceDetachments(
  symbols: readonly BoardSymbol[], openCards: readonly BoardSymbol[],
): BoardSourceDetachment[] {
  const facts = new Map<string, BoardSymbol[]>();
  for (const item of symbols) {
    const group = facts.get(item.id) ?? [];
    group.push(item); facts.set(item.id, group);
  }
  // Ambiguous indexed IDs cannot establish identity or an ownership hop.
  const byId = new Map<string, BoardSymbol>();
  for (const [id, group] of facts) if (group.length === 1 && !id.startsWith('missing:')) byId.set(id, group[0]!);
  const open = new Map<string, BoardSymbol>();
  for (const expected of openCards) {
    const fresh = verifiedBoardSourceSymbol(expected, facts.get(expected.id) ?? []);
    if (fresh) open.set(fresh.id, fresh);
  }

  /** A gap proves nothing beyond itself; any observed cycle invalidates the path. */
  function ancestry(item: BoardSymbol): BoardSymbol[] | null {
    const path: BoardSymbol[] = [];
    const seen = new Set<string>([item.id]);
    let parentId = item.ownerId;
    while (parentId) {
      if (seen.has(parentId)) return null;
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      path.push(parent); parentId = parent.ownerId;
    }
    return path;
  }

  const out: BoardSourceDetachment[] = [];
  for (const member of [...open.values()].filter(callable).sort(sourceOrder)) {
    const path = ancestry(member);
    // A function/method nested in a callable or value is not a class member.
    if (!path?.length || !TYPES.has(path[0]!.kind)) continue;
    const ancestorIds = new Set(path.map((item) => item.id));
    let child = member;
    for (const owner of path) {
      // Ranges only validate an explicit ownerId hop; they never discover one.
      if (!contains(owner, child)) break;
      child = owner;
      if (!TYPES.has(owner.kind) || !open.has(owner.id)) continue;
      const start = member.line + 1;
      const end = member.endLine! - 1;
      let safe = start <= end;
      if (safe) for (const other of symbols) {
        // A file node is metadata for these same bytes, not another declaration.
        if (other.kind === 'file' || other.file !== member.file || other.id === member.id || ancestorIds.has(other.id)) continue;
        if (!safeLine(other.line)) continue;
        const otherEnd = safeLine(other.endLine) && other.endLine >= other.line ? other.endLine : other.line;
        if (other.line > end || otherEnd < start) continue;
        // Proven local declarations are part of this method's bytes. An
        // unrelated/unknown-owner declaration must never disappear with it.
        if (ancestry(other)?.some((item) => item.id === member.id)) continue;
        safe = false; break;
      }
      out.push({ owner: open.get(owner.id)!, member, anchorLine: member.line,
        ...(safe ? { fold: { id: `source-detachment:${JSON.stringify([owner.id, member.id])}`, start, end, label: member.name } } : {}) });
    }
  }

  // Even genuinely nested open methods cannot have overlapping replacement
  // intervals in the same source card. Invalidate all conflicts symmetrically,
  // before changing any entries, so input order never picks a winning method.
  const conflicts = new Set<BoardSourceDetachment>();
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i]!; const b = out[j]!;
    if (a.owner.id === b.owner.id && a.fold && b.fold && a.fold.start <= b.fold.end && b.fold.start <= a.fold.end) {
      conflicts.add(a); conflicts.add(b);
    }
  }
  for (const item of conflicts) delete item.fold;
  return out.sort((a, b) => sourceOrder(a.owner, b.owner) || sourceOrder(a.member, b.member));
}
