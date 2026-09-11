import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const listen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }));

import { createIdeaCapturesStore, type IdeaCapture, type IdeaKind } from './ideaCaptures';

function record(over: Partial<IdeaCapture> & { id: string }): IdeaCapture {
  return {
    company_slug: 'indigo',
    kind: 'image' as IdeaKind,
    status: 'extracted',
    confidence: 0.4,
    image_path: ['companies', 'indigo', 'ideas', over.id, 'image.png'].join('/'),
    ocr_text: null,
    extracted: null,
    tags: [],
    provenance: {
      app: 'Safari',
      window_title: 'Window',
      url: null,
      captured_at: '2026-09-01T10:00:00Z',
      display_id: 1,
    },
    note: null,
    cited_count: 0,
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    ...over,
  } as IdeaCapture;
}

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  listen.mockResolvedValue(() => {});
});

describe('US-010 idea captures store', () => {
  it('correctKind upserts the authoritative user correction', async () => {
    invoke.mockResolvedValueOnce([record({ id: 'a', kind: 'x_post', status: 'low_confidence' })]);
    const store = createIdeaCapturesStore();
    await store.load();
    invoke.mockResolvedValueOnce(
      record({
        id: 'a',
        kind: 'article',
        status: 'extracted',
        confidence: 1,
        extraction_source: 'user',
      }),
    );
    await store.correctKind('a', 'article');
    expect(invoke).toHaveBeenLastCalledWith('ideas_correct_kind', { id: 'a', kind: 'article' });
    expect(store.records[0]?.kind).toBe('article');
    expect(store.records[0]?.confidence).toBe(1);
    expect(store.records[0]?.extraction_source).toBe('user');
  });

  it('deleteCapture removes the record from the grid without a reload', async () => {
    invoke.mockResolvedValueOnce([record({ id: 'a' }), record({ id: 'b' })]);
    const store = createIdeaCapturesStore();
    await store.load();
    invoke.mockResolvedValueOnce(undefined);
    await store.deleteCapture('a');
    expect(invoke).toHaveBeenLastCalledWith('ideas_delete_capture', { id: 'a' });
    expect(store.records.map((r) => r.id)).toEqual(['b']);
  });

  it('drops a record when capture:removed fires after a move', async () => {
    const handlers: Array<(e: { payload: unknown }) => void> = [];
    listen.mockImplementation(async (_n: string, h: (e: { payload: unknown }) => void) => {
      handlers.push(h);
      return () => {};
    });
    invoke.mockResolvedValueOnce([record({ id: 'a' })]);
    const store = createIdeaCapturesStore();
    await store.load();
    await store.subscribeToUpdates();
    handlers[2]({ payload: { id: 'a', reason: 'moved' } });
    expect(store.records).toEqual([]);
  });
});
