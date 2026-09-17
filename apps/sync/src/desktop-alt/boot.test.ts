import { describe, expect, it } from 'vitest';
import { bootDesktopAltWindow } from './boot';

describe('bootDesktopAltWindow', () => {
  it('awaits the embedded workspace mount', async () => {
    const order: string[] = [];
    await bootDesktopAltWindow({
      mountHqWork: async () => {
        order.push('hq-work-start');
        await Promise.resolve();
        order.push('hq-work-end');
      },
    });
    expect(order).toEqual(['hq-work-start', 'hq-work-end']);
  });
});
