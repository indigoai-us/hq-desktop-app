// @vitest-environment happy-dom
//
// hq-idea-board US-014: the guided screen-recording permission panel.
//
// What this file proves, from the rendered component:
//   * the ready handshake runs and the panel becomes keyboard-operable
//     (the window is built non-activating, so this invoke is the only way it
//     can ever take a key event)
//   * the panel states plainly that macOS will not re-prompt
//   * the drag source carries the .app bundle path, and the copy-path
//     fallback works — and says so honestly when the clipboard refuses
//   * the deep link targets the screen-capture pane
//   * Escape and both close affordances dismiss through the single Rust
//     teardown command (nothing here hides a window itself)
//
// Auto-resume is NOT in this file: it is entirely Rust-side (the poller in
// commands/capture.rs), covered by hq_idea_board_guide_poll_truth_table and
// the US-014 source-contract spec.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  listenMock: vi.fn(async (..._args: unknown[]): Promise<() => void> => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Complete event mock: listen() resolves to a real unlisten fn, so the
// component's teardown boundary has something to call.
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
  emit: vi.fn(async () => undefined),
  once: vi.fn(async () => () => {}),
}));

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import PermissionGuide, { EVENT_STATE, normalizeGuideState } from './PermissionGuide.svelte';

type Mounted = ReturnType<typeof mount>;
let mounted: Mounted | null = null;

const GRANT_PATH = '/Applications/HQ Sync.app';

function state(overrides: Record<string, unknown> = {}) {
  return { grantPath: GRANT_PATH, grantName: 'HQ Sync.app', willReprompt: false, ...overrides };
}

function mountGuide() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  mounted = mount(PermissionGuide, { target });
  flushSync();
  return target;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

function invokesOf(name: string) {
  return invokeMock.mock.calls.filter((c) => c[0] === name);
}

function q<T extends Element = HTMLElement>(root: Element, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
}

let clipboardWrite: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: unknown) =>
    cmd === 'permission_guide_ready' ? state() : undefined,
  );
  listenMock.mockReset();
  listenMock.mockImplementation(async () => () => {});
  clipboardWrite = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWrite },
    configurable: true,
  });
});

afterEach(() => {
  if (mounted) {
    void unmount(mounted);
    mounted = null;
  }
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('US-014 permission guide — adapter normalization', () => {
  it('unwraps an array-shaped Tauri response', () => {
    expect(normalizeGuideState([state()])?.grantPath).toBe(GRANT_PATH);
  });

  it('rejects a payload with no grant path rather than rendering an empty chip', () => {
    expect(normalizeGuideState({ grantName: 'HQ' })).toBeNull();
    expect(normalizeGuideState(null)).toBeNull();
    expect(normalizeGuideState('nope')).toBeNull();
  });

  it('defaults the display name but never invents a path', () => {
    const s = normalizeGuideState({ grantPath: '/x/Y.app', grantName: '' });
    expect(s).toEqual({ grantPath: '/x/Y.app', grantName: 'HQ', willReprompt: false });
  });
});

describe('US-014 permission guide — rendered panel', () => {
  it('runs the ready handshake and makes itself keyboard-operable', async () => {
    mountGuide();
    await settle();
    expect(invokesOf('permission_guide_ready')).toHaveLength(1);
    // The window is built non-activating: without this toggle no key event,
    // including Escape, could ever reach the panel.
    expect(invokesOf('set_permission_guide_focusable')[0]?.[1]).toEqual({ focusable: true });
  });

  it('shows the grant path from the handshake on a keyboard-reachable drag source', async () => {
    const target = mountGuide();
    await settle();
    expect(q(target, '[data-testid="grant-path"]').textContent).toContain(GRANT_PATH);
    const chip = q(target, '[data-testid="drag-source"]');
    expect(chip.getAttribute('draggable')).toBe('true');
    // Draggable is not enough: it must also be reachable and actionable by
    // keyboard for anyone who cannot drag.
    expect(chip.getAttribute('tabindex')).toBe('0');
    expect(chip.getAttribute('role')).toBe('button');
    expect(chip.getAttribute('aria-label')).toContain('HQ Sync.app');
  });

  it('states plainly that macOS will not ask again', async () => {
    const target = mountGuide();
    await settle();
    const text = q(target, '[data-testid="no-reprompt"]').textContent ?? '';
    expect(text).toMatch(/only asks once/i);
    expect(text).toMatch(/will not ask again/i);
  });

  it('drops the no-reprompt notice when the system would still prompt', async () => {
    invokeMock.mockImplementation(async (cmd: unknown) =>
      cmd === 'permission_guide_ready' ? state({ willReprompt: true }) : undefined,
    );
    const target = mountGuide();
    await settle();
    expect(target.querySelector('[data-testid="no-reprompt"]')).toBeNull();
  });

  it('re-arms the keyboard on every show, not just the first mount', async () => {
    // The window is pre-rendered once and reused, and Rust drops focusability
    // on every hide — so a second open that relied on onMount alone would be
    // silently un-dismissable by keyboard.
    mountGuide();
    await settle();
    const afterMount = invokesOf('set_permission_guide_focusable').length;
    const handler = listenMock.mock.calls.find((c) => c[0] === EVENT_STATE)?.[1] as (ev: {
      payload: unknown;
    }) => void;
    handler({ payload: state() });
    await settle();
    expect(invokesOf('set_permission_guide_focusable').length).toBeGreaterThan(afterMount);
    expect(invokesOf('set_permission_guide_focusable').at(-1)?.[1]).toEqual({ focusable: true });
  });

  it('accepts a late state event over permission-guide:state', async () => {
    invokeMock.mockImplementation(async () => undefined);
    const target = mountGuide();
    await settle();
    const handler = listenMock.mock.calls.find((c) => c[0] === EVENT_STATE)?.[1] as (ev: {
      payload: unknown;
    }) => void;
    handler({ payload: state({ grantPath: '/Applications/Later.app', grantName: 'Later.app' }) });
    flushSync();
    expect(q(target, '[data-testid="grant-path"]').textContent).toContain('/Applications/Later.app');
  });

  it('deep-links the screen-capture pane', async () => {
    const target = mountGuide();
    await settle();
    q<HTMLButtonElement>(target, '.action').click();
    await settle();
    expect(invokesOf('permissions_open_settings')[0]?.[1]).toEqual({
      permission: 'screen-capture',
    });
  });

  it('surfaces a failed deep link instead of looking inert', async () => {
    invokeMock.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'permission_guide_ready') return state();
      if (cmd === 'permissions_open_settings') throw new Error('nope');
      return undefined;
    });
    const target = mountGuide();
    await settle();
    q<HTMLButtonElement>(target, '.action').click();
    await settle();
    expect(q(target, '[data-testid="open-failed"]').textContent).toMatch(/Privacy/);
  });

  it('copies the path for users who cannot drag', async () => {
    const target = mountGuide();
    await settle();
    q<HTMLButtonElement>(target, '[data-testid="copy-path"]').click();
    await settle();
    expect(clipboardWrite).toHaveBeenCalledWith(GRANT_PATH);
    expect(q(target, '[data-testid="copy-path"]').textContent).toContain('copied');
  });

  it('copies the path from the keyboard on the drag source itself', async () => {
    const target = mountGuide();
    await settle();
    q(target, '[data-testid="drag-source"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await settle();
    expect(clipboardWrite).toHaveBeenCalledWith(GRANT_PATH);
  });

  it('admits a blocked clipboard rather than claiming success', async () => {
    clipboardWrite.mockRejectedValueOnce(new Error('blocked'));
    const target = mountGuide();
    await settle();
    q<HTMLButtonElement>(target, '[data-testid="copy-path"]').click();
    await settle();
    expect(q(target, '[data-testid="copy-failed"]').textContent).toMatch(/copy it manually/i);
    expect(q(target, '[data-testid="copy-path"]').textContent).not.toContain('copied');
  });

  it('puts the bundle path on the drag payload', async () => {
    const target = mountGuide();
    await settle();
    const data = new Map<string, string>();
    const event = new Event('dragstart', { bubbles: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        setData: (k: string, v: string) => data.set(k, v),
        effectAllowed: '',
      },
    });
    q(target, '[data-testid="drag-source"]').dispatchEvent(event);
    expect(data.get('text/plain')).toBe(GRANT_PATH);
    // Per-segment encoding: a bundle path with `#` must not truncate the URL.
    expect(data.get('text/uri-list')).toBe('file:///Applications/HQ%20Sync.app');
  });

  it('dismisses through Rust on Escape, the close button, and "Not now"', async () => {
    const target = mountGuide();
    await settle();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(invokesOf('dismiss_permission_guide')).toHaveLength(1);

    q<HTMLButtonElement>(target, '.close').click();
    await settle();
    expect(invokesOf('dismiss_permission_guide')).toHaveLength(2);

    q<HTMLButtonElement>(target, '.link.quiet').click();
    await settle();
    expect(invokesOf('dismiss_permission_guide')).toHaveLength(3);

    // The panel never hides its own window — teardown is Rust's single path,
    // so a dismissal can't leave a stuck always-on-top window behind.
    const windowApis = invokeMock.mock.calls.map((c) => String(c[0]));
    expect(windowApis.filter((c) => c.includes('hide') || c.includes('close'))).toEqual([]);
  });

  it('mounts with no Tauri runtime present and invokes nothing', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    mounted = mount(PermissionGuide, { target });
    flushSync();
    await settle();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(target.querySelector('[data-testid="drag-source"]')).not.toBeNull();
  });
});
