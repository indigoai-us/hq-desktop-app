// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWelcomeController } from './controller';
import type { SceneEngine } from './engines';

function fakeEngine(): SceneEngine & { frames: number } {
  const engine = {
    frames: 0,
    size: vi.fn(),
    enter: vi.fn(),
    skip: vi.fn(),
    exit: vi.fn(),
    frame: vi.fn(() => {
      engine.frames += 1;
    }),
  };
  return engine;
}

function harness(reducedMotion = false) {
  let clock = 0;
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  let visibility: DocumentVisibilityState = 'visible';
  const listeners = new Map<string, () => void>();
  const doc = {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Document;
  const controller = createWelcomeController({
    reducedMotion: () => reducedMotion,
    now: () => clock,
    raf: (cb) => {
      const id = next++;
      queue.set(id, cb);
      return id;
    },
    cancelRaf: (id) => queue.delete(id),
    doc,
  });
  return {
    controller,
    /** Run one animation frame `ms` later. */
    step(ms = 16) {
      clock += ms;
      const pending = [...queue.values()];
      queue.clear();
      for (const cb of pending) cb(clock);
    },
    setHidden(hidden: boolean) {
      visibility = hidden ? 'hidden' : 'visible';
      listeners.get('visibilitychange')?.();
    },
    get queued() {
      return queue.size;
    },
  };
}

let active: ReturnType<typeof harness> | null = null;
afterEach(() => {
  active?.controller.destroy();
  active = null;
});

describe('welcome controller', () => {
  it('runs only the screen on show, plus the outgoing one during the cross-fade', () => {
    active = harness();
    const a = fakeEngine();
    const b = fakeEngine();
    const c = fakeEngine();
    active.controller.register('a', a);
    active.controller.register('b', b);
    active.controller.register('c', c);

    active.controller.show('a');
    active.step();
    expect(a.frames).toBe(1);
    expect(b.frames + c.frames).toBe(0);

    active.controller.show('b');
    active.step(100);
    expect(b.frames).toBe(1);
    expect(a.frames).toBe(2); // still fading out
    active.step(800); // past the 700ms cross-fade
    const aFrames = a.frames;
    active.step();
    active.step();
    expect(a.frames).toBe(aFrames);
    expect(c.frames).toBe(0);
  });

  it('stops all work while the window is hidden and resumes when it returns', () => {
    active = harness();
    const a = fakeEngine();
    active.controller.register('a', a);
    active.controller.show('a');
    active.step();
    expect(active.controller.running).toBe(true);

    active.setHidden(true);
    expect(active.controller.running).toBe(false);
    expect(active.queued).toBe(0);
    const frames = a.frames;
    active.step();
    expect(a.frames).toBe(frames);

    active.setHidden(false);
    expect(active.controller.running).toBe(true);
    active.step();
    expect(a.frames).toBe(frames + 1);
  });

  it('does not count time spent hidden: a screen shown while hidden still plays from its start', () => {
    active = harness();
    active.setHidden(true);
    const a = fakeEngine();
    const seen: number[] = [];
    a.frame = vi.fn((time: number) => {
      seen.push(time);
    });
    active.controller.register('a', a);
    active.controller.show('a');
    const enteredAt = (a.enter as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    active.step(10_000); // ten seconds hidden: nothing runs
    expect(seen).toHaveLength(0);
    active.setHidden(false);
    active.step(16);
    // The first visible frame is 16ms into the screen, not ten seconds.
    expect(seen[0]! - enteredAt).toBeLessThan(100);
  });

  it('renders the settled frame once under reduced motion, with no loop', () => {
    active = harness(true);
    const a = fakeEngine();
    active.controller.register('a', a);
    active.controller.show('a');
    expect(a.enter).toHaveBeenCalledWith(-30000);
    expect(a.frames).toBe(1);
    expect(active.controller.running).toBe(false);
  });

  it('lands a screen on its final frame when asked to (Back into it)', () => {
    active = harness();
    const a = fakeEngine();
    active.controller.register('a', a);
    active.controller.show('a', { settled: true });
    expect(a.skip).toHaveBeenCalledTimes(1);
  });

  it('retires a screen whose motion throws instead of stopping the flow', () => {
    const onError = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let clock = 0;
    const queue: FrameRequestCallback[] = [];
    const controller = createWelcomeController({
      reducedMotion: () => false,
      now: () => clock,
      raf: (cb) => queue.push(cb),
      cancelRaf: () => {},
      onError,
    });
    const broken = fakeEngine();
    broken.frame = vi.fn(() => {
      throw new Error('no canvas on this GPU');
    });
    const healthy = fakeEngine();
    controller.register('broken', broken);
    controller.register('healthy', healthy);

    controller.show('broken');
    clock += 16;
    queue.shift()?.(clock);
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
    // The loop carries on, and the next screen still animates.
    controller.show('healthy');
    clock += 1000;
    for (let i = 0; i < 3 && queue.length; i += 1) queue.shift()!(clock);
    expect(healthy.frames).toBeGreaterThan(0);
    expect(broken.frame).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('stops for good when destroyed', () => {
    active = harness();
    const a = fakeEngine();
    active.controller.register('a', a);
    active.controller.show('a');
    active.controller.destroy();
    expect(active.controller.running).toBe(false);
    active.step();
    expect(a.frames).toBe(0);
    active = null;
  });
});
