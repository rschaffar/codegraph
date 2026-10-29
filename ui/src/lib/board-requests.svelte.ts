/** Reader → Board handoff. Session memory only; the Board resolves and explicitly adds these IDs. */
import { boardHref, navigate } from './navigation';

let pending = $state<string[]>([]);

export const boardRequests = {
  get pending(): readonly string[] { return pending; },
  enqueue(ids: readonly string[]): void {
    pending = [...new Set([...pending, ...ids.filter((id) => id.length > 0)])];
  },
  take(): string[] {
    const ids = [...pending];
    pending = [];
    return ids;
  },
};

/** Navigation uses the host's driver; neither source nor board metadata is written here. */
export function addToBoard(ids: readonly string[]): void {
  boardRequests.enqueue(ids);
  navigate(boardHref());
}
