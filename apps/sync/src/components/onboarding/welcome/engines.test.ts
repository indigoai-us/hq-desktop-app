// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFolderEngine,
  createOrbitEngine,
  createReadyEngine,
  orbitGaps,
  skylineBand,
  skylineGround,
  type FolderRefs,
  type OrbitRefs,
} from './engines';

describe('orbitGaps', () => {
  it("keeps the prototype's gaps when the orbit fits", () => {
    expect(orbitGaps(600, 300)).toEqual({ gap1: 40, gap2: 44, navGap: 44 });
  });

  it('shrinks the gaps together, down to a floor, when the window is short', () => {
    expect(orbitGaps(300, 290)).toEqual({ gap1: 20, gap2: 24, navGap: 24 });
    const partial = orbitGaps(128 + 200 - 30, 200);
    expect(partial.gap1).toBeLessThan(40);
    expect(partial.gap1).toBeGreaterThan(20);
    expect(partial.gap1 + partial.gap2 + partial.navGap).toBe(98);
  });
});

/** Stub a box's size; happy-dom has no layout. */
function sized<T extends Element>(el: T, width: number, height: number): T {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return el;
}

function orbitRefs(): OrbitRefs {
  const svgNs = 'http://www.w3.org/2000/svg';
  const chip = () => sized(document.createElement('div'), 60, 28);
  return {
    rings: document.createElementNS(svgNs, 'svg'),
    ellipses: [document.createElementNS(svgNs, 'ellipse'), document.createElementNS(svgNs, 'ellipse')],
    core: document.createElementNS(svgNs, 'svg'),
    corelabel: sized(document.createElement('div'), 100, 14),
    // one-line headline + body at 1024 wide
    copy: sized(document.createElement('div'), 880, 98),
    // one-line cards, as the prototype renders them
    rail: sized(document.createElement('ul'), 983, 95),
    railRows: Array.from({ length: 5 }, () => sized(document.createElement('li'), 188, 95)),
    innerChips: [chip(), chip(), chip()],
    outerChips: [chip(), chip(), chip(), chip(), chip()],
    nav: document.createElement('div'),
  };
}

describe('createOrbitEngine layout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives the orbit room to clear the mark and its caption in a short, wide window (1024x686)', () => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 686);
    const refs = orbitRefs();
    createOrbitEngine(refs, { reveal: () => {} }).size();

    const innerRy = Number(refs.ellipses[0].getAttribute('ry'));
    const outerRy = Number(refs.ellipses[1].getAttribute('ry'));
    // The mark is at its 72px floor; its caption ends coreH/2 + 26 below the
    // centre. A front chip on the inner track (half-height ~14 at full scale)
    // must pass below it, and the two tracks must sit a chip apart.
    const coreH = (72 * 161) / 280;
    expect(innerRy - 14).toBeGreaterThan(coreH / 2 + 26);
    expect(outerRy - innerRy).toBeGreaterThan(28);

    // Nothing runs past the window: the rail stays inside it and Next sits
    // above the bottom controls.
    expect(parseFloat(refs.rail.style.width)).toBeLessThanOrEqual(1024 * 0.96);
    expect(parseFloat(refs.nav!.style.top) + 44).toBeLessThanOrEqual(686 - 64);
  });

  it("keeps the prototype's layout in a tall window (820x910)", () => {
    vi.stubGlobal('innerWidth', 820);
    vi.stubGlobal('innerHeight', 910);
    const refs = orbitRefs();
    // the headline wraps to two lines at this width
    sized(refs.copy, 754, 170);
    createOrbitEngine(refs, { reveal: () => {} }).size();
    // The prototype's own sizing, with its 40/44/44 gaps: the outer track
    // takes the room left under the title (bottom - title - 40 - rail - 44 -
    // 44 - Next) less a chip's half-height.
    const outerRy = Number(refs.ellipses[1].getAttribute('ry'));
    const room = 910 - 64 - (Math.round(910 * 0.13) + 170 + 40) - 95 - 44 - 44 - 44;
    expect(outerRy).toBeCloseTo(room / 2 - 12, 0);
    const cy = Number(refs.ellipses[1].getAttribute('cy'));
    const railTop = parseFloat(refs.rail.style.top);
    expect(Math.abs(railTop - (cy + outerRy + 12) - 44)).toBeLessThanOrEqual(1);
    expect(parseFloat(refs.nav!.style.top) - (railTop + 95)).toBe(44);
  });
});

describe('skyline band', () => {
  it('keeps the bottom row of characters inside the window', () => {
    for (const H of [600, 686, 720, 875, 910]) {
      const ground = skylineGround(H);
      // row 0 is drawn centred in cell (ground - 1)
      expect((ground - 1) * 11 + 11 / 2).toBeLessThanOrEqual(H);
    }
    // 686 is 62.4 cells: the prototype's ceil() put row 0 at 687.5px
    expect(skylineGround(686)).toBe(62);
    // a tall window keeps the prototype's ground row
    expect(skylineGround(910)).toBe(Math.ceil(910 / 11));
  });

  it('reserves 60% of the tallest tower plus the gap above it', () => {
    expect(skylineBand(686)).toBe(Math.ceil(18 * 0.6) * 11 + 28);
    expect(skylineBand(910)).toBe(Math.ceil(24 * 0.6) * 11 + 28);
  });
});

/** The folder tree's height responds to --fold-k as welcome.css makes it. */
function folderRefs(looseTreeH: number, savedAtFull: number): FolderRefs {
  const tree = document.createElement('div');
  tree.getBoundingClientRect = () => {
    const k = Number(tree.style.getPropertyValue('--fold-k') || 0);
    const height = looseTreeH - savedAtFull * k;
    return { left: 202, top: 0, right: 822, bottom: height, width: 620, height, x: 202, y: 0, toJSON() {} } as DOMRect;
  };
  const canvas = document.createElement('canvas');
  canvas.getContext = (() => null) as never;
  return {
    canvas,
    copy: sized(document.createElement('div'), 880, 78),
    tree,
    root: document.createElement('div'),
    rows: [document.createElement('div')],
    loc: document.createElement('div'),
    folder: document.createElement('div'),
    nav: document.createElement('div'),
  };
}

describe('createFolderEngine layout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('closes up its spacing in a short window so the skyline keeps its band (1024x686)', () => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 686);
    // measured tree heights at 1024 wide: 332px as designed, 276px tightest
    const refs = folderRefs(332, 56);
    createFolderEngine(refs, { reveal: () => {} }).size();
    expect(Number(refs.tree.style.getPropertyValue('--fold-k'))).toBeGreaterThan(0);
    const treeTop = parseFloat(refs.tree.style.top);
    const navTop = parseFloat(refs.nav!.style.top);
    expect(navTop).toBeGreaterThan(treeTop + refs.tree.getBoundingClientRect().height);
    // Install here ends above the band kept for the skyline
    expect(navTop + 44).toBeLessThanOrEqual(686 - skylineBand(686));
  });

  it("keeps the prototype's spacing in a tall window (820x910)", () => {
    vi.stubGlobal('innerWidth', 820);
    vi.stubGlobal('innerHeight', 910);
    const refs = folderRefs(332, 56);
    createFolderEngine(refs, { reveal: () => {} }).size();
    expect(Number(refs.tree.style.getPropertyValue('--fold-k'))).toBe(0);
    const treeTop = parseFloat(refs.tree.style.top);
    // copy -> tree 34 (plus up to 30 of drift), tree -> Install here 44
    expect(treeTop).toBeGreaterThanOrEqual(Math.round(910 * 0.13) + 78 + 34);
    expect(parseFloat(refs.nav!.style.top)).toBe(treeTop + 332 + 44);
  });
});

describe('createReadyEngine layout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the whole stack above the skyline band in a short window', () => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 560);
    const canvas = document.createElement('canvas');
    canvas.getContext = (() => null) as never;
    const refs = {
      canvas,
      copy: sized(document.createElement('div'), 880, 132),
      prog: sized(document.createElement('div'), 300, 34),
      nav: document.createElement('div'),
      alt: sized(document.createElement('p'), 360, 18),
    };
    createReadyEngine(refs, { reveal: () => {} }).size();
    const altTop = parseFloat(refs.alt.style.top);
    expect(altTop + 18).toBeLessThanOrEqual(560 - skylineBand(560));
    expect(parseFloat(refs.copy.style.top)).toBeGreaterThanOrEqual(56);
  });
});
