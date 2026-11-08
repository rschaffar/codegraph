/** Reviewer-owned annotations, deliberately separate from indexed identities. */
export const BOARD_COMMENT_LIMIT = 64;
export const BOARD_COMMENT_TEXT_LIMIT = 16_384;
export interface CommentCardData extends Record<string, unknown> {
  text: string;
  edit: (id: string, text: string) => void;
  close: (id: string) => void;
  resize: (id: string, widthDelta: number, heightDelta: number) => void;
}
