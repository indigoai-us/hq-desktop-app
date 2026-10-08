<script lang="ts">
  /**
   * Visual first run, "Bring in your context": the approved knowledge-tree
   * scene (workspace/previews/first-run-knowledge-tree), driven by the real
   * scan instead of a script.
   *
   * The person agrees first ("Bring it in"; it reads only this Mac and
   * nothing leaves it) or skips. Once the scan runs, each source gets a row,
   * dust lifts from the row into the tree, companies grow limbs with a
   * coral-peach blossom and a callout, projects grow twigs, and the crown
   * fills in step with what was found. When the scan is done the title
   * becomes "<Name> knows your world." with a summary line.
   *
   * The scene model (scene-model.ts) paces the events into beats; the tree
   * (tree-model.ts) and the canvas drawing (scene-renderer.ts) are pure
   * functions of the plan and the scene second. This component only keeps
   * a clock, draws frames while something moves, pauses while the window is
   * hidden, slows to a light ambient once settled and then stops. Under
   * reduced motion it draws the settled frame for the data in so far, and
   * the rows still update.
   */
  import { onMount, untrack } from "svelte";
  import RailIcon from "../../../common/button/RailIcon.svelte";
  import {
    countValue,
    countWord,
    createPlanMemo,
    treeSpecFor,
    PACE,
    type PlanLimb,
    type PlanRow,
    type ScenePlan,
  } from "./scene-model.js";
  import {
    crownExtents,
    generateTree,
    rasterizeTree,
    referenceSpec,
    type TreeRaster,
  } from "./tree-model.js";
  import {
    INTRO,
    MONO_FONT,
    SAFE,
    buildCallouts,
    buildFeed,
    buildStaticLayout,
    calloutGeom,
    calloutTime,
    drawScene,
    lastScheduled,
    sceneGeometry,
    swayAmp,
    swayAt,
    witherAt,
    type DrawContext,
    type RowBox,
    type SceneGeometry,
    type SceneLayout,
    type StaticLayout,
  } from "./scene-renderer.js";
  import { clamp01, easeInOut, easeOut, smooth } from "./tree-math.js";
  import type { ImportRunView } from "./import-runner.js";
  import type { SceneClock } from "./scene-clock.js";
  import "./first-run-import.css";

  interface Props {
    /** The assistant's name, as the person confirmed it. */
    name: string;
    /** Where this step sits in the flow's bars. */
    stepNumber: number;
    total: number;
    run: ImportRunView;
    clock: SceneClock;
    /** "Next: Done" */
    nextLabel: string;
    /** "Finish with defaults" sits beside Next when the flow has more steps after this one. */
    offersFinish: boolean;
    finishLabel?: string;
    /** A leave is in flight (Continue in chat): hold Back. */
    leaving?: boolean;
    onback?: (() => void) | null;
    onstart: () => void;
    onskip: () => void;
    onretry: () => void;
    /** "Check again" on the Update HQ state: scan once more (HQ may have been updated meanwhile). */
    onrecheck?: (() => void) | null;
    onnext: () => void;
    onfinish: () => void;
    /** Test seam; null follows prefers-reduced-motion. */
    reducedMotion?: boolean | null;
    /** What to say in the takeover's one live region (this step has none of its own). */
    onannounce?: ((text: string) => void) | null;
  }

  let {
    name,
    stepNumber,
    total,
    run,
    clock,
    nextLabel,
    offersFinish,
    finishLabel = "Finish with defaults",
    leaving = false,
    onback = null,
    onstart,
    onskip,
    onretry,
    onrecheck = null,
    onnext,
    onfinish,
    reducedMotion = null,
    onannounce = null,
  }: Props = $props();

  const shownName = $derived(name.trim() || "your assistant");
  /**
   * The plan for the lines so far. The runner hands over lines once per
   * frame; the plan is rebuilt only when that batch, the start or the failure
   * changed (a new view object with the same lines reuses the last plan).
   */
  const planFor = createPlanMemo();
  const plan = $derived<ScenePlan>(planFor({ scanStart: run.scanStart, events: run.events, failure: run.failure }));
  /** Retry helps unless HQ itself needs an update first. */
  const canRetry = $derived(run.failure?.retry !== false);
  /** Asking first: before "Bring it in" (and after a cancel or a skip). */
  const asking = $derived(run.phase === "idle" || run.phase === "skipped");
  const empty = $derived(plan.outcome === "empty");

  let prefersReduced = $state(false);
  onMount(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    prefersReduced = mq.matches;
    const onChange = () => (prefersReduced = mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  });
  const reduced = $derived(reducedMotion ?? prefersReduced);

  /** One press per action: Bring it in, Skip, Retry, Next and Finish all hold once pressed. */
  let pressed = $state<"start" | "skip" | "next" | "finish" | "recheck" | null>(null);
  /** The failure "Check again" was pressed on; the press holds until the scan it ran has ended. */
  let recheckedFailure: ImportRunView["failure"] = null;
  $effect(() => {
    // A new phase is a new decision.
    const phase = run.phase;
    const failure = run.failure;
    untrack(() => {
      if (pressed === "start" || pressed === "skip") pressed = null;
      if (pressed === "recheck" && phase !== "running" && failure !== recheckedFailure) pressed = null;
    });
  });
  function press(kind: "start" | "skip" | "next" | "finish" | "recheck", fn: () => void): void {
    if (pressed === null && kind === "recheck") recheckedFailure = run.failure;
    if (pressed !== null) return;
    pressed = kind;
    fn();
  }

  /** A row shows its two largest counts, as the preview does (Skills and settings has nine keys), zeros left out. */
  function rowWords(row: PlanRow): Array<{ key: string; word: string }> {
    const latest = row.counts.map((c) => ({ key: c.key, v: c.samples[c.samples.length - 1]?.v ?? 0 }));
    const shown = latest.filter((c) => c.v > 0).sort((a, b) => b.v - a.v).slice(0, 2);
    return (shown.length ? shown : latest.slice(0, 1)).map((c) => ({ key: c.key, word: countWord(c.key, c.v) }));
  }
  function limbTitle(limb: PlanLimb): string {
    if (limb.slot !== "other") return limb.name;
    if (limb.extraCompanies > 0) return `${limb.extraCompanies} more ${limb.extraCompanies === 1 ? "company" : "companies"}`;
    return "Other projects";
  }
  function limbMeta(limb: PlanLimb): string {
    return `${limb.projectTotal} ${limb.projectTotal === 1 ? "project" : "projects"}`;
  }

  /** What the live region says: a change of the scan's state, never every count. */
  const announcement = $derived(
    asking
      ? ""
      : plan.outcome === "running"
        ? `Reading this Mac. ${plan.rows.filter((r) => r.resolve !== null).length} of ${Math.max(plan.rows.length, 1)} sources read.`
        : plan.outcome === "failed"
          ? (plan.failure?.message ?? "")
          : plan.outcome === "empty"
            ? "Nothing to bring in yet."
            : `${shownName} knows your world. ${plan.summary.map((s) => `${s.value} ${s.label}`).join(", ")}.`,
  );
  $effect(() => {
    const text = announcement;
    untrack(() => onannounce?.(text));
  });

  // ── the frame ─────────────────────────────────────────────────────────────

  let root = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);

  let geo: SceneGeometry | null = null;
  let reference: TreeRaster | null = null;
  let crown = { minX: 0, maxX: 0, minY: 0 };
  let stat: StaticLayout | null = null;
  let layout: SceneLayout | null = null;
  let busyUntil = 0;
  let builtPlan: ScenePlan | null = null;
  let builtAt = -Infinity;
  let ctx: (CanvasRenderingContext2D & DrawContext) | null = null;
  let dpr = 1;
  let raf = 0;
  let frameCount = 0;
  let lastWidths: number[] = [];

  function relayout(): void {
    const el = root;
    if (!el) return;
    const W = Math.max(320, el.clientWidth || window.innerWidth || 1180);
    const H = Math.max(320, el.clientHeight || window.innerHeight || 760);
    geo = sceneGeometry(W, H);
    el.style.setProperty("--fr-col-left", `${geo.colLeft}px`);
    el.style.setProperty("--fr-col-top", `${geo.colTop}px`);
    el.style.setProperty("--fr-col-width", `${geo.colW}px`);
    el.style.setProperty("--fr-h-size", `${geo.hSize}px`);
    el.style.setProperty("--fr-rows-gap", `${geo.rowsGap}px`);
    el.style.setProperty("--fr-foot-top", `${geo.footTop}px`);
    reference = rasterizeTree(generateTree(referenceSpec()), geo.box);
    crown = crownExtents(reference);
    stat = buildStaticLayout(geo, reference, crown);
    if (canvas) {
      dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      try {
        ctx = canvas.getContext("2d") as (CanvasRenderingContext2D & DrawContext) | null;
      } catch {
        ctx = null;
      }
    }
    builtPlan = null;
  }

  function rowBoxes(): RowBox[] {
    const el = root;
    const rows = el?.querySelector<HTMLElement>("[data-fr-rows]");
    if (!el || !rows || !geo) return [];
    const base = el.getBoundingClientRect();
    const box = rows.getBoundingClientRect();
    const x = box.left - base.left + 18;
    const y0 = box.top - base.top;
    return plan.rows.map((_, i) => ({ x, y: y0 + i * 38 + 19, w: 138 + 92 }));
  }

  function labelWidths(): number[] {
    const el = root;
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>("[data-fr-clabel]")).map((n) => n.offsetWidth || 120);
  }

  function rebuild(t: number): void {
    if (!geo || !reference) relayout();
    if (!geo || !reference) return;
    const p = plan;
    const model = generateTree(treeSpecFor(p));
    const raster = rasterizeTree(model, geo.box);
    lastWidths = labelWidths();
    layout = {
      geo,
      raster,
      feed: buildFeed(raster, p, rowBoxes()),
      callouts: buildCallouts(raster, reference, geo.W, lastWidths),
      crown,
    };
    busyUntil = lastScheduled(layout, p);
    builtPlan = p;
    builtAt = t;
  }

  /** The frame for a second shown under reduced motion: everything in so far, settled. */
  function settledSecond(): number {
    const p = plan;
    return Math.max(clock.now(), busyUntil + 2, (p.settle ?? 0) + 3, INTRO.consent + 2);
  }

  function render(t: number): void {
    if (builtPlan !== plan && (reduced || t - builtAt >= 0.2 || !layout)) rebuild(t);
    if (!layout || !stat) return;
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScene(ctx, layout, stat, builtPlan ?? plan, t);
    }
    applyDom(t);
  }

  function loop(): void {
    raf = 0;
    if (typeof document !== "undefined" && document.hidden) return; // visibilitychange restarts
    const t = clock.now();
    const p = plan;
    frameCount += 1;
    const rest = p.settle ?? (p.failure ? p.lastBeat : null);
    let every = 1;
    if (t > busyUntil + 1) every = 2; // ambient only: dust, twinkle, sway
    if (rest !== null && t > Math.max(rest, busyUntil) + 8) every = 4;
    const stopAt =
      rest !== null ? Math.max(rest, busyUntil) + 60 : run.phase === "running" ? Infinity : Math.max(75, busyUntil + 60);
    const stale = builtPlan !== p;
    if (stale || every === 1 || frameCount % every === 0) render(t);
    if (t < stopAt) raf = requestAnimationFrame(loop);
  }

  function kick(): void {
    if (reduced) {
      render(settledSecond());
      return;
    }
    if (raf || typeof requestAnimationFrame !== "function") return;
    raf = requestAnimationFrame(loop);
  }

  onMount(() => {
    relayout();
    kick();
    const onResize = () => {
      relayout();
      if (reduced) render(settledSecond());
      else {
        render(clock.now());
        kick();
      }
    };
    const onVisibility = () => {
      if (!document.hidden) kick();
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    // Draw again once the mono face is in, so the glyph grid is the right one.
    void document.fonts?.load?.(`10px ${MONO_FONT}`).then(
      () => {
        if (reduced) render(settledSecond());
      },
      () => undefined,
    );
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
  });

  // New data (or a change of motion preference): draw it.
  $effect(() => {
    void plan;
    void reduced;
    void asking;
    untrack(() => {
      if (!root) return;
      if (reduced && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      kick();
    });
  });

  // ── the DOM part of the frame (the preview's drawDom) ──────────────────────

  const SPIN = [".  ", ".. ", "...", " ..", "  .", "   "];
  const GRAIN = [
    [0, 0],
    [-3, 2],
    [4, -2],
    [-2, -3],
    [3, 3],
    [1, -1],
  ] as const;

  function show(el: HTMLElement | null, opacity: number, dy: number): void {
    if (!el) return;
    el.style.opacity = opacity.toFixed(3);
    el.style.transform = dy ? `translateY(${dy.toFixed(2)}px)` : "none";
  }
  function riseIn(t: number, start: number, dur: number, dist: number): { o: number; y: number } {
    const e = easeOut(clamp01((t - start) / dur));
    return { o: e, y: (1 - e) * dist };
  }
  function setText(el: Element | null, text: string): void {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function applyDom(t: number): void {
    const el = root;
    const L = layout;
    if (!el || !L) return;
    const p = builtPlan ?? plan;
    const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector<T>(sel);
    const amp = swayAmp(p, t);

    const grain = q("[data-fr-grain]");
    if (grain) {
      const gi = Math.floor((((t % 1.2) + 1.2) % 1.2) / 0.2);
      const g = GRAIN[gi] ?? GRAIN[0];
      grain.style.opacity = (0.42 * clamp01(t / 0.9)).toFixed(3);
      grain.style.transform = `translate(${g[0]}%, ${g[1]}%)`;
    }

    let r = riseIn(t, INTRO.kicker, 0.9, 12);
    show(q("[data-fr-kicker]"), r.o, r.y);
    show(q("[data-fr-top]"), r.o, 0);

    // title and body; they change at settle
    const settle = p.settle ?? Infinity;
    const out1 = easeOut(clamp01((t - settle) / 0.6));
    r = riseIn(t, INTRO.title, 0.9, 12);
    show(q("[data-fr-t1]"), r.o * (1 - out1), r.y - out1 * 10);
    r = riseIn(t, settle + 0.32, 0.9, 12);
    show(q("[data-fr-t2]"), r.o, r.y);
    const outB = easeOut(clamp01((t - settle - 0.1) / 0.5));
    r = riseIn(t, INTRO.body, 0.9, 12);
    show(q("[data-fr-b1]"), r.o * (1 - outB), r.y - outB * 8);
    r = riseIn(t, settle + 0.62, 0.9, 10);
    show(q("[data-fr-b2]"), r.o, r.y);

    // the consent line, until "Bring it in"
    const consent = q("[data-fr-consent]");
    if (consent) {
      r = riseIn(t, INTRO.consent - 0.2, 0.9, 8);
      show(consent, r.o, r.y);
    }

    // rows
    el.querySelectorAll<HTMLElement>("[data-fr-row]").forEach((rowEl) => {
      const i = Number(rowEl.dataset.frRow);
      const row = p.rows[i];
      if (!row) return;
      const rr = riseIn(t, row.appear, 0.7, 8);
      show(rowEl, rr.o, rr.y);
      const pending = rowEl.querySelector<HTMLElement>("[data-fr-pending]");
      const txt = rowEl.querySelector("[data-fr-txt]");
      const full = `Reading ${row.label}`;
      const nChars = Math.max(0, Math.min(full.length, Math.floor((t - row.appear) * 42)));
      setText(txt, full.slice(0, nChars));
      const spinI = Math.floor(Math.max(0, t - row.appear) * 6) % SPIN.length;
      const going = row.resolve === null || t < row.resolve;
      const spin = reduced ? "..." : (SPIN[spinI] ?? "");
      setText(rowEl.querySelector("[data-fr-spin]"), nChars >= full.length ? spin : "");
      const shownAt = row.shown ?? Infinity;
      const po = easeOut(clamp01((t - shownAt) / 0.5));
      if (pending) {
        pending.style.opacity = (1 - po).toFixed(3);
        pending.style.transform = `translateY(${(-po * 6).toFixed(2)}px)`;
      }
      const dn = riseIn(t, shownAt + 0.12, 0.7, 8);
      show(rowEl.querySelector("[data-fr-done]"), dn.o, dn.y);
      // hairline brightens while this source is feeding the tree
      const next = p.rows[i + 1];
      const until = next ? next.appear - 0.3 : Math.min(settle, row.resolve !== null ? row.resolve + 0.6 : Infinity);
      const active = smooth((t - row.appear) / 0.4) * (1 - smooth((t - until) / 0.6));
      const rule = rowEl.querySelector<HTMLElement>("[data-fr-rule]");
      if (rule) rule.style.opacity = (0.16 + 0.5 * active).toFixed(3);
      // counters
      rowEl.querySelectorAll<HTMLElement>("[data-fr-num]").forEach((numEl) => {
        const key = numEl.dataset.frNum ?? "";
        const c = row.counts.find((x) => x.key === key);
        const value = c ? countValue(c.samples, t) : 0;
        setText(numEl, String(value));
        // The word follows the number on screen ("1 company", then "3 companies").
        setText(rowEl.querySelector(`[data-fr-word="${key}"]`), countWord(key, value));
      });
      setText(rowEl.querySelector("[data-fr-cspin]"), going && t >= shownAt ? spin : "");
    });

    // the failure line
    const status = q("[data-fr-status]");
    if (status && p.failure) {
      r = riseIn(t, p.failure.at + PACE.lag, 0.7, 8);
      show(status, r.o, r.y);
    }

    // footer
    r = riseIn(t, INTRO.consent, 0.9, 10);
    show(q("[data-fr-actions]"), r.o, r.y);

    // company callouts
    const W = L.geo.W;
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    el.querySelectorAll<HTMLElement>("[data-fr-clabel]").forEach((lab) => {
      const i = Number(lab.dataset.frClabel);
      const g = calloutGeom(L, p, i, t);
      if (!g) {
        lab.style.opacity = "0";
        return;
      }
      const tc = calloutTime(L.raster, i) + 0.35;
      const e = easeOut(clamp01((t - tc) / 0.7)) * witherAt(L.raster.anchors[i]?.gone ?? Infinity, t);
      const sway = swayAt(L.raster, g.ly, t, amp) * 0.5;
      if (lab.dataset.side !== g.side) lab.dataset.side = g.side;
      const w = lab.offsetWidth;
      const h = lab.offsetHeight || 32;
      let x = g.side === "left" ? g.lx - w + sway : g.lx + sway;
      let y = g.ly - 7;
      // step clear of the callouts placed already
      for (let pass = 0; pass < 4; pass += 1) {
        const hit = rects.find((b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y);
        if (!hit) break;
        y = hit.y + hit.h + 2;
      }
      x = Math.max(SAFE, Math.min(W - SAFE - w, x));
      lab.style.opacity = e.toFixed(3);
      lab.style.transform = `translate(${x.toFixed(1)}px, ${(y + (1 - e) * 8).toFixed(1)}px)`;
      if (e > 0.01) rects.push({ x: x - 4, y: y - 4, w: w + 8, h: h + 8 });
    });

    // project labels: briefly, as each project branch forms
    el.querySelectorAll<HTMLElement>("[data-fr-plabel]").forEach((lab) => {
      const li = Number(lab.dataset.frPlabel);
      const pj = Number(lab.dataset.project);
      const a = L.raster.projAnchors.find((x) => x.limb === li && x.project === pj);
      if (!a) {
        lab.style.opacity = "0";
        return;
      }
      const tin = a.done - 0.2;
      const e =
        easeOut(clamp01((t - tin) / 0.6)) * (1 - easeInOut(clamp01((t - tin - 1.7) / 0.8))) * witherAt(a.gone, t);
      if (e <= 0.001) {
        lab.style.opacity = "0";
        return;
      }
      // just past the growing tip, in the direction the branch is heading
      const w = lab.offsetWidth;
      const h = lab.offsetHeight || 16;
      const dx = Math.cos(a.a);
      const dy = Math.sin(a.a);
      const tipX = a.x + dx * 26 + swayAt(L.raster, a.y, t, amp);
      const tipY = a.y + dy * 26;
      let x = dx < -0.25 ? tipX - w : dx > 0.25 ? tipX : tipX - w / 2;
      let y = dy < -0.5 ? tipY - h : tipY - h / 2;
      x = Math.max(SAFE, Math.min(W - SAFE - w, x));
      for (let pass = 0; pass < 4; pass += 1) {
        const hit = rects.find((b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y);
        if (!hit) break;
        y = hit.y + hit.h + 2;
      }
      rects.push({ x: x - 2, y: y - 2, w: w + 4, h: h + 4 });
      lab.style.opacity = (e * 0.9).toFixed(3);
      lab.style.transform = `translate(${x.toFixed(1)}px, ${(y + (1 - e) * 6).toFixed(1)}px)`;
    });
  }
</script>

<div
  bind:this={root}
  class="fr-import"
  data-testid="first-run-import"
  data-phase={run.phase}
  data-outcome={plan.outcome}
  data-reduced={reduced ? "true" : undefined}
>
  <div class="fr-wall" aria-hidden="true"></div>
  <div class="fr-veil" aria-hidden="true"></div>
  <div class="fr-vignette" aria-hidden="true"></div>
  <canvas bind:this={canvas} class="fr-canvas" aria-hidden="true"></canvas>
  <div class="fr-grain" data-fr-grain aria-hidden="true"></div>

  <section class="fr-col">
    <div class="new-bot-step-top" data-fr-top>
      {#if onback}<button
          type="button"
          class="new-bot-back"
          data-testid="first-run-back"
          disabled={leaving}
          onclick={onback}
        ><RailIcon name="arrow-left" />Back</button>{/if}
      {#if total > 0}<div class="new-bot-progress" data-testid="new-bot-progress" role="img" aria-label={`Step ${stepNumber} of ${total}`}>{#each Array(total) as _, index}<span class:done={index + 1 < stepNumber} class:active={index + 1 === stepNumber}></span>{/each}</div>{/if}
    </div>
    <p class="fr-kicker" data-fr-kicker>Step {stepNumber} · Your context</p>
    <div class="fr-stack">
      <h1 class="fr-h" id="new-bot-takeover-title" data-fr-t1 data-testid="first-run-import-title">Let's bring <em>{shownName}</em><br />up to speed.</h1>
      {#if empty}
        <p class="fr-h" data-fr-t2 data-testid="first-run-import-title-done" aria-hidden={plan.settle === null}>Nothing to bring<br />in <em>yet.</em></p>
      {:else}
        <p class="fr-h" data-fr-t2 data-testid="first-run-import-title-done" aria-hidden={plan.settle === null}><em>{shownName}</em> knows<br />your world.</p>
      {/if}
    </div>
    <div class="fr-stack">
      <p class="fr-body" data-fr-b1>HQ reads the tools you already work in, here on this Mac, so {shownName} starts out knowing your companies, projects and people.</p>
      {#if empty}
        <p class="fr-body" data-fr-b2 data-testid="first-run-import-summary">HQ found no history from your tools on this Mac yet. {shownName} learns as you work.</p>
      {:else}
        <p class="fr-body fr-summary" data-fr-b2 data-testid="first-run-import-summary">{#each plan.summary as item, i}{#if i > 0}<span class="fr-dot">·</span>{/if}<b>{item.value}</b> {item.label}{/each}</p>
      {/if}
    </div>

    {#if asking}
      <p class="fr-consent" data-fr-consent data-testid="first-run-import-consent">It reads only this Mac, and nothing leaves it.</p>
    {:else}
      <div class="fr-rows" data-fr-rows data-testid="first-run-import-rows">
        {#each plan.rows as row, i (row.id)}
          <div class="fr-row" data-fr-row={i} data-testid="first-run-import-row" data-source={row.id} data-status={row.status ?? "reading"}>
            <span class="fr-rule" data-fr-rule></span>
            <span class="fr-layer fr-pending" data-fr-pending><span data-fr-txt></span><span class="fr-spin" data-fr-spin></span></span>
            <span class="fr-layer fr-done" data-fr-done>
              <span class="fr-name">{row.label}</span>
              <span class="fr-count" data-testid="first-run-import-row-count">{#each rowWords(row) as w, k (w.key)}{#if k > 0}<span class="fr-dot">·</span>{/if}<b data-fr-num={w.key}>0</b> <span data-fr-word={w.key}>{w.word}</span>{/each}{#if row.message}{#if row.counts.length}<span class="fr-dot">·</span>{/if}<span data-testid="first-run-import-row-message" title={row.message}>{row.message}</span>{/if}<span class="fr-spin" data-fr-cspin></span></span>
            </span>
          </div>
        {/each}
      </div>
      {#if plan.failure}
        <p class="fr-status" data-fr-status data-testid="first-run-import-failed">
          <span>{plan.failure.message}</span>
          {#if canRetry}<button type="button" class="fr-link" data-testid="first-run-import-retry" onclick={onretry}>Retry</button>{:else if onrecheck}<button
              type="button"
              class="fr-link"
              data-testid="first-run-import-recheck"
              disabled={pressed === "recheck"}
              aria-busy={pressed === "recheck" ? "true" : undefined}
              onclick={() => press("recheck", onrecheck)}
            >{pressed === "recheck" ? "Checking…" : "Check again"}</button>{/if}
        </p>
      {/if}
    {/if}
  </section>

  <div class="fr-labels" aria-hidden="true">
    {#each plan.limbs as limb, i (`${limb.id}:${i}`)}
      <div class="fr-clabel" data-fr-clabel={i} data-side="right"><div class="fr-cn">{limbTitle(limb)}</div><div class="fr-cm">{limbMeta(limb)}</div></div>
    {/each}
    {#each plan.limbs as limb, li (`${limb.id}:${li}`)}
      {#each limb.projects as project, j (project.id)}
        <div class="fr-plabel" data-fr-plabel={li} data-project={j}>{project.name}</div>
      {/each}
    {/each}
  </div>

  <div class="fr-actions" data-fr-actions>
    {#if asking}
      <div class="new-bot-foot-actions">
        <button
          type="button"
          class="new-bot-create-next"
          data-testid="first-run-import-skip"
          disabled={pressed !== null}
          onclick={() => press("skip", onskip)}
        >Skip for now</button>
        <button
          type="button"
          class="new-bot-create-submit"
          data-testid="first-run-import-start"
          disabled={pressed !== null}
          aria-busy={pressed === "start" ? "true" : undefined}
          onclick={() => press("start", onstart)}
        >{pressed === "start" ? "Starting…" : "Bring it in"}</button>
      </div>
    {:else}
      <div class="new-bot-foot-actions" class:single={!offersFinish}>
        <button
          type="button"
          class={offersFinish ? "new-bot-create-next" : "new-bot-create-submit"}
          data-testid="first-run-next"
          disabled={pressed === "next" || pressed === "finish"}
          onclick={() => press("next", onnext)}
        >{nextLabel}<RailIcon name="arrow-right" /></button>
        {#if offersFinish}
          <button
            type="button"
            class="new-bot-create-submit"
            data-testid="first-run-finish"
            disabled={pressed === "next" || pressed === "finish"}
            onclick={() => press("finish", onfinish)}
          >{finishLabel}</button>
        {/if}
      </div>
    {/if}
  </div>
</div>
