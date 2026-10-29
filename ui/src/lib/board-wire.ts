import type { BoardEvidence, BoardSymbol } from './board-model';

export interface BoardSnapshot {
  symbols: BoardSymbol[]; relations: BoardEvidence[]; included: string[]; missing: string[];
  bounded: boolean; notes: string[]; nodeKinds: string[]; edgeKinds: string[];
}
export interface BoardSearchRequest { q?: string; kind?: string; path?: string; offset?: number; limit?: number }
export interface BoardSearch { items: BoardSymbol[]; total: number; nextOffset: number | null; bounded: boolean }
export interface BoardConnectionRequest {
  id: string; direction: 'incoming' | 'outgoing'; members: boolean; kind?: string; q?: string; offset?: number; limit?: number; target?: string;
}
export interface BoardConnections {
  scope: BoardSymbol; direction: string; withMembers: boolean; symbols: BoardSymbol[];
  items: Array<{ target: BoardSymbol; owner?: BoardSymbol; evidence: BoardEvidence[]; total: number }>;
  total: number; nextOffset: number | null; bounded: boolean; notes: string[];
}
export interface BoardEvidencePage { symbols: BoardSymbol[]; items: BoardEvidence[]; total: number; nextOffset: number | null; bounded: boolean; notes: string[] }
export interface BoardDocument {
  version: 1;
  symbols: Array<{ key: string; identity: { id?: string; qualifiedName: string; kind: string; file: string; signature?: string };
    position: { x: number; y: number }; included: boolean; hidden: boolean; expanded: boolean }>;
  cards: Array<{ key: string; symbolKey: string; position: { x: number; y: number }; width: number; height: number; collapsed: boolean; zIndex: number }>;
  viewport: { x: number; y: number; zoom: number }; filters: { kind: string; showStructure: boolean };
}
export interface BoardList {
  boards: Array<{ id: string; name: string; updatedAt: string }>; readOnly: boolean; readOnlyReason: string | null;
  directory: string; skipped: number; bounded: boolean;
}
export interface BoardLoaded {
  board: BoardDocument;
  resolutions: Array<{ key: string; status: 'ok' | 'moved' | 'missing' | 'ambiguous'; node: BoardSymbol | null; note: string | null }>;
  readOnly: boolean;
}
export interface BoardSaved { id: string; name: string; updatedAt: string }
export interface SaveBoardRequest { name: string; id?: string; document: BoardDocument }
