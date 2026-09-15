<script lang="ts">
  /**
   * The cinematic first-run intro — the film that plays the first time
   * somebody opens HQ, before the setup wizard asks them for anything.
   *
   * Structure mirrors the old Indigo full-page onboarding: a living
   * full-bleed gradient field, a logo overture, then a short sequence of
   * beats that say what HQ is. It is skippable at all times and it never
   * blocks setup — `onfinish` runs whether the film played out or was skipped.
   */
  import { onDestroy, onMount } from 'svelte';
  import GradientField from './GradientField.svelte';
  import '../../styles/design-system.css';
  import {
    BEAT_FADE_MS,
    INTRO_BEATS,
    OVERTURE_MS,
    beatAt,
    beatOpacity,
    beatStartMs,
    isWaitingForViewer,
    easeInOut,
    hueAt,
    reducedMotionBeats,
    takeoverOpacity,
    takeoverRadius,
    type IntroBeat,
  } from '../../lib/intro-sequence';

  interface Props {
    /** Runs when the film ends, is skipped, or is dismissed with Escape. */
    onfinish?: () => void | Promise<void>;
    /** Test seam: force reduced motion without a matchMedia stub. */
    forceReducedMotion?: boolean;
    /**
     * Design/test seam: open on a given beat instead of the overture, so a
     * single scene can be inspected without waiting out the film. Ignored in
     * the shipped first-run path, which always starts at 0.
     */
    startAtBeat?: number | null;
  }

  let { onfinish, forceReducedMotion = false, startAtBeat = null }: Props = $props();

  let reduced = $state(false);
  let beats = $state<IntroBeat[]>([...INTRO_BEATS]);
  let elapsed = $state(0);
  let finished = $state(false);
  let raf = 0;
  let lastFrame = 0;

  /**
   * Cap on a single frame's advance. A backgrounded window throttles
   * `requestAnimationFrame` but not the clock, so resuming with a raw
   * `now - start` jumps several beats at once and the viewer sees the film
   * teleport. Advancing by a clamped delta instead means a stalled window
   * simply pauses the film and picks up where it left off.
   */
  const MAX_FRAME_MS = 100;

  const position = $derived(beatAt(elapsed, beats));
  const hue = $derived(hueAt(elapsed, beats));
  // The field starts near-black and blooms up through the overture, so the
  // logo arrives out of darkness rather than on top of a busy background.
  const intensity = $derived(
    elapsed < OVERTURE_MS ? 0.25 + 0.75 * easeInOut(elapsed / OVERTURE_MS) : 1,
  );
  const overtureProgress = $derived(Math.min(1, elapsed / OVERTURE_MS));
  // Reduced motion gets the end state immediately — no iris, no bloom.
  const irisRadius = $derived(reduced ? 1.4 : takeoverRadius(elapsed));
  const fieldOpacity = $derived(reduced ? 1 : takeoverOpacity(elapsed));
  const inOverture = $derived(position.index < 0);
  const lastBeatIndex = $derived(beats.length - 1);
  // True while a self-paced beat is holding for the person to read it.
  const waiting = $derived(isWaitingForViewer(elapsed, beats));

  function tick(now: number) {
    if (lastFrame === 0) lastFrame = now;
    const delta = Math.min(MAX_FRAME_MS, Math.max(0, now - lastFrame));
    lastFrame = now;
    // A self-paced beat stops the clock rather than the loop: the gradient
    // field keeps breathing on its own rAF, so the screen stays alive while
    // the person reads.
    if (!isWaitingForViewer(elapsed, beats)) elapsed += delta;
    if (beatAt(elapsed, beats).complete) {
      void complete();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  async function complete() {
    if (finished) return;
    finished = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    await onfinish?.();
  }

  /**
   * Move to the next beat. On a self-paced beat this is the only thing that
   * restarts the clock; elsewhere it lets somebody skip ahead of a hold.
   */
  function advance() {
    const { index, complete: done } = beatAt(elapsed, beats);
    if (done || index >= lastBeatIndex) {
      void complete();
      return;
    }
    elapsed = beatStartMs(Math.max(0, index) + 1, beats);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void complete();
      return;
    }
    if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      advance();
    }
  }

  onMount(() => {
    reduced = forceReducedMotion;
    if (!forceReducedMotion && typeof window.matchMedia === 'function') {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    if (reduced) beats = reducedMotionBeats(INTRO_BEATS);
    if (startAtBeat !== null && startAtBeat >= 0) {
      elapsed = beatStartMs(startAtBeat, beats) + BEAT_FADE_MS;
    }
    raf = requestAnimationFrame(tick);
    window.addEventListener('keydown', onKey);
  });

  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
  });
</script>

<div
  class="intro"
  data-testid="cinematic-intro"
  style={`--iris:${(irisRadius * 100).toFixed(2)}%; --field-opacity:${fieldOpacity.toFixed(3)};`}
>
  <!-- The window itself carries native frosted material, so what sits behind
       this element is the person's own blurred desktop. The colour field
       irises open over it: HQ arrives in the room they are already in. -->
  <div class="field-mask" aria-hidden="true">
    <GradientField {hue} {intensity} still={reduced} />
  </div>

  <div class="drag-strip" data-tauri-drag-region></div>

  <!-- One live region carries the whole film for screen readers: the visual
       cross-fade is decoration, the copy is the content. -->
  <div class="sr-only" aria-live="polite">
    {inOverture ? 'Welcome to HQ' : beats[position.index]?.title}
  </div>

  <!-- A soft dark scrim sized to the copy block. The shader's own centre
       scrim handles the general case, but the colour bodies drift, and a beat
       that fills the stage with a table needs a guarantee, not a tendency. -->
  <div class="stage-scrim" aria-hidden="true"></div>

  <div class="stage" aria-hidden="true">
    <div
      class="overture"
      class:gone={!inOverture}
      style={`--p:${overtureProgress};`}
    >
      <div class="mark"><svg viewBox="0 0 280 161" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M85.7251 3.66162H118.034V154.434H85.7251V89.8175H32.3085V154.434H0V3.66162H32.3085V57.5091H85.7251V3.66162Z" fill="currentColor"/><path d="M257.169 160.035L241.014 144.096C235.343 147.973 229.096 150.988 222.276 153.142C215.527 155.296 208.419 156.373 200.952 156.373C190.757 156.373 181.172 154.363 172.197 150.342C163.223 146.25 155.325 140.65 148.505 133.542C141.684 126.362 136.335 118.07 132.458 108.664C128.581 99.187 126.642 89.0278 126.642 78.1865C126.642 67.417 128.581 57.3296 132.458 47.9242C136.335 38.4471 141.684 30.1187 148.505 22.939C155.325 15.7593 163.223 10.1592 172.197 6.1386C181.172 2.0462 190.757 0 200.952 0C211.219 0 220.84 2.0462 229.814 6.1386C238.789 10.1592 246.686 15.7593 253.507 22.939C260.328 30.1187 265.641 38.4471 269.446 47.9242C273.323 57.3296 275.261 67.417 275.261 78.1865C275.261 86.0123 274.184 93.5151 272.031 100.695C269.948 107.803 267.077 114.444 263.415 120.618L280 137.203L257.169 160.035ZM200.952 124.065C203.896 124.065 206.732 123.741 209.46 123.095C212.26 122.449 214.952 121.552 217.537 120.403L208.491 111.357L231.322 88.5252L239.291 96.4946C240.512 93.6946 241.409 90.7509 241.984 87.6637C242.63 84.5764 242.953 81.4173 242.953 78.1865C242.953 71.8684 241.84 65.9452 239.614 60.4168C237.461 54.8885 234.445 50.0422 230.568 45.878C226.691 41.642 222.204 38.3394 217.106 35.9701C212.08 33.529 206.696 32.3085 200.952 32.3085C195.208 32.3085 189.788 33.529 184.69 35.9701C179.664 38.3394 175.213 41.642 171.336 45.878C167.459 50.0422 164.407 54.8885 162.182 60.4168C160.028 65.9452 158.951 71.8684 158.951 78.1865C158.951 84.5046 160.028 90.4637 162.182 96.0638C164.407 101.592 167.459 106.474 171.336 110.71C175.213 114.875 179.664 118.141 184.69 120.511C189.788 122.88 195.208 124.065 200.952 124.065Z" fill="currentColor"/></svg></div>
      <p class="welcome">Welcome to HQ</p>
    </div>

    {#each beats as beat, index (beat.id)}
      <div
        class="beat"
        class:still={reduced}
        class:wide={beat.kind !== 'statement'}
        style={`opacity:${reduced ? (position.index === index ? 1 : 0) : beatOpacity(index, elapsed, beats)};`}
        data-beat={beat.id}
      >
        <span class="ordinal">{String(index + 1).padStart(2, '0')}</span>
        <h2 class="title" class:small={beat.kind !== 'statement'}>{beat.title}</h2>
        <p class="body">{beat.body}</p>

        {#if beat.kind === 'surfaces' && beat.surfaces}
          <dl class="surfaces">
            {#each beat.surfaces as row (row.name)}
              <div class="surface-row">
                <dt class="surface-name">{row.name}</dt>
                <dd class="surface-meaning">{row.meaning}</dd>
              </div>
            {/each}
          </dl>
        {/if}

        {#if beat.kind === 'shortcuts' && beat.shortcuts}
          <ul class="shortcuts">
            {#each beat.shortcuts as row (row.does)}
              <li class="shortcut-row">
                <span class="caps">
                  {#each row.keys as cap (cap)}
                    <kbd class="cap">{cap}</kbd>
                  {/each}
                </span>
                <span class="shortcut-does">{row.does}</span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if beat.kind === 'steps' && beat.steps}
          <ol class="steps">
            {#each beat.steps as step, stepIndex (step.title)}
              <li class="step-row">
                <span class="step-num">{stepIndex + 1}</span>
                <span class="step-copy">
                  <span class="step-title">{step.title}</span>
                  <span class="step-detail">{step.detail}</span>
                </span>
              </li>
            {/each}
          </ol>
        {/if}
      </div>
    {/each}
  </div>

  <div class="rail">
    <div class="ticks" aria-hidden="true">
      {#each beats as beat, index (beat.id)}
        <span
          class="tick"
          class:done={position.index > index}
          class:active={position.index === index}
        >
          <span
            class="fill"
            style={`transform:scaleX(${position.index > index ? 1 : position.index === index ? position.progress : 0});`}
          ></span>
        </span>
      {/each}
    </div>

    <div class="actions">
      {#if position.index < lastBeatIndex}
        <button class="skip ghost" type="button" onclick={complete}>Skip intro</button>
      {/if}
      <button class="skip" type="button" onclick={advance}>
        {position.index >= lastBeatIndex ? 'Get started' : waiting ? 'Continue' : 'Next'}
      </button>
    </div>
  </div>
</div>

<style>
  .intro {
    position: fixed;
    inset: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    /* Transparent, not black: the native window material behind the webview is
       the blurred desktop, and painting a background here would hide it. */
    background: transparent;
    color: #fff;
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
    border-radius: var(--radius-card);
  }

  .field-mask {
    position: absolute;
    inset: 0;
    opacity: var(--field-opacity, 1);
    /* An iris, not a fade: the field grows out from behind the logo. Radius
       runs past 100% so the circle clears the corners of a wide display. */
    clip-path: circle(var(--iris, 140%) at 50% 42%);
    will-change: clip-path, opacity;
  }

  .drag-strip {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 32px;
    z-index: 5;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  .stage-scrim {
    position: absolute;
    left: 50%;
    top: 50%;
    width: min(1500px, 150vw);
    height: min(1000px, 150vh);
    transform: translate(-50%, -50%);
    z-index: 1;
    pointer-events: none;
    background: radial-gradient(
      closest-side,
      rgba(8, 8, 14, 0.62),
      rgba(8, 8, 14, 0.34) 52%,
      transparent 78%
    );
    opacity: var(--field-opacity, 1);
  }

  .stage {
    position: relative;
    z-index: 2;
    width: min(860px, calc(100vw - 96px));
    /* Fixed height so cross-fading beats of different lengths do not shift the
       layout under each other — every beat is absolutely positioned inside it
       and centres itself. */
    height: min(470px, calc(100dvh - 190px));
    display: grid;
    place-items: center;
  }

  .overture {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
    opacity: calc(var(--p) * 1.6);
    transform: scale(calc(0.94 + var(--p) * 0.06));
    transition: opacity 0.7s ease, transform 0.9s var(--ease-out);
  }

  .overture.gone {
    opacity: 0;
    transform: scale(1.06);
    pointer-events: none;
  }

  .mark {
    width: 132px;
    color: #fff;
    filter: drop-shadow(0 6px 30px rgba(0, 0, 0, 0.35));
  }

  .mark :global(svg) {
    width: 100%;
    height: auto;
    display: block;
  }

  .welcome {
    margin: 0;
    font-size: 15px;
    font-weight: 400;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.72);
  }

  .beat {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    text-align: center;
    padding: 0 8px;
    transition: opacity 0.25s linear;
    will-change: opacity;
  }

  .beat.still {
    transition: none;
  }

  .ordinal {
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.28em;
    color: rgba(255, 255, 255, 0.5);
  }

  .beat.wide {
    gap: 10px;
    justify-content: center;
  }

  .title.small {
    font-size: clamp(24px, 2.8vw, 32px);
    max-width: 24ch;
  }

  .title {
    margin: 0;
    font-size: clamp(30px, 4.4vw, 46px);
    font-weight: 600;
    line-height: 1.08;
    letter-spacing: -0.03em;
    max-width: 14ch;
    text-wrap: balance;
    text-shadow: 0 2px 40px rgba(0, 0, 0, 0.35);
  }

  .body {
    margin: 0;
    font-size: 16px;
    line-height: 26px;
    font-weight: 400;
    color: rgba(255, 255, 255, 0.78);
    max-width: 52ch;
    text-wrap: pretty;
  }

  /* ---- surfaces ---------------------------------------------------- */

  .surfaces {
    margin: 14px 0 0;
    width: 100%;
    max-width: 700px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    text-align: left;
    border-radius: 12px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.16);
  }

  .surface-row {
    display: grid;
    grid-template-columns: 148px 1fr;
    gap: 16px;
    align-items: baseline;
    padding: 11px 16px;
    background: rgba(10, 10, 16, 0.46);
    backdrop-filter: blur(14px);
  }

  .surface-name {
    margin: 0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13.5px;
    color: #fff;
  }

  .surface-meaning {
    margin: 0;
    font-size: 13.5px;
    line-height: 19px;
    color: rgba(255, 255, 255, 0.76);
  }

  /* ---- shortcuts --------------------------------------------------- */

  .shortcuts {
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
    width: 100%;
    max-width: 780px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 22px;
    text-align: left;
  }

  /* The palette shortcut is the one that matters most, so it gets the full
     width at the top instead of being one of eight equal rows. */
  .shortcut-row:first-child {
    grid-column: 1 / -1;
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .caps {
    display: inline-flex;
    gap: 4px;
    flex: 0 0 auto;
  }

  .cap {
    min-width: 26px;
    height: 26px;
    padding: 0 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 7px;
    border: 1px solid rgba(255, 255, 255, 0.26);
    background: rgba(255, 255, 255, 0.13);
    backdrop-filter: blur(14px);
    font-family: inherit;
    font-size: 12.5px;
    font-weight: 500;
    color: #fff;
    box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.18);
  }

  .shortcut-does {
    font-size: 13.5px;
    line-height: 18px;
    color: rgba(255, 255, 255, 0.8);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---- steps ------------------------------------------------------- */

  .steps {
    margin: 16px 0 0;
    padding: 0;
    list-style: none;
    width: 100%;
    max-width: 700px;
    display: flex;
    flex-direction: column;
    gap: 13px;
    text-align: left;
    counter-reset: none;
  }

  .step-row {
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 14px;
    align-items: start;
  }

  .step-num {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.12);
    font-size: 12px;
    font-weight: 500;
    color: #fff;
  }

  .step-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .step-title {
    font-size: 14.5px;
    font-weight: 500;
    color: #fff;
  }

  .step-detail {
    font-size: 13px;
    line-height: 18.5px;
    color: rgba(255, 255, 255, 0.72);
  }

  .rail {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 0 30px 28px;
  }

  .ticks {
    display: flex;
    gap: 8px;
  }

  .tick {
    width: 44px;
    height: 3px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.22);
    overflow: hidden;
  }

  .fill {
    display: block;
    width: 100%;
    height: 100%;
    background: #fff;
    transform-origin: left center;
    transform: scaleX(0);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .skip.ghost {
    background: transparent;
    border-color: rgba(255, 255, 255, 0.16);
    color: rgba(255, 255, 255, 0.7);
  }

  .skip.ghost:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
  }

  .skip {
    appearance: none;
    border: 1px solid rgba(255, 255, 255, 0.24);
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    font: inherit;
    font-size: 13px;
    padding: 8px 18px;
    border-radius: var(--radius-pill);
    cursor: pointer;
    backdrop-filter: blur(12px);
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .skip:hover {
    background: rgba(255, 255, 255, 0.18);
    border-color: rgba(255, 255, 255, 0.36);
  }

  .skip:focus-visible {
    outline: 1.5px solid #fff;
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .overture,
    .beat {
      transition: none;
    }
  }
</style>
