import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { TreeSitterExtractor } from '../src/extraction/tree-sitter';
import { CSHARP_PROPERTY_BODY_CACHE_SIZE, CSHARP_PROPERTY_FILE_CACHE_SIZE, clearCsharpPropertyMemos, matchCsharpPropertyRef } from '../src/resolution/csharp-property-ref';
import * as csharpDeclarations from '../src/resolution/csharp-declaration';
import type { ResolutionContext } from '../src/resolution/types';
import { csharpTypeParametersInScope } from '../src/resolution/type-parameters';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { resetKernelForTests, tryKernelExtract } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

const kernelPath = process.env.CODEGRAPH_KERNEL_PATH ?? path.join(__dirname, '..', 'codegraph-kernel', 'prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node');
const envKeys = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_NO_PARALLEL_RESOLVE', 'CODEGRAPH_NO_REBIND'] as const;
const position = (source: string, at: number) => ({ line: source.slice(0, at).split('\n').length, column: at - source.lastIndexOf('\n', at - 1) - 1 });

const contracts = `namespace Demo;
public class Snapshot { public string Label { get; } }
public interface IState { Snapshot? Current { get; } }
public class State : IState { public Snapshot? Current => null; }
public class Holder { public IState State { get; } }
`;
const readers = `using StateAlias = Demo.IState;
namespace Demo;
public class Consumer {
    private readonly IState _state;
    private readonly Holder _holder;
    public Consumer(IState state, Holder holder) { _state = state; _holder = holder; }
    public Snapshot? FieldRead() => _state.Current;
    public object ArgumentRead() => Evaluate(_state.Current);
    private object Evaluate(Snapshot? value) => value;
    public Snapshot? ThisRead() => this._state.Current;
    public Snapshot? ParameterRead(IState state) => state.Current;
    public Snapshot? LocalRead() { IState state = new State(); return state.Current; }
    public Snapshot? QualifiedRead(Demo.IState state) => state.Current;
    public Snapshot? AliasRead(StateAlias state) => state.Current;
    public string? ConditionalRead() => _state.Current?.Label;
    public Snapshot? ChainRead() => _holder.State.Current;
    public Snapshot? RepeatedRead() { var first = _state.Current; return _state.Current; }
    public object ShadowedRead(dynamic _state) => _state.Current;
    public object UnknownRead(dynamic unknown) => unknown.Current;
    public void First() { Elsewhere.IState data = null; }
    public Snapshot? SiblingRead() { IState data = null; return data.Current; }
}
`;

for (const mode of ['wasm', 'native'] as const) {
  describe.skipIf(mode === 'native' && !fs.existsSync(kernelPath))(`C# property-reference evidence (${mode})`, () => {
    let saved: Record<string, string | undefined>;
    const roots: string[] = [];
    beforeAll(async () => { await initGrammars(); await loadGrammarsForLanguages(['csharp']); });
    beforeEach(() => {
      saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
      process.env.CODEGRAPH_KERNEL = mode === 'wasm' ? '0' : '1';
      process.env.CODEGRAPH_KERNEL_LANGS = 'csharp';
      process.env.CODEGRAPH_NO_PARALLEL_RESOLVE = '1';
      resetKernelForTests();
    });
    afterEach(() => {
      for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
      resetKernelForTests();
      for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });
    function extract(source: string): ExtractionResult {
      if (mode === 'wasm') return new TreeSitterExtractor('Reader.cs', source, 'csharp').extract();
      const result = tryKernelExtract('Reader.cs', source, 'csharp');
      expect(result, 'native property extraction must not defer to WASM').not.toBeNull();
      return result!;
    }
    async function index(files: Record<string, string>) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-property-'));
      roots.push(root);
      for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(root, name), source);
      return { root, cg: await CodeGraph.init(root, { index: true }) };
    }

    for (const expression of ['_state.Current', 'this._state.Current', '_state /* note */\n .Current', '_state.Current?.Label', '_holder.State.Current']) {
      it(`retains the property token and receiver in ${JSON.stringify(expression)}`, () => {
        const source = `class Reader { object Read() { /* 😀 */ return ${expression}; } }`;
        const result = extract(source);
        expect(result.errors).toEqual([]);
        const refs = result.unresolvedReferences.filter(ref => ref.referenceKind === 'property_ref' && ref.referenceName.endsWith('.Current'));
        expect(refs).toEqual([expect.objectContaining({
          referenceName: expression.startsWith('this.') ? 'this._state.Current' : expression.startsWith('_holder') ? '_holder.State.Current' : '_state.Current',
          ...position(source, source.indexOf('Current')),
        })]);
      });
    }

    it('keeps property reads in a call receiver without duplicating its invocation', () => {
      const source = 'class Reader { void Read() { _state.Current.Run(); } }';
      const refs = extract(source).unresolvedReferences;
      expect(refs.filter(ref => ref.referenceKind === 'property_ref').map(ref => ref.referenceName)).toEqual(['_state.Current']);
      expect(refs.filter(ref => ref.referenceKind === 'calls').map(ref => ref.referenceName)).toEqual(['_state.Current.Run']);
    });

    it('does not sanitize pointer, recovery, indexed or factory receiver shapes', () => {
      for (const expression of ['_state->Current', '_state.*Current', 'states[0].Current', 'Factory().Current']) {
        const source = `class Reader { object Read() => ${expression}; }`;
        // The malformed recovery fixture intentionally defers natively; valid
        // shapes above still require a real, nondeferring native extraction.
        const result = mode === 'native' && expression === '_state.*Current'
          ? (expect(tryKernelExtract('Reader.cs', source, 'csharp')).toBeNull(), new TreeSitterExtractor('Reader.cs', source, 'csharp').extract())
          : extract(source);
        expect(result.unresolvedReferences.filter(ref => ref.referenceKind === 'property_ref'), expression).toEqual([]);
      }
    });

    it('resolves readers to the declared interface property, not a concrete or namesake member', async () => {
      const { cg } = await index({
        'Contracts.cs': contracts,
        'Readers.cs': readers,
        'Decoys.cs': 'namespace Elsewhere; public class IState { public object Current { get; } } public class Decoy { public object Current() => null; }',
      });
      try {
        const current = cg.getNodesByName('Current').find(n => n.qualifiedName === 'Demo::IState::Current')!;
        expect(current).toBeDefined();
        const names = ['FieldRead', 'ArgumentRead', 'ThisRead', 'ParameterRead', 'LocalRead', 'QualifiedRead', 'AliasRead', 'ConditionalRead', 'ChainRead', 'RepeatedRead', 'SiblingRead'];
        for (const name of names) {
          const reader = cg.getNodesByName(name).find(n => n.kind === 'method')!;
          const edges = cg.getOutgoingEdges(reader.id).filter(e => cg.getNode(e.target)?.name === 'Current');
          expect(edges.map(e => ({ target: e.target, kind: e.kind })), name).toEqual(Array.from({ length: name === 'RepeatedRead' ? 2 : 1 }, () => ({ target: current.id, kind: 'references' })));
          expect(edges.every(e => e.metadata?.refKind === 'property_ref')).toBe(true);
          expect(cg.getCallers(current.id).map(entry => entry.node.id)).toContain(reader.id);
        }
        for (const name of ['ShadowedRead', 'UnknownRead']) {
          const reader = cg.getNodesByName(name).find(n => n.kind === 'method')!;
          expect(cg.getOutgoingEdges(reader.id).filter(e => cg.getNode(e.target)?.name === 'Current'), name).toEqual([]);
        }
        const implementation = cg.getNodesByName('Current').find(n => n.qualifiedName === 'Demo::State::Current')!;
        expect(cg.getCallers(implementation.id)).toEqual([]);
      } finally { cg.close(); }
    });

    const bindingCases: Array<{ name: string; source: string; target?: string; targets?: string[] }> = [
      { name: 'same-line sibling declarations', source: 'namespace Demo; public class Reader { public void First() { Elsewhere.IState value = null; } public object Read() { IState value = null; return value.Current; } }', target: 'Demo::IState::Current' },
      { name: 'block-local shadow ends before a later field read', source: 'namespace Demo; public class Reader { IState value; public object Read(bool choose) { if (choose) { Elsewhere.IState value = null; return value.Current; } return value.Current; } }', targets: ['Elsewhere::IState::Current', 'Demo::IState::Current'] },
      { name: 'unknown var shadows a typed field', source: 'namespace Demo; public class Reader { IState value; public object Read() { var value = Get(); return value.Current; } dynamic Get() => null; }' },
      { name: 'implicit lambda shadows a typed field', source: 'namespace Demo; public class Reader { IState value; public object Read() { System.Func<dynamic, object> fn = value => value.Current; return fn; } }' },
      { name: 'foreach header is not borrowed from a field', source: 'namespace Demo; public class Reader { IState value; public object Read(Elsewhere.IState[] values) { foreach (var value in values) { return value.Current; } return null; } }' },
      { name: 'using from another namespace is not visible', source: 'namespace Elsewhere { using Alias = Elsewhere.IState; public class Empty { } } namespace Client { public class Reader { public object Read(Alias value) => value.Current; } }' },
      { name: 'ambiguous imported types are not guessed', source: 'using Demo; using Elsewhere; namespace Client; public class Reader { public object Read(IState value) => value.Current; }' },
      { name: 'file alias resolves at its declaration scope, not the caller namespace', source: 'using Alias = Demo.IState; namespace Client; public class Reader { public object Read(Alias value) => value.Current; }', target: 'Demo::IState::Current' },
      { name: 'explicit global alias cannot bind a relative namespace decoy', source: 'using Alias = global::Demo.IState; namespace Client; public class Reader { public object Read(Alias value) => value.Current; }', target: 'Demo::IState::Current' },
      { name: 'unknown interface bases do not donate a namesake', source: 'namespace Demo; public interface IUnknown : IState, External.IState { } public class Reader { public object Read(IUnknown value) => value.Current; }' },
      { name: 'private properties are not accessible from another type', source: 'namespace Demo; public class Hidden { private object Current { get; } } public class Reader { public object Read(Hidden value) => value.Current; }' },
      { name: 'private properties remain accessible in their owner', source: 'namespace Demo; public class Reader { private object Current { get; } public object Read(Reader value) => value.Current; }', target: 'Demo::Reader::Current' },
      { name: 'protected base access is scoped to its subclass', source: 'namespace Demo; public class Parent { protected object Current { get; } } public class Reader : Parent { public object Read() => base.Current; }', target: 'Demo::Parent::Current' },
      { name: 'protected access through a base-typed parameter is not guessed', source: 'namespace Demo; public class Parent { protected object Current { get; } } public class Reader : Parent { public object Read(Parent value) => value.Current; }' },
      { name: 'explicit implementations do not hide ordinary base properties', source: 'namespace Demo; public interface IExplicit { object Current { get; } } public class Parent { public object Current { get; } } public class Reader : Parent, IExplicit { object IExplicit.Current => null; public object Read(Reader value) => value.Current; }', target: 'Demo::Parent::Current' },
      { name: 'later namespace aliases do not borrow an outer alias', source: 'using Alias = Demo.IOne; namespace Prelude { public class Empty { } } namespace Client { using Alias = Demo.ITwo; public class Reader { public object Read(Alias value) => value.Current; } }' },
      { name: 'setter implicit value cannot borrow a field', source: 'namespace Demo; public class Reader { IOne value; public ITwo Target { set { _ = value.Current; } } }' },
      { name: 'init implicit value cannot borrow a field', source: 'namespace Demo; public class Reader { IOne value; public ITwo Target { init { _ = value.Current; } } }' },
      { name: 'getter value field remains distinct from setter value', source: 'namespace Demo; public class Reader { IOne value; public ITwo Target { get { _ = value.Current; return null; } set { _ = value.Current; } } }', target: 'Demo::IOne::Current' },
      { name: 'setter local accessor identifier get cannot cancel implicit shadow', source: 'namespace Demo; public class Reader { IOne value; public ITwo Target { set { int get; _ = value.Current; } } }' },
      { name: 'setter escaped local accessor identifier cannot cancel implicit shadow', source: 'namespace Demo; public class Reader { IOne value; public ITwo Target { set { int @get; _ = value.Current; } } }' },
      { name: 'getter local accessor identifier set cannot cancel a field read', source: 'namespace Demo; public class Reader { IOne value; public ITwo Target { get { int set; _ = value.Current; return null; } set { _ = value.Current; } } }', target: 'Demo::IOne::Current' },
      { name: 'pattern-and designation blocks field fallback', source: 'namespace Demo; public class Reader { IOne value; public bool Read(object item) { if (item is ITwo value && value.Current != null) return true; return false; } }' },
      { name: 'recursive pattern designation blocks field fallback', source: 'namespace Demo; public class Reader { IOne value; public bool Read(object item) { if (item is { } value && value.Current != null) return true; return false; } }' },
      { name: 'ternary pattern designation blocks field fallback', source: 'namespace Demo; public class Reader { IOne value; public object Read(object item) => item is ITwo value ? value.Current : null; }' },
      { name: 'switch expression designation blocks field fallback', source: 'namespace Demo; public class Reader { IOne value; public object Read(object item) => item switch { ITwo value when value.Current != null => value.Current, _ => value.Current }; }' },
      { name: 'var deconstruction cannot borrow a field', source: 'namespace Demo; public class Reader { IOne value; public object Read() { var (value, other) = Get(); return value.Current; } (ITwo, int) Get() => (null, 0); }' },
      { name: 'second declarator cannot borrow a field', source: 'namespace Demo; public class Reader { IOne value; public object Read() { ITwo first=default,value=default; return value.Current; } }' },
      { name: 'for initializer type never leaks after its statement', source: 'namespace Demo; public class Reader { IOne value; public object Read() { for (ITwo value=null; value!=null;) { _ = value.Current; } return value.Current; } }' },
      { name: 'inherited nested identities cannot become namespace namesakes', source: 'namespace Demo; public interface INested { object Current { get; } } public class Parent { public class INested { public object Current { get; } } } public class Reader : Parent { public object Read(INested value) => value.Current; }' },
      { name: 'missing qualified suffix does not change an established prefix', source: 'namespace Client; public class Reader { public object Read(Demo.IMissing value) => value.Current; }' },
      { name: 'private inherited receiver field is not type evidence', source: 'namespace Demo; public class Parent { private IOne value; } public class Reader : Parent { public object Read() => value.Current; }' },
      { name: 'static intermediate property is not an instance receiver', source: 'namespace Demo; public class StaticHolder { public static IOne State { get; } } public class Reader { public object Read(StaticHolder value) => value.State.Current; }' },
      { name: 'escaped this is not a special receiver', source: 'namespace Demo; public class Reader { public object Current { get; } public object Read(IOne @this) => @this.Current; }' },
      { name: 'escaped base is not a special receiver', source: 'namespace Demo; public class Parent { public object Current { get; } } public class Reader : Parent { public object Read(IOne @base) => @base.Current; }' },
      { name: 'nested type identity precedes namespace alias', source: 'using IState = Demo.IOne; namespace Demo; public class Reader { public class IState { public object Current { get; } } public object Read(IState value) => value.Current; }', target: 'Demo::Reader::IState::Current' },
      { name: 'opaque ordinary interpolation cannot erase lambda shadowing', source: 'namespace Demo; public class Reader { IOne value; public string Read(ITwo other) => $"{Apply(value => value.Current, other)}"; static object Apply(System.Func<ITwo, object> fn, ITwo other) => fn(other); }' },
      { name: 'opaque verbatim interpolation cannot erase lambda shadowing', source: 'namespace Demo; public class Reader { IOne value; public string Read(ITwo other) => $@"{Apply(value => value.Current, other)}"; static object Apply(System.Func<ITwo, object> fn, ITwo other) => fn(other); }' },
      { name: 'opaque raw interpolation cannot erase lambda shadowing', source: 'namespace Demo; public class Reader { IOne value; public string Read(ITwo other) => $"""{Apply(value => value.Current, other)}"""; static object Apply(System.Func<ITwo, object> fn, ITwo other) => fn(other); }' },
      { name: 'attributed class type parameter is not a concrete namesake', source: 'namespace Demo; public class Reader<[Marker] IOne> where IOne : ITwo { public object Read(IOne value) => value.Current; }' },
      { name: 'attributed method type parameter is not a concrete namesake', source: 'namespace Demo; public class Reader { public object Read<[Marker] IOne>(IOne value) where IOne : ITwo => value.Current; }' },
      { name: 'explicit protected interface property is not public', source: 'namespace Demo; public interface IHidden { protected object Current => null; } public class Reader { public object Read(IHidden value) => value.Current; }' },
      { name: 'explicit private interface property is not public', source: 'namespace Demo; public interface IHidden { private object Current => null; } public class Reader { public object Read(IHidden value) => value.Current; }' },
      { name: 'generic receiver types are not erased', source: 'namespace Demo; public interface IGeneric<T> { object Current { get; } } public class IGeneric { public object Current { get; } } public class Reader { public object Read(IGeneric<string> value) => value.Current; }' },
    ];
    for (const fixture of bindingCases) it(fixture.name, async () => {
      const { cg } = await index({ 'Contracts.cs': contracts, 'Other.cs': 'namespace Elsewhere; public interface IState { object Current { get; } }', 'NestedDecoy.cs': 'namespace Client.Demo; public interface IState { object Current { get; } }', 'ReviewTypes.cs': 'namespace Demo; public interface IOne { object Current { get; } } public interface ITwo { object Current { get; } } public interface IMissing { object Current { get; } }', 'Reader.cs': fixture.source });
      try {
        const edges = cg.getOutgoingEdgesFrom(cg.getNodesInFile('Reader.cs').map(n => n.id)).filter(e => e.kind !== 'contains' && cg.getNode(e.target)?.name === 'Current').sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
        expect(edges.map(e => cg.getNode(e.target)!.qualifiedName)).toEqual(fixture.targets ?? (fixture.target ? [fixture.target] : []));
        expect(edges.every(e => e.kind === 'references')).toBe(true);
        if (!fixture.target && !fixture.targets?.length) {
          const candidates = new TreeSitterExtractor('Reader.cs', fixture.source, 'csharp').extract().unresolvedReferences;
          expect(candidates.some(ref => ref.referenceKind === 'property_ref' && ref.referenceName.endsWith('.Current')), 'negative binding retains its occurrence').toBe(true);
          const failed = cg['db'].getDb().prepare("SELECT count(*) AS total FROM unresolved_refs WHERE file_path='Reader.cs' AND reference_kind='property_ref' AND name_tail='Current' AND status='failed'").get() as { total: number };
          expect(failed.total, 'unknown evidence is failed, not dropped or name-guessed').toBeGreaterThan(0);
        }
      } finally { cg.close(); }
    });

    it('uses the concrete type when declared and resolves base/interface inheritance without guessing', async () => {
      const { cg } = await index({
        'Types.cs': 'namespace Demo; public interface IBase { object Current { get; } } public interface IChild : IBase { } public class Base { public object Current { get; } } public class Child : Base { public object BaseRead() => base.Current; } public class Other { public object Current { get; } }',
        'Reader.cs': 'namespace Demo; public class Reader { public object ConcreteRead(Base value) => value.Current; public object InheritedRead(IChild value) => value.Current; }',
      });
      try {
        for (const [name, target] of [['ConcreteRead', 'Demo::Base::Current'], ['BaseRead', 'Demo::Base::Current'], ['InheritedRead', 'Demo::IBase::Current']]) {
          const reader = cg.getNodesByName(name!).find(n => n.kind === 'method')!;
          const edges = cg.getOutgoingEdges(reader.id).filter(e => cg.getNode(e.target)?.name === 'Current');
          expect(edges.map(e => [e.kind, cg.getNode(e.target)?.qualifiedName]), name).toEqual([['references', target]]);
        }
      } finally { cg.close(); }
    });

    for (const count of [1, 2101]) it(`refreshes cross-file receiver types and failed reads without a ${count}-reader ceiling`, async () => {
      process.env.CODEGRAPH_NO_REBIND = '1';
      const holder = (type: string) => `namespace Demo; public class Holder { public ${type} State { get; } }`;
      const { root, cg } = await index({
        'Types.cs': 'namespace Demo; public interface IOne { object Current { get; } } public interface ITwo { object Current { get; } }',
        'Holder.cs': holder('IOne'),
        'Reader.cs': `namespace Demo; public class Reader { ${Array.from({ length: count }, (_, i) => `public object Read${i}(Holder holder) => holder.State.Current;`).join('\n')} }`,
      });
      const currentEdges = () => cg.getOutgoingEdgesFrom(cg.getNodesInFile('Reader.cs').map(n => n.id)).filter(e => cg.getNode(e.target)?.name === 'Current');
      try {
        for (const type of ['IOne', 'ITwo', 'dynamic', 'IOne']) {
          if (type !== 'IOne' || currentEdges().length !== count) {
            fs.writeFileSync(path.join(root, 'Holder.cs'), holder(type));
            await cg.sync({ paths: ['Holder.cs'] });
          }
          const expected = type === 'dynamic' ? [] : Array.from({ length: count }, () => `Demo::${type}::Current`);
          expect(currentEdges().map(e => cg.getNode(e.target)!.qualifiedName), type).toEqual(expected);
        }
      } finally { cg.close(); }
    }, 30_000);

    it('visits shared interface ancestors once rather than once per diamond path', async () => {
      const declarations = ['public interface I0 { object Current { get; } }'];
      for (let level = 1; level <= 12; level++) {
        const parents = level === 1 ? 'I0' : `I${level - 1}A, I${level - 1}B`;
        declarations.push(`public interface I${level}A : ${parents} { }`, `public interface I${level}B : ${parents} { }`);
      }
      const source = 'namespace Demo;\n' + declarations.join('\n') + '\npublic class Reader { public object Read(I12A state) => state.Current; }';
      const { cg } = await index({ 'Diamond.cs': source });
      const context = (cg as unknown as { resolver: { context: ResolutionContext } }).resolver.context;
      const original = context.getNodesByName;
      let lookups = 0;
      context.getNodesByName = name => { if (name === 'Current') lookups++; return original(name); };
      try {
        const caller = cg.getNodesByName('Read')[0]!;
        const result = matchCsharpPropertyRef({ fromNodeId: caller.id, referenceName: 'state.Current', referenceKind: 'property_ref', filePath: 'Diamond.cs', language: 'csharp', ...position(source, source.lastIndexOf('Current')) }, context);
        expect(cg.getNode(result!.targetNodeId)!.qualifiedName).toBe('Demo::I0::Current');
        expect(lookups).toBeLessThanOrEqual(25);
      } finally { context.getNodesByName = original; cg.close(); }
    });

    it('does not turn a 40-line clipped generic head into an empty scope', async () => {
      const source = 'namespace Demo; public class Reader' + '\n'.repeat(41) + '<[Marker] IOne> where IOne : ITwo { public object Read(IOne value) => value.Current; }';
      const { cg } = await index({ 'Types.cs': 'namespace Demo; public interface IOne { object Current { get; } } public interface ITwo { object Current { get; } }', 'Reader.cs': source });
      try {
        const context = (cg as unknown as { resolver: { context: ResolutionContext } }).resolver.context;
        expect(csharpTypeParametersInScope(cg.getNodesByName('Read')[0]!, context)).toBeNull();
      } finally { cg.close(); }
    });

    it('requires a declaration after bounded interface attributes before inferring modifiers', async () => {
      const source = 'namespace Demo; public interface IHidden {\n' + '[Marker]\n'.repeat(40) + 'protected object Current => null; }';
      const { cg } = await index({ 'Reader.cs': source });
      try {
        const context = (cg as unknown as { resolver: { context: ResolutionContext } }).resolver.context;
        expect(csharpDeclarations.csharpDeclarationModifiers(cg.getNodesByName('Current')[0]!, context)).toBeNull();
      } finally { cg.close(); }
    });

    it('evicts heavy file views and retains negative caching without changing bindings', async () => {
      const files: Record<string, string> = { 'Contracts.cs': contracts };
      for (let i = 0; i <= CSHARP_PROPERTY_FILE_CACHE_SIZE; i++) files[`Reader${i}.cs`] = `namespace Demo; public class Reader${i} { public object Read(IState state) => state.Current; }`;
      const { cg } = await index(files);
      const context = (cg as unknown as { resolver: { context: ResolutionContext } }).resolver.context;
      const read = vi.spyOn(context, 'readFile');
      clearCsharpPropertyMemos(context);
      const resolve = (i: number) => {
        const file = `Reader${i}.cs`, caller = cg.getNodesInFile(file).find(n => n.kind === 'method')!;
        const result = matchCsharpPropertyRef({ fromNodeId: caller.id, referenceName: 'state.Current', referenceKind: 'property_ref', filePath: file, language: 'csharp', ...position(files[file]!, files[file]!.lastIndexOf('Current')) }, context);
        expect(cg.getNode(result!.targetNodeId)!.qualifiedName).toBe('Demo::IState::Current');
      };
      try {
        resolve(0);
        for (let i = 1; i <= CSHARP_PROPERTY_FILE_CACHE_SIZE; i++) resolve(i);
        resolve(0);
        expect(read.mock.calls.filter(([file]) => file === 'Reader0.cs')).toHaveLength(2);
        const missing = { fromNodeId: 'missing', referenceName: 'state.Current', referenceKind: 'property_ref' as const, filePath: 'Missing.cs', language: 'csharp' as const, line: 1, column: 0 };
        expect(matchCsharpPropertyRef(missing, context)).toBeNull();
        expect(matchCsharpPropertyRef(missing, context)).toBeNull();
        expect(read.mock.calls.filter(([file]) => file === 'Missing.cs')).toHaveLength(1);
        clearCsharpPropertyMemos(context);
        expect(matchCsharpPropertyRef(missing, context)).toBeNull();
        expect(read.mock.calls.filter(([file]) => file === 'Missing.cs')).toHaveLength(2);
      } finally { read.mockRestore(); cg.close(); }
    });

    it('evicts numeric body ranges and refreshes edited declarations on the same instance', async () => {
      const methods = Array.from({ length: CSHARP_PROPERTY_BODY_CACHE_SIZE + 1 }, (_, i) => `public object Read${i}(IState state) => state.Current;`);
      const source = 'namespace Demo; public class Reader {\n' + methods.join('\n') + '\n}';
      const { cg, root } = await index({ 'Contracts.cs': contracts, 'Reader.cs': source });
      const context = (cg as unknown as { resolver: { context: ResolutionContext } }).resolver.context;
      const names = vi.spyOn(csharpDeclarations, 'csharpDeclarationNameEnd');
      clearCsharpPropertyMemos(context);
      const resolve = (i: number) => {
        const caller = cg.getNodesByName(`Read${i}`).find(n => n.kind === 'method')!;
        const at = source.indexOf('state.Current', source.indexOf(`Read${i}(`)) + 'state.'.length;
        const result = matchCsharpPropertyRef({ fromNodeId: caller.id, referenceName: 'state.Current', referenceKind: 'property_ref', filePath: 'Reader.cs', language: 'csharp', ...position(source, at) }, context);
        expect(cg.getNode(result!.targetNodeId)!.qualifiedName).toBe('Demo::IState::Current');
        return caller.id;
      };
      try {
        const first = resolve(0), initial = names.mock.calls.filter(([, node]) => node.id === first).length;
        for (let i = 1; i <= CSHARP_PROPERTY_BODY_CACHE_SIZE; i++) resolve(i);
        resolve(0);
        expect(names.mock.calls.filter(([, node]) => node.id === first)).toHaveLength(initial + 1);
        fs.writeFileSync(path.join(root, 'Reader.cs'), source.replace('Read0(IState state)', 'Read0(State state)'));
        await cg.sync({ paths: ['Reader.cs'] });
        const caller = cg.getNodesByName('Read0')[0]!;
        const edges = cg.getOutgoingEdges(caller.id).filter(e => e.metadata?.refKind === 'property_ref');
        expect(edges.map(e => cg.getNode(e.target)!.qualifiedName)).toEqual(['Demo::State::Current']);
      } finally { names.mockRestore(); cg.close(); }
    }, 30_000);

    it('retries positive and failed type lookup when a nearer declaration appears or disappears', async () => {
      const { cg, root } = await index({ 'Types.cs': 'namespace Demo; public interface IState { object Current { get; } }', 'Reader.cs': 'using Demo; namespace Client; public class Reader { public object Read(IState state) => state.Current; }' });
      try {
        process.env.CODEGRAPH_NO_REBIND = '1';
        const targets = () => cg.getOutgoingEdgesFrom(cg.getNodesInFile('Reader.cs').map(n => n.id)).filter(e => e.metadata?.refKind === 'property_ref').map(e => cg.getNode(e.target)!.qualifiedName);
        expect(targets()).toEqual(['Demo::IState::Current']);
        for (const [source, expected] of [['namespace Client; public interface IState { object Current { get; } }', ['Client::IState::Current']], ['namespace Client; public interface IState { }', []]] as const) {
          fs.writeFileSync(path.join(root, 'Shadow.cs'), source);
          await cg.sync({ paths: ['Shadow.cs'] });
          expect(targets()).toEqual(expected);
        }
        fs.unlinkSync(path.join(root, 'Shadow.cs'));
        await cg.sync({ paths: ['Shadow.cs'] });
        expect(targets()).toEqual(['Demo::IState::Current']);
      } finally { cg.close(); }
    });

    it('resurrects the original property reference after target deletion and restoration', async () => {
      const files = { 'State.cs': 'namespace Demo; public interface IState { object Current { get; } }', 'Reader.cs': 'namespace Demo; public class Reader { public object Read(IState state) => state.Current; }' };
      const { root, cg } = await index(files);
      const targets = () => cg.getOutgoingEdges(cg.getNodesByName('Read').find(n => n.kind === 'method')!.id).filter(e => cg.getNode(e.target)?.name === 'Current');
      try {
        expect(targets()).toHaveLength(1);
        fs.writeFileSync(path.join(root, 'State.cs'), 'namespace Demo; public interface IState { }');
        await cg.sync({ paths: ['State.cs'] });
        expect(targets()).toEqual([]);
        expect(cg.getUnresolvedReferencesInFile('Reader.cs', 100)).toEqual(expect.arrayContaining([expect.objectContaining({ referenceName: 'state.Current', referenceKind: 'property_ref' })]));
        fs.writeFileSync(path.join(root, 'State.cs'), files['State.cs']);
        await cg.sync({ paths: ['State.cs'] });
        expect(targets()).toHaveLength(1);
      } finally { cg.close(); }
    });
  });
}
