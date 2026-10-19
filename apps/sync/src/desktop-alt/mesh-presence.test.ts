import { describe, expect, it, vi } from 'vitest';

import { createChatWakeBus, requestLiveRefresh } from '@hq/ui';
import { WorkFeedPagingError } from '@hq/core';
import { createDesktopReconcileFetcher, startDesktopMeshPresence } from './mesh-presence';

describe('startDesktopMeshPresence', () => {
  it('refreshes the owning MeshClient for Atlas requests and unbinds on stop', () => {
    const wakes = createChatWakeBus();
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    const handle = startDesktopMeshPresence({ wakes, fetchImpl });
    const refreshLive = vi.spyOn(handle.client, 'refreshLive');

    requestLiveRefresh('cmp_indigo');
    expect(refreshLive).toHaveBeenCalledWith('cmp_indigo');

    handle.stop();
    requestLiveRefresh('cmp_after_stop');
    expect(refreshLive).toHaveBeenCalledTimes(1);
  });

  it('logs a non-JSON reconcile body and stores no live read', async () => {
    const error = new SyntaxError('Unexpected token < in "<html>secret-body"');
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wakes = createChatWakeBus();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw error;
      },
    }));
    const handle = startDesktopMeshPresence({
      wakes,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    handle.client.refreshLive('cmp_indigo');
    await vi.waitFor(() => {
      const meshCalls = logged.mock.calls.filter(
        (call) => call[0] === 'mesh presence reconcile body was not JSON',
      );
      expect(meshCalls.length).toBeGreaterThan(0);
      const rendered = meshCalls
        .flat()
        .map((value) =>
          value instanceof Error ? `${value.name} ${value.message}` : String(value),
        )
        .join('\n');
      expect(rendered).not.toContain('secret-body');
      expect(logged).toHaveBeenCalledWith(
        'mesh presence reconcile body was not JSON',
        'SyntaxError',
      );
    });
    // A null JSON body is not a live-read snapshot, so nothing is stored.
    // That is the same fallback as returning null without a log.
    expect(handle.client.getLiveReadStore().get('cmp_indigo')).toBeUndefined();
    handle.stop();
    logged.mockRestore();
  });
});

describe('createDesktopReconcileFetcher work feed paging', () => {
  const SYNC_IN = 'a'.repeat(40);
  const SYNC_OUT = 'b'.repeat(40);
  const FEED = '/v1/work-mesh/work';
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const row = (threadId: string) => ({ threadId, projectId: `proj_${threadId}` });

  it('pages the work feed with the same sync cursor and merges rows', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('pageCursor=')
        ? json({ cursor: SYNC_OUT, open: [], changed: [row('t2')], hasMore: false })
        : json({
            cursor: SYNC_OUT,
            open: [row('t1')],
            changed: [],
            hasMore: true,
            nextCursor: 'p2',
          }),
    );

    const result = await createDesktopReconcileFetcher(
      fetchImpl as unknown as typeof fetch,
    )({ path: FEED }, SYNC_IN);

    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      FEED + '?cursor=' + SYNC_IN,
      FEED + '?cursor=' + SYNC_IN + '&pageCursor=p2',
    ]);
    expect(result.cursor).toBe(SYNC_OUT);
    expect(result.state).toMatchObject({
      open: [row('t1')],
      changed: [row('t2')],
      hasMore: false,
    });
  });

  it('makes a single request when the server sends no hasMore', async () => {
    const fetchImpl = vi.fn(async () => json({ cursor: SYNC_OUT, open: [row('t1')] }));

    const result = await createDesktopReconcileFetcher(
      fetchImpl as unknown as typeof fetch,
    )({ path: FEED }, undefined);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.cursor).toBe(SYNC_OUT);
  });

  it('throws on a later-page failure', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('pageCursor=')
        ? json({}, 500)
        : json({ cursor: SYNC_OUT, open: [row('t1')], hasMore: true, nextCursor: 'p2' }),
    );

    await expect(
      createDesktopReconcileFetcher(fetchImpl as unknown as typeof fetch)(
        { path: FEED },
        SYNC_IN,
      ),
    ).rejects.toBeInstanceOf(WorkFeedPagingError);
  });

  it('returns no cursor when the page cap stops the walk', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return json({
        cursor: SYNC_OUT,
        open: [row(`t${n}`)],
        hasMore: true,
        nextCursor: `p${n + 1}`,
      });
    });

    const result = await createDesktopReconcileFetcher(
      fetchImpl as unknown as typeof fetch,
    )({ path: FEED }, SYNC_IN);

    expect(fetchImpl).toHaveBeenCalledTimes(50);
    expect(result.cursor).toBeUndefined();
    warn.mockRestore();
  });
});
