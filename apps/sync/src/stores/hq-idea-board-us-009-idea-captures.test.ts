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
    confidence: 0.9,
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

describe('US-009 idea captures store', () => {
  it('normalizes a non-array list result to an empty board', async () => {
    invoke.mockResolvedValue({ oops: true });
    const store = createIdeaCapturesStore();
    await store.load();
    expect(store.records).toEqual([]);
    expect(store.state).toBe('ready');
  });

  it('drops malformed rows and sorts the rest newest first', async () => {
    invoke.mockResolvedValue([
      record({ id: 'old', created_at: '2026-09-01T10:00:00Z' }),
      null,
      { nope: 1 },
      record({ id: 'new', created_at: '2026-09-03T10:00:00Z' }),
    ]);
    const store = createIdeaCapturesStore();
    await store.load();
    expect(store.records.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('records the error and state when the list command fails', async () => {
    invoke.mockRejectedValue(new Error('unconfigured'));
    const store = createIdeaCapturesStore();
    await store.load();
    expect(store.state).toBe('error');
    expect(store.error).toContain('unconfigured');
  });

  it('upserts the record returned by setKind in place', async () => {
    invoke.mockResolvedValueOnce([
      record({ id: 'a', kind: 'x_post', status: 'low_confidence' }),
      record({ id: 'b', created_at: '2026-08-01T10:00:00Z' }),
    ]);
    const store = createIdeaCapturesStore();
    await store.load();
    expect(store.records.map((r) => r.id)).toEqual(['a', 'b']);

    invoke.mockResolvedValueOnce(record({ id: 'a', kind: 'image', status: 'plain' }));
    await store.setKind('a', 'image', 'plain');
    expect(invoke).toHaveBeenLastCalledWith('ideas_set_kind', {
      id: 'a',
      kind: 'image',
      status: 'plain',
    });
    expect(store.records).toHaveLength(2);
    const updated = store.records.find((r) => r.id === 'a');
    expect(updated?.kind).toBe('image');
    expect(updated?.status).toBe('plain');
  });

  it('turns an authorized preview into a data URL and caches failures', async () => {
    const store = createIdeaCapturesStore();
    const row = record({ id: 'a' });

    invoke.mockResolvedValueOnce({ mimeType: 'image/png', dataBase64: 'AAAA' });
    expect(await store.thumbnail(row)).toBe('data:image/png;base64,AAAA');
    // Cached: a second read does not invoke again.
    expect(await store.thumbnail(row)).toBe('data:image/png;base64,AAAA');
    expect(invoke).toHaveBeenCalledTimes(1);

    const missing = record({ id: 'b' });
    invoke.mockRejectedValueOnce(new Error('no such file'));
    expect(await store.thumbnail(missing)).toBeNull();
    expect(await store.thumbnail(missing)).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('subscribes to both capture events and upserts their payloads', async () => {
    const handlers: Array<(e: { payload: unknown }) => void> = [];
    listen.mockImplementation(async (_n: string, h: (e: { payload: unknown }) => void) => {
      handlers.push(h);
      return () => {};
    });
    const store = createIdeaCapturesStore();
    await store.subscribeToUpdates();
    expect(listen.mock.calls.map((c) => c[0])).toEqual([
      'capture:completed',
      'capture:updated',
      'capture:removed',
    ]);

    handlers[0]({ payload: record({ id: 'fresh' }) });
    handlers[1]({ payload: 'not a record' });
    expect(store.records.map((r) => r.id)).toEqual(['fresh']);
  });
});
