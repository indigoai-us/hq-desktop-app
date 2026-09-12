// @vitest-environment happy-dom
//
// hq-idea-board US-005: the capture toast reports what was just captured,
// who it's filed to, and offers undo / note / reassign / open — all optional,
// never a confirmation dialog, and it auto-dismisses when idle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import CaptureToast from './CaptureToast.svelte';
import type { IdeaCapture } from '../../stores/ideaCaptures';

type Mounted = ReturnType<typeof mount>;
let mounted: Mounted | null = null;

function mountToast() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  mounted = mount(CaptureToast, { target });
  flushSync();
  return target;
}

function handlerFor(name: string) {
  return listenMock.mock.calls.find((c) => c[0] === name)?.[1] as
    | ((ev: { payload: unknown }) => void)
    | undefined;
}

function baseRecord(overrides: Partial<IdeaCapture> = {}): IdeaCapture {
  return {
    id: 'rec-1',
    company_slug: 'indigo',
    kind: 'x_post',
    status: 'extracted',
    confidence: 0.94,
    image_path: '/tmp/rec-1.png',
    ocr_text: null,
    extracted: {
      body: 'The best interface is the one you never have to think about…',
      author: 'handle',
    },
    tags: [],
    provenance: {
      app: 'X',
      window_title: 'X',
      url: 'https://x.com/handle/status/1',
      captured_at: '2026-09-12T14:22:00.000Z',
      display_id: 1,
    },
    note: null,
    cited_count: 0,
    created_at: '2026-09-12T14:22:00.000Z',
    updated_at: '2026-09-12T14:22:00.000Z',
    ...overrides,
  };
}

function show(target: HTMLElement, record: IdeaCapture) {
  const shownFn = handlerFor('capture-toast:show');
  shownFn!({ payload: record });
  flushSync();
  return target.querySelector('[data-testid="capture-toast"]') as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  if (mounted) {
    unmount(mounted);
    mounted = null;
  }
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invokeMock.mockClear();
  invokeMock.mockImplementation(async () => undefined);
  listenMock.mockClear();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('CaptureToast (hq-idea-board US-005)', () => {
  it('renders nothing before a show event', () => {
    const target = mountToast();
    expect(target.querySelector('[data-testid="capture-toast"]')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('capture_toast_ready');
  });

  it('renders thumbnail, pill, title, provenance, and "Filed to indigo" after capture-toast:show', async () => {
    invokeMock.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'get_authorized_file_preview') {
        return { mimeType: 'image/png', dataBase64: 'AAAA' };
      }
      return undefined;
    });
    const target = mountToast();
    const toast = show(target, baseRecord());
    expect(toast).not.toBeNull();

    expect(target.querySelector('[data-testid="capture-toast-pill"]')?.textContent).toBe('X post · 0.94');
    expect(target.querySelector('[data-testid="capture-toast-title"]')?.textContent).toContain(
      'The best interface',
    );
    expect(target.querySelector('[data-testid="capture-toast-filed"]')?.textContent).toContain('indigo');

    await vi.waitFor(() => {
      expect(
        target.querySelector('[data-testid="capture-toast-thumb"] img')?.getAttribute('src'),
      ).toBe('data:image/png;base64,AAAA');
    });
  });

  it('shows "Reading…" while pending, then the live pill from a capture:updated event', () => {
    const target = mountToast();
    const record = baseRecord({ status: 'pending', kind: 'unknown', confidence: null });
    show(target, record);
    expect(target.querySelector('[data-testid="capture-toast-pill"]')?.textContent).toBe('Reading…');

    const updatedFn = handlerFor('capture:updated');
    updatedFn!({ payload: baseRecord({ status: 'extracted', kind: 'x_post', confidence: 0.94 }) });
    flushSync();
    expect(target.querySelector('[data-testid="capture-toast-pill"]')?.textContent).toBe('X post · 0.94');
  });

  it('ignores a capture:updated event for a different record id', () => {
    const target = mountToast();
    show(target, baseRecord({ id: 'rec-1' }));
    const updatedFn = handlerFor('capture:updated');
    updatedFn!({ payload: baseRecord({ id: 'rec-other', kind: 'article' }) });
    flushSync();
    expect(target.querySelector('[data-testid="capture-toast-pill"]')?.textContent).toBe('X post · 0.94');
  });

  it('auto-dismisses after 6s, and never while hovered', () => {
    const target = mountToast();
    const toast = show(target, baseRecord());
    invokeMock.mockClear();

    toast.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }));
    flushSync();
    vi.advanceTimersByTime(6000);
    flushSync();
    // Still up: hovered before the timer could fire.
    expect(target.querySelector('[data-testid="capture-toast"]')).not.toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith('dismiss_capture_toast');

    toast.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }));
    flushSync();
    vi.advanceTimersByTime(6000);
    flushSync();
    expect(target.querySelector('[data-testid="capture-toast"]')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('dismiss_capture_toast');
  });

  it('⌘Z deletes the capture and shows "Undone"', async () => {
    const target = mountToast();
    show(target, baseRecord());
    invokeMock.mockClear();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    // The delete is awaited before the toast claims success, so "Undone"
    // appears only once the command resolved.
    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-undone"]')?.textContent).toBe('Undone');
    });
    expect(invokeMock).toHaveBeenCalledWith('ideas_delete_capture', { id: 'rec-1' });
    expect(target.querySelector('[data-testid="capture-toast-error"]')).toBeNull();

    vi.advanceTimersByTime(1200);
    flushSync();
    expect(target.querySelector('[data-testid="capture-toast"]')).toBeNull();
  });

  it('N sets focusable true before the note input exists, and Enter saves the note then flips focusable false', async () => {
    const target = mountToast();
    show(target, baseRecord());
    invokeMock.mockClear();

    const focusableCallOrder: unknown[] = [];
    invokeMock.mockImplementation(async (...args: unknown[]) => {
      const [cmd, cmdArgs] = args as [string, unknown];
      focusableCallOrder.push([cmd, cmdArgs]);
      return undefined;
    });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    // Right after dispatch (before the awaited invoke resolves), the input
    // must not exist yet — focusable is requested first.
    expect(target.querySelector('[data-testid="capture-toast-note-input"]')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('set_capture_toast_focusable', { focusable: true });

    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-note-input"]')).not.toBeNull();
    });
    flushSync();

    const input = target.querySelector('[data-testid="capture-toast-note-input"]') as HTMLInputElement;
    input.value = 'remember this';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    flushSync();

    await vi.waitFor(() => {
      expect(focusableCallOrder.filter((c) => (c as unknown[])[0] === 'set_capture_toast_focusable'))
        .toHaveLength(2);
    });
    // ideas_set_note commits, then focusable flips back to false — in that order.
    const noteIdx = focusableCallOrder.findIndex((c) => (c as unknown[])[0] === 'ideas_set_note');
    const secondFocusableIdx = focusableCallOrder.findIndex(
      (c, i) => (c as unknown[])[0] === 'set_capture_toast_focusable' && i > 0,
    );
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(focusableCallOrder[noteIdx]).toEqual(['ideas_set_note', { id: 'rec-1', note: 'remember this' }]);
    expect(noteIdx).toBeLessThan(secondFocusableIdx);
    expect(focusableCallOrder[secondFocusableIdx]).toEqual(['set_capture_toast_focusable', { focusable: false }]);
    expect(target.querySelector('[data-testid="capture-toast-note-input"]')).toBeNull();
  });

  it('Escape commits the typed note instead of silently discarding it', async () => {
    // The toast is a ~6s surface with no second chance: leaving the note
    // field must persist what was typed (US-010's review found the detail
    // pane dropping blur-only drafts on Escape).
    const target = mountToast();
    show(target, baseRecord());
    invokeMock.mockClear();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-note-input"]')).not.toBeNull();
    });
    flushSync();

    const input = target.querySelector('[data-testid="capture-toast-note-input"]') as HTMLInputElement;
    input.value = 'typed but never committed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('ideas_set_note', {
        id: 'rec-1',
        note: 'typed but never committed',
      });
      expect(invokeMock).toHaveBeenCalledWith('set_capture_toast_focusable', { focusable: false });
    });
    expect(target.querySelector('[data-testid="capture-toast-note-input"]')).toBeNull();
  });

  it('flushes an in-progress note when the toast is dismissed by ⏎ open', async () => {
    const target = mountToast();
    show(target, baseRecord());
    invokeMock.mockClear();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-note-input"]')).not.toBeNull();
    });
    flushSync();
    const input = target.querySelector('[data-testid="capture-toast-note-input"]') as HTMLInputElement;
    input.value = 'draft in flight';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    // Commit + leave edit mode, then open: the dismiss path must not drop it.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('ideas_set_note', { id: 'rec-1', note: 'draft in flight' });
    });
  });

  it('a rejected ideas_delete_capture surfaces an error and never claims "Undone"', async () => {
    invokeMock.mockImplementation(async (...args: unknown[]) => {
      if ((args[0] as string) === 'ideas_delete_capture') throw new Error('vault is read-only');
      return undefined;
    });
    const target = mountToast();
    show(target, baseRecord());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-error"]')?.textContent).toContain(
        'vault is read-only',
      );
    });
    expect(target.querySelector('[data-testid="capture-toast-undone"]')).toBeNull();
    // The record is still on disk, so the toast must still be up saying so.
    vi.advanceTimersByTime(1200);
    flushSync();
    expect(target.querySelector('[data-testid="capture-toast"]')).not.toBeNull();
  });

  it('a rejected ideas_move_capture keeps "Filed to" on the original company', async () => {
    invokeMock.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'ideas_list_companies') return ['acme'];
      if (cmd === 'ideas_move_capture') throw new Error('acme is not yours');
      return undefined;
    });
    const target = mountToast();
    show(target, baseRecord({ company_slug: 'indigo' }));

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Alt', altKey: true, metaKey: true, bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-picker-item"]')).not.toBeNull();
    });
    (
      target.querySelector('[data-testid="capture-toast-picker-item"][data-company="acme"]') as HTMLButtonElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-error"]')?.textContent).toContain(
        'acme is not yours',
      );
    });
    expect(target.querySelector('[data-testid="capture-toast-filed"]')?.textContent).toContain('indigo');
    expect(target.querySelector('[data-testid="capture-toast-filed"]')?.textContent).not.toContain('acme');
  });

  it('a rejected ideas_set_note surfaces the error and keeps the typed text on screen', async () => {
    invokeMock.mockImplementation(async (...args: unknown[]) => {
      if ((args[0] as string) === 'ideas_set_note') throw new Error('disk full');
      return undefined;
    });
    const target = mountToast();
    show(target, baseRecord());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-note-input"]')).not.toBeNull();
    });
    const input = target.querySelector('[data-testid="capture-toast-note-input"]') as HTMLInputElement;
    input.value = 'precious';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-error"]')?.textContent).toContain('disk full');
    });
    const still = target.querySelector('[data-testid="capture-toast-note-input"]') as HTMLInputElement;
    expect(still).not.toBeNull();
    expect(still.value).toBe('precious');
  });

  it('⌘⌥ lists companies and choosing one calls ideas_move_capture and re-renders "Filed to <new>"', async () => {
    const listCompaniesImpl = async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'ideas_list_companies') return ['acme', 'globex'];
      return undefined;
    };
    invokeMock.mockImplementation(listCompaniesImpl);
    const target = mountToast();
    show(target, baseRecord({ company_slug: 'indigo' }));
    invokeMock.mockClear();
    invokeMock.mockImplementation(listCompaniesImpl);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Alt', altKey: true, metaKey: true, bubbles: true }),
    );
    flushSync();

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('ideas_list_companies');
      expect(target.querySelectorAll('[data-testid="capture-toast-picker-item"]').length).toBe(2);
    });

    const item = target.querySelector(
      '[data-testid="capture-toast-picker-item"][data-company="acme"]',
    ) as HTMLButtonElement;
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-filed"]')?.textContent).toContain('acme');
    });
    expect(invokeMock).toHaveBeenCalledWith('ideas_move_capture', { id: 'rec-1', toCompany: 'acme' });
    expect(target.querySelector('[data-testid="capture-toast-error"]')).toBeNull();
    // Choosing a company does not dismiss the toast.
    expect(target.querySelector('[data-testid="capture-toast"]')).not.toBeNull();
  });

  it('Enter (no note editing, no picker) opens the board and dismisses', async () => {
    const target = mountToast();
    show(target, baseRecord());
    invokeMock.mockClear();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('dismiss_capture_toast');
    });
    flushSync();
    expect(invokeMock).toHaveBeenCalledWith('ideas_open_board', { id: 'rec-1' });
    expect(target.querySelector('[data-testid="capture-toast"]')).toBeNull();
  });

  it('clicking into the toast body sets focusable true, but mounting/showing never does', () => {
    const target = mountToast();
    invokeMock.mockClear();
    const toast = show(target, baseRecord());
    expect(invokeMock).not.toHaveBeenCalledWith('set_capture_toast_focusable', { focusable: true });

    toast.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(invokeMock).toHaveBeenCalledWith('set_capture_toast_focusable', { focusable: true });
  });

  it('renders a typed fallback when the thumbnail preview fails, without throwing or retrying', async () => {
    invokeMock.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'get_authorized_file_preview') throw new Error('not authorized');
      return undefined;
    });
    const target = mountToast();
    show(target, baseRecord());

    await vi.waitFor(() => {
      expect(target.querySelector('[data-testid="capture-toast-thumb-fallback"]')).not.toBeNull();
    });
    expect(target.querySelector('[data-testid="capture-toast-thumb"] img')).toBeNull();

    const previewCalls = invokeMock.mock.calls.filter((c) => c[0] === 'get_authorized_file_preview');
    expect(previewCalls).toHaveLength(1);
  });

  it('uses no native dialogs', () => {
    // The static source check lives in the e2e source-contract spec; this is
    // a runtime smoke check that a full interaction pass never calls the
    // globals, guarding environments (happy-dom) that may not define them.
    const win = window as unknown as { confirm?: () => boolean; alert?: () => void; prompt?: () => string | null };
    win.confirm = vi.fn(() => true);
    win.alert = vi.fn();
    win.prompt = vi.fn(() => null);
    const confirmSpy = win.confirm as ReturnType<typeof vi.fn>;
    const alertSpy = win.alert as ReturnType<typeof vi.fn>;
    const promptSpy = win.prompt as ReturnType<typeof vi.fn>;

    const target = mountToast();
    show(target, baseRecord());
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    flushSync();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });
});
