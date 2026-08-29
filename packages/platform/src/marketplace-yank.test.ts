import { describe, expect, it } from 'vitest';
import { TauriPlatformAdapter } from './tauri/index.js';
import { WebPlatformAdapter } from './web/index.js';

describe('MarketplaceApi.yank audit reason', () => {
  it('passes the reason through the Tauri adapter command', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (command, args) => {
        calls.push({ command, args });
        return undefined;
      },
    });

    const result = await adapter.marketplace.yank('lst_1', 'DMCA takedown');

    expect(result).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([
      {
        command: 'yank_listing',
        args: { id: 'lst_1', reason: 'DMCA takedown' },
      },
    ]);
  });

  it('posts the reason through the web adapter', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: 'https://api.example.test',
      fetch: async (input, init) => {
        calls.push({
          path: String(input).replace('https://api.example.test', ''),
          method: init?.method,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        return new Response('{}', { status: 200 });
      },
    });

    const result = await adapter.marketplace.yank('lst_1', 'DMCA takedown');

    expect(result).toEqual({ ok: true, value: {} });
    expect(calls).toEqual([
      {
        path: '/v1/moderation/listings/lst_1/yank',
        method: 'POST',
        body: JSON.stringify({ reason: 'DMCA takedown' }),
      },
    ]);
  });
});
