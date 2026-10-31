import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('VB generic span-extension preservation', () => {
  it.each([
    { name: 'project parameter and local', types: 'Public Class Packet\nEnd Class', generic: 'T', parameters: 'ByVal value As T', calls: [
      'Public Function FromParameter(ByVal value As Packet) As Integer\nReturn value.AsSpan()\nEnd Function',
      'Public Function FromLocal() As Integer\nDim item As New Packet()\nReturn item.aSsPaN()\nEnd Function',
    ] },
    { name: 'constrained generic and optional parameter', types: 'Public Interface IView\nEnd Interface\nPublic Class Packet\nImplements IView\nEnd Class', generic: 'T As IView', parameters: 'ByVal value As T, Optional count As Integer = 0', calls: [
      'Public Function Omitted(ByVal value As Packet) As Integer\nReturn value.AsSpan()\nEnd Function',
      'Public Function Provided(ByVal value As Packet) As Integer\nReturn value.ASSPAN(3)\nEnd Function',
    ] },
    { name: 'built-in generic receiver controls', types: '', generic: 'T', parameters: 'ByVal value As T', calls: [
      'Public Function FromInteger(ByVal value As Integer) As Integer\nReturn value.AsSpan()\nEnd Function',
      'Public Function FromDate(ByVal value As Date) As Integer\nReturn value.AsSpan()\nEnd Function',
      'Public Function FromString(ByVal value As String) As Integer\nReturn value.AsSpan()\nEnd Function',
      'Public Function FromArray(ByVal value As Integer()) As Integer\nReturn value.AsSpan()\nEnd Function',
    ] },
  ])('preserves $name', async ({ types, generic, parameters, calls }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-span-preserve-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'Types.vb'), types);
    fs.writeFileSync(path.join(root, 'Extensions.vb'), `Imports System.Runtime.CompilerServices
Public Module GenericSpanExtensions
    <Extension()>
    Public Function AsSpan(Of ${generic})(${parameters}) As Integer
        Return 4
    End Function
End Module`);
    fs.writeFileSync(path.join(root, 'Consumer.vb'), `Public Class Consumer\n${calls.join('\n')}\nEnd Class`);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const targets = cg.getNodesInFile('Extensions.vb').filter((node) => node.kind === 'method' && node.name.toLowerCase() === 'asspan');
      expect(targets).toHaveLength(1);
      expect(targets[0]!.qualifiedName).toBe('GenericSpanExtensions::AsSpan');
      const methods = cg.getNodesInFile('Consumer.vb').filter((node) => node.kind === 'method');
      expect(methods).toHaveLength(calls.length);
      for (const method of methods) {
        const spanCalls = cg.getOutgoingEdges(method.id).filter((edge) => edge.kind === 'calls' && cg.getNode(edge.target)?.name.toLowerCase() === 'asspan');
        expect(spanCalls.map((edge) => edge.target), method.name).toEqual([targets[0]!.id]);
      }
    } finally {
      cg.close();
    }
  });
});
