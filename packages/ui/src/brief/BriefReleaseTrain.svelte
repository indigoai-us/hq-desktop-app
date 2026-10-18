<script lang="ts">
  /**
   * Ready to release: what is merged for a product but not yet shipped, read
   * left to right as a train line. The hero says how much waits ("4 | changes
   * waiting / since yesterday"); under it a thin track runs through stations:
   * the last release (filled dot, "SHIPPED · 1.4"), one hollow dot per day of
   * waiting changes ("YESTERDAY · 4 changes · fixes", up to five, then "+N
   * more"), and the next cut (a ring whose light is the only colour on the
   * card: red = a check on main is red, yellow = waiting on a human cut,
   * green = ready). The track only ever runs through the dot row; every label
   * sits above or below it. Merged work is a solid line; the stretch still to
   * cut is dashed. Held work rides on glass chips under the line. The footer
   * is the status in plain words, a quiet "Why not green" link and the one
   * action, "Cut release in Claude". Never a SHA or a PR number: a station's
   * peek lists its changes as plain titles. Two-row slots run the line down
   * the left. Hidden when no release is due (same gate as the picker).
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import {
    CAR_CAP,
    HELD_CAP,
    carLabel,
    carTitles,
    dayLong,
    dayShort,
    dueReleases,
    healthFor,
    lastStation,
    lightWord,
    localDay,
    plural,
    releaseKey,
    releasePrompt,
    trainCars,
    trainFooter,
    trainLight,
    trainTitle,
    trainWait,
    whyNotGreenLines,
    type TrainCar,
  } from "./brief-release-train.js";
  import type { BriefMainHealth, BriefRelease } from "./brief-types.js";

  interface Props {
    releases: BriefRelease[];
    mainHealth: BriefMainHealth[];
    /** Prompt per launch id (`release:<product>`); falls back to the release's own prompt, then a written one. */
    prompts: Record<string, string>;
    cols: number;
    rows: number;
    /** ISO time of the brief; defaults to the machine clock. */
    now?: string;
    /** YYYY-MM-DD local; defaults to the local date of `now`. */
    today?: string;
  }
  let { releases, mainHealth, prompts, cols, rows, now = new Date().toISOString(), today }: Props = $props();
  const brief = useBrief();

  const nowMs = $derived(Date.parse(now));
  const day = $derived(today ?? localDay(now));
  const due = $derived(dueReleases(releases, nowMs));
  const release = $derived(due[0] ?? null);
  const others = $derived(due.slice(1));
  const tall = $derived(rows > 1);
  const light = $derived(release ? trainLight(release, mainHealth) : "ok");
  const id = $derived(release ? releaseKey(release) : "");
  const prompt = $derived(release ? (prompts[id] ?? release.prompt ?? releasePrompt(release, mainHealth, nowMs, day)) : "");
  const wait = $derived(release ? trainWait(release, day) : null);
  const last = $derived(release ? lastStation(release, nowMs) : null);

  // Stations by day, oldest first; five at most (three in a narrow one-row slot), then "+N more".
  const cars = $derived(release ? trainCars(release) : []);
  const carCap = $derived(tall || cols >= 3 ? CAR_CAP : 3);
  const shownCars = $derived(cars.slice(0, carCap));
  const restCars = $derived(cars.slice(shownCars.length));
  const restCount = $derived(restCars.reduce((n, c) => n + c.count, 0));
  const held = $derived(release?.held ?? []);
  const shownHeld = $derived(held.slice(0, HELD_CAP));
  const restHeld = $derived(held.slice(shownHeld.length));
  const footer = $derived(release ? trainFooter(release, mainHealth, nowMs) : "");
  const health = $derived(release ? healthFor(release, mainHealth) : []);
  /** The stretch from the newest waiting day to the next cut is not cut yet: dashed. */
  const lastWaiting = $derived(restCars.length ? "more" : shownCars.length ? shownCars[shownCars.length - 1]!.day : "last");

  function enginePeek(r: BriefRelease): PeekContent {
    const redRows = health.filter((m) => m.red.length);
    return {
      compact: true,
      eyebrow: "Next cut",
      origin: { companyUid: r.origin.companyUid, label: r.product },
      title: trainTitle(r),
      status: footer,
      sections: [
        {
          label: "Checklist",
          lines: [
            { label: "Checks on main", state: redRows.length ? "RED" : health.length ? "GREEN" : "UNKNOWN", tone: redRows.length ? "red" : health.length ? "ok" : "neutral" },
            { label: "Waiting to ship", state: plural(r.pendingCount, "change"), tone: r.pendingCount ? "warn" : "neutral" },
            { label: "Held behind it", state: String(r.held.length), tone: r.held.length ? "warn" : "neutral" },
            ...(r.version ? [{ label: "Last release", state: r.version }] : []),
          ],
        },
      ],
      prompt: { id, text: prompt, verb: "Cut release" },
    };
  }

  const lastPeek = (r: BriefRelease): PeekContent => ({
    title: r.version ? `${r.product} ${r.version}` : `${r.product}, last release`,
    status: last?.age ? `Shipped ${last.age}` : "Shipped",
    sections: [{ label: "Since then", text: r.pendingCount ? `${plural(r.pendingCount, "change")} merged and waiting for the next cut.` : "Nothing merged yet." }],
  });

  function carPeek(c: TrainCar): PeekContent {
    const t = carTitles(c);
    const sections: PeekContent["sections"] = [];
    if (t.lines.length) sections.push({ label: "Changes", lines: t.lines });
    else sections.push({ label: "Changes", text: `${plural(c.count, "change")} merged ${dayLong(c.day, day)}${c.theme.trim() ? `, mostly ${c.theme.trim()}` : ""}.` });
    if (t.more) sections.push({ label: "And", text: `+${t.more} more` });
    return { title: `${dayLong(c.day, day)} · ${plural(c.count, "change")}`, status: c.theme.trim() || undefined, sections };
  }

  const moreCarsPeek = (): PeekContent => ({
    title: `${restCars.length} more ${restCars.length === 1 ? "day" : "days"}`,
    status: "Also waiting to ship",
    sections: [{ label: "By day", lines: restCars.map((c) => ({ label: carLabel(c, day), state: "" })) }],
  });

  const heldPeek = (h: BriefRelease["held"][number]): PeekContent => ({
    title: h.title,
    status: "Held until this release ships",
    sections: h.why.trim() ? [{ label: "Why", text: h.why }] : [],
  });

  const moreHeldPeek = (): PeekContent => ({
    title: `${restHeld.length} more held`,
    status: "Also waiting on this release",
    sections: [{ label: "Held", lines: restHeld.map((h) => ({ label: h.title, state: "" })) }],
  });

  const whyPeek = (): PeekContent => {
    const lines = whyNotGreenLines(mainHealth);
    return {
      title: light === "ok" ? "Main health" : "Why not green",
      status: light === "red" ? footer : light === "warn" ? "No check is red; the cut is yours to make" : "Every check on main is green",
      sections: lines.length ? [{ label: "Checks on main, by product", lines }] : [{ label: "Checks on main", text: "No main-health data in this brief." }],
    };
  };

  const othersPeek = (): PeekContent => ({
    title: `${others.length} more ${others.length === 1 ? "release" : "releases"} waiting`,
    sections: [
      {
        label: "Also ready",
        lines: others.map((r) => {
          const l = trainLight(r, mainHealth);
          return { label: `${r.product} · ${plural(r.pendingCount, "change")}${r.held.length ? ` · ${r.held.length} held` : ""}`, state: lightWord(l).toUpperCase(), tone: l };
        }),
      },
    ],
  });
</script>

{#snippet dot(kind: "shipped" | "waiting")}
  <svg class="dot {kind}" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r={kind === "shipped" ? 4.5 : 3.9} /></svg>
{/snippet}

{#if release && wait && last}
  <div class="w train" class:tall class:narrow={cols < 3} data-testid="brief-release-train" data-light={light} role="group" aria-label={trainTitle(release)}>
    <div class="top">
      <div>
        <div class="eyebrow">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3.5" width="16" height="13" rx="3.5" /><path d="M4 10.5h16M9.5 21l1.5-4.5M14.5 21 13 16.5M8.5 14h.01M15.5 14h.01" /></svg>
          Ready to release
        </div>
        <div class="hero" class:none={wait.count == null}>
          <h3 data-testid="brief-release-title">{#if wait.count != null}<span class="num">{wait.count}</span>{" "}{/if}<span class="what">{wait.what}</span></h3>
          {#if wait.caption}<div class="sub" data-testid="brief-release-sub">{wait.caption}</div>{/if}
        </div>
      </div>
      <div class="right">
        {#if others.length}
          <span class="chip others" role="group" aria-label="More releases waiting" data-testid="brief-release-others" use:peek={{ state: brief, content: othersPeek }}>+{others.length} more</span>
        {/if}
        <BriefOrigin origin={release.origin} product />
      </div>
    </div>

    <!-- The line: a station is its label above, its dot (and the track leaving it) in a row of its own, its values below. -->
    <div class="line">
      <div class="rail" class:vertical={tall} data-testid="brief-release-rail">
        <div class="st last" class:tail={lastWaiting === "last"} role="group" aria-label={`Shipped · ${last.value}${last.age ? ` · ${last.age}` : ""}`} data-testid="brief-release-last" use:peek={{ state: brief, content: () => lastPeek(release) }}>
          <span class="k">Shipped</span>
          <span class="pin">{@render dot("shipped")}<i class="seg" data-seg={lastWaiting === "last" ? "dash" : "solid"}></i></span>
          <b class="v">{last.value}</b>
          {#if last.age}<em class="t">{last.age}</em>{/if}
        </div>
        {#each shownCars as c, i (c.day)}
          <div
            class="st car"
            class:tail={lastWaiting === c.day}
            style="animation-delay:{(i + 1) * 40}ms"
            role="group"
            aria-label={carLabel(c, day)}
            data-testid="brief-release-car"
            use:peek={{ state: brief, content: () => carPeek(c) }}
          >
            <span class="k">{dayShort(c.day, day)}</span>
            <span class="pin">{@render dot("waiting")}<i class="seg" data-seg={lastWaiting === c.day ? "dash" : "solid"}></i></span>
            <b class="v">{plural(c.count, "change")}</b>
            {#if c.theme.trim()}<em class="t">{c.theme.trim()}</em>{/if}
          </div>
        {/each}
        {#if restCars.length}
          <div class="st car more tail" style="animation-delay:{(shownCars.length + 1) * 40}ms" role="group" aria-label="More days waiting" data-testid="brief-release-car-more" use:peek={{ state: brief, content: moreCarsPeek }}>
            <span class="k">+{restCars.length} more</span>
            <span class="pin">{@render dot("waiting")}<i class="seg" data-seg="dash"></i></span>
            <b class="v">{plural(restCount, "change")}</b>
          </div>
        {/if}
        <div class="st engine" role="group" aria-label={`Next cut · ${lightWord(light)}`} data-testid="brief-release-engine" use:peek={{ state: brief, content: () => enginePeek(release) }}>
          <span class="k">Next cut</span>
          <span class="pin"><svg class="dot ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" /></svg><i class="light {light}" class:blink={light === "warn"} data-testid="brief-release-light" aria-hidden="true"></i></span>
          <b class="v">{lightWord(light)}</b>
        </div>
      </div>

      {#if held.length}
        <div class="siding" data-testid="brief-release-siding">
          <span class="sk">{cols < 3 ? "Held" : "Held until it ships"}</span>
          {#each shownHeld as h (h.title)}
            <div class="held" role="group" aria-label={h.title} data-testid="brief-release-held" use:peek={{ state: brief, content: () => heldPeek(h) }}>{h.title}</div>
          {/each}
          {#if restHeld.length}
            <div class="held more" role="group" aria-label="More held" data-testid="brief-release-held-more" use:peek={{ state: brief, content: moreHeldPeek }}>+{restHeld.length} more held</div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="foot">
      <span class="status">
        <span class="fl" data-testid="brief-release-foot" title={footer}>{footer}</span>
        <button type="button" class="why" data-testid="brief-release-why" use:peek={{ state: brief, content: whyPeek }}>{light === "ok" ? "Main health" : "Why not green"}</button>
      </span>
      {#if brief.notes[id]}
        <span class="launch-note" role="status">{brief.notes[id]}</span>
      {:else}
        <!-- One action: "Cut release in" and the engine's Start button read as one pill; the words start it too. -->
        <span class="cut" data-testid="brief-release-cut">
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <span class="cutlbl" aria-hidden="true" onclick={() => void brief.start(id, prompt)}>Cut release in</span><BriefLaunch {id} {prompt} compact />
        </span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .top > div:first-child {
    min-width: 0;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
  }
  .others {
    cursor: default;
  }

  /* Hero: the count large, what it counts and since when stacked beside it. */
  .hero {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: 10px;
    align-items: center;
    margin-top: 2px;
  }
  .hero h3 {
    display: contents;
  }
  .num {
    grid-row: 1 / span 2;
    font-size: var(--b-fs-num);
    font-weight: 400;
    letter-spacing: -0.04em;
    line-height: 1;
    color: var(--b-t1);
  }
  .what {
    grid-column: 2;
    align-self: end;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.25;
    letter-spacing: -0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hero .sub {
    grid-column: 2;
    align-self: start;
    margin-top: 1px;
    font-size: 11px;
    line-height: 1.3;
    color: var(--b-t2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hero.none .what {
    grid-column: 1 / -1;
    font-size: var(--b-fs-title-lg);
    font-weight: 500;
  }
  .hero.none .sub {
    grid-column: 1 / -1;
  }

  /* The line. Each station is a small grid: label, the dot row, value, note.
     The track is drawn only inside the dot row (.pin), so it never crosses text. */
  /* The line sits midway between the hero and the footer, whatever the slot's height. */
  .line {
    margin: auto 0;
    padding: 16px 0 4px;
    min-width: 0;
  }
  .rail {
    --dot: 12px;
    --gap: 5px;
    display: flex;
    align-items: flex-start;
    min-width: 0;
  }
  .st {
    position: relative;
    display: grid;
    grid-template-rows: 12px var(--dot) auto auto;
    row-gap: 6px;
    justify-items: start;
    flex: 1 1 0;
    min-width: 0;
    padding-right: 10px;
    cursor: default;
  }
  .st.car {
    animation: stin 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  @keyframes stin {
    from {
      opacity: 0;
      transform: translateX(-12px);
    }
  }
  .st.more,
  .st.engine {
    flex: 0 0 auto;
  }
  .st.engine {
    padding-right: 0;
  }
  .k {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    line-height: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.2s;
  }
  .pin {
    position: relative;
    align-self: stretch;
    justify-self: stretch;
    display: block;
  }
  .dot {
    position: absolute;
    left: 0;
    top: 0;
    width: var(--dot);
    height: var(--dot);
    overflow: visible;
  }
  .dot.shipped circle {
    fill: #fff;
  }
  .dot.waiting circle {
    fill: transparent;
    stroke: rgba(255, 255, 255, 0.9);
    stroke-width: 1.5;
    transition: fill 0.2s;
  }
  .st.more .dot.waiting circle {
    stroke-dasharray: 2 2.1;
  }
  .st:hover .dot.waiting circle {
    fill: rgba(255, 255, 255, 0.45);
  }
  .st:hover .k {
    color: var(--b-t1);
  }
  /* Next cut: a wider ring with the light inside it. */
  .dot.ring {
    width: 16px;
    height: 16px;
    top: -2px;
    left: -2px;
  }
  /* A small white disc, so the light reads as a colour on any field (the field's own
     pale ok/warn/red tones all wash out to near-white). */
  .dot.ring circle {
    fill: rgba(255, 255, 255, 0.95);
    stroke: rgba(255, 255, 255, 0.35);
    stroke-width: 2.4;
    transition: stroke 0.2s;
  }
  .st.engine:hover .dot.ring circle {
    stroke: rgba(255, 255, 255, 0.6);
  }
  /* The track leaving a station: from just past its dot to just before the next one. */
  .seg {
    position: absolute;
    top: calc(var(--dot) / 2 - 0.5px);
    left: calc(var(--dot) + var(--gap));
    right: calc(var(--gap) - 10px);
    height: 1px;
    border-radius: 1px;
    background: rgba(255, 255, 255, 0.7);
  }
  /* Not cut yet: the stretch to the next station is dashed. */
  .seg[data-seg="dash"] {
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.7) 3px, transparent 3px) 0 0 / 7px 1px repeat-x;
  }
  /* The last stretch, to the next cut, is never shorter than a few dashes. */
  .st.tail {
    padding-right: 36px;
  }
  .st.tail .seg {
    right: calc(var(--gap) - 36px);
  }
  .v {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.25;
    color: var(--b-t1);
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The note never widens its station: it takes the station's width and ellipsizes. */
  .t {
    contain: inline-size;
    justify-self: stretch;
    font-style: normal;
    font-size: 11px;
    line-height: 1.25;
    color: var(--b-t2);
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: -4px;
  }
  /* The light: the only colour on the card. No glow. */
  .light {
    position: absolute;
    left: 2.5px;
    top: 2.5px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #1f9d4c;
  }
  .light.warn {
    background: #e3a008;
  }
  .light.red {
    background: #e5172f;
  }
  /* Blinks once every 4s only while the cut waits on a person. */
  .light.blink {
    animation: el 4s 1s infinite;
  }
  @keyframes el {
    0%,
    80%,
    100% {
      opacity: 1;
    }
    90% {
      opacity: 0.35;
    }
  }

  /* Two-row slots: the line runs down the left, oldest at the top, the next cut at the bottom. */
  .rail.vertical {
    flex-direction: column;
    align-items: stretch;
  }
  .rail.vertical .st {
    flex: none;
    grid-template-rows: auto auto;
    grid-template-columns: var(--dot) 84px minmax(0, auto) minmax(0, 1fr);
    column-gap: 12px;
    row-gap: 0;
    align-items: baseline;
    padding: 0 0 22px;
  }
  .rail.vertical .st.engine {
    padding-bottom: 0;
  }
  .rail.vertical .pin {
    grid-column: 1;
    grid-row: 1;
    align-self: start;
    height: 100%;
    margin-top: 2px;
  }
  .rail.vertical .k {
    grid-column: 2;
    grid-row: 1;
  }
  .rail.vertical .v {
    grid-column: 3;
    grid-row: 1;
  }
  .rail.vertical .t {
    grid-column: 4;
    grid-row: 1;
    margin-top: 0;
  }
  .rail.vertical .seg,
  .rail.vertical .st.more .seg {
    top: calc(var(--dot) + var(--gap));
    bottom: calc(var(--gap) - 22px - 2px);
    left: calc(var(--dot) / 2 - 0.5px);
    right: auto;
    width: 1px;
    height: auto;
  }
  .rail.vertical .seg[data-seg="dash"] {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.7) 3px, transparent 3px) 0 0 / 1px 7px repeat-y;
  }

  /* Held work: glass chips under the line, after a mono label. */
  .siding {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 6px;
    margin-top: 12px;
    min-width: 0;
  }
  .sk {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    white-space: nowrap;
    margin-right: 4px;
    flex: none;
  }
  .held {
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 9px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.14);
    font-size: 11px;
    font-weight: 500;
    color: var(--b-t1);
    white-space: nowrap;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 0 1 auto;
    transition: background 0.2s;
  }
  .held:hover {
    background: rgba(255, 255, 255, 0.22);
  }
  .held.more {
    color: var(--b-t2);
    flex: none;
  }

  /* Footer: the status in plain words with a quiet link, then the one action. No divider. */
  .foot {
    margin-top: 0;
    border-top: 0;
    padding-top: 14px;
    align-items: center;
    letter-spacing: 0;
  }
  .status {
    display: flex;
    align-items: baseline;
    gap: 12px;
    min-width: 0;
  }
  .fl {
    font-family: var(--b-ui);
    font-size: 11px;
    color: var(--b-t1);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .why {
    all: unset;
    cursor: default;
    flex: none;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    white-space: nowrap;
    transition: color 0.2s;
  }
  .why:hover,
  .why:focus-visible {
    color: #fff;
  }
  /* "Cut release in" + the engine's Start button: one soft glass pill, solid white with dark ink on hover. */
  .cut {
    display: inline-flex;
    align-items: center;
    flex: none;
    margin-left: auto;
    text-shadow: none;
  }
  .cutlbl,
  .cut :global(.launch .go) {
    height: 28px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fff;
    background: rgba(255, 255, 255, 0.16);
    box-shadow: none;
    transition: background 0.15s, color 0.15s;
  }
  .cutlbl {
    display: inline-flex;
    align-items: center;
    padding: 0 0 0 11px;
    border-radius: 6px 0 0 6px;
    white-space: nowrap;
    cursor: pointer;
  }
  .cut :global(.launch) {
    gap: 2px;
  }
  .cut :global(.launch .go) {
    padding: 0 11px 0 0.55em;
    border-radius: 0 6px 6px 0;
  }
  .cut:has(.cutlbl:hover, :global(.launch .go:hover), :global(.launch .go:focus-visible)) .cutlbl,
  .cut:has(.cutlbl:hover, :global(.launch .go:hover), :global(.launch .go:focus-visible)) :global(.launch .go) {
    color: #18181b;
    background: #fff;
    outline: none;
  }
  /* The engine switch and copy stay, quietly: no container, marks muted until hovered or chosen. */
  .cut :global(.launch .eng) {
    height: 28px;
    padding: 2px;
    margin-left: 4px;
    background: none;
  }
  .cut :global(.launch .eng button) {
    height: 24px;
    padding: 0 5px;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.6);
  }
  .cut :global(.launch .eng button:hover) {
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
  }
  .cut :global(.launch .eng button[aria-pressed="true"]) {
    color: #fff;
    background: rgba(255, 255, 255, 0.22);
  }
  .cut :global(.launch .eng button[aria-pressed="true"] .mark.clay) {
    fill: currentColor;
  }
  .cut :global(.launch .copy) {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: none;
    color: rgba(255, 255, 255, 0.6);
  }
  .cut :global(.launch .copy:hover) {
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
  }
  /* Narrow slots (two columns): the engine switch and copy step aside (the next cut's peek
     still starts the cut and copies the prompt), so the status keeps its words. */
  .narrow .cut :global(.launch .eng),
  .narrow .cut :global(.launch .copy) {
    display: none;
  }
  /* Narrow one-row slots: stations take their own width, a size down, so three days fit. */
  .narrow .rail:not(.vertical) .st {
    flex: 1 1 auto;
    padding-right: 8px;
  }
  .narrow .rail:not(.vertical) .st.engine {
    padding-right: 0;
  }
  .narrow .rail:not(.vertical) .st.tail {
    padding-right: 22px;
  }
  .narrow .rail:not(.vertical) .st .seg {
    right: calc(var(--gap) - 8px);
  }
  .narrow .rail:not(.vertical) .st.tail .seg {
    right: calc(var(--gap) - 22px);
  }
  .narrow .rail:not(.vertical) .v {
    font-size: 12px;
  }
  .foot .launch-note {
    margin: 0 0 0 auto;
  }
</style>
