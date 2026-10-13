import { describe, expect, it } from 'vitest';
import { flowerTreesLayout, type KeepOutBox } from './engines';

const W = 1280;
const H = 820;
const CONTENT: KeepOutBox = { left: 440, top: 212, right: 840, bottom: 608 };

describe('company step flowering trees', () => {
  const trees = flowerTreesLayout(W, H, CONTENT);
  const blooms = trees.cells.filter((cell) => cell.kind === 'bloom');

  it('puts the pink cherry in the top-left corner and the coral tree in the bottom-right', () => {
    const pink = blooms.filter((cell) => cell.tree === 'pink');
    const coral = blooms.filter((cell) => cell.tree === 'coral');
    expect(pink.length).toBeGreaterThan(150);
    expect(coral.length).toBeGreaterThan(150);
    expect(pink.every((cell) => cell.x < W * 0.45 && cell.y < H * 0.55)).toBe(true);
    expect(coral.every((cell) => cell.x > W * 0.55 && cell.y > H * 0.3)).toBe(true);
  });

  it('never draws over the content', () => {
    const inside = trees.cells.filter(
      (cell) => cell.x > CONTENT.left && cell.x < CONTENT.right && cell.y > CONTENT.top && cell.y < CONTENT.bottom,
    );
    expect(inside).toEqual([]);
  });

  it('stays inside the window', () => {
    expect(trees.cells.every((cell) => cell.x >= 0 && cell.x <= W + 3 && cell.y >= 0 && cell.y <= H + 4)).toBe(true);
  });

  it("draws in the skyline's characters, with ':' only on the lit side and H/Q as an accent", () => {
    const allowed = new Set(['.', ',', '/', ':', '#', 'H', 'Q', '*', '|', '\\', '-']);
    expect(trees.cells.every((cell) => allowed.has(cell.ch))).toBe(true);
    const hq = blooms.filter((cell) => cell.ch === 'H' || cell.ch === 'Q').length;
    const dense = blooms.filter((cell) => '#HQ*'.includes(cell.ch)).length;
    expect(hq).toBeGreaterThan(0);
    expect(hq / dense).toBeLessThan(0.25);
  });

  it('keeps every character at or under the skyline brightness', () => {
    expect(Math.max(...trees.cells.map((cell) => cell.a))).toBeLessThanOrEqual(0.6 + 1e-9);
  });

  it('lets a few petals fall', () => {
    expect(trees.petals).toHaveLength(12);
  });

  it('is the same every time for the same window and content', () => {
    expect(flowerTreesLayout(W, H, CONTENT).cells.length).toBe(trees.cells.length);
  });
});
