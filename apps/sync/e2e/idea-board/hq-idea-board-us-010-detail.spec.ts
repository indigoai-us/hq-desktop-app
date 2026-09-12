// @vitest-environment happy-dom
/**
 * US-010 acceptance: kind correction re-renders the grid card, delete
 * removes the record, provenance URLs go through the host opener.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.fn();
const listen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }));
const shellOpen = vi.fn();
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: (...args: unknown[]) => shellOpen(...args),
}));

import { mount, tick, unmount } from 'svelte';
import IdeasBoard from '../../src/desktop-alt/ideas/IdeasBoard.svelte';
import type { IdeaCapture, IdeaKind, IdeaStatus } from '../../src/stores/ideaCaptures';

function record(over: Partial<IdeaCapture> & { id: string }): IdeaCapture {
  return {
    company_slug: 'indigo',
    kind: 'x_post' as IdeaKind,
    status: 'low_confidence' as IdeaStatus,
    confidence: 0.3,
    image_path: `companies/indigo/ideas/${over.id}/image.png`,
    ocr_text: null,
    extracted: { title: 'Guessed post' },
    tags: [],
    extraction_source: 'local',
    provenance: {
      app: 'Safari',
      window_title: 'Tab',
      url: 'https://example.com/x',
      captured_at: '2026-09-01T10:00:00Z',
      display_id: 1,
    },
    note: null,
    cited_count: 0,
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    ...over,
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let rows: IdeaCapture[] = [];
let listeners: Record<string, (e: { payload: unknown }) => void> = {};

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

beforeEach(() => {
  rows = [record({ id: 'cap-1' }), record({ id: 'cap-2', kind: 'article', status: 'extracted' })];
  invoke.mockReset();
  listen.mockReset();
  shellOpen.mockReset();
  listeners = {};
  listen.mockImplementation(async (name: string, handler: (e: { payload: unknown }) => void) => {
    listeners[name] = handler;
    return () => {};
  });
  invoke.mockImplementation(async (cmd: string, args?: { id?: string; kind?: string }) => {
    if (cmd === 'ideas_list_captures') return rows;
    if (cmd === 'ideas_list_companies') return ['indigo', 'acme'];
    if (cmd === 'get_authorized_file_preview') {
      return { mimeType: 'image/png', dataBase64: 'AAAA' };
    }
    if (cmd === 'ideas_correct_kind') {
      const next = record({
        id: args?.id ?? 'cap-1',
        kind: (args?.kind as IdeaKind) ?? 'article',
        status: 'extracted',
        confidence: 1,
        extraction_source: 'user',
        extracted: { title: 'Guessed post' },
      });
      rows = rows.map((r) => (r.id === next.id ? next : r));
      return next;
    }
    if (cmd === 'ideas_move_capture') {
      rows = rows.filter((r) => r.id !== args?.id);
      return undefined;
    }
    if (cmd === 'ideas_delete_capture') {
      rows = rows.filter((r) => r.id !== args?.id);
      return undefined;
    }
    return undefined;
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe('US-010: Card detail', () => {
  it('Given a low_confidence record, when the user changes kind to article in the detail view, then status becomes extracted, confidence is 1.0, source is user, and the grid card re-renders as an article', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
    await settle();

    const card = host.querySelector('[data-id="cap-1"]') as HTMLElement;
    card.click();
    await settle();

    const select = host.querySelector('[data-testid="idea-detail-kind"]') as HTMLSelectElement;
    select.value = 'article';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const updated = host.querySelector('[data-id="cap-1"]') as HTMLElement;
    expect(updated.getAttribute('data-kind')).toBe('article');
    expect(updated.getAttribute('data-status')).toBe('extracted');
    expect(invoke).toHaveBeenCalledWith('ideas_correct_kind', { id: 'cap-1', kind: 'article' });
    // confidence 1.0 and source `user` must reach the rendered pane, not just
    // the record — this is the half of the criterion the grid can't show.
    const confidence = host.querySelector('[data-testid="idea-detail-confidence"]')?.textContent;
    expect(confidence).toContain('100%');
    expect(confidence).toContain('user');
  });

  it('Given a record, when delete is confirmed, then the record directory no longer exists and the card is gone from the grid', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
    await settle();

    (host.querySelector('[data-id="cap-1"]') as HTMLElement).click();
    await settle();
    (host.querySelector('[data-testid="idea-detail-delete"]') as HTMLButtonElement).click();
    await settle();
    (host.querySelector('[data-testid="idea-detail-delete-yes"]') as HTMLButtonElement).click();
    await settle();

    expect(invoke).toHaveBeenCalledWith('ideas_delete_capture', { id: 'cap-1' });
    expect(host.querySelector('[data-id="cap-1"]')).toBeNull();
    expect(rows.find((r) => r.id === 'cap-1')).toBeUndefined();
    // The surviving card must not have been swept up with it.
    expect(host.querySelector('[data-id="cap-2"]')).not.toBeNull();
  });

  it('Given a record with a URL in provenance, when the link is clicked, then it opens in the system browser and the desktop webview does not navigate', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
    await settle();
    (host.querySelector('[data-id="cap-1"]') as HTMLElement).click();
    await settle();
    const link = host.querySelector('[data-testid="idea-detail-url"]') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(shellOpen).toHaveBeenCalledWith('https://example.com/x');
    // No href at all: `click`-only interception cannot stop a middle-click,
    // so the anchor must have nothing for the webview to navigate to.
    expect(link.getAttribute('href')).toBeNull();
  });

  it('routes a hostile provenance scheme nowhere instead of handing it to the shell', async () => {
    rows = [record({ id: 'cap-1', provenance: { ...record({ id: 'cap-1' }).provenance, url: 'javascript:alert(1)' } })];
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
    await settle();
    (host.querySelector('[data-id="cap-1"]') as HTMLElement).click();
    await settle();

    const link = host.querySelector('[data-testid="idea-detail-url"]') as HTMLAnchorElement;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();

    expect(shellOpen).not.toHaveBeenCalled();
  });

  it('middle-clicking a provenance link opens the host opener and never navigates', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
    await settle();
    (host.querySelector('[data-id="cap-1"]') as HTMLElement).click();
    await settle();

    const link = host.querySelector('[data-testid="idea-detail-url"]') as HTMLAnchorElement;
    const aux = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    link.dispatchEvent(aux);
    await settle();

    expect(aux.defaultPrevented).toBe(true);
    expect(shellOpen).toHaveBeenCalledWith('https://example.com/x');
  });

  it('AC5: arrow keys step between the cards in the current filter', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
    await settle();
    (host.querySelector('[data-id="cap-1"]') as HTMLElement).click();
    await settle();
    expect(host.querySelector('[data-testid="idea-detail"]')?.getAttribute('data-id')).toBe('cap-1');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await settle();
    expect(host.querySelector('[data-testid="idea-detail"]')?.getAttribute('data-id')).toBe('cap-2');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await settle();
    expect(host.querySelector('[data-testid="idea-detail"]')?.getAttribute('data-id')).toBe('cap-1');

    // Wraps rather than dead-ending at the edge of the filter.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await settle();
    expect(host.querySelector('[data-testid="idea-detail"]')?.getAttribute('data-id')).toBe('cap-2');
  });

  it('AC5: arrow keys inside a text field edit the text instead of changing cards', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
    await settle();
    (host.querySelector('[data-id="cap-1"]') as HTMLElement).click();
    await settle();

    const note = host.querySelector('[data-testid="idea-detail-note"]') as HTMLTextAreaElement;
    note.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();

    expect(host.querySelector('[data-testid="idea-detail"]')?.getAttribute('data-id')).toBe('cap-1');
  });

  it('AC3: reassigning to another company moves the record and drops it from the board', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
    await settle();
    (host.querySelector('[data-id="cap-1"]') as HTMLElement).click();
    await settle();

    const move = host.querySelector('[data-testid="idea-detail-move"]') as HTMLSelectElement;
    // The current company is not offered as a destination.
    const options = Array.from(move.querySelectorAll('option')).map((o) => o.value);
    expect(options).not.toContain('indigo');
    expect(options).toContain('acme');

    move.value = 'acme';
    move.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(invoke).toHaveBeenCalledWith('ideas_move_capture', { id: 'cap-1', toCompany: 'acme' });
    expect(host.querySelector('[data-id="cap-1"]')).toBeNull();
    expect(host.querySelector('[data-testid="idea-detail"]')).toBeNull();
  });

  it('AC4: a background capture:updated does not wipe a note being typed', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
    await settle();
    (host.querySelector('[data-id="cap-1"]') as HTMLElement).click();
    await settle();

    const note = host.querySelector('[data-testid="idea-detail-note"]') as HTMLTextAreaElement;
    note.value = 'half-written thought';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    // The pipeline revises the same record (model refinement / cited bump).
    listeners['capture:updated']?.({
      payload: record({ id: 'cap-1', cited_count: 9 }),
    });
    await settle();

    const after = host.querySelector('[data-testid="idea-detail-note"]') as HTMLTextAreaElement;
    expect(after.value).toBe('half-written thought');
    expect(host.querySelector('[data-testid="idea-detail-cited"]')?.textContent).toBeTruthy();
  });
});
