// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.fn();
const listen = vi.fn();
const openExternal = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }));
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: (...args: unknown[]) => openExternal(...args),
}));

import { mount, tick, unmount } from 'svelte';
import IdeaDetail from './IdeaDetail.svelte';
import { createIdeaCapturesStore, type IdeaCapture, type IdeaKind } from '../../stores/ideaCaptures';

function record(over: Partial<IdeaCapture> & { id: string } = { id: 'cap-1' }): IdeaCapture {
  return {
    company_slug: 'indigo',
    kind: 'x_post' as IdeaKind,
    status: 'low_confidence',
    confidence: 0.42,
    image_path: 'companies/indigo/ideas/cap-1/image.png',
    ocr_text: 'hello ocr',
    extracted: { title: 'A post', handle: '@hq' },
    tags: ['alpha'],
    extraction_source: 'local',
    provenance: {
      app: 'Safari',
      window_title: 'Tab',
      url: 'https://example.com/post',
      captured_at: '2026-09-01T10:00:00Z',
      display_id: 1,
    },
    note: 'keep',
    cited_count: 2,
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:05:00Z',
    ...over,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function render(over: Partial<IdeaCapture> = {}, extras: Record<string, unknown> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const store = extras.store as ReturnType<typeof createIdeaCapturesStore> | undefined;
  component = mount(IdeaDetail, {
    target: host,
    props: {
      record: record({ id: 'cap-1', ...over } as Partial<IdeaCapture> & { id: string }),
      imageSrc: 'data:image/png;base64,AAAA',
      companies: ['indigo', 'acme'],
      store,
      ...extras,
    },
  });
  await tick();
  return host;
}

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  openExternal.mockReset();
  listen.mockResolvedValue(() => {});
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe('US-010 IdeaDetail', () => {
  it('shows image, kind, confidence source, fields, tags, OCR, provenance, note, cited, timestamps', async () => {
    const el = await render();
    expect(el.querySelector('[data-testid="idea-detail-image"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="idea-detail-confidence"]')?.textContent).toMatch(/42%/);
    expect(el.querySelector('[data-testid="idea-detail-confidence"]')?.textContent).toMatch(/local/);
    expect(el.querySelector('[data-testid="idea-detail-extracted"]')?.textContent).toContain('A post');
    expect((el.querySelector('[data-testid="idea-detail-tags"]') as HTMLInputElement).value).toContain('alpha');
    expect(el.querySelector('[data-testid="idea-detail-ocr"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="idea-detail-url"]')?.textContent).toContain('https://example.com/post');
    expect((el.querySelector('[data-testid="idea-detail-note"]') as HTMLTextAreaElement).value).toBe('keep');
    expect(el.querySelector('[data-testid="idea-detail-cited"]')?.textContent).toContain('Cited 2× by agents');
    expect(el.querySelector('[data-testid="idea-detail-times"]')?.textContent).toContain('2026-09-01T10:00:00Z');
  });

  it('changes kind to article via the store as an extracted user correction', async () => {
    const store = createIdeaCapturesStore();
    invoke.mockImplementation(async (cmd: string, args?: { id?: string; kind?: string }) => {
      if (cmd === 'ideas_correct_kind') {
        return record({
          id: args?.id ?? 'cap-1',
          kind: args?.kind as IdeaKind,
          status: 'extracted',
          confidence: 1,
          extraction_source: 'user',
        });
      }
      return [];
    });
    await store.load();
    const el = await render({ id: 'cap-1' }, { store });
    const select = el.querySelector('[data-testid="idea-detail-kind"]') as HTMLSelectElement;
    select.value = 'article';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('ideas_correct_kind', { id: 'cap-1', kind: 'article' });
  });

  it('deletes only after a single confirmation and then the record is gone', async () => {
    const store = createIdeaCapturesStore();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'ideas_list_captures') return [record({ id: 'cap-1' })];
      if (cmd === 'ideas_delete_capture') return undefined;
      return [];
    });
    await store.load();
    expect(store.records).toHaveLength(1);
    const el = await render({ id: 'cap-1' }, { store });
    (el.querySelector('[data-testid="idea-detail-delete"]') as HTMLButtonElement).click();
    await tick();
    expect(el.querySelector('[data-testid="idea-detail-confirm"]')).not.toBeNull();
    (el.querySelector('[data-testid="idea-detail-delete-yes"]') as HTMLButtonElement).click();
    await tick();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('ideas_delete_capture', { id: 'cap-1' });
    expect(store.records).toHaveLength(0);
  });

  it('opens provenance URLs through the host opener and does not navigate the webview', async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const el = await render({}, { openUrl });
    const link = el.querySelector('[data-testid="idea-detail-url"]') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    await tick();
    expect(openUrl).toHaveBeenCalledWith('https://example.com/post');
    expect(event.defaultPrevented).toBe(true);
  });

  it('closes on Escape', async () => {
    const onclose = vi.fn();
    await render({}, { onclose });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(onclose).toHaveBeenCalled();
  });

  it('flushes an unsaved note before closing on Escape', async () => {
    // Persistence is onblur-only and Escape never fires blur, so closing has
    // to flush the draft itself or the edit is silently lost.
    const store = createIdeaCapturesStore();
    const onclose = vi.fn();
    invoke.mockResolvedValue(undefined);
    const el = await render({}, { store, onclose });

    const note = el.querySelector('[data-testid="idea-detail-note"]') as HTMLTextAreaElement;
    note.value = 'typed but never blurred';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();

    expect(invoke).toHaveBeenCalledWith('ideas_set_note', {
      id: 'cap-1',
      note: 'typed but never blurred',
    });
    expect(onclose).toHaveBeenCalled();
  });

  it('persists edited tags on blur', async () => {
    const store = createIdeaCapturesStore();
    invoke.mockResolvedValue(undefined);
    const el = await render({}, { store });

    const tags = el.querySelector('[data-testid="idea-detail-tags"]') as HTMLInputElement;
    tags.value = 'alpha, beta ,  gamma';
    tags.dispatchEvent(new Event('input', { bubbles: true }));
    tags.dispatchEvent(new Event('blur', { bubbles: true }));
    await settle();

    // Trimmed, empties dropped.
    expect(invoke).toHaveBeenCalledWith('ideas_set_tags', {
      id: 'cap-1',
      tags: ['alpha', 'beta', 'gamma'],
    });
  });

  it('does not re-issue a tag write when the value is unchanged', async () => {
    const store = createIdeaCapturesStore();
    invoke.mockResolvedValue(undefined);
    const el = await render({}, { store });
    const tags = el.querySelector('[data-testid="idea-detail-tags"]') as HTMLInputElement;
    tags.dispatchEvent(new Event('blur', { bubbles: true }));
    await settle();
    expect(invoke).not.toHaveBeenCalledWith('ideas_set_tags', expect.anything());
  });

  it('clears a previous write error once a later write succeeds', async () => {
    const store = createIdeaCapturesStore();
    invoke.mockRejectedValueOnce(new Error('transient vault lock'));
    const el = await render({}, { store });

    const select = el.querySelector('[data-testid="idea-detail-kind"]') as HTMLSelectElement;
    select.value = 'article';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(el.querySelector('[data-testid="idea-detail-error"]')).not.toBeNull();

    invoke.mockResolvedValue(undefined);
    select.value = 'quote';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(el.querySelector('[data-testid="idea-detail-error"]')).toBeNull();
  });

  it('surfaces a failed write instead of swallowing it', async () => {
    const store = createIdeaCapturesStore();
    invoke.mockRejectedValue(new Error('vault is read-only'));
    const el = await render({}, { store });

    const select = el.querySelector('[data-testid="idea-detail-kind"]') as HTMLSelectElement;
    select.value = 'article';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const err = el.querySelector('[data-testid="idea-detail-error"]');
    expect(err?.textContent).toContain('vault is read-only');
  });

  it('keeps the pane open when a delete fails', async () => {
    const store = createIdeaCapturesStore();
    const onclose = vi.fn();
    invoke.mockRejectedValue(new Error('record not found'));
    const el = await render({}, { store, onclose });

    (el.querySelector('[data-testid="idea-detail-delete"]') as HTMLButtonElement).click();
    await settle();
    (el.querySelector('[data-testid="idea-detail-delete-yes"]') as HTMLButtonElement).click();
    await settle();

    expect(onclose).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="idea-detail-error"]')?.textContent).toContain(
      'record not found',
    );
  });
});
