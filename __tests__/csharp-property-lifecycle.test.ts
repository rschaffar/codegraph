import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { CSHARP_PROPERTY_PAGE_SIZE, CSHARP_PROPERTY_REFRESH_PENDING } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { resetKernelForTests } from '../src/extraction/kernel';
import { clearProjectConfigCache } from '../src/project-config';
import type { UnresolvedReference } from '../src/types';

const kernelPath = process.env.CODEGRAPH_KERNEL_PATH ?? path.join(__dirname, '..', 'codegraph-kernel/prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node');
const keys = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_NO_PARALLEL_RESOLVE', 'CODEGRAPH_NO_REBIND', 'CODEGRAPH_NO_STORE_WORKER', 'CODEGRAPH_NO_FAST_INIT'] as const;
const types = 'namespace Demo; public interface IOne { object Current { get; } } public interface ITwo { object Current { get; } }';
const holder = (type: string) => `namespace Demo; public class Holder { public ${type} State { get; } }`;
function readers(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let start = 0; start < count; start += 400) {
    const body = Array.from({ length: Math.min(400, count - start) }, (_, i) => `public object Read${start + i}(Holder holder) { _ = holder.State.Current; return holder.State.Current; }`);
    files[`Reader${start}.cs`] = `namespace Demo; public class Reader${start} {\n${body.join('\n')}\n}`;
  }
  return files;
}
function propertyEdges(cg: CodeGraph) {
  const nodes = cg['queries'].getAllNodes();
  return cg.getOutgoingEdgesFrom(nodes.filter(n => n.filePath.startsWith('Reader')).map(n => n.id))
    .filter(e => e.metadata?.refKind === 'property_ref')
    .map(e => ({ source: cg.getNode(e.source)!.qualifiedName, target: cg.getNode(e.target)!.qualifiedName,
      kind: e.kind, name: e.metadata!.refName, line: e.line, column: e.column }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

for (const mode of ['wasm', 'native'] as const) describe.skipIf(mode === 'native' && !fs.existsSync(kernelPath))(`C# property lifecycle (${mode})`, () => {
  let saved: Record<string, string | undefined>;
  const roots: string[] = [];
  beforeAll(async () => { await initGrammars(); await loadGrammarsForLanguages(['csharp']); });
  beforeEach(() => {
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { CODEGRAPH_KERNEL: mode === 'native' ? '1' : '0', CODEGRAPH_KERNEL_LANGS: 'csharp', CODEGRAPH_NO_PARALLEL_RESOLVE: '1', CODEGRAPH_NO_REBIND: '1', CODEGRAPH_NO_STORE_WORKER: '1', CODEGRAPH_NO_FAST_INIT: '1' });
    resetKernelForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    resetKernelForTests();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  async function create(files: Record<string, string>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-property-life-')); roots.push(root);
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source);
    const cg = await CodeGraph.init(root, { index: false });
    await cg.indexAll();
    expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).not.toBe('1');
    return { cg, root };
  }
  async function expectFresh(cg: CodeGraph, files: Record<string, string>) {
    const fresh = await create(files);
    try { expect(propertyEdges(cg)).toEqual(propertyEdges(fresh.cg)); } finally { fresh.cg.close(); }
  }

  it('detects same-name qualified additions/removals and retries failed lookup', async () => {
    const before = 'namespace Elsewhere { public interface IState { object Current { get; } } } namespace Client { public class Empty { } }';
    const withType = (member: string) => `namespace Elsewhere { public interface IState { object Current { get; } } } namespace Client { public class Empty { } public interface IState { ${member} } }`;
    const files = { 'Types.cs': 'namespace Demo; public interface IState { object Current { get; } }', 'Reader.cs': 'using Demo; namespace Client; public class Reader { public object Read(IState state) => state.Current; }', 'Shadow.cs': before };
    const { cg, root } = await create(files);
    try {
      for (const [source, shape, targets] of [
        [withType('object Current { get; }'), true, ['Client::IState::Current']],
        [withType(''), false, []],
        [before, true, ['Demo::IState::Current']],
      ] as const) {
        files['Shadow.cs'] = source; fs.writeFileSync(path.join(root, 'Shadow.cs'), source);
        const result = await cg.sync({ paths: ['Shadow.cs'] });
        expect(result.definitionDelta ?? []).toEqual([]);
        expect(result.csharpLookupChanged).toBe(shape);
        expect(propertyEdges(cg).map(e => e.target)).toEqual(targets);
        await expectFresh(cg, files);
      }
    } finally { cg.close(); }
  });

  it('preserves duplicate qualified declaration multiplicity without binding partial identities', async () => {
    const one = 'namespace Demo;\npublic partial interface IState { object Current { get; } }';
    const two = one + '\npublic partial interface IState { object Current { get; } }';
    const files = { 'Types.cs': one, 'Reader.cs': 'namespace Demo; public class Reader { public object Read(IState state) => state.Current; }' };
    const { cg, root } = await create(files);
    try {
      for (const [source, count] of [[two, 0], [one, 1]] as const) {
        files['Types.cs'] = source; fs.writeFileSync(path.join(root, 'Types.cs'), source);
        const result = await cg.sync({ paths: ['Types.cs'] });
        expect(result.definitionDelta ?? []).toEqual([]);
        expect(result.csharpLookupChanged).toBe(true);
        expect(propertyEdges(cg)).toHaveLength(count);
        await expectFresh(cg, files);
      }
    } finally { cg.close(); }
  });

  it('keeps declaration-shape-stable edits scoped to their positive dependencies', async () => {
    const files = { 'Types.cs': types, 'Holder.cs': holder('IOne'), ...readers(1), 'ReaderOther.cs': 'namespace Demo; public class ReaderOther { public object Read(IOne state) => state.Current; }' };
    const { cg, root } = await create(files);
    const driver = vi.spyOn(cg['orchestrator'], 'resurrectCsharpPropertyEdges');
    const reopen = vi.spyOn(cg['queries'], 'replaceResolutionEdgesWithUnresolvedRefs');
    try {
      files['Holder.cs'] = holder('ITwo'); fs.writeFileSync(path.join(root, 'Holder.cs'), files['Holder.cs']);
      const result = await cg.sync({ paths: ['Holder.cs'] });
      expect(result.csharpLookupChanged).toBe(false);
      expect(driver.mock.calls.at(-1)![2]).toBe(false);
      const other = cg.getNodesInFile('ReaderOther.cs').find(n => n.kind === 'method')!.id;
      expect(reopen.mock.calls.flatMap(([, refs]) => refs).some(ref => ref.fromNodeId === other)).toBe(false);
      await expectFresh(cg, files);
    } finally { cg.close(); }
  });

  for (const stop of ['entry', 'after-invalidation', 'admission'] as const) it(`recovers a durable obligation after ${stop}, including no-change reopen`, async () => {
    const files = { 'Types.cs': types, 'Holder.cs': holder('IOne'), ...readers(stop === 'entry' ? 1 : 501) };
    let { cg, root } = await create(files);
    const originalQueries = cg['queries'];
    const remove = originalQueries.deleteFile.bind(originalQueries);
    const markAtDelete = vi.spyOn(originalQueries, 'deleteFile');
    markAtDelete.mockImplementation(file => {
      if (file === 'Holder.cs') expect(originalQueries.getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('1');
      return remove(file);
    });
    files['Holder.cs'] = holder('ITwo'); fs.writeFileSync(path.join(root, 'Holder.cs'), files['Holder.cs']);
    let fault: { mockRestore(): void };
    let admitted = 0;
    if (stop === 'entry') fault = vi.spyOn(cg['orchestrator'], 'resurrectCsharpPropertyEdges').mockRejectedValueOnce(new Error('controlled property stop'));
    else if (stop === 'after-invalidation') {
      const reopen = originalQueries.replaceResolutionEdgesWithUnresolvedRefs.bind(originalQueries);
      fault = vi.spyOn(originalQueries, 'replaceResolutionEdgesWithUnresolvedRefs').mockImplementation((ids, refs) => {
        reopen(ids, refs);
        if (refs.some(ref => ref.referenceKind === 'property_ref')) throw new Error('controlled property stop');
      });
    } else {
      const persist = cg['resolver'].resolveAndPersistListYielding.bind(cg['resolver']);
      fault = vi.spyOn(cg['resolver'], 'resolveAndPersistListYielding').mockImplementation(async (refs, ...rest) => {
        if (refs.every(ref => ref.referenceKind === 'property_ref')) {
          expect(refs.length).toBeLessThanOrEqual(CSHARP_PROPERTY_PAGE_SIZE);
          expect(refs.every(ref => ref.language === 'csharp' && ref.rowId !== undefined)).toBe(true);
          if (++admitted === 2) throw new Error('controlled property stop');
        }
        return persist(refs, ...rest);
      });
    }
    try {
      await expect(cg.sync({ paths: ['Holder.cs'] })).rejects.toThrow('controlled property stop');
      expect(originalQueries.getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('1');
      if (stop === 'entry') expect(cg.getPendingReferenceCount()).toBe(0);
      fault.mockRestore(); markAtDelete.mockRestore();
      if (stop !== 'after-invalidation') { cg.close(); cg = await CodeGraph.open(root); }
      const clear = vi.spyOn(cg['resolver'], 'clearCaches');
      const result = await cg.sync();
      expect(result.filesAdded + result.filesModified + result.filesRemoved).toBe(0);
      expect(clear).toHaveBeenCalled();
      expect(cg.getPendingReferenceCount()).toBe(0);
      expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('0');
      expect(propertyEdges(cg).filter(e => e.name === 'holder.State.Current').every(e => e.target === 'Demo::ITwo::Current')).toBe(true);
      await expectFresh(cg, files);
      await cg.sync();
      expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('0');
    } finally { fault!.mockRestore(); markAtDelete.mockRestore(); cg.close(); }
  }, 30_000);

  it('replays failed-only work when a completed drain could not clear its marker', async () => {
    const files = { 'Types.cs': types, 'Holder.cs': holder('IOne'), ...readers(1) };
    let { cg, root } = await create(files);
    try {
      const set = cg['queries'].setMetadata.bind(cg['queries']);
      const failClear = vi.spyOn(cg['queries'], 'setMetadata').mockImplementation((key, value) => {
        if (key === CSHARP_PROPERTY_REFRESH_PENDING && value === '0') throw new Error('controlled marker clear failure');
        set(key, value);
      });
      files['Holder.cs'] = holder('dynamic'); fs.writeFileSync(path.join(root, 'Holder.cs'), files['Holder.cs']);
      await expect(cg.sync({ paths: ['Holder.cs'] })).rejects.toThrow('controlled marker clear failure');
      expect(cg.getPendingReferenceCount()).toBe(0);
      expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('1');
      failClear.mockRestore(); cg.close(); cg = await CodeGraph.open(root);
      const failed = vi.spyOn(cg['queries'], 'reopenFailedCsharpPropertyPage');
      await cg.sync();
      expect(failed).toHaveBeenCalled();
      expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('0');
      expect(cg.getPendingReferenceCount()).toBe(0);
      await expectFresh(cg, files);
    } finally { cg.close(); }
  });

  it('marks extraction-only writes and consumes them on sync or successful existing-db full index', async () => {
    const files = { 'Types.cs': types, 'Holder.cs': holder('IOne'), ...readers(1) };
    const { cg, root } = await create(files);
    try {
      fs.writeFileSync(path.join(root, 'Holder.cs'), holder('ITwo'));
      await cg.indexFiles(['Holder.cs']);
      expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('1');
      const sync = await cg.sync();
      expect(sync.filesModified).toBe(0);
      expect(propertyEdges(cg).find(e => e.name === 'holder.State.Current')!.target).toBe('Demo::ITwo::Current');
      fs.writeFileSync(path.join(root, 'Holder.cs'), holder('IOne'));
      await cg.indexAll();
      expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('0');
      expect(propertyEdges(cg).find(e => e.name === 'holder.State.Current')!.target).toBe('Demo::IOne::Current');
    } finally { cg.close(); }
  });

  it('leaves a pre-existing obligation armed when full indexing is cancelled', async () => {
    const { cg, root } = await create({ 'Types.cs': types, 'Holder.cs': holder('IOne'), ...readers(1) });
    try {
      fs.writeFileSync(path.join(root, 'Holder.cs'), holder('ITwo'));
      await cg.indexFiles(['Holder.cs']);
      const driver = vi.spyOn(cg['orchestrator'], 'resurrectCsharpPropertyEdges');
      const result = await cg.indexAll({ signal: AbortSignal.abort() });
      expect(result.success).toBe(false);
      expect(driver).not.toHaveBeenCalled();
      expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('1');
      await cg.sync();
      expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('0');
      expect(propertyEdges(cg).find(e => e.name === 'holder.State.Current')!.target).toBe('Demo::ITwo::Current');
    } finally { cg.close(); }
  });

  for (const change of ['remove', 'reclassify'] as const) it(`retains old C# language evidence for mapped-extension ${change}`, async () => {
    const files: Record<string, string> = {
      'codegraph.json': JSON.stringify({ extensions: { '.csrc': 'csharp' } }),
      'Types.cs': 'namespace Demo; public interface IState { object Current { get; } }',
      'Shadow.csrc': 'namespace Client; public interface IState { object Current { get; } }',
      'Reader.cs': 'using Demo; namespace Client; public class Reader { public object Read(IState state) => state.Current; }',
    };
    const { cg, root } = await create(files);
    const remove = cg['queries'].deleteFile.bind(cg['queries']);
    vi.spyOn(cg['queries'], 'deleteFile').mockImplementation(file => {
      if (file === 'Shadow.csrc') expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('1');
      return remove(file);
    });
    try {
      expect(propertyEdges(cg)[0]!.target).toBe('Client::IState::Current');
      if (change === 'remove') { delete files['Shadow.csrc']; fs.unlinkSync(path.join(root, 'Shadow.csrc')); }
      else {
        files['codegraph.json'] = JSON.stringify({ extensions: { '.csrc': 'typescript' } });
        files['Shadow.csrc'] = 'export interface NotCSharp { Current: unknown }';
        fs.writeFileSync(path.join(root, 'codegraph.json'), files['codegraph.json']);
        fs.writeFileSync(path.join(root, 'Shadow.csrc'), files['Shadow.csrc']);
        clearProjectConfigCache();
      }
      const result = await cg.sync({ paths: ['Shadow.csrc'] });
      expect(result.csharpLookupChanged).toBe(true);
      expect(cg['queries'].getMetadata(CSHARP_PROPERTY_REFRESH_PENDING)).toBe('0');
      expect(propertyEdges(cg)[0]!.target).toBe('Demo::IState::Current');
      await expectFresh(cg, files);
    } finally { cg.close(); }
  });

  it('does not let the property-only phase admit unrelated pending kinds or languages', async () => {
    const { cg } = await create({ 'Types.cs': types, 'Holder.cs': holder('IOne'), ...readers(1) });
    try {
      const caller = cg.getNodesInFile('Reader0.cs').find(n => n.kind === 'method')!;
      const refs: UnresolvedReference[] = [
        { fromNodeId: caller.id, referenceName: 'holder.State.Current', referenceKind: 'property_ref', language: 'csharp', filePath: 'Reader0.cs', line: 2, column: 73 },
        { fromNodeId: caller.id, referenceName: 'Unknown', referenceKind: 'calls', language: 'csharp', filePath: 'Reader0.cs', line: 2, column: 0 },
        { fromNodeId: caller.id, referenceName: 'Unknown', referenceKind: 'references', language: 'csharp', filePath: 'Reader0.cs', line: 2, column: 1 },
        { fromNodeId: caller.id, referenceName: 'other.Current', referenceKind: 'property_ref', language: 'java', filePath: 'Reader0.cs', line: 2, column: 2 },
      ];
      cg['queries'].insertUnresolvedRefsBatch(refs);
      const persist = vi.spyOn(cg['resolver'], 'resolveAndPersistListYielding');
      await cg['refreshCsharpPropertyReferences']([], [], false);
      expect(persist.mock.calls.flatMap(([page]) => page).every(ref => ref.language === 'csharp' && ref.referenceKind === 'property_ref')).toBe(true);
      const pending = cg['queries'].getUnresolvedReferencesBatchAfter(0, 20);
      expect(pending.map(ref => [ref.referenceKind, ref.language]).sort()).toEqual([['calls', 'csharp'], ['property_ref', 'java'], ['references', 'csharp']].sort());
    } finally { cg.close(); }
  });

  it('fails before replacement if the durable marker cannot be written', async () => {
    const { cg, root } = await create({ 'Types.cs': types, 'Holder.cs': holder('IOne'), ...readers(1) });
    try {
      const hash = cg['queries'].getFileByPath('Holder.cs')!.contentHash;
      const set = cg['queries'].setMetadata.bind(cg['queries']);
      vi.spyOn(cg['queries'], 'setMetadata').mockImplementation((key, value) => {
        if (key === CSHARP_PROPERTY_REFRESH_PENDING && value === '1') throw new Error('controlled marker failure');
        set(key, value);
      });
      fs.writeFileSync(path.join(root, 'Holder.cs'), holder('ITwo'));
      await expect(cg.sync({ paths: ['Holder.cs'] })).rejects.toThrow('controlled marker failure');
      expect(cg['queries'].getFileByPath('Holder.cs')!.contentHash).toBe(hash);
    } finally { cg.close(); }
  });
});
