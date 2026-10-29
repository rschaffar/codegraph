// Fixture adapter over the same pure presentation model the live board uses.
import { demoRelations, demoSymbols } from './demo-data';
import { createBoardModel } from '../lib/board-model';
export * from '../lib/board-model';
export const { symbol, children, scopeIds, representative, targetState, includeSymbols,
  browseConnections, projectBoard, filterSymbols, memberOf } = createBoardModel(demoSymbols, demoRelations);
