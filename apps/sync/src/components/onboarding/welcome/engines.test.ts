// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createConsentEngine,
  createFolderEngine,
  createKeyboardEngine,
  createMarkEngine,
  createOrbitEngine,
  createPanelEngine,
  createReadyEngine,
  orbitGaps,
  skylineBand,
  skylineGround,
  type ConsentRefs,
  type FolderRefs,
  type KeyboardRefs,
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

// Owner run 2026-10-16: the intro started from the top-left corner. The
// engine was built while the window was still at heads-up card size (440x380)
// and its particles kept start points drawn across that box.
describe('createMarkEngine start points', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function markRun(resizeTo: { width: number; height: number }) {
    vi.stubGlobal('innerWidth', 440);
    vi.stubGlobal('innerHeight', 380);
    const canvas = document.createElement('canvas');
    const dots: Array<{ x: number; y: number }> = [];
    const ctx = {
      setTransform() {},
      clearRect() {},
      beginPath() {},
      fill() {},
      arc(x: number, y: number) {
        dots.push({ x, y });
      },
      fillStyle: '',
      globalAlpha: 1,
    };
    canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
    const engine = createMarkEngine(
      {
        canvas,
        cap: sized(document.createElement('div'), 600, 80),
        signin: sized(document.createElement('div'), 400, 48),
        nav: null,
      },
      { replay: false, onSettle: () => {} },
    );
    vi.stubGlobal('innerWidth', resizeTo.width);
    vi.stubGlobal('innerHeight', resizeTo.height);
    engine.size();
    return { engine, dots };
  }

  it('spreads the field across the window when it grows before the mark settles', () => {
    const { engine, dots } = markRun({ width: 1440, height: 900 });
    engine.enter(0);
    // 2.5s in: the field is visible and no particle has started its pull yet.
    engine.frame(2500);
    expect(dots.length).toBe(3400);
    // Each particle drifts at most 40px across and 30px down from its start.
    expect(Math.max(...dots.map((d) => d.x))).toBeGreaterThan(1200);
    expect(Math.max(...dots.map((d) => d.y))).toBeGreaterThan(750);
    expect(dots.filter((d) => d.x > 480 || d.y > 410).length).toBeGreaterThan(3400 * 0.7);
  });

  it('flies in from across the new window when entered again after a resize once settled', () => {
    const { engine, dots } = markRun({ width: 440, height: 380 });
    engine.enter(0);
    engine.frame(6100);
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 900);
    engine.size();
    dots.length = 0;
    // Back from the folder screen plays the welcome again.
    engine.enter(0);
    engine.frame(2500);
    expect(Math.max(...dots.map((d) => d.x))).toBeGreaterThan(1200);
  });
});

describe('createPanelEngine', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('centres the panel again when its content grows after it is shown', () => {
    vi.stubGlobal('innerHeight', 686);
    const observers: Array<{ callback: () => void; disconnected: boolean }> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        entry: { callback: () => void; disconnected: boolean };
        constructor(callback: () => void) {
          this.entry = { callback, disconnected: false };
          observers.push(this.entry);
        }
        observe() {}
        disconnect() {
          this.entry.disconnected = true;
        }
      },
    );
    const block = sized(document.createElement('div'), 560, 80);
    const engine = createPanelEngine(block, { reveal: () => {} });
    engine.enter(0);
    // The short "Getting things ready…" block sits in the middle.
    expect(block.style.top).toBe(`${Math.round((686 - 80) / 2)}px`);

    // The form arrives: the block is now 470px tall.
    sized(block, 560, 470);
    observers[0]!.callback();
    expect(block.style.top).toBe(`${Math.round((686 - 470) / 2)}px`);
    // Never above the title bar band, even when taller than the window.
    sized(block, 560, 900);
    observers[0]!.callback();
    expect(block.style.top).toBe('56px');

    // A panel that is no longer on show is left alone.
    engine.exit?.();
    sized(block, 560, 100);
    observers[0]!.callback();
    expect(block.style.top).toBe('56px');

    engine.destroy?.();
    expect(observers[0]!.disconnected).toBe(true);
  });
});

// Design review (2026-10-12): the folder, cloud, shortcut and consent screens
// move their whole block (title, content, button) down so it sits in the
// middle of the window, but never so far that its bottom passes the room kept
// for the skyline (folder) or for Back and the install card (FLOOR, 64px).
describe('screens centre their block vertically', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const NAVH = 44;
  const FLOOR = 64;

  /** The block is the title's top to the forward button's bottom. */
  function block(copy: HTMLElement, nav: HTMLElement | null): { top: number; bottom: number } {
    const top = parseFloat(copy.style.top);
    const bottom = parseFloat(nav!.style.top) + NAVH;
    expect(Number.isFinite(top)).toBe(true);
    expect(Number.isFinite(bottom)).toBe(true);
    return { top, bottom };
  }

  function keyboardRefs(): KeyboardRefs {
    return {
      kb: sized(document.createElement('div'), 660, 230),
      keys: new Map(),
      glow: document.createElement('div'),
      line: sized(document.createElement('p'), 360, 22),
      copy: sized(document.createElement('div'), 880, 98),
      nav: document.createElement('div'),
    };
  }

  function consentRefs(): ConsentRefs {
    return {
      copy: sized(document.createElement('div'), 880, 98),
      form: sized(document.createElement('div'), 480, 180),
      choices: [document.createElement('label'), document.createElement('label')],
      fine: document.createElement('p'),
      nav: document.createElement('div'),
    };
  }

  type Case = {
    name: string;
    run: () => { copy: HTMLElement; nav: HTMLElement | null };
    limit: (H: number) => number;
  };

  const cases: Case[] = [
    {
      name: 'folder',
      run: () => {
        const refs = folderRefs(332, 56);
        createFolderEngine(refs, { reveal: () => {} }).size();
        return refs;
      },
      limit: (H) => H - skylineBand(H),
    },
    {
      name: 'cloud (orbit)',
      run: () => {
        const refs = orbitRefs();
        createOrbitEngine(refs, { reveal: () => {} }).size();
        return refs;
      },
      limit: (H) => H - FLOOR,
    },
    {
      name: 'shortcut (keyboard)',
      run: () => {
        const refs = keyboardRefs();
        createKeyboardEngine(refs, { reveal: () => {} }).size();
        return refs;
      },
      limit: (H) => H - FLOOR,
    },
    {
      name: 'consent',
      run: () => {
        const refs = consentRefs();
        createConsentEngine(refs, { reveal: () => {} }).size();
        return refs;
      },
      limit: (H) => H - FLOOR,
    },
  ];

  it.each(cases.map((c) => [c.name, c] as const))('%s: sits in the middle of a tall window (1024x1100)', (_name, c) => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 1100);
    const { copy, nav } = c.run();
    const { top, bottom } = block(copy, nav);
    expect(Math.abs((top + bottom) / 2 - 1100 / 2)).toBeLessThanOrEqual(3);
    // Moved down from the old title position, and still inside its limit.
    expect(top).toBeGreaterThan(Math.round(1100 * 0.13));
    expect(bottom).toBeLessThanOrEqual(c.limit(1100));
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s: never passes its limit, nor rises above the title band, in a short window (1024x686)',
    (_name, c) => {
      vi.stubGlobal('innerWidth', 1024);
      vi.stubGlobal('innerHeight', 686);
      const { copy, nav } = c.run();
      const { top, bottom } = block(copy, nav);
      expect(bottom).toBeLessThanOrEqual(c.limit(686));
      expect(top).toBeGreaterThanOrEqual(56);
    },
  );

  it('moves the content with the title, keeping the gaps between them', () => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 1100);
    const refs = keyboardRefs();
    createKeyboardEngine(refs, { reveal: () => {} }).size();
    const copyTop = parseFloat(refs.copy.style.top);
    const kbTop = parseFloat(refs.kb.style.top);
    const lineTop = parseFloat(refs.line.style.top);
    const navTop = parseFloat(refs.nav!.style.top);
    expect(kbTop).toBeGreaterThanOrEqual(copyTop + 98 + 36);
    expect(lineTop - kbTop).toBe(230 + 26);
    expect(navTop - lineTop).toBe(22 + 44);

    const consent = consentRefs();
    createConsentEngine(consent, { reveal: () => {} }).size();
    const formTop = parseFloat(consent.form.style.top);
    expect(formTop).toBeGreaterThanOrEqual(parseFloat(consent.copy.style.top) + 98 + 36);
    expect(parseFloat(consent.nav!.style.top) - formTop).toBe(180 + 44);
  });
});
