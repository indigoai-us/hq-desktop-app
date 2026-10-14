/**
 * Line-by-line reveal for bot replies (the flowtoken idea, done natively in
 * Svelte so no React or new dependency ships).
 *
 * flowtoken fades streamed text in piece by piece. HQ bot replies do not
 * stream: the host polls the timeline and a reply lands whole. So a reply
 * that arrives while the conversation is open fades in one line at a time —
 * each paragraph, list item, heading, quote, table row or code block is one
 * unit — on a bounded, staggered schedule. If a body ever grows in place (a
 * partial update with the same event id), only the newly appended lines
 * animate. History loads and human messages render instantly, and
 * `prefers-reduced-motion` turns the effect off.
 *
 * While a reveal runs and the reader is pinned to the bottom, the timeline
 * eases down to follow it with one rAF-driven scroll (`smoothFollow`). A
 * reader who has scrolled up is never moved.
 */

/** Delay between consecutive lines. */
export const REVEAL_LINE_STEP_MS = 90;
/** The last line starts no later than this, however long the reply. */
export const REVEAL_MAX_DURATION_MS = 1500;
/** Fade length for one line. */
export const REVEAL_LINE_ANIMATION_MS = 220;

export interface RevealSchedule {
  /** Delay between consecutive lines, in ms. 0 = show instantly. */
  stepMs: number;
  /** Time until the last line finishes animating, in ms. */
  totalMs: number;
}

/**
 * Schedule `count` new lines: a fixed stagger, shrunk so the last line starts
 * within `maxDurationMs`. Reduced motion or nothing to reveal is instant.
 */
export function planReveal(
  count: number,
  opts: { reducedMotion?: boolean; stepMs?: number; maxDurationMs?: number } = {},
): RevealSchedule {
  if (opts.reducedMotion || count <= 0) return { stepMs: 0, totalMs: 0 };
  const natural = opts.stepMs ?? REVEAL_LINE_STEP_MS;
  const max = opts.maxDurationMs ?? REVEAL_MAX_DURATION_MS;
  const stepMs = count > 1 ? Math.min(natural, max / (count - 1)) : 0;
  return { stepMs, totalMs: stepMs * (count - 1) + REVEAL_LINE_ANIMATION_MS };
}

/**
 * How many leading lines of the new body were already shown. A body that
 * grew by appending keeps its earlier lines (the last one re-settles, since
 * it may have been mid-stream); a body that changed in the middle reveals
 * nothing new, so an edit never replays.
 */
export function revealedPrefixLines(
  prevText: string,
  prevLines: number,
  nextText: string,
  nextLines: number,
): number {
  if (!prevText) return 0;
  if (!nextText.startsWith(prevText.trimEnd())) return nextLines;
  return Math.max(0, Math.min(prevLines, nextLines) - 1);
}

/** Containers whose children are the lines. */
const CONTAINER = "ul, ol, table, thead, tbody, tfoot";

/**
 * The line units of a rendered body, in order: list items, table rows and
 * every other top-level block. Bare top-level text is wrapped in a span so it
 * can fade too.
 */
export function lineUnits(root: HTMLElement): HTMLElement[] {
  const units: HTMLElement[] = [];
  const collect = (parent: Element) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 3) {
        if (!(child.textContent ?? "").trim() || parent !== root) continue;
        const span = root.ownerDocument.createElement("span");
        span.dataset.revealText = "";
        child.parentNode?.replaceChild(span, child);
        span.appendChild(child);
        units.push(span);
      } else if (child.nodeType === 1) {
        const el = child as HTMLElement;
        if (el.matches(CONTAINER)) collect(el);
        else units.push(el);
      }
    }
  };
  collect(root);
  return units;
}

/**
 * Decides which messages reveal. The first snapshot of a conversation once
 * loading has finished is history: seeded, never animated. After that an id
 * reveals only if it is new, is a bot message, and lands after the previously
 * newest message, so "load earlier" pages never animate.
 */
export class RevealTracker {
  private key: string | null | undefined = undefined;
  private known = new Set<string>();
  private seeded = false;
  readonly reveal = new Set<string>();

  observe(
    key: string | null,
    rows: ReadonlyArray<{ id: string; bot: boolean }>,
    loading = false,
  ): ReadonlySet<string> {
    if (key !== this.key) {
      this.key = key;
      this.known = new Set();
      this.reveal.clear();
      this.seeded = false;
    }
    if (!this.seeded) {
      if (loading) return this.reveal;
      for (const row of rows) this.known.add(row.id);
      this.seeded = true;
      return this.reveal;
    }
    let lastKnown = -1;
    rows.forEach((row, i) => {
      if (this.known.has(row.id)) lastKnown = i;
    });
    rows.forEach((row, i) => {
      if (this.known.has(row.id)) return;
      this.known.add(row.id);
      if (row.bot && i > lastKnown) this.reveal.add(row.id);
    });
    return this.reveal;
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function clearUnits(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".reveal-line"))) {
    el.classList.remove("reveal-line");
    el.style.animationDelay = "";
  }
  for (const span of Array.from(root.querySelectorAll("span[data-reveal-text]"))) {
    span.replaceWith(...Array.from(span.childNodes));
  }
}

export interface RevealParams {
  /** Animate this body. False renders instantly. */
  active: boolean;
  /** The body text; a change re-runs the reveal for new lines only. */
  text: string;
  /** Told when a reveal starts, with its duration (drives scroll follow). */
  onreveal?: (totalMs: number) => void;
}

/**
 * Svelte action for a rendered message body. Runs after `{@html}` paints and
 * removes its classes when the reveal ends, so the DOM is back to what the
 * renderer produced.
 */
export function revealLines(node: HTMLElement, params: RevealParams) {
  let shownText = "";
  let shownLines = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    clearUnits(node);
    node.removeAttribute("data-revealing");
  };

  const run = (p: RevealParams) => {
    const prevText = shownText;
    const prevLines = shownLines;
    finish();
    const units = lineUnits(node);
    shownText = p.text;
    shownLines = units.length;
    if (!p.active || prefersReducedMotion()) {
      clearUnits(node);
      return;
    }
    const skip = revealedPrefixLines(prevText, prevLines, p.text, units.length);
    const fresh = units.slice(skip);
    const plan = planReveal(fresh.length);
    if (plan.totalMs === 0) {
      clearUnits(node);
      return;
    }
    fresh.forEach((el, i) => {
      el.classList.add("reveal-line");
      el.style.animationDelay = `${Math.round(i * plan.stepMs)}ms`;
    });
    node.dataset.revealing = "true";
    timer = setTimeout(finish, plan.totalMs + 50);
    p.onreveal?.(plan.totalMs);
  };

  run(params);
  return {
    update(next: RevealParams) {
      if (next.text === shownText) return;
      run(next);
    },
    destroy() {
      if (timer) clearTimeout(timer);
    },
  };
}

export interface FollowOptions {
  /** How long to keep easing toward the bottom, in ms. */
  durationMs: number;
  /** Called once when following ends; `scrolledAway` = the reader took over. */
  ondone?: (scrolledAway: boolean) => void;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
}

/**
 * Ease `el` down to its bottom for `durationMs` with a single rAF loop. Each
 * frame closes a share of the remaining gap, so the view glides instead of
 * snapping per line. If the reader scrolls up (scrollTop drops below what
 * this loop last wrote), following stops and never pulls them back.
 * Returns a cancel function.
 */
export function smoothFollow(el: HTMLElement, opts: FollowOptions): () => void {
  const raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = opts.caf ?? ((id) => cancelAnimationFrame(id));
  const now = opts.now ?? (() => performance.now());
  const end = now() + opts.durationMs;
  let id = 0;
  let stopped = false;
  let written = el.scrollTop;
  const stop = (scrolledAway: boolean) => {
    if (stopped) return;
    stopped = true;
    opts.ondone?.(scrolledAway);
  };
  const frame = () => {
    if (stopped) return;
    if (el.scrollTop < written - 1) {
      stop(true);
      return;
    }
    const target = el.scrollHeight - el.clientHeight;
    const gap = target - el.scrollTop;
    if (gap > 0.5) el.scrollTop = el.scrollTop + Math.max(1, Math.ceil(gap * 0.2));
    written = el.scrollTop;
    const remaining = el.scrollHeight - el.clientHeight - el.scrollTop;
    if (now() < end || remaining > 0.5) id = raf(frame);
    else stop(false);
  };
  id = raf(frame);
  return () => {
    caf(id);
    stop(false);
  };
}
