import { describe, expect, it, vi } from 'vitest';
import { bootDesktopAltWindow, resolveDesktopAltShell } from './boot';

describe('resolveDesktopAltShell', () => {
  it('returns hq-work only for a strict true handoff', async () => {
    expect(await resolveDesktopAltShell(async () => true)).toBe('hq-work');
    expect(await resolveDesktopAltShell(async () => false)).toBe('legacy');
  });

  it('falls back to legacy when getHandoff throws', async () => {
    expect(
      await resolveDesktopAltShell(async () => {
        throw new Error('menubar missing');
      }),
    ).toBe('legacy');
  });
});

describe('bootDesktopAltWindow', () => {
  it('mounts legacy when getHandoff returns false, without calling mountHqWork', async () => {
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
    expect(shell).toBe('legacy');
    expect(order).toEqual(['handoff', 'legacy']);
  });

  it('mounts legacy when getHandoff throws', async () => {
    const mountLegacy = vi.fn();
    const mountHqWork = vi.fn(() => {
      throw new Error('must not mount HQ Work when the flag cannot be read');
    });
    const shell = await bootDesktopAltWindow({
      getHandoff: async () => {
        throw new Error('menubar missing');
      },
      mountLegacy,
      mountHqWork,
    });
    expect(shell).toBe('legacy');
    expect(mountLegacy).toHaveBeenCalledOnce();
    expect(mountHqWork).not.toHaveBeenCalled();
  });

  it('awaits mountHqWork after a truthy handoff, without calling legacy', async () => {
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
    expect(order).toEqual(['handoff', 'hq-work-start', 'hq-work-end']);
  });
});
