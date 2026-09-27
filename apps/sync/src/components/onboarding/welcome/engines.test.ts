// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOrbitEngine, orbitGaps, type OrbitRefs } from './engines';

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
