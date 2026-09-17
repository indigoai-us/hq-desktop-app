/**
 * Browser-side measurement code for the local perf harness.
 *
 * Everything here is stringified and injected into the page (as an init script
 * or via page.evaluate), so it must be self-contained ES5-ish JavaScript with
 * no imports and no closure over Node scope.
 *
 * WHY requestAnimationFrame DELTAS RATHER THAN A CDP TRACE
 * -------------------------------------------------------
 * Both were tried. The `devtools.timeline` trace gives you DrawFrame / Commit
 * events, which are the truest picture of what the compositor did — but the
 * event names, their phases and their nesting change between Chromium
 * revisions, so a parser written against one Playwright version silently
 * reports zero frames against the next. rAF deltas are stable API, they are
 * measured from inside the page on the same clock as everything else here, and
 * for the question the owner is actually asking ("does scrolling feel choppy?")
 * they answer it directly: a rAF callback that runs 33ms after the previous one
 * IS a dropped frame from the user's point of view.
 *
 * The trade-off, documented so nobody is misled: rAF cannot see work that
 * happens after the callback (a long paint at the end of a frame shows up on
 * the NEXT delta, not this one), and it cannot see frames the compositor
 * produced without the main thread. For a main-thread-bound shell — which is
 * exactly what a choppy Svelte app is — that is the right lens.
 */

/**
 * Installed via addInitScript BEFORE any app code runs, so the observers are
 * live for the very first paint. Everything lands on `window.__hqPerf`.
 */
export const INIT_SCRIPT = String(function installHqPerf() {
  var perf = {
    paint: {},
    longTasks: [],
    mutationBatches: 0,
    shellReadyAt: null,
    navStart:
      typeof performance !== "undefined" && performance.timeOrigin
        ? performance.timeOrigin
        : Date.now(),
  };
  window.__hqPerf = perf;

  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        perf.paint[entry.name] = entry.startTime;
      });
    }).observe({ type: "paint", buffered: true });
  } catch (e) {
    /* paint timing unsupported */
  }

  try {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      // LCP fires repeatedly; the LAST entry is the real one.
      perf.paint["largest-contentful-paint"] =
        entries[entries.length - 1].startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {
    /* LCP unsupported */
  }

  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        perf.longTasks.push({ start: entry.startTime, duration: entry.duration });
      });
    }).observe({ type: "longtask", buffered: true });
  } catch (e) {
    /* long tasks unsupported */
  }

  // "How many times did the UI re-render?" — a DOM mutation batch is the
  // closest observable proxy: Svelte's effects flush into one microtask, so one
  // MutationObserver callback ~ one render pass. Counting individual mutation
  // records would over-count a single list re-key as hundreds of renders.
  try {
    var observer = new MutationObserver(function () {
      perf.mutationBatches += 1;
    });
    var start = function () {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start);
  } catch (e) {
    /* no MutationObserver */
  }
});

/**
 * Poll for the shell being genuinely usable and stamp the time.
 *
 * We deliberately do NOT add a `performance.mark()` to app source: the source
 * files are owned by other work in flight, and a diagnostic must not change the
 * thing it measures. Instead "interactive" is defined observably, from outside:
 * the conversation rail exists AND has painted at least one conversation row
 * (or its skeleton), i.e. the user has something to click.
 */
export const SHELL_READY_SELECTORS = [
  '[data-testid="chat-sidebar"]',
  ".chat-sidebar",
  '[data-testid="desktop-shell"]',
  ".desktop-shell",
];

/**
 * Collect N frame deltas while `driver` runs. Returns raw deltas in ms so the
 * Node side owns all statistics (and can re-derive different thresholds later
 * from a stored run file).
 */
export const FRAME_CAPTURE = String(function captureFrames(durationMs) {
  return new Promise(function (resolve) {
    var deltas = [];
    var last = performance.now();
    var stopAt = last + durationMs;
    function tick(now) {
      deltas.push(now - last);
      last = now;
      if (now < stopAt) requestAnimationFrame(tick);
      else resolve(deltas);
    }
    requestAnimationFrame(tick);
  });
});

/** A frame budget of 60Hz. Anything longer than this is a dropped frame. */
export const FRAME_BUDGET_MS = 1000 / 60;

/**
 * Turn raw rAF deltas into the numbers a human cares about.
 *
 * The first delta is dropped: it measures the gap from "we called
 * requestAnimationFrame" to "the browser served the next frame", which is a
 * scheduling artefact, not a frame time.
 */
export function frameStats(deltas, budgetMs = FRAME_BUDGET_MS) {
  const frames = deltas.slice(1);
  if (frames.length === 0) {
    return { frames: 0, avgMs: NaN, worstMs: NaN, dropped: 0, droppedPct: NaN };
  }
  const dropped = frames.filter((d) => d > budgetMs).length;
  return {
    frames: frames.length,
    avgMs: frames.reduce((a, b) => a + b, 0) / frames.length,
    worstMs: Math.max(...frames),
    dropped,
    droppedPct: (dropped / frames.length) * 100,
  };
}

/** Total main-thread time spent in >50ms tasks over a window. */
export function longTaskBusyMs(longTasks, fromMs = 0) {
  return longTasks
    .filter((t) => t.start >= fromMs)
    .reduce((acc, t) => acc + t.duration, 0);
}
