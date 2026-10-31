import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { QueryBuilder } from '../src/db/queries';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';
import type { MaybeYield } from '../src/resolution/cooperative-yield';

const roots: string[] = [];
const envKeys = ['CODEGRAPH_NO_PARALLEL_RESOLVE', 'CODEGRAPH_RESOLVE_WORKERS', 'CODEGRAPH_NO_REBIND', 'CODEGRAPH_NO_STORE_WORKER', 'CODEGRAPH_NO_FAST_INIT', 'CODEGRAPH_PARSE_WORKERS', 'CODEGRAPH_KERNEL'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.CODEGRAPH_NO_PARALLEL_RESOLVE = '1';
  process.env.CODEGRAPH_RESOLVE_WORKERS = '0';
  process.env.CODEGRAPH_NO_REBIND = '1';
});
afterEach(() => {
  vi.restoreAllMocks();
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
      const callCount = 2001; // More than one page, not merely the old 500 ceiling.
      const methods = Array.from({ length: callCount }, (_, i) => `public int Read${i}(Buffer value) => value.AsSpan();`).join('\n');
      fs.writeFileSync(path.join(root, 'Consumer.cs'), `namespace Example; public class Consumer {\n${methods}\n}`);
      await cg.sync({ paths: ['Consumer.cs'] });
      expect(calls(cg)).toHaveLength(callCount);
      for (const [i, method] of ['public static int AsSpan(this Other value) => 1;', original].entries()) {
        const file = path.join(root, 'Extensions.cs');
        fs.writeFileSync(file, declaration(method));
        const stamp = new Date(Date.now() + (i + 1) * 2000);
        fs.utimesSync(file, stamp, stamp);
        await cg.sync({ paths: ['Extensions.cs'] });
        expect(calls(cg)).toHaveLength(i === 0 ? 0 : callCount);
        expect(cg.getUnresolvedReferencesInFile('Consumer.cs', 5000).filter((ref) => ref.referenceName === 'value.AsSpan')).toHaveLength(i === 0 ? callCount : 0);
      }
    } finally {
      cg.close();
    }
  });

  it('skips fresh-DB drains even without fast init or a store worker', async () => {
    process.env.CODEGRAPH_NO_FAST_INIT = '1';
    process.env.CODEGRAPH_NO_STORE_WORKER = '1';
    const targets = vi.spyOn(QueryBuilder.prototype, 'getDotnetSpanTargetsPage');
    const failures = vi.spyOn(QueryBuilder.prototype, 'reopenFailedDotnetSpanPage');
    const { cg } = await index(original);
    try {
      expect(calls(cg)).toHaveLength(1);
      expect(targets).not.toHaveBeenCalled();
      expect(failures).not.toHaveBeenCalled();
    } finally {
      cg.close();
    }
  });

  it('orders oversized markers with actual parse-worker commits before reattaching promoted targets', async () => {
    // Source-mode tests have no parse-worker.js. Use the normal global-setup
    // build so this exercises the actual indexAll worker/marker scheduling.
    const { CodeGraph: CompiledCodeGraph } = require('../dist') as { CodeGraph: typeof CodeGraph };
    const { ParseWorkerPool } = require('../dist/extraction/parse-pool') as {
      ParseWorkerPool: { prototype: { requestParse(request: { filePath: string; language: string }): Promise<unknown> } };
    };
    process.env.CODEGRAPH_PARSE_WORKERS = '1';
    process.env.CODEGRAPH_KERNEL = '0';
    process.env.CODEGRAPH_NO_STORE_WORKER = '1';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-span-marker-'));
    roots.push(root);
    const config = (language: string) => fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ extensions: { '.mixed': language } }));
    config('csharp');
    fs.writeFileSync(path.join(root, 'a.mixed'), 'namespace Example; public class Legacy { public int asspan() => 1; }');
    fs.writeFileSync(path.join(root, 'b.cs'), 'namespace Example; public class Marker { public int AsSpan() => 1; }');
    fs.writeFileSync(path.join(root, 'c.cs'), 'namespace Example; public class Consumer { public int Read(Legacy value) => value.asspan(); }');
    const cg = await CompiledCodeGraph.init(root, { index: true });
    try {
      const target = cg.getNodesInFile('a.mixed').find((node) => node.kind === 'method' && node.name === 'asspan')!;
      const caller = cg.getNodesByName('Read').find((node) => node.kind === 'method')!;
      expect(cg.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls' && edge.target === target.id)).toHaveLength(1);
      config('vbnet');
      fs.writeFileSync(path.join(root, 'a.mixed'), 'Namespace Example\nPublic Class Legacy\nPublic Function asspan() As Integer\nReturn 1\nEnd Function\nEnd Class\nEnd Namespace');
      fs.truncateSync(path.join(root, 'b.cs'), MAX_SOURCE_FILE_SIZE_BYTES + 1);
      const internal = cg as unknown as {
        queries: QueryBuilder;
        orchestrator: { indexAll(): Promise<{ errors: Array<{ severity: string }> }>;
          storeExtractionResult(...args: unknown[]): Promise<void> };
      };
      const requests = vi.spyOn(ParseWorkerPool.prototype, 'requestParse');
      const store = internal.orchestrator.storeExtractionResult;
      let release!: () => void;
      const promoted = new Promise<void>((resolve) => { release = resolve; });
      const order: string[] = [];
      let active = 0;
      let maxActive = 0;
      vi.spyOn(internal.orchestrator, 'storeExtractionResult').mockImplementation(async function (...args) {
        const file = args[0];
        if (file !== 'a.mixed' && file !== 'b.cs') return store.apply(this, args);
        order.push(file);
        maxActive = Math.max(maxActive, ++active);
        const phase = args[6] as { onYield: MaybeYield };
        // If the marker bypasses ordered commits, pause its real drain until
        // the ordinary store promotes the old C# target to VB. No fake DB rows
        // or resolver results: both use the production extraction/store path.
        phase.onYield = file === 'b.cs' ? () => promoted : () => null;
        try { await store.apply(this, args); }
        finally { active--; if (file === 'a.mixed') release(); }
      });
      const result = await internal.orchestrator.indexAll(); // Inspect pending queue before coordinator resolution.
      expect(result.errors.filter((error) => error.severity === 'error')).toEqual([]);
      expect(requests.mock.calls.some(([request]) => request.filePath === 'a.mixed' && request.language === 'vbnet')).toBe(true);
      expect(order).toEqual(['a.mixed', 'b.cs']);
      expect(maxActive).toBe(1);
      const replacement = cg.getNodesInFile('a.mixed').find((node) => node.kind === 'method' && node.name === 'asspan')!;
      expect(replacement.language).toBe('vbnet');
      expect(cg.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls' && edge.target === replacement.id)).toEqual([]);
      expect(internal.queries.getUnresolvedReferencesCount()).toBeGreaterThan(0);
      expect(internal.queries.getUnresolvedReferencesBatchAfter(0, 100).some((ref) => ref.filePath === 'c.cs' && ref.referenceName === 'value.asspan')).toBe(true);
    } finally {
      vi.restoreAllMocks();
      cg.close();
    }
  });

  it.each(['sync', 'indexFiles', 'indexAll'] as const)('shares only the failed drain within %s, never across operations', async (mode) => {
    const { cg, root } = await index(original);
    try {
      fs.writeFileSync(path.join(root, 'Extensions.cs'), declaration(original).replace('class Extensions', 'class BufferValueExtensions'));
      fs.writeFileSync(path.join(root, 'Consumer.cs'), sourceFiles(original)['Consumer.cs']
        .replace('Buffer value', 'Buffer bufferValue').replace('value.AsSpan', 'bufferValue.AsSpan'));
      fs.writeFileSync(path.join(root, 'OtherExtensions.cs'), 'namespace Example; public class OtherExtensions { public static int AsSpan(this Other value) => 1; }');
      await cg.sync({ paths: ['Extensions.cs', 'Consumer.cs', 'OtherExtensions.cs'] });
      expect(calls(cg)).toHaveLength(1);
      const targets = vi.spyOn(QueryBuilder.prototype, 'getDotnetSpanTargetsPage');
      const failures = vi.spyOn(QueryBuilder.prototype, 'reopenFailedDotnetSpanPage');
      const paths = ['Extensions.cs', 'OtherExtensions.cs'];
      for (const [step, next] of ['2', '3'].entries()) {
        for (const file of paths) {
          const full = path.join(root, file);
          fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace(/=> \d;/, `=> ${next};`));
        }
        if (mode === 'sync') await cg.sync({ paths });
        else if (mode === 'indexFiles') {
          await cg.indexFiles(paths);
          await cg.sync({ paths: ['Consumer.cs'] }); // The existing orphan sweep resolves pending extraction output.
        } else await cg.indexAll({ verbose: false });
        expect(failures.mock.calls.filter(([after]) => after === 0)).toHaveLength(step + 1);
        // Keep edge drains per file: a reattachment may promote a target's language.
        expect(targets.mock.calls.filter(([after]) => after === 0)).toHaveLength((step + 1) * 2);
        expect(calls(cg)).toHaveLength(1);
      }
    } finally {
      cg.close();
    }
  });

  it.each(['edges', 'failures', 'stored'] as const)('recovers a durable queue after interruption at %s', async (where) => {
    const other = 'public static int AsSpan(this Other value) => 1;';
    const { cg, root } = await index(where === 'failures' ? other : original);
    try {
      const methods = Array.from({ length: 5 }, (_, i) => `public int Read${i}(Buffer value) => value.AsSpan();`).join('\n');
      fs.writeFileSync(path.join(root, 'Consumer.cs'), `namespace Example; public class Consumer {\n${methods}\n}`);
      await cg.sync({ paths: ['Consumer.cs'] });
      expect(calls(cg)).toHaveLength(where === 'failures' ? 0 : 5);
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      const before = queries.getFileByPath('Extensions.cs')!.contentHash;
      const changed = where === 'failures' ? original : other;
      fs.writeFileSync(path.join(root, 'Extensions.cs'), declaration(changed));
      const failure = new Error('span cleanup interruption');
      if (where === 'edges') {
        const read = QueryBuilder.prototype.getDotnetSpanCallsPage;
        let pages = 0;
        vi.spyOn(QueryBuilder.prototype, 'getDotnetSpanCallsPage').mockImplementation(function (target, after, through) {
          if (++pages === 2) throw failure;
          return read.call(this, target, after, through, 2);
        });
      } else if (where === 'failures') {
        const reopen = QueryBuilder.prototype.reopenFailedDotnetSpanPage;
        let pages = 0;
        vi.spyOn(QueryBuilder.prototype, 'reopenFailedDotnetSpanPage').mockImplementation(function (after) {
          if (++pages === 2) throw failure;
          return reopen.call(this, after, 2);
        });
      } else {
        const count = QueryBuilder.prototype.getUnresolvedReferencesCount;
        vi.spyOn(QueryBuilder.prototype, 'getUnresolvedReferencesCount').mockImplementation(function (...args) {
          if (this.getFileByPath('Extensions.cs')!.contentHash !== before) throw failure;
          return count.apply(this, args);
        });
      }
      await expect(cg.sync({ paths: ['Extensions.cs'] })).rejects.toThrow('span cleanup interruption');
      vi.restoreAllMocks();
      expect(queries.getUnresolvedReferencesCount()).toBe(where === 'stored' ? 5 : 2);
      expect(queries.getFileByPath('Extensions.cs')!.contentHash === before).toBe(where !== 'stored');
      cg.close();
      const resumed = CodeGraph.openSync(root);
      try {
        await resumed.sync({ paths: ['Extensions.cs'] });
        expect(calls(resumed)).toHaveLength(where === 'failures' ? 5 : 0);
        expect((resumed as unknown as { queries: QueryBuilder }).queries.getUnresolvedReferencesCount()).toBe(0);
      } finally {
        resumed.close();
      }
    } finally {
      vi.restoreAllMocks();
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
