// Shared viewer presentation catalogue. Tests compare it with the engine;
// importing the engine here would couple browser components to Node.
export const nodeKinds = [
  'file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
  'function', 'method', 'property', 'field', 'variable', 'constant', 'enum',
  'enum_member', 'type_alias', 'namespace', 'parameter', 'import', 'export',
  'route', 'component', 'union',
] as const;
export const edgeKinds = [
  'contains', 'calls', 'imports', 'exports', 'extends', 'implements', 'references',
  'type_of', 'returns', 'instantiates', 'overrides', 'decorates', 'navigates',
] as const;

export type CardFamily = 'container' | 'type' | 'callable' | 'value' | 'framework' | 'binding' | 'symbol';
const families: Record<string, CardFamily> = {
  file: 'container', module: 'container', namespace: 'container',
  class: 'type', struct: 'type', interface: 'type', trait: 'type', protocol: 'type',
  enum: 'type', union: 'type', type_alias: 'type', function: 'callable', method: 'callable',
  property: 'value', field: 'value', variable: 'value', constant: 'value',
  parameter: 'value', enum_member: 'value', route: 'framework', component: 'framework',
  import: 'binding', export: 'binding',
};
export function cardFamily(kind: string): CardFamily { return families[kind] ?? 'symbol'; }
export function kindLabel(kind: string): string { return kind.replaceAll('_', ' '); }
export const relationLabels: Record<string, string> = {
  contains: 'contains', calls: 'calls', imports: 'imports', exports: 'exports',
  extends: 'extends', implements: 'implements', references: 'references',
  type_of: 'has type', returns: 'returns type', instantiates: 'creates',
  overrides: 'overrides', decorates: 'decorates', navigates: 'navigates to',
};
export function relationLabel(kind: string): string { return relationLabels[kind] ?? kindLabel(kind); }
