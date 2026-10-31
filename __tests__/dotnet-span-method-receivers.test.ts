import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { TreeSitterExtractor } from '../src/extraction/tree-sitter';
import { resetKernelForTests, tryKernelExtract } from '../src/extraction/kernel';
import { isStdMethodName } from '../src/resolution/name-matcher';

const kernelBuilt = fs.existsSync(path.join(
  __dirname, '..', 'codegraph-kernel', 'prebuilds',
  `${process.platform}-${process.arch}`, 'codegraph-kernel.node',
));
const envKeys = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

for (const mode of ['wasm', 'native'] as const) {
  describe.skipIf(mode === 'native' && !kernelBuilt)(`.NET span-method receivers (${mode})`, () => {
    const roots: string[] = [];
    let savedEnv: Record<string, string | undefined>;

    beforeAll(async () => {
      await initGrammars();
      await loadGrammarsForLanguages(['csharp']);
    });
    beforeEach(() => {
      savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      process.env.CODEGRAPH_KERNEL = mode === 'wasm' ? '0' : '1';
      process.env.CODEGRAPH_KERNEL_LANGS = 'csharp';
      resetKernelForTests();
    });
    afterEach(() => {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      resetKernelForTests();
      for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });

    async function index(files: Record<string, string>): Promise<CodeGraph> {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dotnet-span-'));
      roots.push(root);
      for (const [file, source] of Object.entries(files)) {
        if (mode === 'native') {
          expect(tryKernelExtract(file, source, 'csharp'), 'native fixtures must not silently defer').not.toBeNull();
        }
        fs.writeFileSync(path.join(root, file), source);
      }
      return CodeGraph.init(root, { index: true });
    }

    for (const parameters of ['int count', '', 'int count = 0', 'params int[] counts']) {
      for (const separator of ['', '\n        ', ' /* receiver */\r\n        ']) {
        it(`does not guess a span method on an untyped string lambda (${JSON.stringify(parameters)}, ${JSON.stringify(separator)})`, async () => {
          const source = `using System;
namespace Example;
public static class Matching {
    static bool WithProperty<T>(Func<T, bool> predicate) => false;
    public static bool FromSource() => WithProperty<string>(s => s${separator}.AsSpan().Length > 0);
}`;
          const extracted = mode === 'native'
            ? tryKernelExtract('Consumer.cs', source, 'csharp')
            : new TreeSitterExtractor('Consumer.cs', source, 'csharp').extract();
          expect(extracted, 'the rejected call must still be extracted').not.toBeNull();
          expect(extracted!.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls' && ref.referenceName === 's.AsSpan')).toHaveLength(1);
          const cg = await index({
            'Decoy.cs': `namespace Example;
public struct PropertiesInlineArray { public int AsSpan(${parameters}) => 0; }`,
            'Consumer.cs': source,
          });
          try {
            const caller = cg.getNodesByName('FromSource').find((node) => node.kind === 'method')!;
            const candidates = cg.getNodesByName('AsSpan').filter((node) => node.kind === 'method');
            expect(candidates).toHaveLength(1);
            const decoy = candidates[0]!;
            expect(caller).toBeDefined();
            expect(decoy).toMatchObject({ filePath: 'Decoy.cs', qualifiedName: 'Example::PropertiesInlineArray::AsSpan', language: 'csharp' });
            const sources = cg.getNodesInFile('Consumer.cs').map((node) => node.id);
            expect(cg.getOutgoingEdgesFrom(sources).filter((edge) => edge.kind === 'calls' && edge.target === decoy.id)).toEqual([]);
            expect(cg.getCallers(decoy.id).map(({ node }) => node.id)).not.toContain(caller.id);
            expect(cg.findPath(caller.id, decoy.id, ['calls'])).toBeFalsy();
          } finally {
            cg.close();
          }
        });
      }
    }

    it('preserves project span methods on known receivers and explicit self/base calls', async () => {
      const cg = await index({
        'Buffer.cs': `namespace Example;
public class Buffer {
    public int AsSpan() => 1;
    public int FromThis() => this.AsSpan();
}
public class DerivedBuffer : Buffer { public int FromBase() => base.AsSpan(); }
public static class Factory { public static Buffer Create() => new Buffer(); }`,
        'Consumer.cs': `namespace Example;
public class Consumer {
    public int FromParameter(Buffer value) => value.AsSpan();
    public int FromLocal() { var value = new Buffer(); return value.AsSpan(); }
    public int FromFactory() => Factory.Create().AsSpan();
}`,
      });
      try {
        const target = cg.getNodesByName('AsSpan').find((node) => node.kind === 'method')!;
        expect(target).toMatchObject({ filePath: 'Buffer.cs', qualifiedName: 'Example::Buffer::AsSpan' });
        for (const name of ['FromThis', 'FromBase', 'FromParameter', 'FromLocal', 'FromFactory']) {
          const caller = cg.getNodesByName(name).find((node) => node.kind === 'method')!;
          const spans = cg.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls' && cg.getNode(edge.target)?.name === 'AsSpan');
          expect(spans.map((edge) => edge.target), name).toEqual([target.id]);
        }
      } finally {
        cg.close();
      }
    });

    it('preserves a project extension span method with an evidenced receiver type', async () => {
      const cg = await index({
        'Buffer.cs': 'namespace Example; public class Buffer { }',
        'Extensions.cs': 'namespace Example; public static class Extensions { public static int AsSpan(this Buffer value) => 1; }',
        'Consumer.cs': 'namespace Example; public class Consumer { public int Read(Buffer value) => value.AsSpan(); }',
      });
      try {
        const caller = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
        const target = cg.getNodesByName('AsSpan').find((node) => node.kind === 'method')!;
        expect(cg.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls').map((edge) => edge.target)).toEqual([target.id]);
      } finally {
        cg.close();
      }
    });

    it('reads an attributed multiline extension declaration without mistaking attribute text for its receiver', async () => {
      const cg = await index({
        'Buffer.cs': 'namespace Example; public class Buffer { }',
        'Extensions.cs': `using System;
namespace Example;
public class ReceiverAttribute : Attribute { public ReceiverAttribute(string text) { } }
public static class Extensions {
    [Receiver("AsSpan(not the parameter list)")]
    public static int AsSpan(
        [Receiver("this Other")] this /* receiver */ Buffer value
    ) => 1;
}`,
        'Consumer.cs': 'namespace Example; public class Consumer { public int Read(Buffer value) => value.AsSpan(); }',
      });
      try {
        const caller = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
        const target = cg.getNodesByName('AsSpan').find((node) => node.kind === 'method')!;
        expect(cg.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls').map((edge) => edge.target)).toEqual([target.id]);
      } finally {
        cg.close();
      }
    });

    for (const declaration of [
      'public static int AsSpan(this Other value) => 1;',
      'public static int AsSpan(Buffer value) => 1;',
      'public static string ToString(this Buffer value) => "not Object.ToString";',
    ]) {
      it(`does not bypass other receiver or standard-method guards: ${declaration}`, async () => {
        const name = declaration.includes('ToString') ? 'ToString' : 'AsSpan';
        const cg = await index({
          'Buffer.cs': 'namespace Example; public class Buffer { } public class Other { }',
          'Extensions.cs': `namespace Example; public static class Extensions { ${declaration} }`,
          'Consumer.cs': `namespace Example; public class Consumer { public object Read(Buffer value) => value.${name}(); }`,
        });
        try {
          const caller = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
          const target = cg.getNodesByName(name).find((node) => node.kind === 'method')!;
          expect(target).toBeDefined();
          expect(cg.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls' && edge.target === target.id)).toEqual([]);
        } finally {
          cg.close();
        }
      });
    }

    it('keeps owner-name evidence for an otherwise untyped extension receiver', async () => {
      const cg = await index({
        'Buffer.cs': 'namespace Example; public class Buffer { }',
        'Extensions.cs': 'namespace Example; public static class Extensions { public static int AsSpan(this Buffer value) => 1; }',
        'Consumer.cs': `using System;
namespace Example;
public class Consumer {
    static int WithProperty<T>(Func<T, int> predicate) => 0;
    public int Read() => WithProperty<Buffer>(buffer => buffer.AsSpan());
}`,
      });
      try {
        const caller = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
        const target = cg.getNodesByName('AsSpan').find((node) => node.kind === 'method')!;
        expect(target).toMatchObject({ filePath: 'Extensions.cs', qualifiedName: 'Example::Extensions::AsSpan' });
        expect(cg.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls' && edge.target === target.id)).toHaveLength(1);
      } finally {
        cg.close();
      }
    });

    it('does not use a generic receiver parameter as concrete name evidence in the live fallback', async () => {
      const source = `using System;
namespace Example;
public class Consumer {
    static int WithProperty<T>(Func<T, int> predicate) => 0;
    public int Read() => WithProperty<string>(t => t.AsSpan());
}`;
      const extracted = mode === 'native'
        ? tryKernelExtract('Consumer.cs', source, 'csharp')
        : new TreeSitterExtractor('Consumer.cs', source, 'csharp').extract();
      expect(extracted).not.toBeNull();
      expect(extracted!.unresolvedReferences.filter((ref) => ref.referenceKind === 'calls' && ref.referenceName === 't.AsSpan')).toHaveLength(1);
      const cg = await index({
        'Extensions.cs': 'namespace Example; public static class Extensions { public static int AsSpan<T>(this T value) => 1; }',
        'Consumer.cs': source,
      });
      try {
        const methods = cg.getNodesByName('AsSpan').filter((node) => node.kind === 'method');
        expect(methods).toHaveLength(1);
        expect(methods[0]!.qualifiedName).toBe('Example::Extensions::AsSpan');
        // Deliberately conservative: the variable `t` spelling a generic `T`
        // must not authorize this name-only guess. This exercises the actual
        // selected-target veto, not a separate declaration-reader wrapper.
        const sources = cg.getNodesInFile('Consumer.cs').map((node) => node.id);
        expect(cg.getOutgoingEdgesFrom(sources).filter((edge) => edge.kind === 'calls' && edge.target === methods[0]!.id)).toEqual([]);
      } finally {
        cg.close();
      }
    });

    it('keeps the unique nonstandard project-method fallback for a generic lambda receiver', async () => {
      const cg = await index({
        'Value.cs': 'namespace Example; public class Datum { public bool ProjectOnly() => true; }',
        'Consumer.cs': `using System;
namespace Example;
public class Consumer {
    static bool WithProperty<T>(Func<T, bool> predicate) => false;
    public bool Read() => WithProperty<Datum>(item => item.ProjectOnly());
}`,
      });
      try {
        const caller = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
        const target = cg.getNodesByName('ProjectOnly').find((node) => node.kind === 'method')!;
        expect(cg.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls' && edge.target === target.id)).toEqual([
          expect.objectContaining({ metadata: expect.objectContaining({ confidence: 0.7, resolvedBy: 'instance-method' }) }),
        ]);
      } finally {
        cg.close();
      }
    });
  });
}

describe('.NET standard span-method names', () => {
  it('recognizes the C# spelling without making C# case-insensitive', () => {
    expect(isStdMethodName('csharp', 'AsSpan')).toBe(true);
    expect(isStdMethodName('csharp', 'asspan')).toBe(false);
  });
  it.each(['AsSpan', 'asspan', 'ASSPAN'])('shares the .NET safeguard with VB.NET: %s', (name) => {
    expect(isStdMethodName('vbnet', name)).toBe(true);
  });
});
