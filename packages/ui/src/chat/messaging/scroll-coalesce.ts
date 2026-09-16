/**
 * Collapse a burst of scroll events into at most two reads per frame.
 *
 * A scroll handler that reads `scrollHeight` forces the engine to flush layout
 * before it can answer. macOS momentum scrolling delivers scroll events faster
 * than frames — several per frame during a flick — so a handler that reads
 * geometry directly pays that flush several times for a single painted frame,
 * and each flush is main-thread work delaying the frame it is measuring.
 *
 * LEADING PLUS TRAILING, not one or the other. Both edges are load-bearing:
 *
 *   Leading — the first event of a burst runs synchronously, inside the event.
 *   Callers (and tests) can dispatch a scroll and observe its effect without
 *   waiting for a frame. A trailing-only throttle silently breaks that
 *   contract: "scroll to the top loads older messages" stops being true until
 *   a frame happens to run, which is a behaviour change dressed up as an
 *   optimisation.
 *
 *   Trailing — the events suppressed during the frame still moved the
 *   scroller, so the position at the end of the burst differs from the one the
 *   leading call read. Without a trailing run the scroller can come to rest
 *   somewhere the handler never observed, leaving stickiness stale exactly
 *   when a flick ends at the bottom.
 *
 * Net effect during a flick: 2 layout flushes per frame instead of one per
 * event, with no observable change in when the handler responds.
 *
 * Do NOT use this for a handler that must observe every position — scroll
 * distance accumulation, or animation driven off event count. Those need each
 * event, and suppressing any of them changes the result.
 */
export interface CoalescedScroll {
  /** Attach as the element's `onscroll`. */
  readonly onScroll: () => void;
  /** Cancel a pending frame. Call from the component's teardown. */
  readonly cancel: () => void;
}

export function coalesceScroll(
  run: () => void,
  scheduler: {
    request: (cb: () => void) => number;
    cancel: (handle: number) => void;
  } = {
    request: (cb) => requestAnimationFrame(cb),
    cancel: (h) => cancelAnimationFrame(h),
  },
): CoalescedScroll {
  let frame: number | null = null;
  let suppressed = false;

  return {
    onScroll() {
      if (frame !== null) {
        // Inside the current frame's window. Remember that the scroller moved
        // again so the trailing run happens; do not read geometry now.
        suppressed = true;
        return;
      }
      run();
      frame = scheduler.request(() => {
        frame = null;
        if (!suppressed) return;
        suppressed = false;
        run();
      });
    },
    cancel() {
      suppressed = false;
      if (frame === null) return;
      scheduler.cancel(frame);
      frame = null;
    },
  };
}
