// The intro art must keep its own proportions at every window size.
//
// Reported on the full-screen film (PR #927): "the full page intro worked! but
// i noticed the folder is still a litle stretched horizontally." The folder was
// drawn 224 x 144 in its viewBox — half again wider than tall — so it read as a
// folder someone had dragged out sideways. Two smaller faults sat next to it:
// the reduced-motion end state handed the folder box `height: 158px` inside a
// shared rule, squashing it vertically, and the wire's round end nodes lived in
// a `preserveAspectRatio="none"` svg, where a circle renders as an ellipse.
//
// A source contract, because there is no other cheap place to pin geometry: the
// film only ever plays on a real screen.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/components/onboarding/CinematicIntro.svelte'),
  'utf8',
);

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bounding box of an SVG path made of move/line/axis/arc/close commands — every
 * command the folder uses. Arcs contribute their endpoint, which is exact here
 * because every arc in the folder is a corner radius inside the box its
 * neighbours already define.
 */
function pathBounds(d: string): Box {
  const tokens = d.match(/[MmLlHhVvAaZz]|-?\d*\.?\d+/g) ?? [];
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let x = 0;
  let y = 0;
  let command = '';
  let i = 0;

  const mark = () => {
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  };
  const next = () => Number(tokens[i++]);

  while (i < tokens.length) {
    const token = tokens[i];
    if (/[MmLlHhVvAaZz]/.test(token)) {
      command = token;
      i += 1;
      if (command === 'Z' || command === 'z') continue;
    }
    switch (command) {
      case 'M':
      case 'L':
        x = next();
        y = next();
        break;
      case 'm':
      case 'l':
        x += next();
        y += next();
        break;
      case 'H':
        x = next();
        break;
      case 'h':
        x += next();
        break;
      case 'V':
        y = next();
        break;
      case 'v':
        y += next();
        break;
      case 'A':
        i += 5;
        x = next();
        y = next();
        break;
      case 'a':
        i += 5;
        x += next();
        y += next();
        break;
      default:
        throw new Error(`unsupported path command: ${command}`);
    }
    mark();
  }
  return box;
}

function folderSvg(): string {
  const start = source.indexOf('<svg class="folder"');
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('</svg>', start));
}

function folderPaths(): string[] {
  return [...folderSvg().matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
}

function unionBounds(boxes: Box[]): Box {
  return boxes.reduce((acc, box) => ({
    minX: Math.min(acc.minX, box.minX),
    minY: Math.min(acc.minY, box.minY),
    maxX: Math.max(acc.maxX, box.maxX),
    maxY: Math.max(acc.maxY, box.maxY),
  }));
}

describe('intro art keeps its proportions', () => {
  it('draws the folder folder-shaped, not stretched sideways', () => {
    const boxes = folderPaths().map(pathBounds);
    const art = unionBounds(boxes);
    const aspect = (art.maxX - art.minX) / (art.maxY - art.minY);
    // A folder icon is a touch wider than tall. Anything past ~1.3 reads as a
    // folder that has been pulled horizontally, which is the reported defect.
    expect(aspect).toBeGreaterThan(1.02);
    expect(aspect).toBeLessThan(1.3);
  });

  it('keeps the folder front pocket from going letterbox-wide', () => {
    // The front pocket is the largest single shape, so its proportions carry
    // most of the read. The old one was 224 x 100 (2.24:1).
    const front = folderPaths()
      .map(pathBounds)
      .reduce((widest, box) =>
        box.maxX - box.minX > widest.maxX - widest.minX ? box : widest,
      );
    expect((front.maxX - front.minX) / (front.maxY - front.minY)).toBeLessThan(1.8);
  });

  it('letterboxes the folder rather than filling its box', () => {
    expect(folderSvg()).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(source).toContain('object-fit: contain;');
  });

  it('gives the folder a CSS box with the same aspect as its viewBox', () => {
    const viewBox = folderSvg().match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(viewBox).not.toBeNull();
    const [, vw, vh] = viewBox as RegExpMatchArray;
    // The box is declared as `width` + `aspect-ratio`, so height can never
    // drift away from the art.
    expect(source).toContain(`width: ${vw}px;`);
    expect(source).toContain(`aspect-ratio: ${vw} / ${vh};`);
  });

  it('never puts round geometry inside a stretched svg', () => {
    for (const svg of source.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
      expect(svg).toContain('viewBox=');
      if (!svg.includes('preserveAspectRatio="none"')) continue;
      // A stretched box leaves H and V segments straight and, with a
      // non-scaling stroke, the same weight. Circles and arcs are not so lucky.
      expect(svg).not.toContain('<circle');
      expect(svg).not.toContain('<ellipse');
      expect(svg).not.toMatch(/\sd="[^"]*[AaCcQqSsTt][^"]*"/);
    }
  });

  it('holds the folder box square-on when motion is reduced', () => {
    // The reduced-motion end state used to be one shared rule that gave every
    // selector `height: 158px` — including the folder box.
    const still = source.slice(source.indexOf('.beat.still .fmove,'));
    const shared = still.slice(0, still.indexOf('}') + 1);
    expect(shared).not.toContain('height:');
    expect(source).toContain('.beat.still .tspine { height: 158px; }');
  });
});
