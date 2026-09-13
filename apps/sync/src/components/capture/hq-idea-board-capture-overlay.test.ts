// @vitest-environment happy-dom
//
// hq-idea-board US-003: the pre-rendered capture overlay renders a dim layer,
// a small live pixel readout beside the pointer, and a hint — and, because
// its window is non-activating, hosts no text input.

import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  listenMock: vi.fn(async (..._args: unknown[]): Promise<() => void> => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import CaptureOverlay from './CaptureOverlay.svelte';

type Mounted = ReturnType<typeof mount>;
let mounted: Mounted | null = null;

function mountOverlay() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted = mount(CaptureOverlay, { target });
  flushSync();
  return target;
}

afterEach(() => {
  if (mounted) {
    unmount(mounted);
    mounted = null;
  }
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invokeMock.mockClear();
  listenMock.mockClear();
});

describe('CaptureOverlay (hq-idea-board US-003)', () => {
  it('renders the dim layer and the Esc hint with zero Tauri APIs', () => {
    const target = mountOverlay();
    const overlay = target.querySelector('[data-testid="capture-overlay"]');
    expect(overlay).not.toBeNull();
    expect(target.querySelector('[data-testid="capture-hint"]')?.textContent).toMatch(
      /Esc to cancel/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });

  it('flips the readout back across the cursor at the right/bottom edge', () => {
    const target = mountOverlay();
    const overlay = target.querySelector('[data-testid="capture-overlay"]') as HTMLElement;
    const w = window.innerWidth;
    const h = window.innerHeight;
    overlay.dispatchEvent(
      new MouseEvent('mousemove', { clientX: w - 4, clientY: h - 4, bubbles: true }),
    );
    flushSync();
    const plate = target.querySelector('[data-testid="capture-readout"]') as HTMLElement;
    // Like Cmd+Shift+4: it never hangs off the edge.
    expect(parseFloat(plate.style.left)).toBeLessThan(w - 4);
    expect(parseFloat(plate.style.top)).toBeLessThan(h - 4);
  });

  it('hosts no text input (non-activating window policy)', () => {
    const target = mountOverlay();
    expect(target.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
  });

  it('tracks the pointer with a close-in pixel readout and no guide rules', () => {
    const target = mountOverlay();
    const overlay = target.querySelector('[data-testid="capture-overlay"]') as HTMLElement;
    expect(target.querySelector('[data-testid="capture-readout"]')).toBeNull();

    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 80, bubbles: true }));
    flushSync();
    const readout = target.querySelector('[data-testid="capture-readout"]');
    expect(readout).not.toBeNull();
    const dpr = window.devicePixelRatio || 1;
    expect(readout?.textContent?.trim()).toBe(`${Math.round(120 * dpr)}, ${Math.round(80 * dpr)}`);
    // OWNER FEEDBACK: "this giant crosshairs thing is no good". The reticle is
    // the native macOS crosshair NSCursor; the DOM must NOT draw full-screen
    // guide rules on top of it. Falsified by reintroducing either rule.
    expect(target.querySelector('.crosshair-v')).toBeNull();
    expect(target.querySelector('.crosshair-h')).toBeNull();
    // And the readout stays tight to the pointer, not offset across the screen.
    expect((readout as HTMLElement).style.left).toBe('132px');
    expect((readout as HTMLElement).style.top).toBe('92px');

    overlay.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    flushSync();
    expect(target.querySelector('[data-testid="capture-readout"]')).toBeNull();
  });

  it('subscribes to shown/hidden and handshakes ready when Tauri is present', () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mountOverlay();
    const events = listenMock.mock.calls.map((c) => c[0]);
    expect(events).toContain('capture-overlay:shown');
    expect(events).toContain('capture-overlay:hidden');
    expect(invokeMock).toHaveBeenCalledWith('capture_overlay_ready');
  });

  it('flips visible state on the Rust-driven shown/hidden events', () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const target = mountOverlay();
    const overlay = target.querySelector('[data-testid="capture-overlay"]') as HTMLElement;
    const handlerFor = (name: string) =>
      listenMock.mock.calls.find((c) => c[0] === name)?.[1] as
        | ((ev: { payload: unknown }) => void)
        | undefined;
    const shown = handlerFor('capture-overlay:shown');
    const hidden = handlerFor('capture-overlay:hidden');
    expect(shown).toBeTypeOf('function');
    expect(hidden).toBeTypeOf('function');

    expect(overlay.dataset.visible).toBe('false');
    shown!({ payload: { display: { x: 0, y: 0, width: 2880, height: 1800, scale: 2 } } });
    flushSync();
    expect(overlay.dataset.visible).toBe('true');

    // Readout uses the display scale delivered with the shown event.
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 20, bubbles: true }));
    flushSync();
    expect(target.querySelector('[data-testid="capture-readout"]')?.textContent?.trim()).toBe('20, 40');

    hidden!({ payload: { reason: 'escape' } });
    flushSync();
    expect(overlay.dataset.visible).toBe('false');
    expect(target.querySelector('[data-testid="capture-readout"]')).toBeNull();
  });

  it('Escape asks Rust to dismiss without creating anything', () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mountOverlay();
    invokeMock.mockClear();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('dismiss_capture_overlay');
  });
});

describe('CaptureOverlay drag selection (hq-idea-board US-004)', () => {
  function showOverlay(target: HTMLElement, scale: number) {
    const shown = listenMock.mock.calls.find((c) => c[0] === 'capture-overlay:shown')?.[1] as (ev: {
      payload: unknown;
    }) => void;
    shown({ payload: { display: { x: 0, y: 0, width: 2880, height: 1800, scale } } });
    flushSync();
    return target.querySelector('[data-testid="capture-overlay"]') as HTMLElement;
  }

  function mountShown(scale = 1) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const target = mountOverlay();
    const overlay = showOverlay(target, scale);
    invokeMock.mockClear();
    return { target, overlay };
  }

  function drag(overlay: HTMLElement, from: [number, number], to: [number, number]) {
    overlay.dispatchEvent(
      new MouseEvent('mousedown', { clientX: from[0], clientY: from[1], button: 0, bubbles: true }),
    );
    overlay.dispatchEvent(
      new MouseEvent('mousemove', { clientX: to[0], clientY: to[1], bubbles: true }),
    );
    flushSync();
  }

  it('hq-idea-board draws the selection and invokes capture_region_release on release', () => {
    const { target, overlay } = mountShown(1);
    drag(overlay, [100, 100], [500, 400]);

    const rect = target.querySelector('[data-testid="capture-selection"]') as HTMLElement;
    expect(rect).not.toBeNull();
    expect(rect.dataset.w).toBe('400');
    expect(rect.dataset.h).toBe('300');
    expect(
      target.querySelector('[data-testid="capture-dimensions"]')?.textContent?.trim(),
    ).toBe('400 × 300');
    // The readout gives way to the running dimension label during the drag.
    expect(target.querySelector('[data-testid="capture-readout"]')).toBeNull();

    overlay.dispatchEvent(new MouseEvent('mouseup', { clientX: 500, clientY: 400, button: 0, bubbles: true }));
    flushSync();

    expect(invokeMock).toHaveBeenCalledWith('capture_region_release', {
      selection: { x: 100, y: 100, width: 400, height: 300 },
    });
    expect(invokeMock.mock.calls.some((c) => c[0] === 'dismiss_capture_overlay')).toBe(false);
    expect(overlay.dataset.visible).toBe('false');
    expect(target.querySelector('[data-testid="capture-selection"]')).toBeNull();
  });

  it('hq-idea-board normalizes a reversed drag to the same selection', () => {
    const { target, overlay } = mountShown(1);
    drag(overlay, [500, 400], [100, 100]);
    const rect = target.querySelector('[data-testid="capture-selection"]') as HTMLElement;
    expect(rect.dataset.w).toBe('400');
    expect(rect.dataset.h).toBe('300');

    overlay.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 100, button: 0, bubbles: true }));
    flushSync();
    expect(invokeMock).toHaveBeenCalledWith('capture_region_release', {
      selection: { x: 100, y: 100, width: 400, height: 300 },
    });
  });

  it('hq-idea-board doubles the displayed dimensions on a scale-2 display but invokes logical px', () => {
    const { target, overlay } = mountShown(2);
    drag(overlay, [100, 100], [500, 400]);
    expect(
      target.querySelector('[data-testid="capture-dimensions"]')?.textContent?.trim(),
    ).toBe('800 × 600');

    overlay.dispatchEvent(new MouseEvent('mouseup', { clientX: 500, clientY: 400, button: 0, bubbles: true }));
    flushSync();
    expect(invokeMock).toHaveBeenCalledWith('capture_region_release', {
      selection: { x: 100, y: 100, width: 400, height: 300 },
    });
  });

  it('hq-idea-board ignores a mouseup with no active drag', () => {
    const { overlay } = mountShown(1);
    overlay.dispatchEvent(new MouseEvent('mouseup', { clientX: 10, clientY: 10, button: 0, bubbles: true }));
    flushSync();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('hq-idea-board invokes anyway for a click with no movement (Rust rejects the empty rect)', () => {
    const { overlay } = mountShown(1);
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 42, clientY: 24, button: 0, bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('mouseup', { clientX: 42, clientY: 24, button: 0, bubbles: true }));
    flushSync();
    expect(invokeMock).toHaveBeenCalledWith('capture_region_release', {
      selection: { x: 42, y: 24, width: 0, height: 0 },
    });
  });

  it('hq-idea-board ignores right-click and resets drag state on the hidden event', () => {
    const { target, overlay } = mountShown(1);
    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, button: 2, bubbles: true }));
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 80, clientY: 60, bubbles: true }));
    flushSync();
    expect(target.querySelector('[data-testid="capture-selection"]')).toBeNull();

    drag(overlay, [10, 10], [80, 60]);
    expect(target.querySelector('[data-testid="capture-selection"]')).not.toBeNull();
    const hidden = listenMock.mock.calls.find((c) => c[0] === 'capture-overlay:hidden')?.[1] as (ev: {
      payload: unknown;
    }) => void;
    hidden({ payload: { reason: 'escape' } });
    flushSync();
    expect(target.querySelector('[data-testid="capture-selection"]')).toBeNull();
    expect(overlay.dataset.visible).toBe('false');
  });

  it('hq-idea-board still hosts no text input while dragging', () => {
    const { target, overlay } = mountShown(1);
    drag(overlay, [100, 100], [500, 400]);
    expect(target.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
  });
});

describe('CaptureOverlay drag robustness (live-capture fix BUG 1)', () => {
  function mountShown() {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted = mount(CaptureOverlay, { target });
    flushSync();
    const shown = listenMock.mock.calls.find((c) => c[0] === 'capture-overlay:shown')?.[1] as (ev: {
      payload: unknown;
    }) => void;
    shown({ payload: { display: { x: 0, y: 0, width: 1440, height: 900, scale: 2 } } });
    flushSync();
    invokeMock.mockClear();
    return { target, overlay: target.querySelector('[data-testid="capture-overlay"]') as HTMLElement };
  }

  /**
   * The owner's first attempt logged `release_rejected reason=empty`: the
   * mousedown landed, but the drag never became a rect. Move/up were bound to
   * the overlay `<div>` only, so the instant the gesture stopped being
   * delivered with the overlay as its target (macOS was activating HQ and
   * raising its other windows over it) `dragEnd` stayed pinned to `anchor`.
   *
   * Once a drag begins the overlay must own the whole gesture.
   */
  it('hq-idea-board forms the rect when the drag continues off the overlay element', () => {
    const { target, overlay } = mountShown();
    overlay.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 200, clientY: 150, button: 0, bubbles: true }),
    );
    // Deliberately NOT dispatched on the overlay: the drag left the element.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 600 }));
    flushSync();

    const rect = target.querySelector('[data-testid="capture-selection"]') as HTMLElement;
    expect(rect, 'a drag that leaves the overlay element must still draw a rect').not.toBeNull();
    expect(rect.dataset.w).toBe('1000');
    expect(rect.dataset.h).toBe('900');

    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 700, clientY: 600, button: 0 }));
    flushSync();

    expect(invokeMock).toHaveBeenCalledWith('capture_region_release', {
      selection: { x: 200, y: 150, width: 500, height: 450 },
    });
    // …and never the empty rect that Rust rejects as reason=empty.
    expect(
      invokeMock.mock.calls.some(
        (c) =>
          c[0] === 'capture_region_release' &&
          ((c[1] as { selection: { width: number; height: number } }).selection.width === 0 ||
            (c[1] as { selection: { width: number; height: number } }).selection.height === 0),
      ),
    ).toBe(false);
  });

  it('hq-idea-board keeps the drag alive when the pointer leaves the overlay element', () => {
    const { target, overlay } = mountShown();
    overlay.dispatchEvent(
      new MouseEvent('mousedown', { clientX: 100, clientY: 100, button: 0, bubbles: true }),
    );
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: 300 }));
    flushSync();
    overlay.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 500, clientY: 400 }));
    flushSync();

    const rect = target.querySelector('[data-testid="capture-selection"]') as HTMLElement;
    expect(rect.dataset.w).toBe('800');
    expect(rect.dataset.h).toBe('600');
  });

  // ── US-003 regression: the drag must survive a WebView that sees nothing ──

  /**
   * THE SHIPPED DEFECT this covers.
   *
   * The overlay window is a non-activating NSPanel. Such a panel never becomes
   * key, is never sent `mouseMoved:`, and — per the owner's hand test — is not
   * reliably sent `mouseUp` either: the 0x0 selection stayed on screen and
   * simply re-anchored on the next click, and zero `release` marks were
   * logged. Every existing test above passed anyway, because happy-dom
   * dispatches whatever synthetic DOM event the test hands it.
   *
   * So the real contract is: with NOT ONE DOM mouse event, a drag pushed by
   * Rust's AppKit tracker still forms the rect and still ends the gesture.
   */
  it('hq-idea-board forms and releases a drag from native events alone, with zero DOM mouse events', () => {
    const { target, overlay } = mountShown();
    const nativeDrag = listenMock.mock.calls.find((c) => c[0] === 'capture-overlay:drag')?.[1] as
      | ((ev: { payload: unknown }) => void)
      | undefined;
    expect(nativeDrag, 'the overlay must subscribe to the native tracker').toBeTypeOf('function');

    nativeDrag!({
      payload: {
        phase: 'start',
        selection: { x: 100, y: 100, width: 0, height: 0 },
        pointer: { x: 100, y: 100 },
      },
    });
    nativeDrag!({
      payload: {
        phase: 'move',
        selection: { x: 100, y: 100, width: 400, height: 300 },
        pointer: { x: 500, y: 400 },
      },
    });
    flushSync();

    const rect = target.querySelector('[data-testid="capture-selection"]') as HTMLElement;
    expect(rect, 'the rect must grow without a DOM mousemove').not.toBeNull();
    expect(rect.style.width).toBe('400px');
    expect(rect.style.height).toBe('300px');
    expect(rect.dataset.w).toBe('800');
    expect(rect.dataset.h).toBe('600');

    // Rust runs the release itself on the native mouse-up, so the component
    // must stop painting and must NOT invoke a second capture.
    nativeDrag!({
      payload: {
        phase: 'end',
        selection: { x: 100, y: 100, width: 400, height: 300 },
        pointer: { x: 500, y: 400 },
      },
    });
    flushSync();
    expect(overlay.dataset.visible).toBe('false');
    expect(invokeMock).not.toHaveBeenCalledWith('capture_region_release', expect.anything());
  });

  /**
   * Double-capture guard: once AppKit is driving, a late DOM `mouseup` (a host
   * where the WebView does happen to see it) must not fire a second capture.
   */
  it('hq-idea-board does not capture twice when a DOM mouseup trails the native release', () => {
    const { overlay } = mountShown();
    const nativeDrag = listenMock.mock.calls.find((c) => c[0] === 'capture-overlay:drag')?.[1] as (
      ev: { payload: unknown },
    ) => void;
    nativeDrag({
      payload: { phase: 'start', selection: { x: 10, y: 10, width: 0, height: 0 }, pointer: { x: 10, y: 10 } },
    });
    nativeDrag({
      payload: { phase: 'move', selection: { x: 10, y: 10, width: 90, height: 90 }, pointer: { x: 100, y: 100 } },
    });
    flushSync();

    overlay.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 10, button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 100, clientY: 100, button: 0, bubbles: true }));
    flushSync();
    expect(invokeMock).not.toHaveBeenCalledWith('capture_region_release', expect.anything());
  });

  /**
   * The readout the owner has never seen: it renders only under
   * `{:else if pointer}`, so with no mousemove it could never appear. A
   * native pointer update must light it up — and must still bring no guide
   * rules with it.
   */
  it('hq-idea-board shows the readout from a native pointer update', () => {
    const { target } = mountShown(); // this block's fixture is a 2x display
    expect(target.querySelector('[data-testid="capture-readout"]')).toBeNull();
    const nativeDrag = listenMock.mock.calls.find((c) => c[0] === 'capture-overlay:drag')?.[1] as (
      ev: { payload: unknown },
    ) => void;
    nativeDrag({ payload: { phase: 'pointer', selection: null, pointer: { x: 240, y: 160 } } });
    flushSync();
    expect(target.querySelector('.crosshair-v')).toBeNull();
    expect(target.querySelector('.crosshair-h')).toBeNull();
    expect(target.querySelector('[data-testid="capture-readout"]')?.textContent?.trim()).toBe(
      '480, 320',
    );
  });

  it('hq-idea-board captures the pointer so the gesture cannot be stolen mid-drag', () => {
    const { overlay } = mountShown();
    const setPointerCapture = vi.fn();
    (overlay as unknown as Record<string, unknown>).setPointerCapture = setPointerCapture;
    // `pointerdown` is the only event that carries a pointerId, so that is the
    // one the capture has to hang off.
    const down = new MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0, bubbles: true });
    Object.defineProperty(down, 'pointerId', { value: 1 });
    overlay.dispatchEvent(down);
    flushSync();
    expect(setPointerCapture).toHaveBeenCalledWith(1);
  });
});
