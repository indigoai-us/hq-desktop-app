import { describe, expect, it } from 'vitest';
import { failure, ok, type PlatformAdapter } from '@hq/platform';

import { createConversationApi } from './chat-adapter';

describe('createConversationApi runCardAction', () => {
  it('wires runCardAction to the desktop command payload', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = {
      messaging: {
        runCardAction: async (args: Record<string, unknown>) => {
          calls.push(args);
          return ok({
            cardId: args.cardId,
            actionId: args.actionId,
            eventId: 'evt_1',
            state: 'pending',
            replayed: false,
          });
        },
      },
    } as unknown as PlatformAdapter;

    const api = createConversationApi(adapter);
    const result = await api.runCardAction({
      channelId: 'setup',
      cardId: 'card_create_1',
      actionId: 'submit',
      values: { name: 'Acme' },
      idempotencyKey: 'idem-1',
    });
    expect(calls).toEqual([
      {
        channelId: 'setup',
        cardId: 'card_create_1',
        actionId: 'submit',
        values: { name: 'Acme' },
        idempotencyKey: 'idem-1',
      },
    ]);
    expect(result).toMatchObject({
      cardId: 'card_create_1',
      actionId: 'submit',
      state: 'pending',
      replayed: false,
    });
  });

  it('throws the permission reason on 403 so the card can render it', async () => {
    const adapter = {
      messaging: {
        runCardAction: async () =>
          failure('invoke', 'Viewer cannot act on this card'),
      },
    } as unknown as PlatformAdapter;
    const api = createConversationApi(adapter);
    await expect(
      api.runCardAction({
        channelId: 'setup',
        cardId: 'card_agent',
        actionId: 'submit',
        values: {},
      }),
    ).rejects.toThrow('Viewer cannot act on this card');
  });
});
