import type { BoardEvidence, BoardSymbol } from './board-model';

export interface BoardFilters { tests?: boolean; generated?: boolean; uncertain?: boolean }
export interface BoardExcludedCounts { tests: number; generated: number; uncertain: number }
export interface BoardExclusions { symbols: BoardExcludedCounts; relations: BoardExcludedCounts }
export interface BoardSnapshot {
  symbols: BoardSymbol[]; relations: BoardEvidence[]; included: string[]; missing: string[]; scopeIds?: string[];
  bounded: boolean; notes: string[]; nodeKinds: string[]; edgeKinds: string[]; excluded?: BoardExclusions;
}
export interface BoardSourceContext {
  symbol: BoardSymbol; symbols: BoardSymbol[]; containers: BoardSymbol[]; bounded: boolean; notes: string[];
}
export interface BoardSearchRequest extends BoardFilters { q?: string; kind?: string; path?: string; namespace?: string; offset?: number; limit?: number }
export interface BoardGroupRequest extends BoardFilters { type: 'folder' | 'namespace'; q?: string; offset?: number; limit?: number }
export interface BoardGroups { items: Array<{ id: string; name: string; type: 'folder' | 'namespace'; path?: string; namespace?: string; total: number; byKind: Array<{ kind: string; count: number }> }>; total: number; nextOffset: number | null; bounded: boolean; notes: string[]; excluded?: BoardExclusions }
export interface BoardMembers { symbols: BoardSymbol[]; items: BoardSymbol[]; total: number; nextOffset: number | null; bounded: boolean; notes: string[]; excluded?: BoardExclusions }
export interface BoardMemberRequest extends BoardFilters { id: string; offset?: number; limit?: number }
export interface BoardSiblingSourcesRequest extends BoardFilters { id: string; offset?: number; limit?: number }
/** Source discovery only: excludes origin; symbols may include identity ancestors, not extra matches. */
export interface BoardSiblingSources extends BoardSearch {
  scope: { kind: 'type' | 'file' | 'unavailable'; id?: string; label: string };
}
export interface BoardSearch { items: BoardSymbol[]; symbols?: BoardSymbol[]; total: number; nextOffset: number | null; bounded: boolean; notes?: string[]; excluded?: BoardExclusions }
export interface BoardConnectionRequest extends BoardFilters {
  id: string; direction: 'incoming' | 'outgoing'; members: boolean; kind?: string; q?: string; offset?: number; limit?: number; target?: string;
}
export interface BoardConnections {
  scope: BoardSymbol; direction: string; withMembers: boolean; symbols: BoardSymbol[];
  items: Array<{ target: BoardSymbol; owner?: BoardSymbol; evidence: BoardEvidence[]; total: number }>;
  total: number; nextOffset: number | null; bounded: boolean; notes: string[]; excluded?: BoardExclusions;
}
export interface BoardEvidencePage { symbols: BoardSymbol[]; items: BoardEvidence[]; total: number; nextOffset: number | null; bounded: boolean; notes: string[]; excluded?: BoardExclusions }
export interface BoardComment {
  key: string; text: string; position: { x: number; y: number }; width: number; height: number; zIndex: number;
}
export interface BoardDocument {
  version: 1;
  symbols: Array<{ key: string; identity: { id?: string; qualifiedName: string; kind: string; file: string; signature?: string };
    position: { x: number; y: number }; included: boolean; hidden: boolean; expanded: boolean; memberLimit?: number }>;
  cards: Array<{ key: string; symbolKey: string; position: { x: number; y: number }; width: number; height: number; collapsed: boolean; zIndex: number }>;
  /** Optional for legacy V1 documents. Plain reviewer text, not indexed source. */
  comments?: BoardComment[];
  viewport: { x: number; y: number; zoom: number }; filters: { kind: string; showStructure: boolean; includeTests?: boolean; includeGenerated?: boolean; includeUncertain?: boolean };
}
export interface BoardList {
  boards: Array<{ id: string; name: string; updatedAt: string }>; readOnly: boolean; readOnlyReason: string | null;
  directory: string; skipped: number; bounded: boolean;
}
export interface BoardLoaded {
  board: BoardDocument;
  symbols?: BoardSymbol[]; notes?: string[];
  resolutions: Array<{ key: string; status: 'ok' | 'moved' | 'missing' | 'ambiguous'; node: BoardSymbol | null; note: string | null }>;
  readOnly: boolean;
}
export interface BoardSaved { id: string; name: string; updatedAt: string }
export interface SaveBoardRequest { name: string; id?: string; document: BoardDocument }
