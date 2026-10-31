import type { Node } from '../types';
import type { ResolutionContext } from './types';
import { escapeRegExp } from '../utils';

/** A bounded, column-correct declaration view shared by the C# source readers. */
export function csharpDeclarationHead(node: Node, context: ResolutionContext, limit = 40): string | null {
  const lines = context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split(/\r?\n/) ?? null;
  if (!lines || node.startLine < 1 || node.startLine > lines.length) return null;
  const end = Math.min(lines.length, node.endLine, node.startLine - 1 + limit);
  const head = lines.slice(node.startLine - 1, end);
  if (end === node.endLine && head.length) head[head.length - 1] = head[head.length - 1]!.slice(0, node.endColumn);
  head[0] = head[0]!.slice(node.startColumn);
  return blankCsharpTrivia(head.join('\n'));
}

/** Blank whole literal/comment spans; interpolation expressions cannot expose fake declarations. */
export function blankCsharpTrivia(text: string): string {
  const out = text.split('');
  const commentEnd = (at: number): number | null => {
    if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at + 2);
      return end < 0 ? text.length : end;
    }
    if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2);
      return end < 0 ? text.length : end + 2;
    }
    return null;
  };
  // A hole's own literals/comments and object/initializer braces nest inside
  // its interpolation delimiter. Read them, but never expose their contents.
  const holeEnd = (start: number, closes: number, nesting: number): number => {
    let depth = 0;
    for (let at = start; at < text.length;) {
      const end = commentEnd(at) ?? literalEnd(at, nesting + 1);
      if (end !== null) { at = end; continue; }
      if (depth === 0 && text.startsWith('}'.repeat(closes), at)) return at + closes;
      if (text[at] === '{') depth++;
      else if (text[at] === '}') depth--;
      at++;
    }
    return text.length;
  };
  const literalEnd = (start: number, nesting = 0): number | null => {
    let quote = start;
    while (text[quote] === '$' || text[quote] === '@') quote++;
    if (text[quote] !== '"' && !(quote === start && text[quote] === "'")) return null;
    if (nesting > 32) return text.length; // Bound nested interpolation; unknown stays blank.
    const delimiter = text[quote]!;
    const prefix = text.slice(start, quote);
    const verbatim = prefix.includes('@');
    const dollars = (prefix.match(/\$/g) ?? []).length;
    let quotes = 1;
    while (delimiter === '"' && text[quote + quotes] === '"') quotes++;
    // @""" starts a verbatim literal containing a doubled quote, never raw.
    const raw = !verbatim && quotes >= 3;
    if (raw && quotes >= 6 && quotes % 2 === 0 && /^(?:[ \t]*[,);\]}+]|$)/.test(text.slice(quote + quotes))) return quote + quotes;
    for (let at = quote + (raw ? quotes : 1); at < text.length;) {
      if (raw) {
        if (text.startsWith('"'.repeat(quotes), at)) return at + quotes;
        if (dollars && text.startsWith('{'.repeat(dollars), at)) {
          // In a longer run, the prefix braces are literal; the final N
          // braces open the hole. None belongs to the expression's depth.
          let end = at + dollars;
          while (text[end] === '{') end++;
          at = holeEnd(end, dollars, nesting);
          continue;
        }
      } else {
        if (!verbatim && text[at] === '\\') { at += 2; continue; }
        if (text[at] === delimiter) {
          if (verbatim && text[at + 1] === '"') { at += 2; continue; }
          return at + 1;
        }
        if (dollars && text[at] === '{') {
          if (text[at + 1] === '{') { at += 2; continue; }
          at = holeEnd(at + 1, 1, nesting);
          continue;
        }
      }
      at++;
    }
    return text.length;
  };
  for (let at = 0; at < text.length;) {
    const end = commentEnd(at) ?? literalEnd(at);
    if (end === null) { at++; continue; }
    for (let i = at; i < end; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    at = end;
  }
  return out.join('');
}

/** Structural matching. Angles are structural only in a requested type-parameter list. */
export function csharpClosingBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const angles = text[open] === '<';
  const expected = angles ? '>' : pairs[text[open]!];
  if (!expected) return -1;
  const stack = [expected];
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (pairs[ch]) stack.push(pairs[ch]!);
    else if (angles && stack[stack.length - 1] === '>' && ch === '<') stack.push('>');
    else if ((angles && stack[stack.length - 1] === '>' && ch === '>') || ')]}'.includes(ch)) {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** End of the actual declaration name, past attributes and any return-type namesake. */
export function csharpDeclarationNameEnd(head: string, node: Node): number | null {
  let at = 0;
  while (at < head.length) {
    while (/\s/.test(head[at] ?? '') && at < head.length) at++;
    if (head[at] !== '[') break;
    const close = csharpClosingBracket(head, at);
    if (close < 0) return null;
    at = close + 1;
  }
  const name = escapeRegExp(node.name.replace(/^@/, ''));
  const method = node.kind === 'method' || node.kind === 'function';
  const pattern = method
    ? new RegExp(`(?<![\\w@])@?${name}(?!\\w)`, 'g')
    : new RegExp(`\\b(?:class|struct|interface|record|enum|delegate)\\s+(?:(?:class|struct)\\s+)?@?${name}(?!\\w)`, 'g');
  pattern.lastIndex = at;
  for (let match; (match = pattern.exec(head));) {
    const end = match.index + match[0].length;
    if (!method) return end;
    let next = end;
    while (/\s/.test(head[next] ?? '') && next < head.length) next++;
    if (head[next] === '<') {
      const close = csharpClosingBracket(head, next);
      if (close < 0) return null;
      next = close + 1;
      while (/\s/.test(head[next] ?? '') && next < head.length) next++;
    }
    if (head[next] === '(') return end;
    if (head[next] === '{' || head[next] === ';') return null;
  }
  return null;
}
