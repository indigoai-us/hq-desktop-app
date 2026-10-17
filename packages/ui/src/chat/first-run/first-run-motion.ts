/**
 * First-run motion (US-010): the takeover leaves as part of one motion.
 *
 * The welcome window's last scene, the first-run takeover and the landing
 * view run as one sequence on the same wallpaper. Svelte removes a component's
 * DOM before its actions tear down, and packages/ui uses no Svelte
 * transitions, so the takeover cannot fade itself out. `fadeOutOnLeave`
 * leaves an inert copy of the takeover where it was and fades that copy out
 * over the view that replaced it, the same way the welcome flow fades an old
 * screen out.
 */

/** Under the 400ms per-step budget. */
export const FIRST_RUN_LEAVE_MS = 320;

/** The copy is removed by this time even if the animation never finishes. */
const LEAVE_SAFETY_MS = FIRST_RUN_LEAVE_MS + 200;

export const FIRST_RUN_LEAVING_ATTR = "data-first-run-leaving";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A copy of `node` that nothing can find, focus or click: test ids and ids
 * are dropped so queries and labels never resolve to it.
 */
function inertCopy(node: HTMLElement): HTMLElement {
  const copy = node.cloneNode(true) as HTMLElement;
  // cloneNode copies canvas attributes, but leaves its bitmap transparent.
  // Copy at backing resolution (including device-pixel scaling), before the
  // fading layer is attached. drawImage can copy tainted canvases without
  // reading their pixels back into JavaScript.
  const sources = node.querySelectorAll("canvas");
  const targets = copy.querySelectorAll("canvas");
  sources.forEach((source, index) => {
    const target = targets[index];
    target.width = source.width;
    target.height = source.height;
    try {
      // WebGL drawing buffers can be cleared after compositing without
      // drawImage throwing. Keep that surface instead of copying a blank one.
      if (!source.getContext("2d")) throw new Error("Non-2D canvas surface");
      const context = target.getContext("2d");
      if (!context) throw new Error("Canvas context unavailable");
      context.drawImage(source, 0, 0);
    } catch {
      // A browser may refuse a bitmap copy (including a lost GPU context).
      // Keep the existing surface in the inert layer until the fade ends.
      // The takeover is already detached and its drawing loop is stopped.
      target.replaceWith(source);
    }
  });
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    el.removeAttribute("data-testid");
    el.removeAttribute("id");
  }
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute(FIRST_RUN_LEAVING_ATTR, "");
  copy.inert = true;
  copy.style.pointerEvents = "none";
  return copy;
}

/**
 * Svelte action: when the node is destroyed, fade an inert copy of it out
 * over whatever replaced it. Skipped under prefers-reduced-motion, or where
 * the Web Animations API is missing, so the view changes at once there.
 */
export function fadeOutOnLeave(node: HTMLElement) {
  return {
    destroy() {
      if (typeof document === "undefined" || prefersReducedMotion()) return;
      if (typeof node.animate !== "function") return;
      const host =
        document.querySelector<HTMLElement>(".desktop-shell") ?? document.body;
      const copy = inertCopy(node);
      host.appendChild(copy);
      const remove = () => copy.remove();
      const safety = setTimeout(remove, LEAVE_SAFETY_MS);
      try {
        const animation = copy.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: FIRST_RUN_LEAVE_MS,
          easing: "ease-out",
          fill: "forwards",
        });
        animation.finished.then(
          () => {
            clearTimeout(safety);
            remove();
          },
          () => {
            clearTimeout(safety);
            remove();
          },
        );
      } catch (err) {
        console.warn("first-run: leave animation failed", err);
        clearTimeout(safety);
        remove();
      }
    },
  };
}
