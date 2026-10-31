import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { overrideFilter } from '../src/resolution/override-parameters';
import { typeParametersInScope } from '../src/resolution/type-parameters';
import type { ResolutionContext } from '../src/resolution/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('C# lexical declarations do not change type/override evidence', () => {
  it.each([
    { name: 'raw literal prefix brace', attribute: '[Tag($$"""{{{"text"}}""")]', extra: '' },
    { name: 'raw literal prefix braces', attribute: '[Tag($$$"""{{{{{"text"}}}""")]', extra: '' },
    { name: 'verbatim quote', attribute: '[Tag(@"""text")]', extra: '' },
    { name: 'verbatim empty quote', attribute: '[Tag(@"""")]', extra: '' },
    { name: 'greater-than attribute', attribute: '[Tag(1 > 0)]', extra: '' },
    { name: 'less-than attribute', attribute: '[Tag(1 < 2)]', extra: '' },
    { name: 'relational default', attribute: '', extra: ', bool b = 1 > 0' },
    { name: 'shift default', attribute: '', extra: ', int b = 1 << 2' },
  ])('$name', async ({ attribute, extra }) => {
    const files: Record<string, string> = {
      'Types.cs': 'namespace N; public class T { } public class TagAttribute : System.Attribute { public TagAttribute(string text) { } public TagAttribute(bool value) { } }',
      'Box.cs': `namespace N; ${attribute} public class Box<T> { public T Echo(T value) => value; }`,
      'Base.cs': `namespace N; public class Base { ${attribute} public virtual void Put(int value${extra}) { } }`,
      'Other.cs': `namespace N; public class Other { public void Put(string value${extra}) { } }`,
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csharp-head-'));
    roots.push(root);
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const context = {
        getNodesInFile: (file: string) => cg.getNodesInFile(file),
        getFileLines: (file: string) => files[file]?.split(/\r?\n/) ?? null,
        readFile: (file: string) => files[file] ?? null,
      } as ResolutionContext;
      const echo = cg.getNodesInFile('Box.cs').find((node) => node.kind === 'method' && node.name === 'Echo')!;
      const decoy = cg.getNodesInFile('Types.cs').find((node) => node.kind === 'class' && node.name === 'T')!;
      expect(echo).toBeDefined();
      expect(decoy).toBeDefined();
      expect([...typeParametersInScope(echo, context)]).toEqual(['T']);
      expect(cg.getOutgoingEdges(echo.id).filter((edge) => edge.target === decoy.id)).toEqual([]);
      const base = cg.getNodesInFile('Base.cs').find((node) => node.kind === 'method' && node.name === 'Put')!;
      const wrong = cg.getNodesInFile('Other.cs').find((node) => node.kind === 'method' && node.name === 'Put')!;
      expect(base).toBeDefined();
      expect(wrong).toBeDefined();
      expect(overrideFilter(context)(base, [wrong])).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
