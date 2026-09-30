<script lang="ts">
  /**
   * Spotlight layer for the first-run guided tour. Dims the window, cuts a
   * rounded hole around the current step's target and anchors a small card
   * next to it. Steps advance on the card's buttons only; Esc skips.
   *
   * The step model, geometry and target resolution live in
   * `guided-tour.ts`; the host (`DesktopApp.svelte`) owns the step index and
   * the side effects of entering a step (navigation, the Launch menu).
   */
  import { onDestroy, tick } from "svelte";
  import {
    TOUR_TARGET_TIMEOUT_MS,
    placeTourCard,
    resolveTourTarget,
    scrimPath,
    spotlightRect,
    tourCanGoBack,
    tourPrimaryLabel,
    tourProgressLabel,
    unionTourRects,
    type TourRect,
    type TourStep,
  } from "./guided-tour.js";

  interface Props {
    step: TourStep;
    index: number;
    count: number;
    onnext: () => void;
    onback: () => void;
    onskip: () => void;
  }

  let { step, index, count, onnext, onback, onskip }: Props = $props();

  const titleId = "hq-tour-title";
  const bodyId = "hq-tour-body";

  let viewport = $state({ width: window.innerWidth, height: window.innerHeight });
  let target = $state<TourRect | null>(null);
  let timedOut = $state(false);
  let cardWidth = $state(0);
  let cardHeight = $state(0);
  let cardEl: HTMLDivElement | null = $state(null);
  let nextBtn: HTMLButtonElement | null = $state(null);

  let observed: Element | null = null;
  const resizeObserver =
    typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;

  function isShown(el: Element): boolean {
    if (el.closest("[data-hq-tour]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function firstShown(selector: string): Element | null {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (isShown(el)) return el;
    }
    return null;
  }

  function toRect(el: Element): TourRect {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  function sameRect(a: TourRect | null, b: TourRect | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
      Math.abs(a.top - b.top) < 0.5 &&
      Math.abs(a.left - b.left) < 0.5 &&
      Math.abs(a.width - b.width) < 0.5 &&
      Math.abs(a.height - b.height) < 0.5
    );
  }

  function measure(): void {
    if (viewport.width !== window.innerWidth || viewport.height !== window.innerHeight) {
      viewport = { width: window.innerWidth, height: window.innerHeight };
    }
    const resolved = resolveTourTarget(step.targets, firstShown);
    if (resolved?.element !== observed) {
      if (observed) resizeObserver?.unobserve(observed);
      observed = resolved?.element ?? null;
      if (observed) resizeObserver?.observe(observed);
    }
    let next: TourRect | null = null;
    if (resolved) {
      const extras = (step.include ?? []).map((sel) => {
        const el = firstShown(sel);
        return el ? toRect(el) : null;
      });
      next = unionTourRects([toRect(resolved.element), ...extras]);
    }
    if (!sameRect(next, target)) target = next;
  }

  // Poll hard (every frame) for a short while after each step change, because
  // targets can mount late (a route change, the Launch menu opening), then
  // settle to a slow poll that keeps the cutout honest if layout shifts.
  let frame = 0;
  let slowTimer = 0;
  let giveUpTimer = 0;
  function stopPolling(): void {
    cancelAnimationFrame(frame);
    clearInterval(slowTimer);
    clearTimeout(giveUpTimer);
  }

  $effect(() => {
    // Re-run on every step change.
    void step.id;
    void index;
    target = null;
    timedOut = false;
    stopPolling();
    const started = performance.now();
    const loop = () => {
      measure();
      if (performance.now() - started < TOUR_TARGET_TIMEOUT_MS) {
        frame = requestAnimationFrame(loop);
      } else {
        slowTimer = window.setInterval(measure, 250);
      }
    };
    frame = requestAnimationFrame(loop);
    // A step with nothing to point at (no company yet) centers at once.
    if (step.targets.length === 0) timedOut = true;
    giveUpTimer = window.setTimeout(() => {
      if (!target) timedOut = true;
    }, TOUR_TARGET_TIMEOUT_MS);
    return stopPolling;
  });

  $effect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  });

  onDestroy(() => {
    stopPolling();
    resizeObserver?.disconnect();
  });

  // Focus Next on every step. Surfaces a step opens (the create modal, the
  // command palette) focus themselves on mount, so check again once they have.
  const REFOCUS_MS = 80;
  $effect(() => {
    void index;
    let timer = 0;
    void tick().then(() => {
      nextBtn?.focus({ preventScroll: true });
      timer = window.setTimeout(() => {
        const active = document.activeElement;
        if (!(active instanceof Node) || !cardEl?.contains(active)) {
          nextBtn?.focus({ preventScroll: true });
        }
      }, REFOCUS_MS);
    });
    return () => clearTimeout(timer);
  });

  const cutout = $derived(target ? spotlightRect(target, viewport) : null);
  const ready = $derived(Boolean(target) || timedOut);
  const position = $derived(
    placeTourCard(
      cutout,
      { width: cardWidth || 300, height: cardHeight || 140 },
      viewport,
      step.placement,
    ),
  );
  const primaryLabel = $derived(tourPrimaryLabel(index, count));

  // Registered on window in the capture phase when the tour mounts, so it
  // runs before the listeners of surfaces a step opens later (the create
  // modal's Escape and Tab trap); stopImmediatePropagation keeps those from
  // also acting on a key the tour handled.
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      onskip();
      return;
    }
    if (event.key !== "Tab" || !cardEl) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !cardEl.contains(active)) return;
    const buttons = Array.from(cardEl.querySelectorAll<HTMLButtonElement>("button"));
    if (buttons.length === 0) return;
    const at = buttons.indexOf(active as HTMLButtonElement);
    const next = event.shiftKey
      ? buttons[(at - 1 + buttons.length) % buttons.length]
      : buttons[(at + 1) % buttons.length];
    event.preventDefault();
    event.stopImmediatePropagation();
    next.focus();
  }
</script>

<svelte:window onkeydowncapture={onKeyDown} />

<div class="hq-tour" data-hq-tour data-testid="guided-tour" data-step={step.id}>
  <svg
    class="hq-tour-scrim"
    width={viewport.width}
    height={viewport.height}
    viewBox={`0 0 ${viewport.width} ${viewport.height}`}
    aria-hidden="true"
  >
    <path class="hq-tour-dim" fill-rule="evenodd" d={scrimPath(viewport, cutout)} />
    {#if cutout}
      <rect
        class="hq-tour-ring"
        data-testid="guided-tour-cutout"
        x={cutout.left}
        y={cutout.top}
        width={cutout.width}
        height={cutout.height}
        rx="10"
        ry="10"
      />
    {/if}
  </svg>

  <div
    class="hq-tour-card"
    class:is-ready={ready}
    data-placement={position.placement}
    data-testid="guided-tour-card"
    role="dialog"
    aria-modal="false"
    aria-labelledby={titleId}
    aria-describedby={bodyId}
    style:top={`${position.top}px`}
    style:left={`${position.left}px`}
    bind:this={cardEl}
    bind:offsetWidth={cardWidth}
    bind:offsetHeight={cardHeight}
  >
    {#if position.arrow !== null}
      <span
        class="hq-tour-arrow"
        aria-hidden="true"
        style:--hq-tour-arrow={`${position.arrow}px`}
      ></span>
    {/if}
    <p class="hq-tour-progress" data-testid="guided-tour-progress">
      {tourProgressLabel(index, count)}
    </p>
    <h2 class="hq-tour-title" id={titleId}>{step.title}</h2>
    <p class="hq-tour-body" id={bodyId}>{step.body}</p>
    <div class="hq-tour-actions">
      <button
        type="button"
        class="hq-tour-btn hq-tour-skip"
        data-testid="guided-tour-skip"
        onclick={onskip}
      >
        Skip
      </button>
      <span class="hq-tour-spacer"></span>
      {#if tourCanGoBack(index)}
        <button
          type="button"
          class="hq-tour-btn hq-tour-back"
          data-testid="guided-tour-back"
          onclick={onback}
        >
          Back
        </button>
      {/if}
      <button
        type="button"
        class="hq-tour-btn hq-tour-next"
        data-testid="guided-tour-next"
        bind:this={nextBtn}
        onclick={onnext}
      >
        {primaryLabel}
      </button>
    </div>
  </div>
</div>

<style>
  /* Above tooltips (10001) and the titlebar menus (10000), below
     ConfirmDialog (40000). */
  .hq-tour {
    position: fixed;
    inset: 0;
    z-index: 20000;
    pointer-events: none;
  }

  .hq-tour-scrim {
    position: absolute;
    inset: 0;
    display: block;
    pointer-events: none;
  }

  /* Hits follow the painted fill, so the dimmed area blocks clicks and the
     evenodd hole lets them reach the spotlit target. */
  .hq-tour-dim {
    fill: rgba(0, 0, 0, 0.55);
    pointer-events: visiblePainted;
  }

  .hq-tour-ring {
    fill: none;
    stroke: rgba(255, 255, 255, 0.35);
    stroke-width: 1;
    pointer-events: none;
  }

  .hq-tour-card {
    position: absolute;
    box-sizing: border-box;
    width: 300px;
    max-width: calc(100vw - 24px);
    padding: 12px 14px 12px;
    border: 1px solid var(--panel-border, var(--line2));
    border-radius: 10px;
    /* --v4-popover-strong (the Launch menu's surface) laid over the solid
       surface, so body copy under the card never reads through it. */
    background:
      linear-gradient(
        var(--v4-popover-strong, var(--panel-bg, var(--btn-bg))),
        var(--v4-popover-strong, var(--panel-bg, var(--btn-bg)))
      ),
      var(--v4-surface-solid, var(--panel-bg, #fff));
    box-shadow: var(--v4-shadow-popover, 0 22px 55px rgba(0, 0, 0, 0.22));
    color: var(--v4-text-1, var(--t1));
    pointer-events: auto;
    opacity: 0;
    transition:
      opacity 160ms ease,
      top 200ms ease,
      left 200ms ease;
  }

  .hq-tour-card.is-ready {
    opacity: 1;
  }

  .hq-tour-arrow {
    position: absolute;
    width: 10px;
    height: 10px;
    background: inherit;
    border: 1px solid var(--panel-border, var(--line2));
    transform: rotate(45deg);
  }

  /* Card below the target: arrow on the card's top edge, and so on. */
  [data-placement="bottom"] > .hq-tour-arrow {
    top: -6px;
    left: calc(var(--hq-tour-arrow) - 5px);
    border-right: 0;
    border-bottom: 0;
  }

  [data-placement="top"] > .hq-tour-arrow {
    bottom: -6px;
    left: calc(var(--hq-tour-arrow) - 5px);
    border-left: 0;
    border-top: 0;
  }

  [data-placement="right"] > .hq-tour-arrow {
    left: -6px;
    top: calc(var(--hq-tour-arrow) - 5px);
    border-right: 0;
    border-top: 0;
  }

  [data-placement="left"] > .hq-tour-arrow {
    right: -6px;
    top: calc(var(--hq-tour-arrow) - 5px);
    border-left: 0;
    border-bottom: 0;
  }

  .hq-tour-progress {
    margin: 0 0 4px;
    font-size: 11px;
    font-weight: 500;
    color: var(--v4-text-3, var(--t3));
  }

  .hq-tour-title {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
  }

  .hq-tour-body {
    margin: 0 0 12px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--v4-text-2, var(--t2));
  }

  .hq-tour-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .hq-tour-spacer {
    flex: 1 1 auto;
  }

  .hq-tour-btn {
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    padding: 7px 12px;
    border-radius: 7px;
    border: 1px solid transparent;
    cursor: pointer;
  }

  .hq-tour-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, currentColor);
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .hq-tour-skip {
    padding-left: 4px;
    padding-right: 4px;
    background: none;
    color: var(--v4-text-2, var(--t2));
  }

  .hq-tour-skip:hover {
    color: var(--v4-text-1, var(--t1));
  }

  .hq-tour-back {
    background: var(--v4-secondary-bg, var(--v4-control-bg));
    color: var(--v4-secondary-fg, var(--v4-text-1));
    border-color: var(--v4-control-border, transparent);
  }

  .hq-tour-next {
    min-width: 64px;
    background: var(--v4-primary-bg, #000);
    color: var(--v4-primary-fg, #fff);
  }

  @media (prefers-reduced-motion: reduce) {
    .hq-tour-card {
      transition: none;
    }
  }
</style>
