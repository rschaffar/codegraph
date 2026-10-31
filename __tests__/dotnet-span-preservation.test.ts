import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { resetKernelForTests, tryKernelExtract } from '../src/extraction/kernel';
import { TreeSitterExtractor } from '../src/extraction/tree-sitter';

interface Fixture {
  name: string;
  files: Record<string, string>;
  target: string | null;
  candidates?: number;
}

const consumer = (type: string, receiver = 'value') => `namespace Example;
public class Consumer { public int Read(${type} ${receiver}) => ${receiver}.AsSpan(); }`;
const extension = (type: string) => `namespace Example;
public static class Extensions { public static int AsSpan(this ${type} value) => 42; }`;
const fixtures: Fixture[] = [
  ...[
    { actual: 'left.Payload', namespace: 'left', other: 'right' },
    { actual: 'Left . Payload', namespace: 'Left', other: 'Right' },
  ].flatMap((f) => [false, true].map((matches): Fixture => ({
    name: `${f.actual} explicit local retains complete qualification (${matches ? 'matches' : 'contradicts'})`,
    files: {
      'Left.cs': `namespace ${f.namespace}; public class Payload { }`,
      'Right.cs': `namespace ${f.other}; public class Payload { }`,
      'Extensions.cs': extension(`${matches ? f.namespace : f.other}.Payload`),
      'Consumer.cs': `namespace Example; public class Consumer { public int Read() { ${f.actual} dataValue = default; return dataValue.AsSpan(); } }`,
    }, target: matches ? 'Extensions.cs' : null, candidates: 1,
  }))),
  ...[
    { name: 'generic', types: 'public class Payload<T> { }', initializer: 'new Payload<string>()', actual: 'Payload<string>', wrong: 'Payload<int>' },
    { name: 'nullable', types: 'public struct Payload { }', initializer: 'new Payload?()', actual: 'Payload?', wrong: 'Payload' },
    { name: 'array rank', types: 'public class Payload { }', initializer: 'new Payload[,] { { new Payload() } }', actual: 'Payload[,]', wrong: 'Payload[]' },
  ].flatMap((f) => [false, true].map((matches): Fixture => ({
    name: `split-line var retains ${f.name} spelling (${matches ? 'matches' : 'contradicts'})`,
    files: {
      'Types.cs': `namespace Example; ${f.types}`,
      'Extensions.cs': extension(matches ? f.actual : f.wrong),
      'Consumer.cs': `namespace Example; public class Consumer { public int Read() { var\n dataValue = ${f.initializer}; return dataValue.AsSpan(); } }`,
    }, target: matches ? 'Extensions.cs' : null, candidates: 1,
  }))),
  ...[
    { name: 'explicit generic', types: 'public class Payload<T> { }', local: 'Payload<int> dataValue = default;', assigned: 'new Payload<int>()', actual: 'Payload<int>', wrong: 'Payload<string>' },
    { name: 'static base rather than constructed subtype', types: 'public class Payload { } public class Payload<T> : Payload { }', local: 'Payload dataValue = default;', assigned: 'new Payload<int>()', actual: 'Payload', wrong: 'Payload<int>' },
    { name: 'previous var', types: 'public class Payload<T> { }', local: 'var dataValue = new Payload<int>();', assigned: 'new Payload<int>()', actual: 'Payload<int>', wrong: 'Payload<string>' },
  ].flatMap((f) => [false, true].map((matches): Fixture => ({
    name: `reassignment retains ${f.name} declaration (${matches ? 'matches' : 'contradicts'})`,
    files: {
      'Types.cs': `namespace Example; ${f.types}`,
      'Extensions.cs': extension(matches ? f.actual : f.wrong),
      'Consumer.cs': `namespace Example; public class Consumer { public int Read() {\n${f.local}\ndataValue = ${f.assigned};\nreturn dataValue.AsSpan(); } }`,
    }, target: matches ? 'Extensions.cs' : null, candidates: 1,
  }))),
  ...([false, true] as const).map((matches): Fixture => ({
    name: `split-line var preserves generic member ownership (${matches ? 'matches' : 'contradicts'})`,
    files: {
      'Types.cs': 'namespace Example; public class Payload { } public class Other { } public class Holder { public Payload Data { get; } } public class Holder<T> { public Other Data { get; } }',
      'Extensions.cs': extension(matches ? 'Other' : 'Payload'),
      'Consumer.cs': 'namespace Example; public class Consumer { public int Read() { var\n holder = new Holder<int>(); return holder.Data.AsSpan(); } }',
    }, target: matches ? 'Extensions.cs' : null, candidates: 1,
  })),
  ...([false, true] as const).map((matches): Fixture => ({
    name: `qualified explicit local preserves member ownership (${matches ? 'matches' : 'contradicts'})`,
    files: {
      'Types.cs': 'namespace Example { public class Payload { } public class Other { } } namespace left { public class Holder { public Example.Payload Data { get; } } } namespace right { public class Holder { public Example.Other Data { get; } } }',
      'Extensions.cs': extension(matches ? 'Example.Payload' : 'Example.Other'),
      'Consumer.cs': 'namespace Example; public class Consumer { public int Read() { left.Holder holder = default; return holder.Data.AsSpan(); } }',
    }, target: matches ? 'Extensions.cs' : null, candidates: 1,
  })),
  {
    name: 'base-class receiver conversion',
    files: {
      'Types.cs': 'namespace Example; public class Parent { } public class Child : Parent { }',
      'Extensions.cs': extension('Parent'),
      'Consumer.cs': consumer('Child'),
    }, target: 'Extensions.cs',
  },
  {
    name: 'implemented-interface receiver conversion',
    files: {
      'Types.cs': 'namespace Example; public interface IPayload { } public class Payload : IPayload { }',
      'Extensions.cs': extension('IPayload'),
      'Consumer.cs': consumer('Payload'),
    }, target: 'Extensions.cs',
  },
  ...(['class', 'struct'] as const).map((kind): Fixture => ({
    name: `nullable ${kind} receiver`,
    files: {
      'Types.cs': `namespace Example; public ${kind} Payload { }`,
      'Extensions.cs': '#nullable enable\n' + extension('Payload?'),
      'Consumer.cs': '#nullable enable\n' + consumer(kind === 'struct' ? 'Payload?' : 'Payload'),
    }, target: 'Extensions.cs',
  })),
  ...([false, true] as const).map((instance): Fixture => ({
    name: `typed parameter/property chain to ${instance ? 'instance' : 'extension'} method`,
    files: {
      'Types.cs': `namespace Example;
public class Payload { ${instance ? 'public int AsSpan() => 42;' : ''} }
public class Holder { public Payload Data { get; } = new Payload(); }`,
      ...(!instance ? { 'Extensions.cs': extension('Payload') } : {}),
      'Consumer.cs': 'namespace Example; public class Consumer { public int Read(Holder holder) => holder.Data.AsSpan(); }',
    }, target: instance ? 'Types.cs' : 'Extensions.cs',
  })),
  {
    name: 'escaped keyword receiver type',
    files: {
      'Types.cs': 'namespace Example; public class @event { }',
      'Extensions.cs': extension('@event'),
      'Consumer.cs': consumer('@event'),
    }, target: 'Extensions.cs',
  },
  {
    name: 'qualified concrete receiver declaration',
    files: {
      'Types.cs': 'namespace ReceiverTypes; public class Payload { }',
      'Extensions.cs': extension('ReceiverTypes.Payload'),
      'Consumer.cs': 'using ReceiverTypes;\n' + consumer('Payload'),
    }, target: 'Extensions.cs',
  },
  {
    name: 'constructed generic receiver declaration',
    files: {
      'Types.cs': 'namespace Example; public class Payload<T> { }',
      'Extensions.cs': extension('Payload<int>'),
      'Consumer.cs': consumer('Payload<int>'),
    }, target: 'Extensions.cs',
  },
  {
    name: 'does not promote an out-of-scope exact-name candidate over a valid base extension',
    files: {
      'Types.cs': 'namespace Example; public class Parent { } public class Child : Parent { }',
      'Correct.cs': 'namespace Example; public static class ChildPayloadExtensions { public static int AsSpan(this Parent value) => 42; }',
      'Decoy.cs': 'using Example; namespace Invisible; public static class ChildHelper { public static int AsSpan(this Child value) => 99; }',
      'Consumer.cs': consumer('Child', 'childPayload'),
    }, target: 'Correct.cs',
  },
  {
    name: 'does not promote a nongeneric namesake over the constructed generic receiver',
    files: {
      'Types.cs': 'namespace Example; public class Payload { } public class Payload<T> { }',
      'Correct.cs': 'namespace Example; public static class PayloadValueExtensions { public static int AsSpan(this Payload<int> value) => 42; }',
      'Decoy.cs': 'namespace Example; public static class PayloadHelper { public static int AsSpan(this Payload value) => 99; }',
      'Consumer.cs': consumer('Payload<int>', 'payloadValue'),
    }, target: 'Correct.cs',
  },
  {
    name: 'a veto of the original winner never promotes a runner-up',
    files: {
      'Types.cs': 'namespace Example; public class Buffer { } public class Other { }',
      'Wrong.cs': 'namespace Example; public static class BufferValueExtensions { public static int AsSpan(this Other value) => 1; }',
      'OtherwiseApplicable.cs': 'namespace Example; public static class BufferHelper { public static int AsSpan(this Buffer value) => 2; }',
      'Consumer.cs': consumer('Buffer', 'bufferValue'),
    }, target: null,
  },
  {
    name: 'nested interpolation text cannot authorize an unrelated receiver',
    files: {
      'Types.cs': 'namespace Example; public class Buffer { } public class Other { } public class TagAttribute : System.Attribute { public TagAttribute(string text) { } }',
      'Extensions.cs': 'namespace Example; public static class Extensions { [Tag($"{")] AsSpan(this Other fake)"}")] public static int AsSpan(this Buffer value) => 42; }',
      'Consumer.cs': consumer('Other'),
    }, target: null, candidates: 1,
  },
  ...[
    { name: 'constructed member vs nongeneric namesake', types: 'public class Payload { } public class Payload<T> { } public class Holder { public Payload<int> Data { get; } = new Payload<int>(); }', actual: 'Holder holder', receiver: 'holder.Data', wrong: 'Payload', right: 'Payload<int>', rank: 'DataOperations' },
    { name: 'nullable struct member cannot be unwrapped', types: 'public struct Payload { } public class Holder { public Payload? Data { get; } }', actual: 'Holder holder', receiver: 'holder.Data', wrong: 'Payload', right: 'Payload?', rank: 'DataOperations' },
    { name: 'local generic arguments are not erased', types: 'public class Payload<T> { }', actual: '', receiver: 'dataValue', local: 'Payload<string> dataValue = new Payload<string>();', wrong: 'Payload<int>', right: 'Payload<string>', rank: 'DataValueOperations' },
    { name: 'array ranks are not erased', types: 'public class Payload { }', actual: 'Payload[,] matrixValue', receiver: 'matrixValue', wrong: 'Payload[]', right: 'Payload[,]', rank: 'MatrixValueOperations' },
    { name: 'constructed supertype arguments are not erased', types: 'public class Parent<T> { } public class Child : Parent<string> { }', actual: 'Child childValue', receiver: 'childValue', wrong: 'Parent<int>', right: 'Parent<string>', rank: 'ChildValueOperations' },
    { name: 'generic root does not borrow its nongeneric namesake member', types: 'public class Payload { } public class Other { } public class Holder { public Payload Data { get; } } public class Holder<T> { public Other Data { get; } }', actual: 'Holder<int> holder', receiver: 'holder.Data', wrong: 'Payload', right: 'Other', rank: 'DataOperations' },
    { name: 'same-line types do not donate each other members', types: 'public class Payload { } public class Other { } public class Holder { public Payload Data { get; } } public class OtherHolder { public Other Data { get; } }', actual: 'OtherHolder holder', receiver: 'holder.Data', wrong: 'Payload', right: 'Other', rank: 'DataOperations' },
  ].map((f): Fixture => ({
    name: f.name,
    files: {
      'Types.cs': `namespace Example; ${f.types}`,
      'Wrong.cs': `namespace Example; public static class ${f.rank} { public static int AsSpan(this ${f.wrong} value) => 99; }`,
      'OtherwiseApplicable.cs': `namespace Example; public static class ActualExtensions { public static int AsSpan(this ${f.right} value) => 42; }`,
      'Consumer.cs': `namespace Example; public class Consumer { public int Read(${f.actual}) { ${f.local ?? ''} return ${f.receiver}.AsSpan(); } }`,
    }, target: null,
  })),
  {
    name: 'a method parameter never donates the type of an indexed property',
    files: {
      'Types.cs': 'namespace Example; public class Payload { } public class Payload<T> { } public class Holder { public void Ignore(Payload Data) { } public Payload<int> Data { get; } }',
      'Extensions.cs': extension('Payload<int>'),
      'Consumer.cs': 'namespace Example; public class Consumer { public int Read(Holder holder) => holder.Data.AsSpan(); }',
    }, target: 'Extensions.cs',
  },
  {
    name: 'an explicitly qualified base supplies its own indexed property',
    files: {
      'Types.cs': 'namespace Example { public class Payload { } public class Payload<T> { } public class Holder : Right.BaseHolder { } } namespace Left { public class BaseHolder { public Example.Payload Data { get; } } } namespace Right { public class BaseHolder { public Example.Payload<int> Data { get; } } }',
      'Extensions.cs': extension('Example.Payload<int>'),
      'Consumer.cs': 'namespace Example; public class Consumer { public int Read(Holder holder) => holder.Data.AsSpan(); }',
    }, target: 'Extensions.cs',
  },
  {
    name: 'indexed fields retain the type of multi-declarator statements',
    files: {
      'Types.cs': 'namespace Example; public class Payload { } public class Holder { public Payload First, Data; }',
      'Extensions.cs': extension('Payload'),
      'Consumer.cs': 'namespace Example; public class Consumer { public int Read(Holder holder) => holder.Data.AsSpan(); }',
    }, target: 'Extensions.cs',
  },
  ...([false, true] as const).map((base): Fixture => ({
    name: `explicit qualified ${base ? 'supertype' : 'property'} contradictions stay unresolved`,
    files: {
      'Left.cs': 'namespace Left; public class Payload { } public class Parent { }',
      'Right.cs': 'namespace Right; public class Payload { } public class Parent { }',
      'Types.cs': base ? 'namespace Example; public class Child : Left.Parent { }' : 'namespace Example; public class Holder { public Left.Payload Data { get; } }',
      'Wrong.cs': `namespace Example; public static class ${base ? 'ChildValueOperations' : 'DataOperations'} { public static int AsSpan(this Right.${base ? 'Parent' : 'Payload'} value) => 99; }`,
      'OtherwiseApplicable.cs': `namespace Example; public static class ActualExtensions { public static int AsSpan(this Left.${base ? 'Parent' : 'Payload'} value) => 42; }`,
      'Consumer.cs': base ? consumer('Child', 'childValue') : 'namespace Example; public class Consumer { public int Read(Holder holder) => holder.Data.AsSpan(); }',
    }, target: null,
  })),
  ...(['Parent', 'IPayload'] as const).map((base): Fixture => ({
    name: `nullable reference retains its ${base} conversion`,
    files: {
      'Types.cs': 'namespace Example; public class Parent { } public interface IPayload { } public class Child : Parent, IPayload { }',
      'Extensions.cs': extension(base),
      'Consumer.cs': '#nullable enable\n' + consumer('Child?'),
    }, target: 'Extensions.cs',
  })),
  {
    name: 'array property preserves complete element/array spelling',
    files: {
      'Types.cs': 'namespace Example; public class Payload { } public class Holder { public Payload[] Data { get; } = new Payload[0]; }',
      'Extensions.cs': extension('Payload[]'),
      'Consumer.cs': 'namespace Example; public class Consumer { public int Read(Holder holder) => holder.Data.AsSpan(); }',
    }, target: 'Extensions.cs',
  },
  ...[
    '[Tag($$"""{{{"text"}}""")] public static int AsSpan(this Buffer value) => 42;',
    '[Tag($$$"""{{{{{"text"}}}""")] public static int AsSpan(this Buffer value) => 42;',
    '[Tag(@"""text")] public static int AsSpan(this Buffer value) => 42;',
    '[Tag(@"""")] public static int AsSpan(this Buffer value) => 42;',
    '[Tag($@"""text")] public static int AsSpan(this Buffer value) => 42;',
    '[Tag(1 > 0)] public static int AsSpan(this Buffer value) => 42;',
    '[Tag(1 < 2)] public static int AsSpan(this Buffer value) => 42;',
    'public static int AsSpan(this Buffer value, bool b = 1 > 0) => 42;',
    'public static int AsSpan(this Buffer value, int b = 1 << 2) => 42;',
    '[Tag($"{")] AsSpan(this Other fake)"}")] public static int AsSpan(this Buffer value) => 42;',
    '[Tag("AsSpan<Buffer>")] public static int AsSpan(this Buffer value) => 42;',
    'public /* AsSpan<Buffer> */ static int AsSpan(this Buffer value) => 42;',
    'public static string Previous() => "AsSpan<Buffer>"; public static int AsSpan(this Buffer value) => 42;',
    '[Tag("""\nAsSpan(this Other fake)\n""")] public static int AsSpan(this Buffer value) => 42;',
    '[Tag("""\n"\n)] AsSpan(this Other fake)\n"\n""")] public static int AsSpan(this Buffer value) => 42;',
  ].map((declaration, i): Fixture => ({
    name: `literal/comment text is not receiver or generic-parameter evidence (${i})`,
    files: {
      'Types.cs': 'namespace Example; public class Buffer { } public class Other { }',
      'Extensions.cs': `using System;
namespace Example;
public class TagAttribute : Attribute { public TagAttribute(string text) { } public TagAttribute(bool value) { } }
public static class Extensions { ${declaration} }`,
      'Consumer.cs': consumer('Buffer'),
    }, target: 'Extensions.cs',
  })),
];

const kernelBuilt = fs.existsSync(path.join(__dirname, '..', 'codegraph-kernel', 'prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node'));
const envKeys = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_NO_PARALLEL_RESOLVE', 'CODEGRAPH_RESOLVE_WORKERS'] as const;

for (const mode of ['wasm', 'native'] as const) {
  describe.skipIf(mode === 'native' && !kernelBuilt)(`span-call preservation (${mode})`, () => {
    const roots: string[] = [];
    let saved: Record<string, string | undefined>;
    beforeAll(async () => {
      await initGrammars();
      await loadGrammarsForLanguages(['csharp']);
    });
    beforeEach(() => {
      saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      process.env.CODEGRAPH_KERNEL = mode === 'wasm' ? '0' : '1';
      process.env.CODEGRAPH_KERNEL_LANGS = 'csharp';
      process.env.CODEGRAPH_NO_PARALLEL_RESOLVE = '1';
      process.env.CODEGRAPH_RESOLVE_WORKERS = '0';
      resetKernelForTests();
    });
    afterEach(() => {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      resetKernelForTests();
      for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });

    it.each(fixtures)('$name', async ({ files, target, candidates }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-span-preserve-'));
      roots.push(root);
      for (const [file, source] of Object.entries(files)) {
        const extracted = mode === 'native'
          ? tryKernelExtract(file, source, 'csharp')
          : new TreeSitterExtractor(file, source, 'csharp').extract();
        expect(extracted, `${mode}: ${file} must not silently defer`).not.toBeNull();
        expect(extracted!.errors).toEqual([]);
        if (file === 'Consumer.cs') {
          expect(extracted!.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls' && ref.referenceName.endsWith('.AsSpan'))).toHaveLength(1);
        }
        fs.writeFileSync(path.join(root, file), source);
      }
      const cg = await CodeGraph.init(root, { index: true });
      try {
        const expected = target === null ? [] : cg.getNodesInFile(target).filter((node) => node.kind === 'method' && node.name === 'AsSpan');
        expect(expected).toHaveLength(target === null ? 0 : 1);
        if (target === null) expect(cg.getNodesByName('AsSpan').filter((node) => node.kind === 'method')).toHaveLength(candidates ?? 2);
        const callers = cg.getNodesInFile('Consumer.cs').map((node) => node.id);
        const calls = cg.getOutgoingEdgesFrom(callers).filter((edge) => edge.kind === 'calls' && cg.getNode(edge.target)?.name === 'AsSpan');
        expect(calls.map((edge) => edge.target)).toEqual(expected.map((node) => node.id));
      } finally {
        cg.close();
      }
    });
  });
}
