import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EDGE_KINDS } from '../src/types';
import { relationColor } from '../ui/src/lib/board-catalog';

const theme = readFileSync(new URL('../ui/src/lib/theme.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const palettes = [...theme.matchAll(/(?:^|\n)([^{}]+)\{([^{}]*--board-edge-contains[^{}]*)\}/g)].map((match) => ({
  selector: match[1].trim(),
  tokens: new Map([...match[2].matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/g)].map((token) => [token[1], token[2]])),
}));
function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe('Board relationship colors', () => {
  it('gives every exact engine relationship its own stable token, independent of filtering or ordering', () => {
    for (const kind of [...EDGE_KINDS].reverse()) expect(relationColor(kind)).toBe(`var(--board-edge-${kind}, var(--ink-3))`);
    expect(new Set(EDGE_KINDS.map(relationColor)).size).toBe(EDGE_KINDS.length);
  });

  it('keeps future and unsafe kind strings neutral instead of interpolating them into CSS', () => {
    for (const kind of ['future_relation', '', 'constructor', '__proto__', 'calls);stroke:red']) {
      expect(relationColor(kind)).toBe('var(--ink-3)');
    }
  });

  it('defines distinct, contrasting colors in default, OS-dark and explicit light/dark themes', () => {
    expect(palettes.map((palette) => palette.selector)).toEqual([
      ':root', ":root:not([data-theme='light'])", ":root[data-theme='dark'],\n[data-theme='dark']", "[data-theme='light']",
    ]);
    for (const { tokens } of palettes) {
      const colors = EDGE_KINDS.map((kind) => tokens.get(`--board-edge-${kind}`));
      expect(colors.every(Boolean)).toBe(true);
      expect(new Set(colors).size).toBe(EDGE_KINDS.length);
      const paper = luminance(tokens.get('--paper')!);
      for (const color of colors) {
        const ink = luminance(color!);
        expect((Math.max(ink, paper) + 0.05) / (Math.min(ink, paper) + 0.05)).toBeGreaterThanOrEqual(3);
      }
    }
    expect(palettes[0].tokens).toEqual(palettes[3].tokens);
    expect(palettes[1].tokens).toEqual(palettes[2].tokens);
  });
});
