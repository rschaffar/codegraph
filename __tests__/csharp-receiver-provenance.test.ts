import { describe, expect, it } from 'vitest';
import { clearNameMatcherMemos, inferLocalReceiverType } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

describe('C# receiver declaration provenance with shared inference patterns', () => {
  it('keeps source columns through cold, cached, extended and backward scans', () => {
    const lines = [
      '    Left.Payload<int> value = default;',
      '    value.AsSpan();',
      '        Right.Other<string> value = default;',
      '        value.AsSpan();',
    ];
    const context = {
      getNodesInFile: () => [],
      getFileLines: () => lines,
      readFile: () => lines.join('\n'),
    } as unknown as ResolutionContext;
    const ref = (line: number): UnresolvedRef => ({
      fromNodeId: 'caller', referenceName: 'value.AsSpan', referenceKind: 'calls',
      filePath: 'Consumer.cs', language: 'csharp', line, column: 0,
    });
    type Declaration = NonNullable<Parameters<typeof inferLocalReceiverType>[3]>;
    const early = { raw: 'Left.Payload', line: 1, column: 4 };
    const late = { raw: 'Right.Other', line: 3, column: 8 };

    // A caller not requesting provenance must not poison the shared memo for
    // the span resolver, which needs the actual declaration's source column.
    expect(inferLocalReceiverType('value', ref(2), context)).toBe('Payload');
    const cached: Declaration = {};
    expect(inferLocalReceiverType('value', ref(2), context, cached)).toBe('Payload');
    expect(cached).toEqual(early);

    const extended: Declaration = {};
    expect(inferLocalReceiverType('value', ref(4), context, extended)).toBe('Other');
    expect(extended).toEqual(late);
    const backward: Declaration = {};
    expect(inferLocalReceiverType('value', ref(2), context, backward)).toBe('Payload');
    expect(backward).toEqual(early);
    const latest: Declaration = {};
    expect(inferLocalReceiverType('value', ref(4), context, latest)).toBe('Other');
    expect(latest).toEqual(late);

    clearNameMatcherMemos(context);
    const cold: Declaration = {};
    expect(inferLocalReceiverType('value', ref(2), context, cold)).toBe('Payload');
    expect(cold).toEqual(early);
  });

  it('records the selected constructor match rather than the synthetic prefix', () => {
    const line = '    var value = new Left.Payload<int>();';
    const context = {
      getNodesInFile: () => [], getFileLines: () => [line], readFile: () => line,
    } as unknown as ResolutionContext;
    const declaration: NonNullable<Parameters<typeof inferLocalReceiverType>[3]> = {};
    expect(inferLocalReceiverType('value', {
      fromNodeId: 'caller', referenceName: 'value.AsSpan', referenceKind: 'calls',
      filePath: 'Consumer.cs', language: 'csharp', line: 1, column: 0,
    }, context, declaration)).toBe('Payload');
    expect(declaration).toEqual({ raw: 'Left.Payload', line: 1, column: line.indexOf('value') });
  });
});
