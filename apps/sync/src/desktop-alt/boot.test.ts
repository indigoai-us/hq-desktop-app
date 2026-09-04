import { describe, expect, it, vi } from 'vitest';
import { bootDesktopAltWindow, resolveDesktopAltShell } from './boot';

describe('resolveDesktopAltShell', () => {
  it('always returns hq-work, including for a GA user with no company', async () => {
    expect(await resolveDesktopAltShell(async () => true)).toBe('hq-work');
    expect(await resolveDesktopAltShell(async () => false)).toBe('hq-work');
    expect(await resolveDesktopAltShell()).toBe('hq-work');
  });

  it('ignores a retired hqWorkHandoff false / throw from an upgraded install', async () => {
    expect(
      await resolveDesktopAltShell(async () => {
        throw new Error('menubar missing');
      }),
    ).toBe('hq-work');
  });
});

describe('bootDesktopAltWindow', () => {
  it('mounts hq-work even when getHandoff returns false', async () => {
    const order: string[] = [];
    const shell = await bootDesktopAltWindow({
      getHandoff: async () => {
        order.push('handoff');
        return false;
      },
      mountLegacy: () => {
        order.push('legacy');
      },
      mountHqWork: () => {
        order.push('hq-work');
      },
    });
    expect(shell).toBe('hq-work');
    expect(order).toEqual(['hq-work']);
  });

  it('mounts hq-work when getHandoff throws (upgraded install / missing key)', async () => {
    const mountLegacy = vi.fn();
    const shell = await bootDesktopAltWindow({
      getHandoff: async () => {
        throw new Error('menubar missing');
      },
      mountLegacy,
      mountHqWork: () => undefined,
    });
    expect(shell).toBe('hq-work');
    expect(mountLegacy).not.toHaveBeenCalled();
  });

  it('awaits mountHqWork without calling legacy', async () => {
    const order: string[] = [];
    const shell = await bootDesktopAltWindow({
      getHandoff: async () => {
        order.push('handoff');
        return true;
      },
      mountLegacy: () => {
        order.push('legacy');
      },
      mountHqWork: async () => {
        order.push('hq-work-start');
        await Promise.resolve();
        order.push('hq-work-end');
      },
    });
    expect(shell).toBe('hq-work');
    expect(order).toEqual(['hq-work-start', 'hq-work-end']);
  });
});
