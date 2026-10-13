<script lang="ts">
  /**
   * Ready to release: what is merged for a product but not yet shipped, how
   * long it has waited, what is held behind it, and whether the owner can cut
   * it now. A thin rail carries the engine tile ("{product} next", whose light
   * is the only colour on the card: red = a check on main is red, amber =
   * waiting on a human cut, green = ready) and up to five cars, one per day
   * ("Thu · 7 changes · onboarding fixes"); held work sits on a dashed siding
   * under the rail. Never a SHA or a PR number: a car's peek lists its
   * changes as plain titles. One-row slots run the rail across; two-row slots
   * stack it. Hidden when no release is due (same gate as the picker).
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
    lightWord,
    localDay,
    plural,
    releaseKey,
    releasePrompt,
    trainCars,
    trainFooter,
    trainLight,
    trainSub,
    trainTitle,
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

  // Cars by day, oldest first; five at most (three in a narrow one-row slot), then "+N more".
  const cars = $derived(release ? trainCars(release) : []);
  const carCap = $derived(tall || cols >= 3 ? CAR_CAP : 3);
  const shownCars = $derived(cars.slice(0, carCap));
  const restCars = $derived(cars.slice(shownCars.length));
  const held = $derived(release?.held ?? []);
  const shownHeld = $derived(held.slice(0, HELD_CAP));
  const restHeld = $derived(held.slice(shownHeld.length));
  const footer = $derived(release ? trainFooter(release, mainHealth, nowMs) : "");
  const health = $derived(release ? healthFor(release, mainHealth) : []);

  function enginePeek(r: BriefRelease): PeekContent {
    const redRows = health.filter((m) => m.red.length);
    return {
      compact: true,
      eyebrow: "Release",
      origin: { companyUid: r.origin.companyUid, label: r.product },
      title: `${r.product} next`,
      status:
        light === "red"
          ? `${lightWord(light)}: a check on main is red`
          : light === "warn"
            ? `${lightWord(light)}: waiting on your cut`
            : `${lightWord(light)}: ready to cut`,
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

{#if release}
  <div class="w train" class:tall data-testid="brief-release-train" data-light={light}>
    <div class="top">
      <div>
        <div class="eyebrow">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3.5" width="16" height="13" rx="3.5" /><path d="M4 10.5h16M9.5 21l1.5-4.5M14.5 21 13 16.5M8.5 14h.01M15.5 14h.01" /></svg>
          Ready to release
        </div>
        <h3 data-testid="brief-release-title">{trainTitle(release)}</h3>
        <div class="sub" data-testid="brief-release-sub">{trainSub(release, day)}</div>
      </div>
      <div class="right">
        {#if others.length}
          <span class="chip others" role="group" aria-label="More releases waiting" data-testid="brief-release-others" use:peek={{ state: brief, content: othersPeek }}>+{others.length} more</span>
        {/if}
        <BriefOrigin origin={release.origin} product />
      </div>
    </div>

    <div class="rail" class:vertical={tall} data-testid="brief-release-rail">
      <div class="tile engine" role="group" aria-label={`${release.product} next`} data-testid="brief-release-engine" use:peek={{ state: brief, content: () => enginePeek(release) }}>
        <i class="light {light}" class:blink={light === "warn"} data-testid="brief-release-light" aria-hidden="true"></i>
        <b>{release.product} next</b>
        <small>{release.version ? `after ${release.version}` : plural(release.pendingCount, "change")}</small>
      </div>
      {#each shownCars as c, i (c.day)}
        <div
          class="tile car"
          style="animation-delay:{i * 40}ms"
          role="group"
          aria-label={carLabel(c, day)}
          data-testid="brief-release-car"
          use:peek={{ state: brief, content: () => carPeek(c) }}
        >
          <b>{dayShort(c.day, day)}</b>
          <span>{plural(c.count, "change")}</span>
          {#if c.theme.trim()}<em>{c.theme.trim()}</em>{/if}
        </div>
      {/each}
      {#if restCars.length}
        <div class="tile car more" style="animation-delay:{shownCars.length * 40}ms" role="group" aria-label="More days waiting" data-testid="brief-release-car-more" use:peek={{ state: brief, content: moreCarsPeek }}>
          +{restCars.length} more
        </div>
      {/if}
    </div>

    {#if held.length}
      <div class="siding" data-testid="brief-release-siding">
        {#each shownHeld as h (h.title)}
          <div class="held" role="group" aria-label={h.title} data-testid="brief-release-held" use:peek={{ state: brief, content: () => heldPeek(h) }}>
            <b>{h.title}</b>
            <small>held until this ships</small>
          </div>
        {/each}
        {#if restHeld.length}
          <div class="held more" role="group" aria-label="More held" data-testid="brief-release-held-more" use:peek={{ state: brief, content: moreHeldPeek }}>+{restHeld.length} more held</div>
        {/if}
      </div>
    {/if}

    <div class="foot">
      <span class="fl" data-testid="brief-release-foot">{footer}</span>
      <span class="acts">
        <button type="button" class="why" data-testid="brief-release-why" use:peek={{ state: brief, content: whyPeek }}>{light === "ok" ? "Main health" : "Why not green"}</button>
        {#if brief.notes[id]}
          <span class="launch-note" role="status">{brief.notes[id]}</span>
        {:else}
          <span class="cut" data-testid="brief-release-cut"><span class="cutlbl">Cut release in</span><BriefLaunch {id} {prompt} compact /></span>
        {/if}
      </span>
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
  .top h3 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    margin-top: 4px;
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

  /* The rail: a 2px hairline the tiles sit on. */
  .rail {
    position: relative;
    display: flex;
    align-items: stretch;
    gap: 8px;
    margin-top: 14px;
    padding: 6px 0;
    min-width: 0;
  }
  .rail::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 2px;
    margin-top: -1px;
    background: var(--b-line);
    border-radius: 1px;
  }
  /* Glass tile: lit from the top, hairline rim, soft drop. No backdrop-filter. */
  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    padding: 8px 11px;
    border-radius: 6px;
    min-width: 0;
    background: rgb(var(--b-ink) / 0.04);
    border: 1px solid var(--b-line);
    box-shadow: none;
    transition: border-color 0.2s, background 0.2s;
  }
  .tile:hover {
    border-color: rgb(var(--b-ink) / 0.3);
  }
  .engine {
    flex: none;
    padding-right: 26px;
    border-radius: 6px;
  }
  .engine b {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.25;
    white-space: nowrap;
  }
  .engine small {
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-t3);
    white-space: nowrap;
  }
  /* The light: the only colour on the card. */
  .light {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--b-ok);
    box-shadow: 0 0 6px var(--b-ok);
  }
  .light.warn {
    background: var(--b-warn);
    box-shadow: 0 0 6px var(--b-warn);
  }
  .light.red {
    background: var(--b-red);
    box-shadow: 0 0 6px var(--b-red);
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
  /* Cars couple in left to right, 40ms apart, in merge order. */
  .car {
    flex: 1 1 0;
    max-width: 150px;
    animation: carin 0.45s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  @keyframes carin {
    from {
      opacity: 0;
      transform: translateX(-24px);
    }
  }
  .car b {
    font-family: var(--b-mono);
    font-size: 11px;
    font-weight: 500;
    color: var(--b-t1);
    white-space: nowrap;
  }
  .car span {
    font-size: 11px;
    color: var(--b-t2);
    white-space: nowrap;
  }
  .car em {
    font-style: normal;
    font-size: 11px;
    color: var(--b-t3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .car.more {
    justify-content: center;
    align-items: center;
    font-size: 11px;
    color: var(--b-t2);
    cursor: default;
    flex: 0 0 auto;
  }
  /* Two-row slots stack the train: the rail runs down the left. */
  .rail.vertical {
    flex-direction: column;
    gap: 6px;
    padding: 0 0 0 18px;
  }
  .rail.vertical::before {
    left: 8px;
    right: auto;
    top: 0;
    bottom: 0;
    height: auto;
    width: 2px;
    margin-top: 0;
  }
  .rail.vertical .car {
    flex: none;
    max-width: none;
    flex-direction: row;
    align-items: baseline;
    gap: 10px;
    padding: 6px 11px;
  }
  .rail.vertical .car b {
    min-width: 64px;
  }
  .rail.vertical .car em {
    margin-left: auto;
  }
  .rail.vertical .car.more {
    justify-content: center;
  }

  /* The siding: held work in dashed boxes under the rail, each joined by a hairline. */
  .siding {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
    padding-top: 8px;
  }
  .held {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px dashed rgb(var(--b-ink) / 0.32);
    min-width: 0;
    max-width: 220px;
    transition: border-color 0.2s;
  }
  .held::before {
    content: "";
    position: absolute;
    top: -9px;
    left: 16px;
    width: 1px;
    height: 8px;
    background: var(--b-line);
  }
  .held:hover {
    border-color: rgb(var(--b-ink) / 0.7);
  }
  .held b {
    font-family: var(--b-mono);
    font-size: 11px;
    font-weight: 500;
    color: var(--b-t2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .held small {
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-t3);
    white-space: nowrap;
  }
  .held.more {
    justify-content: center;
    font-size: 11px;
    color: var(--b-t3);
    cursor: default;
  }

  /* Footer stays plain: no uppercase, the light's word leads it. */
  .foot {
    text-transform: none;
    letter-spacing: 0;
    align-items: center;
    flex-wrap: wrap;
  }
  .fl {
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-t2);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    margin-left: auto;
  }
  .why {
    all: unset;
    cursor: default;
    font-family: var(--b-ui);
    font-size: 11px;
    font-weight: 500;
    padding: 5px 11px;
    border-radius: 999px;
    color: var(--b-t2);
    box-shadow: inset 0 0 0 1px rgb(var(--b-ink) / 0.14);
    transition: color 0.2s, box-shadow 0.2s;
  }
  .why:hover,
  .why:focus-visible {
    color: var(--b-t1);
    box-shadow: inset 0 0 0 1px rgb(var(--b-ink) / 0.3);
  }
  .cut {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .cutlbl {
    font-family: var(--b-ui);
    font-size: 11px;
    color: var(--b-t2);
    white-space: nowrap;
  }
  .foot .launch-note {
    margin-top: 0;
  }
</style>
