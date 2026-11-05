import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { blankCsharpTrivia, csharpClosingBracket, csharpDeclarationHead, csharpDeclarationModifiers, csharpDeclarationNameEnd } from './csharp-declaration';
import { csharpMethodParameters } from './override-parameters';
import { csharpTypeParametersInScope } from './type-parameters';
import { LRUCache } from './lru-cache';
import { escapeRegExp } from '../utils';

const TYPE_KINDS = new Set(['class', 'interface', 'struct']);
const PATH = /^(?:@?[A-Za-z_]\w*)(?:\.@?[A-Za-z_]\w*){1,16}$/;
const TYPE = /^(?:global::)?@?[A-Za-z_]\w*(?:\s*\.\s*@?[A-Za-z_]\w*)*\s*\??$/;
interface FileView { text: string; starts: number[]; nodes: Node[]; types: Node[] }
interface WrittenType { text: string; site: Node }
// Heavy source views have independent budgets; body entries contain offsets,
// not slices that could retain a file after its source view has been evicted.
export const CSHARP_PROPERTY_FILE_CACHE_SIZE = 128;
export const CSHARP_PROPERTY_BODY_CACHE_SIZE = 512;
interface Memo { files: LRUCache<string, FileView | null>; bodies: LRUCache<string, { start: number; end: number } | null> }
const MEMOS = new WeakMap<ResolutionContext, Memo>();

/** The resolver's existing stable-source window, never a process-global binding cache. */
export function clearCsharpPropertyMemos(context: ResolutionContext): void { MEMOS.delete(context); }

/** Internal extraction kind is durable through SQLite, workers and ref resurrection. */
export function isCsharpPropertyRef(ref: UnresolvedRef): boolean {
  return ref.language === 'csharp' && ref.referenceKind === 'property_ref';
}

function memoFor(context: ResolutionContext): Memo {
  let memo = MEMOS.get(context);
  if (!memo) MEMOS.set(context, (memo = { files: new LRUCache(CSHARP_PROPERTY_FILE_CACHE_SIZE), bodies: new LRUCache(CSHARP_PROPERTY_BODY_CACHE_SIZE) }));
  return memo;
}
function fileView(file: string, context: ResolutionContext): FileView | null {
  const memo = memoFor(context);
  if (memo.files.has(file)) return memo.files.get(file)!;
  const source = context.readFile(file);
  if (source === null || source === undefined) { memo.files.set(file, null); return null; }
  const starts = [0];
  for (let at = source.indexOf('\n'); at >= 0; at = source.indexOf('\n', at + 1)) starts.push(at + 1);
  const nodes = context.getNodesInFile(file);
  const view = { text: blankCsharpTrivia(source), starts, nodes, types: nodes.filter(n => n.language === 'csharp' && TYPE_KINDS.has(n.kind)) };
  memo.files.set(file, view);
  return view;
}
function offset(view: FileView, line: number, column: number): number {
  return (view.starts[line - 1] ?? view.text.length) + column;
}
function contains(node: Node, line: number, column: number): boolean {
  return (line > node.startLine || line === node.startLine && column >= node.startColumn) &&
    (line < node.endLine || line === node.endLine && column < node.endColumn);
}
function enclosingTypes(site: Node, context: ResolutionContext, line = site.startLine, column = site.startColumn): Node[] {
  return (fileView(site.filePath, context)?.types ?? [])
    .filter(n => contains(n, line, column))
    .sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn || a.endLine - b.endLine || a.endColumn - b.endColumn);
}
const fullName = (node: Node) => node.qualifiedName.replace(/::/g, '.').replace(/@/g, '');

/** Exact declared identities in lexical/import scope, not global name uniqueness.
 * This deliberately does not bind generics, arrays, dynamic or external types. */
function resolveType(written: WrittenType, context: ResolutionContext, dependencies: Set<string>): Node | null {
  dependencies.add(written.site.filePath);
  if (!TYPE.test(written.text.trim())) return null;
  let text = written.text.replace(/\s+/g, '').replace(/@/g, '');
  const nullable = text.endsWith('?'), absolute = text.startsWith('global::');
  text = text.replace(/\?$/, '').replace(/^global::/, '');
  const head = text.split('.')[0]!;
  const parameters = csharpTypeParametersInScope(written.site, context);
  if (parameters === null || !absolute && parameters.has(head)) return null;
  if (['var', 'dynamic', 'object', 'string'].includes(text)) return null;
  const view = fileView(written.site.filePath, context);
  // Do not apply an outer alias across unmodeled namespace blocks. A later
  // block can introduce a nearer directive after the file's first type.
  if (!absolute && new Set(view?.nodes.filter(n => n.kind === 'namespace').map(n => n.qualifiedName)).size > 1) return null;
  const namedTypes = (name: string) => context.getNodesByName(name).filter(n => n.language === 'csharp' && TYPE_KINDS.has(n.kind));
  let candidates = namedTypes(text.split('.').pop()!);
  const select = (names: Set<string>): Node | null | undefined => {
    const found = candidates.filter(n => names.has(fullName(n)));
    if (found.length === 0) return undefined;
    if (found.length !== 1) return null;
    const node = found[0]!, declaration = csharpDeclarationHead(node, context);
    if (declaration === null) return null;
    const nameEnd = csharpDeclarationNameEnd(declaration, node);
    if ((nullable && node.kind === 'struct') || node.typeParameters?.length ||
        (nameEnd !== null && /^\s*</.test(declaration.slice(nameEnd)))) return null;
    dependencies.add(node.filePath);
    return node;
  };
  if (absolute) return select(new Set([text])) ?? null;
  const owners = enclosingTypes(written.site, context);
  // Type members precede namespace directives. Inherited nested identities
  // are not modeled: their presence blocks a namespace namesake instead.
  for (const owner of owners) {
    const own = select(new Set([fullName(owner) + '.' + text]));
    if (own !== undefined) return own;
  }
  if (namedTypes(head).some(n => enclosingTypes(n, context).some(parent => parent.id !== n.id))) return null;
  const aliases = new Map<string, string>(), usings = new Set<string>(), blockedAliases = new Set<string>();
  let unknownUsings = false;
  const firstType = view?.types.reduce((at, n) => Math.min(at, offset(view, n.startLine, n.startColumn)), view.text.length) ?? 0;
  const firstNamespace = view?.nodes.filter(n => n.kind === 'namespace').reduce((at, n) => Math.min(at, offset(view, n.startLine, n.startColumn)), Infinity) ?? Infinity;
  if (view) for (const match of view.text.slice(0, firstType).matchAll(/\busing\s+(?!static\b)(?:([A-Za-z_]\w*)\s*=\s*)?((?:global::)?[\w.]+)\s*;/g)) {
    const imported = match[2]!.replace(/^global::/, '');
    if (match.index! >= firstNamespace && !match[2]!.startsWith('global::')) {
      if (match[1]) blockedAliases.add(match[1]); else unknownUsings = true;
    } else if (match[1]) aliases.set(match[1], imported); else usings.add(imported);
  }
  if (blockedAliases.has(head)) return null;
  if (aliases.has(head)) {
    text = aliases.get(head)! + text.slice(head.length);
    candidates = namedTypes(text.split('.').pop()!);
    return select(new Set([text])) ?? null;
  }
  const lexical = owners.length ? fullName(owners[owners.length - 1]!).split('.').slice(0, -1) : [];
  for (let end = lexical.length; end > 0; end--) {
    const prefix = lexical.slice(0, end).join('.');
    const found = select(new Set([prefix + '.' + text]));
    if (found !== undefined) return found;
    if (text.includes('.')) {
      const qualifier = prefix + '.' + head;
      const prefixes = [...context.getNodesByName(head), ...context.getNodesByName(qualifier)];
      if (prefixes.some(n => n.language === 'csharp' && (n.kind === 'namespace' || TYPE_KINDS.has(n.kind)) && fullName(n) === qualifier)) return null;
    }
  }
  if (unknownUsings) return null;
  const names = new Set([text]);
  for (const imported of usings) names.add(imported + '.' + text);
  return select(names) ?? null;
}

function bases(owner: Node, context: ResolutionContext, dependencies: Set<string>): Node[] | null {
  const head = csharpDeclarationHead(owner, context);
  if (!head) return null;
  const end = csharpDeclarationNameEnd(head, owner);
  if (end === null || /^\s*</.test(head.slice(end))) return null;
  const declaration = head.slice(end).split('{')[0]!;
  const colon = declaration.indexOf(':');
  if (colon < 0) return [];
  const list = declaration.slice(colon + 1).split(/\bwhere\b/)[0]!;
  if (/[<>]/.test(list)) return null; // No erased generic base identity.
  const names = list.split(',');
  if (owner.kind === 'interface') {
    const found = names.map(text => resolveType({ text: text.trim(), site: owner }, context, dependencies));
    return found.every((n): n is Node => n !== null && n.kind === 'interface') ? found : null;
  }
  // Only a class's first base-list entry can be its superclass. Implemented
  // interfaces do not donate members to a class-typed receiver.
  if (owner.kind !== 'class') return [];
  const first = resolveType({ text: names[0]!.trim(), site: owner }, context, dependencies);
  return first === null ? null : first.kind === 'class' ? [first] : [];
}

/** Own declarations shadow bases even when they are unsupported or not properties. */
function memberOn(owner: Node, name: string, context: ResolutionContext, dependencies: Set<string>, seen = new Set<string>(), answers = new Map<string, Node | null | undefined>()): Node | null | undefined {
  if (answers.has(owner.id)) return answers.get(owner.id);
  if (seen.has(owner.id) || seen.size >= 32) return null;
  seen.add(owner.id);
  dependencies.add(owner.filePath);
  const own = context.getNodesByName(name).filter(n => n.language === 'csharp' && n.filePath === owner.filePath &&
    n.qualifiedName === owner.qualifiedName + '::' + name && contains(owner, n.startLine, n.startColumn)).filter(n => {
      if (n.kind !== 'property' && n.kind !== 'method') return true;
      const head = csharpDeclarationHead(n, context);
      const end = head === null ? null : csharpDeclarationNameEnd(head, n);
      // Explicit interface implementations are not class-accessible members
      // and do not hide ordinary inherited properties.
      if (n.kind === 'property' && head !== null) return !new RegExp(`\\.\\s*@?${escapeRegExp(n.name)}\\s*(?=\\{|=>)`).test(head);
      return end === null || !head!.slice(0, end - n.name.length).trimEnd().endsWith('.');
    });
  let answer: Node | null | undefined;
  if (own.length) answer = own.length === 1 ? own[0]! : null;
  else {
    const parents = bases(owner, context, dependencies);
    if (parents === null) answer = null;
    else {
      const inherited = parents.map(base => memberOn(base, name, context, dependencies, seen, answers));
      const found = new Map(inherited.filter((n): n is Node => n !== null && n !== undefined).map(n => [n.id, n]));
      answer = inherited.some(n => n === null) || found.size > 1 ? null : [...found.values()][0];
    }
  }
  answers.set(owner.id, answer);
  return answer;
}

function accessible(member: Node, receiver: Node, caller: Node, ref: UnresolvedRef, context: ResolutionContext, dependencies: Set<string>): boolean {
  if (member.visibility !== 'private' && member.visibility !== 'protected') return true;
  const name = member.qualifiedName.slice(0, member.qualifiedName.lastIndexOf('::'));
  const declarations = fileView(member.filePath, context)?.types.filter(n => n.qualifiedName === name && contains(n, member.startLine, member.startColumn)) ?? [];
  if (declarations.length !== 1) return false;
  const declaration = declarations[0]!;
  // Only a readable, unrestricted interface declaration may use the legacy
  // implicit-public default. Explicit protection must not take that shortcut.
  if (declaration.kind === 'interface') {
    const modifiers = csharpDeclarationModifiers(member, context);
    if (modifiers === null) return false;
    if (!['private', 'protected', 'internal'].some(modifier => modifiers.has(modifier))) return true;
  }
  const own = enclosingTypes(caller, context, ref.line, ref.column);
  if (own.some(n => n.id === declaration.id)) return true;
  if (member.visibility === 'private' || !own[0]) return false;
  if (receiver.id !== own[0].id && !ref.referenceName.startsWith('base.')) return false;
  const queue = [own[0]], seen = new Set<string>();
  while (queue.length && seen.size < 32) {
    const at = queue.shift()!;
    if (at.id === declaration.id) return true;
    if (seen.has(at.id)) continue;
    seen.add(at.id);
    queue.push(...(bases(at, context, dependencies) ?? []));
  }
  return false;
}

function memberType(node: Node, context: ResolutionContext): WrittenType | null {
  if (node.kind !== 'field' && node.kind !== 'property') return null;
  const name = escapeRegExp(node.name.replace(/^@/, ''));
  const match = new RegExp(`^([\\s\\S]+?)\\s+@?${name}\\s*$`).exec(blankCsharpTrivia(node.signature ?? ''));
  if (match) return { text: match[1]!.trim(), site: node };
  // A simple identifier property type is absent from legacy signatures; read
  // its bounded declaration rather than borrowing a namesake's type.
  if (node.kind !== 'property') return null;
  let head = csharpDeclarationHead(node, context)?.trimStart() ?? '';
  while (head.startsWith('[')) {
    const end = csharpClosingBracket(head, 0);
    if (end < 0) return null;
    head = head.slice(end + 1).trimStart();
  }
  const declaration = new RegExp(`^([\\s\\S]+?)\\s+@?${name}\\s*(?=\\{|=>|;)`).exec(head);
  const type = declaration?.[1]?.replace(/^(?:(?:public|private|protected|internal|static|virtual|override|sealed|abstract|new|required|readonly|unsafe|extern|partial)\s+)+/, '').trim();
  return type ? { text: type, site: node } : null;
}

/** A clipped body prevents a same-line sibling from donating a declaration. */
function bodyView(node: Node, context: ResolutionContext): { start: number; end: number } | null {
  const memo = memoFor(context);
  if (memo.bodies.has(node.id)) return memo.bodies.get(node.id)!;
  const file = fileView(node.filePath, context);
  if (!file) return null;
  const start = offset(file, node.startLine, node.startColumn);
  const text = file.text.slice(start, offset(file, node.endLine, node.endColumn));
  let after = 0;
  if (node.kind === 'method' || node.kind === 'function') {
    const nameEnd = csharpDeclarationNameEnd(text, node);
    if (nameEnd === null) { memo.bodies.set(node.id, null); return null; }
    let open = nameEnd;
    while (/\s/.test(text[open] ?? '') && open < text.length) open++;
    if (text[open] === '<') { open = csharpClosingBracket(text, open) + 1; while (/\s/.test(text[open] ?? '') && open < text.length) open++; }
    if (text[open] !== '(') { memo.bodies.set(node.id, null); return null; }
    after = csharpClosingBracket(text, open) + 1;
    if (after <= 0) return null;
  }
  const brace = text.indexOf('{', after), arrow = text.indexOf('=>', after);
  const begin = brace < 0 ? arrow : arrow < 0 ? brace : Math.min(brace, arrow);
  const body = begin < 0 ? null : { start: start + begin, end: offset(file, node.endLine, node.endColumn) };
  memo.bodies.set(node.id, body);
  return body;
}

/** Return undefined only if no local declaration shadows the member. Unknown
 * local/parameter types must block fallback to a same-named field. */
function localType(name: string, ref: UnresolvedRef, caller: Node, context: ResolutionContext): WrittenType | null | undefined {
  const file = fileView(ref.filePath, context), body = bodyView(caller, context);
  if (!file) return null;
  if (!body) return caller.kind === 'field' || caller.kind === 'constant' ? undefined : null;
  const end = offset(file, ref.line, ref.column);
  if (end < body.start || end > body.end) return null;
  const text = file.text.slice(body.start, end);
  const escaped = escapeRegExp(name);
  // These designation/header forms are deliberately not inferred. An
  // unsupported binder is unknown, never evidence that a field is visible.
  if (new RegExp(`\\b(?:for|foreach|using|catch)\\s*\\([^;{}]*\\b@?${escaped}\\b`).test(text) ||
      new RegExp(`\\b(?:is|case)\\b[^;]*\\b@?${escaped}\\s*(?=&&|\\|\\||\\band\\b|\\bor\\b|\\bwhen\\b|[?),}:;{])`).test(text) ||
      new RegExp(`\\bswitch\\b[^;]*\\b@?${escaped}\\s*(?==>|\\bwhen\\b)`).test(text) ||
      new RegExp(`\\bvar\\s*\\([^;{}]*\\b@?${escaped}\\b`).test(text) ||
      new RegExp(`,\\s*@?${escaped}\\s*(?=[=,;)])`).test(text)) return null;
  if (caller.kind === 'property' && name === 'value') {
    const tags = new Map([...text.matchAll(/\b(get|set|init)\s*(?:\{|=>|;)/g)].map(match => [match.index!, match[1]!]));
    let depth = 0, accessor: string | undefined;
    for (let at = 0; at < text.length; at++) {
      // Accessors belong directly to the property body. A local `get;` or
      // `set;` inside an accessor is an identifier, not a new declaration.
      if (depth === 1 && tags.has(at)) accessor = tags.get(at);
      if (text[at] === '{') depth++;
      else if (text[at] === '}') depth--;
    }
    if (depth > 0 && (accessor === 'set' || accessor === 'init')) return null;
  }
  const declaration = new RegExp(`(?<![\\w.@])((?:global::)?@?[A-Za-z_]\\w*(?:\\s*\\.\\s*@?[A-Za-z_]\\w*)*(?:\\s*<[^;{}=]*>)?(?:\\s*[?\\[\\],*])*)\\s+@?${escaped}\\s*(?=[=;,)])`, 'g');
  const declarations = new Map<number, string>();
  for (const match of text.matchAll(declaration)) declarations.set(match.index!, match[1]!.trim());
  const scopes: Array<string | null | undefined> = [undefined];
  for (let at = 0; at < text.length; at++) {
    if (text[at] === '{') scopes.push(undefined);
    else if (text[at] === '}' && scopes.length > 1) scopes.pop();
    const declared = declarations.get(at);
    if (declared !== undefined) scopes[scopes.length - 1] = declared;
  }
  // Header bindings (local functions, foreach/catch and implicit lambdas)
  // have scope rules this local-declaration reader does not infer. Never
  // borrow a field past a possible shadow, even when that loses a later use.
  if (new RegExp(`\\b@?${escaped}\\s*(?:\\)|,)\\s*=>|\\b@?${escaped}\\s*=>`).test(text) ||
      new RegExp(`\\b(?:@?[A-Za-z_]\\w*[?.\\w<>\\[\\],]*\\s+)@?${escaped}\\s*(?:[(),]|\\bin\\b)`).test(text)) return null;
  for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i] !== undefined) return scopes[i] ? { text: scopes[i]!, site: caller } : null;
  return undefined;
}

function receiverRoot(name: string, ref: UnresolvedRef, caller: Node, context: ResolutionContext, dependencies: Set<string>): Node | null {
  const owners = enclosingTypes(caller, context, ref.line, ref.column);
  const owner = owners[0];
  if (!owner) return null;
  if (name === 'this') return caller.isStatic ? null : owner;
  if (name === 'base') { const found = caller.isStatic ? null : bases(owner, context, dependencies); return found?.length === 1 ? found[0]! : null; }
  const local = localType(name, ref, caller, context);
  if (local !== undefined) return local ? resolveType(local, context, dependencies) : null;
  if (caller.kind === 'method' || caller.kind === 'function') {
    const parameters = csharpMethodParameters(caller, context);
    if (parameters === null) return null;
    const parameter = parameters.find(p => p.name === name);
    if (parameter) return resolveType({ text: parameter.type, site: caller }, context, dependencies);
  }
  const member = memberOn(owner, name, context, dependencies);
  if (!member || caller.isStatic && !member.isStatic || !accessible(member, owner, caller, ref, context, dependencies)) return null;
  const written = memberType(member, context);
  return written ? resolveType(written, context, dependencies) : null;
}

/** Only the property's declared owner supplies a target. Never retry an
 * unsupported access with generic method/import/name-matching strategies. */
export function matchCsharpPropertyRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!isCsharpPropertyRef(ref) || !PATH.test(ref.referenceName)) return null;
  const view = fileView(ref.filePath, context), token = ref.referenceName.split('.').pop()!;
  if (!view || view.text.slice(offset(view, ref.line, ref.column), offset(view, ref.line, ref.column) + token.length) !== token) return null;
  // Opaque interpolation/literal regions cannot prove the absence of a local
  // shadow. Retain the occurrence as unresolved, rather than borrowing a field.
  const caller = context.getNodeById?.(ref.fromNodeId) ?? context.getNodesInFile(ref.filePath).find(n => n.id === ref.fromNodeId);
  if (!caller || !contains(caller, ref.line, ref.column)) return null;
  const dependencies = new Set([ref.filePath]);
  // Escaped keywords are identifiers, not this/base dispatch. Until their
  // declaration identity is modeled, defer rather than erase that distinction.
  if (ref.referenceName.startsWith('@')) return null;
  const parts = ref.referenceName.split('.').map(p => p.replace(/^@/, ''));
  let owner = receiverRoot(parts[0]!, ref, caller, context, dependencies);
  if (!owner) return null;
  for (let i = 1; i < parts.length; i++) {
    const member = memberOn(owner, parts[i]!, context, dependencies);
    if (!member || member.isStatic || !accessible(member, owner, caller, ref, context, dependencies)) return null;
    if (i === parts.length - 1) {
      if (member.kind !== 'property') return null;
      // The legacy strategy bucket denotes declared receiver/member evidence;
      // the actual relationship and target remain references / property.
      return { original: ref, targetNodeId: member.id, confidence: 0.95, resolvedBy: 'instance-method', edgeKind: 'references', metadata: { typeFrom: [...dependencies].sort() } };
    }
    const written = memberType(member, context);
    owner = written ? resolveType(written, context, dependencies) : null;
    if (!owner) return null;
  }
  return null;
}
