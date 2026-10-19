/**
 * In-page probe for the command palette budget. perf-run.mjs passes this
 * function to `page.evaluate`, so it must not reference anything outside its
 * own body.
 *
 * - Start: the Cmd-K keydown's own `event.timeStamp`, so time the event
 *   waited in the page's queue counts.
 * - Ready: the palette input is visible (has a box, not under `[hidden]`)
 *   and at least one result row (`rowSelector`) has a box.
 * - End: from the first animation frame in which the palette is ready, a
 *   message posted on a MessageChannel. Its task runs after that frame's
 *   style, layout and paint, so the sample includes the paint and the wait
 *   for the frame. Compositor and display latency after the paint are not
 *   visible to the page and are not counted.
 *
 * A palette that never paints is a failure, not a missing sample: the probe
 * resolves with the elapsed time at the timeout (at least `readyTimeoutMs`
 * after the keydown, or `keyTimeoutMs` when no keydown arrives), which is far
 * over the 20 ms budget. It never resolves `null`.
 *
 * @param {string} rowSelector
 * @param {{ readyTimeoutMs?: number, keyTimeoutMs?: number }} [options]
 * @returns {Promise<number>}
 */
export function palettePaintedProbe(rowSelector, options) {
  const readyTimeoutMs = options?.readyTimeoutMs ?? 1000;
  const keyTimeoutMs = options?.keyTimeoutMs ?? 2000;
  return new Promise((res) => {
    const armed = performance.now();
    let t0 = 0;
    let settled = false;
    const visible = (el) => {
      if (!el || el.closest("[hidden]")) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const ready = () =>
      visible(document.querySelector('[data-testid="command-palette"] input')) &&
      visible(document.querySelector(rowSelector));
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKey, true);
      res(value);
    };
    const afterPaint = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => finish(performance.now() - t0);
      channel.port2.postMessage(0);
    };
    const frame = () => {
      if (settled) return;
      if (ready()) {
        afterPaint();
        return;
      }
      if (performance.now() - t0 >= readyTimeoutMs) {
        finish(performance.now() - t0);
        return;
      }
      requestAnimationFrame(frame);
    };
    const onKey = (event) => {
      if (t0) return;
      if (String(event.key).toLowerCase() !== "k") return;
      if (!event.metaKey && !event.ctrlKey) return;
      t0 = event.timeStamp || performance.now();
      requestAnimationFrame(frame);
    };
    // Capture on window runs before the shell's own handler.
    window.addEventListener("keydown", onKey, true);
    setTimeout(() => {
      if (!t0) finish(performance.now() - armed);
    }, keyTimeoutMs);
  });
}
