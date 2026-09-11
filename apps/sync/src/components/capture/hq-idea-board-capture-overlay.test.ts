// @vitest-environment happy-dom
//
// hq-idea-board US-003: the pre-rendered capture overlay renders a dim layer,
// a crosshair with a live pixel readout, and a hint — and, because its window
// is non-activating, hosts no text input.

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

  it('hosts no text input (non-activating window policy)', () => {
    const target = mountOverlay();
    expect(target.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
  });

  it('tracks the pointer with a crosshair and pixel readout', () => {
    const target = mountOverlay();
    const overlay = target.querySelector('[data-testid="capture-overlay"]') as HTMLElement;
    expect(target.querySelector('[data-testid="capture-readout"]')).toBeNull();

    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 80, bubbles: true }));
    flushSync();
    const readout = target.querySelector('[data-testid="capture-readout"]');
    expect(readout).not.toBeNull();
    const dpr = window.devicePixelRatio || 1;
    expect(readout?.textContent?.trim()).toBe(`${Math.round(120 * dpr)}, ${Math.round(80 * dpr)}`);
    expect(target.querySelector('.crosshair-v')).not.toBeNull();
    expect(target.querySelector('.crosshair-h')).not.toBeNull();

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
