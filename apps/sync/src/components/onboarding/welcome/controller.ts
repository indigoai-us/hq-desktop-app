import { FADE_MS, clamp01, trackPointer, type SceneEngine } from './engines';

/**
 * Drives the welcome flow's screens: one requestAnimationFrame loop that runs
 * ONLY the screen on show (plus the one fading out, for the length of the
 * cross-fade). A hidden screen does no work, and nothing runs at all while the
 * window is hidden: the loop stops on `visibilitychange` and resumes when the
 * window comes back.
 *
 * Reduced motion: every screen renders its settled frame once, with no loop,
 * exactly like the prototype (`RM`).
 *
 * Time spent hidden does not count: the screens run on a clock that stops
 * while the window is hidden, so a welcome that mounts before its window is
 * shown still plays from the start when the person first sees it.
 */
export interface WelcomeController {
  register(id: string, engine: SceneEngine): void;
  /** Show a screen. `settled` lands it on its final frame (Back into it). */
  show(id: string, options?: { holdMs?: number; settled?: boolean }): void;
  /** Finish the current screen's animation now. */
  fastForward(): void;
  /** Lay the current screen out again (window resize, content that changed height). */
  relayout(): void;
  /** Whether the frame loop is scheduled (for tests and diagnostics). */
  readonly running: boolean;
  readonly current: string | null;
  destroy(): void;
}

export interface WelcomeControllerOptions {
  reducedMotion: () => boolean;
  /** Fill of the current screen's progress tick, 0-1. */
  onTick?: (progress: number) => void;
  /**
   * A screen's motion threw. The motion is decoration in front of setup and
   * must never block it: the engine is dropped and the caller shows the
   * screen's settled state without it.
   */
  onError?: (id: string, error: unknown) => void;
  now?: () => number;
  raf?: (callback: FrameRequestCallback) => number;
  cancelRaf?: (handle: number) => void;
  doc?: Document;
  win?: Window;
}

export function createWelcomeController(options: WelcomeControllerOptions): WelcomeController {
  const now = options.now ?? (() => performance.now());
  const raf = options.raf ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const cancelRaf = options.cancelRaf ?? ((handle: number) => cancelAnimationFrame(handle));
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const engines = new Map<string, SceneEngine>();
  let current: string | null = null;
  let previous: string | null = null;
  let startAt = 0;
  let holdMs = 0;
  let handle: number | null = null;
  let destroyed = false;
  const broken = new Set<string>();
  /** Total time spent hidden; the screens' clock excludes it. */
  let pausedTotal = 0;
  let hiddenSince: number | null = null;

  /** Run one engine call; a throw retires that engine instead of the flow. */
  function guard(id: string | null, call: (engine: SceneEngine) => void): void {
    if (!id || broken.has(id)) return;
    const engine = engines.get(id);
    if (!engine) return;
    try {
      call(engine);
    } catch (error) {
      broken.add(id);
      console.error(`welcome: the ${id} screen's motion failed, showing it without`, error);
      options.onError?.(id, error);
    }
  }

  const hidden = () => doc.visibilityState === 'hidden';
  if (hidden()) hiddenSince = now();
  /** The screens' clock: real time minus time spent hidden. */
  const clock = (real: number) => real - pausedTotal;

  function schedule() {
    if (destroyed || handle !== null || options.reducedMotion() || hidden() || !current) return;
    handle = raf(loop);
  }

  function stop() {
    if (handle !== null) cancelRaf(handle);
    handle = null;
  }

  function loop(real: number) {
    handle = null;
    if (destroyed || !current) return;
    const time = clock(real);
    const elapsed = time - startAt;
    guard(current, (engine) => engine.frame(time));
    if (previous && elapsed < FADE_MS) guard(previous, (engine) => engine.frame(time));
    else previous = null;
    if (holdMs > 0) options.onTick?.(clamp01(elapsed / holdMs));
    schedule();
  }

  const onVisibility = () => {
    if (hidden()) {
      if (hiddenSince === null) hiddenSince = now();
      stop();
      return;
    }
    if (hiddenSince !== null) {
      pausedTotal += Math.max(0, now() - hiddenSince);
      hiddenSince = null;
    }
    schedule();
  };
  const onResize = () => relayout();
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('resize', onResize);
  const untrackPointer = trackPointer(win);

  function relayout() {
    if (!current) return;
    guard(current, (engine) => {
      engine.size();
      if (options.reducedMotion()) engine.frame(clock(now()));
    });
  }

  return {
    register(id, engine) {
      engines.set(id, engine);
    },
    show(id, { holdMs: hold = 0, settled = false } = {}) {
      if (destroyed) return;
      if (current && current !== id) {
        guard(current, (engine) => engine.exit?.());
        previous = current;
      }
      const real = clock(now());
      const rm = options.reducedMotion();
      // Reduced motion enters every screen already 30s in: all of its beats
      // have fired and every canvas draws its settled frame.
      const at = rm ? real - 30000 : real;
      current = id;
      startAt = at;
      holdMs = hold;
      guard(id, (engine) => {
        engine.size();
        engine.enter(at);
        if (settled) engine.skip();
      });
      if (rm) {
        previous = null;
        guard(id, (engine) => engine.frame(real));
        options.onTick?.(1);
        return;
      }
      schedule();
    },
    fastForward() {
      guard(current, (engine) => {
        engine.skip();
        if (options.reducedMotion()) engine.frame(clock(now()));
      });
    },
    relayout,
    get running() {
      return handle !== null;
    },
    get current() {
      return current;
    },
    destroy() {
      destroyed = true;
      stop();
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('resize', onResize);
      untrackPointer();
      for (const id of engines.keys()) guard(id, (engine) => engine.destroy?.());
      engines.clear();
    },
  };
}
