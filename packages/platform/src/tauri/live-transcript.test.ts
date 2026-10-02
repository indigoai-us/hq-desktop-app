import { describe, expect, it, vi } from 'vitest';
import { createSyncPlatformAdapter } from './sync-adapter';

describe('createSyncPlatformAdapter meetings.fetchLiveTranscript', () => {
  it('invokes the native fetch with the cursor and ETag and passes the tagged result through', async () => {
    const result = { kind: 'not-modified' };
    const invoke = vi.fn(async () => result);
    const adapter = createSyncPlatformAdapter({ invoke });

    const res = await adapter.meetings.fetchLiveTranscript!({
      recallBotId: 'bot_1',
      companyId: 'cmp_A',
      sinceRevision: 7,
      etag: '"e7"',
    });

    expect(invoke).toHaveBeenCalledWith('meetings_fetch_live_transcript', {
      recallBotId: 'bot_1',
      companyId: 'cmp_A',
      sinceRevision: 7,
      etag: '"e7"',
    });
    expect(res).toEqual({ ok: true, value: result });
  });

  it('sends null for a first poll with no cursor', async () => {
    const invoke = vi.fn(async () => ({ kind: 'not-found' }));
    const adapter = createSyncPlatformAdapter({ invoke });

    await adapter.meetings.fetchLiveTranscript!({ recallBotId: 'bot_1', companyId: 'cmp_A' });

    expect(invoke).toHaveBeenCalledWith('meetings_fetch_live_transcript', {
      recallBotId: 'bot_1',
      companyId: 'cmp_A',
      sinceRevision: null,
      etag: null,
    });
  });
});
