import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { parseBoardDocument, MAX_BOARD_COMMENTS, MAX_BOARD_COMMENT_TEXT } from '../src/ui-server/api/board-store';
import { BOARD_COMMENT_LIMIT, BOARD_COMMENT_TEXT_LIMIT } from '../ui/src/lib/board-comments';

const root = path.resolve(__dirname, '../skills/codegraph');
const main = readFileSync(path.join(root, 'SKILL.md'), 'utf8');
const boards = readFileSync(path.join(root, 'references/boards.md'), 'utf8');

describe('exported CodeGraph agent skill', () => {
  it('retains its portable name, description and bundled board reference', () => {
    const metadata = main.match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/)!;
    expect(metadata).not.toBeNull(); expect(metadata[1]).toBe('codegraph');
    expect(metadata[2].length).toBeLessThanOrEqual(1024);
    expect(metadata[2]).toContain('plain-text comment cards');
    expect(main).toContain('[Review Board authoring](references/boards.md)');
    expect(main.split('\n').length).toBeLessThan(500);
  });
  it('validates every illustrative board JSON example against the actual strict parser', () => {
    const examples = [...boards.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
    expect(examples).toHaveLength(2);
    for (const example of examples) expect(parseBoardDocument(example)).toEqual(example);
    const notes = examples.find((example) => example.comments)!;
    expect(notes.symbols).toEqual([]); expect(notes.cards).toEqual([]);
    expect(notes.comments[0].text).toContain('\n');
  });
  it('documents current comment bounds and keeps UI and server limits aligned', () => {
    expect(BOARD_COMMENT_LIMIT).toBe(MAX_BOARD_COMMENTS);
    expect(BOARD_COMMENT_TEXT_LIMIT).toBe(MAX_BOARD_COMMENT_TEXT);
    expect(boards).toContain(`${MAX_BOARD_COMMENTS} comment cards`);
    expect(boards).toContain('16,384 characters per comment');
    expect(boards).toContain('Width is 240–4096, height 160–4096');
  });
});
