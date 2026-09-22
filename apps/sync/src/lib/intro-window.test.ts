import { describe, expect, it, vi } from 'vitest';
import {
  enterIntroFullscreen,
  exitIntroFullscreen,
  INTRO_FADE_IN_MS,
  INTRO_FADE_OUT_MS,
  SET_INTRO_FULLSCREEN,
} from './intro-window';

describe('intro window: full screen, faded over the desktop', () => {
  it('asks for the full-screen window with the entrance fade', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await enterIntroFullscreen(invoke);
    expect(invoke).toHaveBeenCalledWith(SET_INTRO_FULLSCREEN, {
      enabled: true,
      fadeMs: INTRO_FADE_IN_MS,
    });
  });

  it('reverses the fade on the way out', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await exitIntroFullscreen(invoke);
    expect(invoke).toHaveBeenCalledWith(SET_INTRO_FULLSCREEN, {
      enabled: false,
      fadeMs: INTRO_FADE_OUT_MS,
    });
  });

  it('fades in slowly enough to read as a blur arriving, and leaves faster', () => {
    expect(INTRO_FADE_IN_MS).toBeGreaterThanOrEqual(600);
    expect(INTRO_FADE_IN_MS).toBeLessThanOrEqual(900);
    expect(INTRO_FADE_OUT_MS).toBeLessThan(INTRO_FADE_IN_MS);
    expect(INTRO_FADE_OUT_MS).toBeGreaterThan(0);
  });

  it('waits for the restore before resolving', async () => {
    const order: string[] = [];
    const invoke = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            order.push('restored');
            resolve(undefined);
          }, 5);
        }),
    );
    await exitIntroFullscreen(invoke);
    order.push('after');
    expect(order).toEqual(['restored', 'after']);
  });

  it('never lets a window failure stop the film', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invoke = vi.fn().mockRejectedValue(new Error('no window'));
    await expect(enterIntroFullscreen(invoke)).resolves.toBeUndefined();
    await expect(exitIntroFullscreen(invoke)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
