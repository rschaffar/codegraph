import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
const envKeys = ['CODEGRAPH_NO_PARALLEL_RESOLVE', 'CODEGRAPH_RESOLVE_WORKERS', 'CODEGRAPH_NO_REBIND'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.CODEGRAPH_NO_PARALLEL_RESOLVE = '1';
  process.env.CODEGRAPH_RESOLVE_WORKERS = '0';
  process.env.CODEGRAPH_NO_REBIND = '1';
});
afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const original = 'public static int AsSpan(this Buffer value) => 1;';
const declaration = (method: string) => `namespace Example;
public class Extensions {
    ${method}
}`;
const sourceFiles = (method: string) => ({
  'Types.cs': 'namespace Example; public class Buffer { } public class Other { }',
  'Extensions.cs': declaration(method),
  'Consumer.cs': 'namespace Example; public class Consumer { public int Read(Buffer value) => value.AsSpan(); }',
});

async function index(method: string): Promise<{ cg: CodeGraph; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-span-sync-'));
  roots.push(root);
  for (const [file, source] of Object.entries(sourceFiles(method))) fs.writeFileSync(path.join(root, file), source);
  return { root, cg: await CodeGraph.init(root, { index: true }) };
}

function calls(cg: CodeGraph): string[] {
  const callers = cg.getNodesInFile('Consumer.cs').map((node) => node.id);
  return cg.getOutgoingEdgesFrom(callers)
    .filter((edge) => edge.kind === 'calls' && cg.getNode(edge.target)?.name === 'AsSpan')
    .map((edge) => edge.target).sort();
}

describe('span-call eligibility after cross-file edits', () => {
  it('does not skip invalidation or failed retries above the optional general-rebind ceiling', async () => {
    const { cg, root } = await index(original);
    try {
      const methods = Array.from({ length: 601 }, (_, i) => `public int Read${i}(Buffer value) => value.AsSpan();`).join('\n');
      fs.writeFileSync(path.join(root, 'Consumer.cs'), `namespace Example; public class Consumer {\n${methods}\n}`);
      await cg.sync({ paths: ['Consumer.cs'] });
      expect(calls(cg)).toHaveLength(601);
      for (const [i, method] of ['public static int AsSpan(this Other value) => 1;', original].entries()) {
        const file = path.join(root, 'Extensions.cs');
        fs.writeFileSync(file, declaration(method));
        const stamp = new Date(Date.now() + (i + 1) * 2000);
        fs.utimesSync(file, stamp, stamp);
        await cg.sync({ paths: ['Extensions.cs'] });
        expect(calls(cg)).toHaveLength(i === 0 ? 0 : 601);
        expect(cg.getUnresolvedReferencesInFile('Consumer.cs', 2000).filter((ref) => ref.referenceName === 'value.AsSpan')).toHaveLength(i === 0 ? 601 : 0);
      }
    } finally {
      cg.close();
    }
  });

  for (const scoped of [false, true]) {
    it.each([
      'public static int AsSpan(this Other value) => 1;',
      'public static int AsSpan(Buffer value) => 1;',
      'public int AsSpan(Buffer value) => 1;',
    ])(`rebinds unchanged callers after %s (${scoped ? 'scoped' : 'full'} sync)`, async (changed) => {
      const { cg, root } = await index(original);
      try {
        const target = cg.getNodesInFile('Extensions.cs').find((node) => node.kind === 'method' && node.name === 'AsSpan')!;
        expect(target).toBeDefined();
        expect(calls(cg)).toEqual([target.id]);
        const consumerBytes = fs.readFileSync(path.join(root, 'Consumer.cs'));
        for (const [step, method] of [changed, original].entries()) {
          const file = path.join(root, 'Extensions.cs');
          fs.writeFileSync(file, declaration(method));
          const stamp = new Date(Date.now() + (step + 1) * 2000);
          fs.utimesSync(file, stamp, stamp);
          const result = await cg.sync(scoped ? { paths: ['Extensions.cs'] } : {});
          expect(result.filesModified).toBe(1);
          expect(cg.getNodesInFile('Extensions.cs').find((node) => node.kind === 'method' && node.name === 'AsSpan')!.id).toBe(target.id);
          expect(fs.readFileSync(path.join(root, 'Consumer.cs'))).toEqual(consumerBytes);
          const fresh = await index(method);
          try {
            const expected = step === 0 ? [] : [target.id];
            expect(calls(fresh.cg), 'fresh-index control').toEqual(expected);
            expect(calls(cg), 'live index must agree with fresh source').toEqual(expected);
            const pending = (engine: CodeGraph) => engine.getUnresolvedReferencesInFile('Consumer.cs', 1000)
              .filter((ref) => ref.referenceName === 'value.AsSpan').map((ref) => ref.referenceName);
            expect(pending(cg)).toEqual(pending(fresh.cg));
            expect(pending(cg)).toHaveLength(step === 0 ? 1 : 0);
          } finally {
            fresh.cg.close();
          }
        }
      } finally {
        cg.close();
      }
    });
  }
});
