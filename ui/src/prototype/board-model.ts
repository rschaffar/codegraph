import { demoCalls, demoComponents, type DemoCall, type DemoComponent } from './demo-data';

export type ComponentAction = 'promote' | 'hide' | 'expand' | 'code';
export type ActOnComponent = (action: ComponentAction, id: string, method?: string) => void;

export interface ComponentData extends Record<string, unknown> {
  component: DemoComponent;
  role: 'focus' | 'context';
  expanded: boolean;
  hiddenConnections: number;
  act: ActOnComponent;
}

export interface CodeCardData extends Record<string, unknown> {
  componentId: string;
  method: string;
  collapsed: boolean;
  close: (id: string) => void;
  toggle: (id: string) => void;
  read: (id: string) => void;
}

export interface BoardCall {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  calls: DemoCall[];
  via: boolean;
}

/** One-hop context only; hidden choices and focus membership are independent. */
export function projectBoard(
  focus: readonly string[],
  hidden: readonly string[],
  expanded: readonly string[],
  includeContext = true
): {
  components: Array<{ component: DemoComponent; role: 'focus' | 'context'; hiddenConnections: number }>;
  edges: BoardCall[];
} {
  const focused = new Set(focus.filter((id) => !hidden.includes(id)));
  const visible = new Set(focused);
  if (includeContext) {
    for (const call of demoCalls) {
      if (focused.has(call.source)) visible.add(call.target);
      if (focused.has(call.target)) visible.add(call.source);
    }
  }
  for (const id of hidden) visible.delete(id);

  const grouped = new Map<string, BoardCall>();
  for (const call of demoCalls) {
    if (!visible.has(call.source) || !visible.has(call.target)) continue;
    // Context does not recursively turn into another full graph.
    if (!focused.has(call.source) && !focused.has(call.target)) continue;
    const sourceHandle = expanded.includes(call.source) ? `out-${call.sourceMethod}` : 'out';
    const targetHandle = expanded.includes(call.target) ? `in-${call.targetMethod}` : 'in';
    const id = `${call.source}:${sourceHandle}>${call.target}:${targetHandle}`;
    const edge = grouped.get(id) ?? {
      id, source: call.source, target: call.target, sourceHandle, targetHandle, calls: [], via: false,
    };
    edge.calls.push(call);
    edge.via ||= !!call.via;
    grouped.set(id, edge);
  }

  return {
    components: demoComponents.filter((item) => visible.has(item.id)).map((item) => ({
      component: item,
      role: focused.has(item.id) ? 'focus' : 'context',
      hiddenConnections: demoCalls.filter((call) =>
        (call.source === item.id || call.target === item.id) &&
        !(visible.has(call.source) && visible.has(call.target) &&
          (focused.has(call.source) || focused.has(call.target)))
      ).length,
    })),
    edges: [...grouped.values()],
  };
}

/** Reuse a free reading slot, respecting cards the reviewer moved or resized. */
export function nextCodePosition(cards: readonly { position: { x: number; y: number }; width?: number; height?: number }[]): { x: number; y: number } {
  const bottom = Math.max(820, ...cards.map((card) => card.position.y + (card.height ?? 310))) + 60;
  for (let y = 820; y <= bottom; y += 370) {
    for (const x of [30, 600]) {
      const overlaps = cards.some((card) => x < card.position.x + (card.width ?? 530) + 20 &&
        x + 550 > card.position.x && y < card.position.y + (card.height ?? 310) + 20 && y + 330 > card.position.y);
      if (!overlaps) return { x, y };
    }
  }
  return { x: 30, y: bottom };
}

export function filterComponents(query: string, folder: string): DemoComponent[] {
  const needle = query.trim().toLowerCase();
  return demoComponents.filter((item) =>
    (!folder || item.folder === folder) &&
    (!needle || `${item.name} ${item.folder} ${item.purpose}`.toLowerCase().includes(needle))
  );
}
