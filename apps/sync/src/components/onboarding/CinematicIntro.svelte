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
  import DustField from './DustField.svelte';
  import NetworkScene from './NetworkScene.svelte';
  import '../../styles/design-system.css';
  import {
    BEAT_FADE_MS,
    INTRO_BEATS,
    KEYBOARD_ROWS,
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
  // Target hue follows the clock; the hue the field actually shows chases it
  // per frame, so a jump in the clock (Continue on a self-paced beat) is a
  // glide on screen, never a snap.
  const hueTarget = $derived(hueAt(elapsed, beats));
  let hue = $state(hueAt(0, INTRO_BEATS));
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
    hue += (hueTarget - hue) * Math.min(1, delta / 900);
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
  <!-- The window is full screen and carries the native full-screen material,
       so what sits behind this element is the person's own blurred desktop,
       edge to edge. The colour field irises open over it: HQ arrives in the
       room they are already in. There is no drag region — the film is not a
       window the person should be able to shove off the screen mid-play. -->
  <div class="field-mask" aria-hidden="true">
    <GradientField {hue} {intensity} still={reduced} />
    <DustField still={reduced} />
  </div>

  <!-- One live region carries the whole film for screen readers: the visual
       cross-fade is decoration, the copy is the content. -->
  <div class="sr-only" aria-live="polite">
    {inOverture ? 'Welcome to HQ' : beats[position.index]?.title}
  </div>

  <div class="stage" aria-hidden="true">
    <div
      class="overture"
      class:gone={!inOverture}
      style={`--p:${overtureProgress};`}
    >
      <div class="mark"><svg viewBox="0 0 280 161" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M85.7251 3.66162H118.034V154.434H85.7251V89.8175H32.3085V154.434H0V3.66162H32.3085V57.5091H85.7251V3.66162Z" fill="currentColor"/><path d="M257.169 160.035L241.014 144.096C235.343 147.973 229.096 150.988 222.276 153.142C215.527 155.296 208.419 156.373 200.952 156.373C190.757 156.373 181.172 154.363 172.197 150.342C163.223 146.25 155.325 140.65 148.505 133.542C141.684 126.362 136.335 118.07 132.458 108.664C128.581 99.187 126.642 89.0278 126.642 78.1865C126.642 67.417 128.581 57.3296 132.458 47.9242C136.335 38.4471 141.684 30.1187 148.505 22.939C155.325 15.7593 163.223 10.1592 172.197 6.1386C181.172 2.0462 190.757 0 200.952 0C211.219 0 220.84 2.0462 229.814 6.1386C238.789 10.1592 246.686 15.7593 253.507 22.939C260.328 30.1187 265.641 38.4471 269.446 47.9242C273.323 57.3296 275.261 67.417 275.261 78.1865C275.261 86.0123 274.184 93.5151 272.031 100.695C269.948 107.803 267.077 114.444 263.415 120.618L280 137.203L257.169 160.035ZM200.952 124.065C203.896 124.065 206.732 123.741 209.46 123.095C212.26 122.449 214.952 121.552 217.537 120.403L208.491 111.357L231.322 88.5252L239.291 96.4946C240.512 93.6946 241.409 90.7509 241.984 87.6637C242.63 84.5764 242.953 81.4173 242.953 78.1865C242.953 71.8684 241.84 65.9452 239.614 60.4168C237.461 54.8885 234.445 50.0422 230.568 45.878C226.691 41.642 222.204 38.3394 217.106 35.9701C212.08 33.529 206.696 32.3085 200.952 32.3085C195.208 32.3085 189.788 33.529 184.69 35.9701C179.664 38.3394 175.213 41.642 171.336 45.878C167.459 50.0422 164.407 54.8885 162.182 60.4168C160.028 65.9452 158.951 71.8684 158.951 78.1865C158.951 84.5046 160.028 90.4637 162.182 96.0638C164.407 101.592 167.459 106.474 171.336 110.71C175.213 114.875 179.664 118.141 184.69 120.511C189.788 122.88 195.208 124.065 200.952 124.065Z" fill="currentColor"/></svg></div>
      <span class="grule" aria-hidden="true"></span>
      <p class="welcome">Welcome to HQ</p>
    </div>

    {#each beats as beat, index (beat.id)}
      <div
        class="beat"
        class:still={reduced}
        class:active={position.index === index}
        class:wide={beat.kind !== 'statement'}
        style={`opacity:${reduced ? (position.index === index ? 1 : 0) : beatOpacity(index, elapsed, beats)};`}
        data-beat={beat.id}
      >
        <span class="ordinal r" style="--d:.1s">{String(index + 1).padStart(2, '0')}</span>
        <h2 class="title r" class:small={beat.kind !== 'statement'} style="--d:.25s">{beat.title}</h2>
        <p class="body r" style="--d:.4s">{beat.body}</p>

        {#if beat.kind === 'folder' && beat.surfaces}
          <!-- Caitlin's slide-18 choreography: the folder holds alone, travels
               left, and a wire draws across to a tree that writes in row by
               row. Every timing below is hers, in seconds from beat start. -->
          <div class="fstage" aria-hidden="true">
            <div class="fmove">
              <div class="fglow"></div>
              <svg class="folder" viewBox="0 0 200 176" preserveAspectRatio="xMidYMid meet" fill="none">
                <defs>
                  <linearGradient id="fback" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="#8f74f5" /><stop offset="1" stop-color="#6a4fd8" />
                  </linearGradient>
                  <linearGradient id="ffront" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stop-color="#8ee6f6" /><stop offset="0.48" stop-color="#8b6df0" /><stop offset="1" stop-color="#e56ab3" />
                  </linearGradient>
                  <linearGradient id="fsheen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="#fff" stop-opacity=".28" /><stop offset="1" stop-color="#fff" stop-opacity="0" />
                  </linearGradient>
                </defs>
                <!-- back panel with tab -->
                <path d="M12 24 a10 10 0 0 1 10 -10 h52 a10 10 0 0 1 7.5 3.4 L90 28 h88 a10 10 0 0 1 10 10 v108 a12 12 0 0 1 -12 12 H24 a12 12 0 0 1 -12 -12 z" fill="url(#fback)" />
                <!-- sheets peeking out -->
                <rect class="sheet" x="40" y="36" width="120" height="92" rx="6" fill="#fff" opacity=".92" transform="rotate(-3 100 82)" />
                <rect class="sheet" x="46" y="40" width="120" height="92" rx="6" fill="#fff" transform="rotate(2.5 106 86)" />
                <!-- front pocket, slightly shorter than the back -->
                <path d="M6 72 a10 10 0 0 1 10 -10 h168 a10 10 0 0 1 10 10 v90 a12 12 0 0 1 -12 12 H18 a12 12 0 0 1 -12 -12 z" fill="url(#ffront)" />
                <path d="M6 72 a10 10 0 0 1 10 -10 h168 a10 10 0 0 1 10 10 v22 H6 z" fill="url(#fsheen)" />
              </svg>
            </div>

            <svg class="wire" viewBox="0 0 1100 380" fill="none" preserveAspectRatio="none">
              <!-- Only axis-aligned segments live in here: a stretched box
                   leaves an H or a V segment straight, and the stroke width is
                   non-scaling. Nothing round or diagonal may join them. -->
              <path class="w draw" d="M 282 190 H 400 V 36.2 H 470" pathLength="1" />
            </svg>
            <span class="wn pop-in" style="--d:2.5s; --wx:25.64%; --wy:50%;"></span>
            <span class="wn pop-in" style="--d:3.05s; --wx:42.73%; --wy:9.53%;"></span>

            <div class="tree">
              <div class="troot r" style="--d:2.6s">HQ/</div>
              <div class="tspine grow" style="--d:2.7s"></div>
              {#each beat.surfaces as row, i (row.name)}
                <div class="trow r" style={`--d:${(2.85 + i * 0.13).toFixed(2)}s`}>
                  <span class="tname">{row.name}</span>
                  <span class="tmeaning">{row.meaning}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if beat.kind === 'surfaces' && beat.surfaces}
          <dl class="surfaces">
            {#each beat.surfaces as row, i (row.name)}
              <div class="surface-row r" style={`--d:${(0.55 + i * 0.15).toFixed(2)}s`}>
                <dt class="surface-name">{row.name}</dt>
                <dd class="surface-meaning">{row.meaning}</dd>
              </div>
            {/each}
          </dl>
        {/if}

        {#if beat.kind === 'shortcuts' && beat.shortcuts}
          <ul class="shortcuts">
            {#each beat.shortcuts as row, i (row.does)}
              <li class="shortcut-row r" style={`--d:${(0.55 + i * 0.1).toFixed(2)}s`}>
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

        {#if beat.kind === 'network' && beat.surfaces}
          <NetworkScene active={position.index === index} still={reduced} caps={beat.surfaces} />
        {/if}

        {#if beat.kind === 'keyboard' && beat.highlightKeys}
          <!-- A drawn keyboard. Every key rises in with a tiny stagger so the
               board assembles itself, then the chord lights up last. -->
          <div class="keyboard r" style="--d:.55s">
            {#each KEYBOARD_ROWS as row, ri (ri)}
              <div class="krow">
                {#each row as key, ki (key.id)}
                  <span
                    class="key"
                    class:lit={beat.highlightKeys.includes(key.id)}
                    class:mod={key.glyph !== undefined}
                    style={`--w:${key.w ?? 1}; --kd:${(0.7 + ri * 0.07 + ki * 0.018).toFixed(3)}s`}
                  >
                    {#if key.glyph}<span class="kglyph">{key.glyph}</span>{/if}
                    <span class="klabel">{key.label}</span>
                  </span>
                {/each}
              </div>
            {/each}
          </div>
          {#if beat.shortcuts}
            <p class="chord r" style="--d:1.9s">
              {#each beat.shortcuts[0].keys as cap (cap)}<kbd class="cap big">{cap}</kbd>{/each}
              <span class="chord-does">{beat.shortcuts[0].does}</span>
            </p>
          {/if}
        {/if}

        {#if beat.kind === 'steps' && beat.steps}
          <ol class="steps">
            {#each beat.steps as step, stepIndex (step.title)}
              <li class="step-row r" style={`--d:${(0.55 + stepIndex * 0.13).toFixed(2)}s`}>
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
    /* Square corners: the film covers the entire display, and a rounded corner
       on a full-screen sheet shows four notches of unblurred desktop. */
    border-radius: 0;
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

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  .stage {
    position: relative;
    z-index: 2;
    width: min(1100px, calc(100vw - 96px));
    /* Fixed height so cross-fading beats of different lengths do not shift the
       layout under each other — every beat is absolutely positioned inside it
       and centres itself. */
    height: min(600px, calc(100dvh - 170px));
    display: grid;
    place-items: center;
  }

  /* The house easing from the roundtable deck: fast out, long settle. */
  .intro { --ease: cubic-bezier(0.2, 0.7, 0.2, 1); }

  .overture {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0;
    transition: opacity 0.7s ease;
  }

  .overture.gone {
    opacity: 0;
    pointer-events: none;
  }

  /* Logo: a long, transform-free fade over the field's slower bloom. */

  /* A hairline in the brand spectrum that widens from the centre. */
  .grule {
    display: block;
    height: 3px;
    width: 0;
    margin: 40px auto 0;
    border-radius: 999px;
    background: linear-gradient(96deg, #7de3f4 0%, #8b6df0 30%, #e56ab3 62%, #f28a4b 100%);
    animation: widen 1.1s var(--ease) 1s forwards;
  }

  .welcome {
    opacity: 0;
    animation: pop 0.8s var(--ease) 1.4s forwards;
  }

  @keyframes pop { to { opacity: 1; } }
  @keyframes widen { to { width: min(420px, 60vw); } }
  @keyframes rise { to { opacity: 1; transform: none; } }

  /* Entrance primitive for everything inside an active beat: 14px rise over
     0.8s, delayed per element via --d. Replays each time a beat goes active. */
  .beat .r {
    opacity: 0;
    transform: translateY(14px);
  }

  .beat.active .r {
    animation: rise 0.8s var(--ease) var(--d, 0s) forwards;
  }

  .beat.still .r,
  .beat.still.active .r {
    animation: none;
    opacity: 1;
    transform: none;
  }

  .mark {
    width: 132px;
    color: #fff;
    filter: drop-shadow(0 20px 46px rgba(0, 0, 0, 0.55));
    opacity: 0;
    animation: pop 1.2s var(--ease) 0.35s forwards;
  }

  .mark :global(svg) {
    width: 100%;
    height: auto;
    display: block;
  }

  .welcome {
    margin: 22px 0 0;
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
    transition: opacity 0.25s linear, filter 0.7s var(--ease), transform 0.9s var(--ease);
    will-change: opacity, filter, transform;
    filter: blur(6px);
    transform: scale(1.02);
  }

  .beat.active {
    filter: blur(0);
    transform: scale(1);
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
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 4px 32px rgba(0, 0, 0, 0.45);
  }

  .body {
    margin: 0;
    font-size: 16px;
    line-height: 26px;
    font-weight: 400;
    color: rgba(255, 255, 255, 0.86);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 3px 20px rgba(0, 0, 0, 0.4);
    max-width: 52ch;
    text-wrap: pretty;
  }

  /* ---- folder → tree ----------------------------------------------- */

  .fstage {
    --fw: min(1100px, calc(100vw - 120px));
    position: relative;
    width: var(--fw);
    height: 380px;
    margin-top: 10px;
  }

  .fmove {
    position: absolute;
    left: 50%;
    top: 50%;
    /* 200 x 176 — the folder viewBox exactly. `aspect-ratio` pins the two to
       each other, so a later height edit cannot squash the art. */
    width: 200px;
    aspect-ratio: 200 / 176;
    margin: -88px 0 0 -100px;
    opacity: 0;
  }

  .beat.active .fmove {
    animation:
      pop 0.65s var(--ease) 0.65s forwards,
      ftravel 0.95s var(--ease) 2.05s forwards;
  }

  @keyframes ftravel { to { transform: translateX(calc(var(--fw) * -0.36)); } }

  .fglow {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 380px;
    height: 380px;
    margin: -190px 0 0 -190px;
    border-radius: 50%;
    background: radial-gradient(closest-side, rgba(139, 109, 240, 0.42), rgba(229, 106, 179, 0.16) 46%, transparent 72%);
  }

  .folder {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    /* Belt and braces with `preserveAspectRatio="xMidYMid meet"`: the art
       letterboxes inside its box, it never stretches to fill it. */
    object-fit: contain;
    filter: drop-shadow(0 18px 40px rgba(0, 0, 0, 0.45));
  }

  .wire {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .w {
    stroke: #e56ab3;
    stroke-width: 2.4;
    vector-effect: non-scaling-stroke;
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
  }

  .beat.active .w.draw { animation: draw 0.9s var(--ease) 2.55s forwards; }
  @keyframes draw { to { stroke-dashoffset: 0; } }

  .wn {
    position: absolute;
    left: var(--wx);
    top: var(--wy);
    width: 8px;
    height: 8px;
    margin: -4px 0 0 -4px;
    border-radius: 50%;
    background: #fff;
    opacity: 0;
  }
  .beat.active .wn.pop-in { animation: pop 0.5s var(--ease) var(--d, 2.5s) forwards; }

  .tree {
    position: absolute;
    left: calc(42.7% + 10px);
    right: 0;
    top: 22px;
    text-align: left;
  }

  .troot {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 15px;
    line-height: 20px;
    color: #fff;
    margin-bottom: 10px;
  }

  .tspine {
    position: absolute;
    left: 0;
    top: 28px;
    width: 1px;
    height: 0;
    background: rgba(255, 255, 255, 0.35);
  }

  .beat.active .tspine.grow { animation: grow 1s var(--ease) var(--d, 2.7s) forwards; }
  @keyframes grow { to { height: 158px; } }

  .trow {
    position: relative;
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 14px;
    align-items: baseline;
    padding: 8px 0 8px 22px;
  }

  .trow::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    width: 14px;
    height: 1px;
    background: rgba(255, 255, 255, 0.35);
  }

  .trow::after {
    content: '';
    position: absolute;
    left: 12px;
    top: calc(50% - 2.5px);
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #e56ab3;
  }

  .tname {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 14px;
    color: #fff;
  }

  .tmeaning {
    font-size: 13.5px;
    line-height: 19px;
    color: rgba(255, 255, 255, 0.8);
  }

  .beat.still .fmove,
  .beat.still .w,
  .beat.still .wn,
  .beat.still .tspine {
    animation: none;
    opacity: 1;
  }
  .beat.still .fmove { transform: translateX(calc(var(--fw) * -0.36)); }
  .beat.still .w { stroke-dashoffset: 0; }
  .beat.still .tspine { height: 158px; }

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
    background: rgba(10, 10, 16, 0.32);
    backdrop-filter: blur(18px);
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

  /* ---- network: drawn by NetworkScene.svelte ------------------------ */

  .pop-in { opacity: 0; }
  .beat.active .pop-in { animation: pop 0.6s var(--ease) var(--d, 0.5s) forwards; }
  .beat.still .pop-in { animation: none; opacity: 1; }

  /* ---- keyboard ---------------------------------------------------- */

  .keyboard {
    --unit: min(52px, calc((100vw - 160px) / 15.5));
    margin: 18px 0 0;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.14);
    backdrop-filter: blur(18px);
  }

  .krow {
    display: flex;
    gap: 6px;
    justify-content: center;
  }

  .key {
    position: relative;
    width: calc(var(--unit) * var(--w, 1) + 6px * (var(--w, 1) - 1));
    height: calc(var(--unit) * 0.82);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.22);
    color: rgba(255, 255, 255, 0.72);
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    opacity: 0;
    transform: translateY(8px);
    transition: background 0.4s var(--ease), box-shadow 0.4s var(--ease), color 0.4s var(--ease);
  }

  .beat.active .key {
    animation: rise 0.6s var(--ease) var(--kd, 0.7s) forwards;
  }

  .beat.still .key {
    animation: none;
    opacity: 1;
    transform: none;
  }

  .key.mod {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.58);
  }

  .kglyph {
    font-size: 13px;
    margin-bottom: 3px;
    color: rgba(255, 255, 255, 0.85);
  }

  /* The chord: lit keys glow in the brand spectrum, 1.6s after the board
     has assembled, so the eye lands on them last. */
  .beat.active .key.lit {
    animation:
      rise 0.6s var(--ease) var(--kd, 0.7s) forwards,
      keylight 0.9s var(--ease) 1.6s forwards,
      keypulse 2.6s ease-in-out 2.5s infinite;
  }
  @keyframes keypulse {
    50% { box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.18), 0 0 0 5px rgba(229, 106, 179, 0.22), 0 14px 46px rgba(229, 106, 179, 0.7); }
  }

  @keyframes keylight {
    to {
      background: linear-gradient(150deg, #8b6df0, #e56ab3 55%, #f28a4b);
      border-color: rgba(255, 255, 255, 0.55);
      box-shadow:
        inset 0 -2px 0 rgba(0, 0, 0, 0.18),
        0 0 0 3px rgba(229, 106, 179, 0.28),
        0 10px 34px rgba(229, 106, 179, 0.45);
      color: #fff;
      transform: translateY(-2px);
    }
  }

  .beat.still .key.lit {
    background: linear-gradient(150deg, #8b6df0, #e56ab3 55%, #f28a4b);
    color: #fff;
  }

  .chord {
    margin: 18px 0 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    color: rgba(255, 255, 255, 0.86);
  }

  .cap.big {
    min-width: 34px;
    height: 34px;
    font-size: 15px;
  }

  .chord-does {
    margin-left: 8px;
  }

  /* ---- steps ------------------------------------------------------- */

  .steps {
    position: relative;
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

  .steps::before {
    content: '';
    position: absolute;
    left: 11.5px;
    top: 24px;
    bottom: 24px;
    width: 1px;
    background: linear-gradient(to bottom, #8b6df0, #e56ab3, #f28a4b);
    transform: scaleY(0);
    transform-origin: top;
  }
  .beat.active .steps::before { animation: growy 1.4s var(--ease) 0.9s forwards; }
  @keyframes growy { to { transform: scaleY(1); } }

  .step-num {
    position: relative;
    z-index: 1;
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
    background: linear-gradient(90deg, #7de3f4, #e56ab3);
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
