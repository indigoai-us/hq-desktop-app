import { describe, expect, it, vi } from 'vitest';

import { subscribeWindowFocus } from '../../src/lib/listener-registry';

describe('HQ-DESKTOP-39: decomposed window focus subscription', () => {
  it('registers focus and blur itself instead of the framework composite', async () => {
    const unlistens = { focus: vi.fn(), blur: vi.fn() };
    const events: string[] = [];
    const win = {
      onFocusChanged() {
        throw new Error('composite onFocusChanged must not be used');
      },
      listen: vi.fn(async (event: string) => {
        events.push(event);
        return event.endsWith('focus') ? unlistens.focus : unlistens.blur;
      }),
    };

    const teardown = await subscribeWindowFocus(win, () => {});
    teardown();
    teardown();

    expect(events).toEqual(['tauri://focus', 'tauri://blur']);
    expect(unlistens.focus).toHaveBeenCalledTimes(1);
    expect(unlistens.blur).toHaveBeenCalledTimes(1);
  });
});
