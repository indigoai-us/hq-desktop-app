<script lang="ts">
  /**
   * Daily Brief page. The generator picks the lead, scores the catalogue
   * against today's priorities and fills a 6-column template; this component
   * renders that plan. Every card carries the sentence that explains it (slot
   * title, header peek), and review mode (Shift+A) shows the whole catalogue
   * grouped, including the cards that are not built yet. Styles and the
   * effect legend live in brief.css.
   *
   * Actions never call product APIs. Each actionable item hands its prompt to
   * a new Claude, Codex or Grok session (through `onlaunch`) or the
   * clipboard, and is marked done in this brief only.
   */
  import "./brief.css";
  import BriefAgenda from "./BriefAgenda.svelte";
  import BriefBlockedByMe from "./BriefBlockedByMe.svelte";
  import BriefCarry from "./BriefCarry.svelte";
  import BriefCatchUp from "./BriefCatchUp.svelte";
  import BriefDecided from "./BriefDecided.svelte";
  import BriefFirsts from "./BriefFirsts.svelte";
  import BriefFleetRecovery from "./BriefFleetRecovery.svelte";
  import BriefFocus from "./BriefFocus.svelte";
  import BriefHandoffs from "./BriefHandoffs.svelte";
  import BriefIncident from "./BriefIncident.svelte";
  import BriefMeetings from "./BriefMeetings.svelte";
  import BriefNeedsYou from "./BriefNeedsYou.svelte";
  import BriefOneThing from "./BriefOneThing.svelte";
  import BriefPeek from "./BriefPeek.svelte";
  import BriefReleaseTrain from "./BriefReleaseTrain.svelte";
  import BriefReminders from "./BriefReminders.svelte";
  import BriefResolved from "./BriefResolved.svelte";
  import BriefRisk from "./BriefRisk.svelte";
  import BriefRunway from "./BriefRunway.svelte";
  import BriefShipped from "./BriefShipped.svelte";
  import BriefSunrise from "./BriefSunrise.svelte";
  import BriefTeam from "./BriefTeam.svelte";
  import BriefTodayStrip from "./BriefTodayStrip.svelte";
  import BriefWaiting from "./BriefWaiting.svelte";
  import BriefWeekArc from "./BriefWeekArc.svelte";
  import BriefHousekeeping from "./BriefHousekeeping.svelte";
  import type { Snippet } from "svelte";
  import type { BriefHousekeeping as BriefHousekeepingData } from "./brief-run-files.js";
  import type { BriefDmApi } from "./brief-dms.js";
  import { briefItemKinds, type BriefLogSink } from "./brief-log.js";
  import {
    BriefState,
    launchBriefPromptViaClipboard,
    provideBrief,
    type BriefCompanyLogo,
    type BriefLaunch,
  } from "./brief-context.svelte.js";
  import { peek, type PeekContent } from "./brief-context.svelte.js";
  import { generateBrief, gridStyle, leadLabel, type BriefWidget } from "./brief-generate.js";
  import { CATALOGUE, SPAN, buildContext, entryOf, rankDecisions, reasonFor, type Scored, type WidgetGroup } from "./brief-catalogue.js";
  import BriefPriorities from "./BriefPriorities.svelte";
  import { briefPriorities, watchTitle } from "./brief-peeks.js";
  import type { BriefInput, BriefRisk as BriefRiskRow } from "./brief-types.js";
  import { effortMinutes } from "./brief-hero.js";
  import { distillTimeline, isTimelineSession, sinceLabel } from "./brief-timeline.js";

  interface Props {
    input: BriefInput;
    companies?: readonly BriefCompanyLogo[];
    /** Opens a session with the prompt pre-filled. Defaults to copying it. */
    onlaunch?: BriefLaunch;
    /** Run controls (Create brief, history) shown in the header. */
    header?: Snippet;
    /** The shown run's housekeeping.json, when it has one. */
    housekeeping?: BriefHousekeepingData | null;
    /** Live DM reads for the Team card. */
    dmApi?: BriefDmApi | null;
    /** Opens the DM with this uid in Messages. */
    onopenthread?: (uid: string) => void;
    /** Opens the Meetings page. */
    onopenmeetings?: () => void;
    /** The brief log (shown, dismiss, launch, pin, hide), when the host keeps one. */
    log?: BriefLogSink | null;
  }
  let { input, companies = [], onlaunch, header, housekeeping = null, dmApi = null, onopenthread, onopenmeetings, log = null }: Props = $props();

  const briefState = new BriefState(
    (engine, prompt) => (onlaunch ?? launchBriefPromptViaClipboard)(engine, prompt),
    () => companies,
    { dmApi: () => dmApi, openThread: () => onopenthread, log: () => log, runId: () => input.runId ?? null, kindOf: (id) => itemKinds[id] ?? null },
  );
  provideBrief(briefState);

  const plan = $derived(generateBrief(input));
  /** The card each item id sits on, for the brief log. */
  const itemKinds = $derived(briefItemKinds(input));
  // One `shown` line per run, with the cards on the page. A run shown again
  // in the same page life (A, B, back to A) is not shown twice.
  const loggedRuns = new Set<string | null>();
  $effect(() => {
    const runId = input.runId ?? null;
    const widgets = plan.widgets.map((w) => w.kind);
    if (!log || loggedRuns.has(runId)) return;
    loggedRuns.add(runId);
    log.append({ event: "shown", run_id: runId, widgets });
  });
  const ctx = $derived(buildContext(input));
  const priorities = $derived(briefPriorities(input));
  // Needs rows: the ones a priority points at first, then by what they unblock.
  const needsRows = $derived(rankDecisions(ctx));
  const cleared = $derived(input.decisions.filter((d) => briefState.cleared[d.id]).length);
  // Every live incident the catalogue counted; the lead is the one a priority points at (by rank), else the first.
  const incidents = $derived(input.risks.filter((r) => r.severity === "incident"));
  const incident = $derived.by((): BriefRiskRow | null => {
    const rank = (r: BriefRiskRow) => ctx.priorities.find((p) => p.itemId === r.id)?.rank ?? 99;
    return [...incidents].sort((a, b) => rank(a) - rank(b))[0] ?? null;
  });
  const watches = $derived(input.risks.filter((r) => r.severity === "watch"));
  const nowDate = $derived(new Date(input.now));
  const dateLabel = $derived(
    nowDate.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }).replace(",", " ·"),
  );
  const timeLabel = $derived(nowDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
  const leadForHero = $derived(plan.leadPriority ? { text: plan.leadPriority.text, because: plan.leadPriority.because } : null);

  /** One line under the greeting, from what the day holds. */
  const sunSub = $derived.by(() => {
    const parts: string[] = [];
    if (input.merged != null) {
      // Same numbers as the loader and the shipped card: the sweep's PR window.
      const since = input.prWindow ? sinceLabel(input.prWindow.from, input.now) : "Yesterday";
      parts.push(`${since} you merged ${input.merged}${input.opened != null ? ` and opened ${input.opened}` : ""}.`);
    } else if (input.shipped.length) {
      parts.push(`Yesterday ${input.shipped.length} thing${input.shipped.length === 1 ? "" : "s"} shipped.`);
    } else if (input.meetingsYesterday.length) {
      parts.push(`Yesterday had ${input.meetingsYesterday.length} meeting${input.meetingsYesterday.length === 1 ? "" : "s"}.`);
    }
    // The incident by its plain title ("HQ Cloud main is red"), never the sweep's repo slug.
    if (incident) parts.push(`The one fire: ${watchTitle(incident)}.`);
    else if (!input.decisions.length) parts.push("Nothing needs you right now.");
    return parts.join(" ") || "A quiet start.";
  });
  const quietLine = $derived(
    input.calendarToday.length ? `${input.calendarToday.length} call${input.calendarToday.length === 1 ? "" : "s"} today.` : "Nothing owed.",
  );
  // The sunrise card always shows the last 24 hours of this company's sessions.
  const timeline = $derived.by(() => {
    const end = Date.parse(input.now);
    return (input.recentSessions ?? input.sessions)
      .filter(isTimelineSession)
      .filter((s) => !s.company || input.companies.some((c) => c.toLowerCase() === s.company!.toLowerCase()))
      .filter((s) => {
        const t = Date.parse(s.startedAt);
        return t > end - 24 * 3600_000 && t <= end;
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((s) => ({ at: s.startedAt, title: s.title, id: s.id, company: s.company, project: s.project ?? null }));
  });
  // Distilled once here so the hero does not distill the same sessions again.
  const tl = $derived(distillTimeline(timeline, input.now));
  // The writer's total minutes to clear every call, else summed from each call's effort size.
  const timeToClear = $derived(input.timeToClearMin ?? effortMinutes(input.decisions));

  // Hover detail for the header counts: what each number is made of, five lines at most.
  function provPeek(label: string): PeekContent {
    const line = (l: string, st: string | number = "") => ({ label: l, state: String(st) });
    if (label.startsWith("session")) {
      return {
        title: `${plan.sessions.count} sessions`,
        status: "By workstream",
        sections: [{ label: "Most active", lines: plan.sessions.byWorkstream.slice(0, 5).map((w) => line(w.name, w.count)) }],
      };
    }
    if (label.startsWith("DM")) {
      const people = input.team.filter((t) => t.dmCount).sort((a, b) => (b.dmCount ?? 0) - (a.dmCount ?? 0));
      return { title: `${input.dmCount ?? 0} DMs`, status: "Who wrote", sections: [{ label: "From", lines: people.slice(0, 5).map((t) => line(t.name, t.dmCount ?? "")) }] };
    }
    if (label.startsWith("signal")) {
      return {
        title: "Signals from meetings",
        sections: [
          { label: "Mix", lines: [line("Decisions to make", input.decisions.length), line("Action items", input.actionItems.length), line("Risks", input.risks.length)] },
          ...(input.decisions.length ? [{ label: "Latest", lines: input.decisions.slice(0, 3).map((d) => line(d.title)) }] : []),
        ],
      };
    }
    return {
      title: `${input.meetingsYesterday.length} meetings yesterday`,
      sections: [{ label: "Meetings", lines: input.meetingsYesterday.map((m) => line(m.title, m.decisions ? `${m.decisions} decided` : "")) }],
    };
  }

  /** A dropped kind by its card name ("Team"), a priority row by its rank; never a camelCase id. */
  function kindName(kind: string): string {
    const m = kind.match(/^priority-(\d+)$/);
    if (m) return `Priority ${m[1]}`;
    return CATALOGUE.find((e) => e.id === kind)?.name ?? kind;
  }

  /** Why these cards: one line per widget (the peek shows five, then "+N more"), then what is not shown. */
  function whyPeek(): PeekContent {
    return {
      title: "Why these cards",
      status: `${plan.template === "1" ? "A quiet day" : `Template ${plan.template}`} · ${plan.dayType}`,
      sections: [
        { label: "On the page", lines: plan.widgets.map((w) => ({ label: `${entryOf(w.kind).name} — ${w.reason}`, state: "" })) },
        ...(plan.dropped.length ? [{ label: "Not shown today", lines: plan.dropped.map((d) => ({ label: `${kindName(String(d.kind))}: ${d.why}`, state: "" })) }] : []),
      ],
    };
  }

  // Review mode (Shift+A on the page): the whole catalogue grouped, every
  // entry with evidence at its first size, so the owner can give feedback card
  // by card. Not-built cards render a placeholder saying what they would say.
  let allCards = $state(false);
  const GROUP_LABEL: Record<WidgetGroup, string> = {
    hero: "Hero",
    needs: "Needs you",
    health: "Health",
    waiting: "Waiting",
    momentum: "Momentum",
    people: "People",
    self: "Your day",
  };
  type Tile = { type: "label"; key: string; text: string } | { type: "card"; key: string; w: BriefWidget; scored: Scored };
  const reviewTiles = $derived.by((): Tile[] => {
    const tiles: Tile[] = [];
    const byKind = new Map(plan.scored.map((s) => [s.kind, s]));
    const groups = [...new Set(CATALOGUE.map((e) => e.group))];
    for (const group of groups) {
      const entries = CATALOGUE.filter((e) => e.group === group && byKind.has(e.id));
      if (!entries.length) continue;
      tiles.push({ type: "label", key: `group:${group}`, text: GROUP_LABEL[group] });
      for (const entry of entries) {
        const s = byKind.get(entry.id)!;
        const size = entry.fits[0]!;
        const [cols, rows] = SPAN[size];
        tiles.push({
          type: "card",
          key: entry.id,
          scored: s,
          w: { kind: entry.id, slot: entry.id, size, cols, rows, tier: s.tier, score: s.score, reason: reasonFor(entry, s.ev, s.why, ctx), serves: s.serves },
        });
      }
    }
    return tiles;
  });
  const liveTiles = $derived.by((): Tile[] => plan.widgets.map((w) => ({ type: "card", key: w.kind, w, scored: plan.scored.find((s) => s.kind === w.kind)! })));
  const tiles = $derived(allCards ? reviewTiles : liveTiles);
  // When the Handoffs card is on the page, the Waiting card leaves handoff rows to it.
  const handoffsPlaced = $derived(tiles.some((t) => t.type === "card" && t.w.kind === "handoffs"));
  const partsOf = (kind: string) => {
    const s = plan.scored.find((x) => x.kind === kind);
    return s ? `value ${s.parts.value} · priority ${s.parts.priority} · day ${s.parts.day} · pref ${s.parts.pref} · rotation -${s.parts.rotation}` : undefined;
  };
  /**
   * The strip under the grid, review mode only: dropped kinds by card name plus entries with no
   * evidence at all. The live page keeps the dropped list behind the lead chip's peek.
   */
  const notShown = $derived.by(() => {
    if (!allCards) return [];
    const rows = plan.dropped.map((d) => ({ kind: String(d.kind), name: kindName(String(d.kind)), why: d.why }));
    const seen = new Set([...plan.scored.map((s) => String(s.kind)), ...rows.map((r) => r.kind)]);
    for (const e of CATALOGUE) if (!seen.has(e.id)) rows.push({ kind: e.id, name: e.name, why: "no data" });
    return rows;
  });
  const notShownRest = (): PeekContent => ({
    title: `${notShown.length - 5} more not shown`,
    sections: [{ label: "Not shown today", lines: notShown.slice(5).map((r) => ({ label: `${r.name}: ${r.why}`, state: "" })) }],
  });
  function onkey(e: KeyboardEvent) {
    if (e.shiftKey && (e.key === "A" || e.key === "a") && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      allCards = !allCards;
    }
  }
</script>

<svelte:window onkeydown={onkey} />

<div class="daily-brief" data-testid="daily-brief" data-lead={plan.lead} data-density={plan.density} data-template={plan.template} data-daytype={plan.dayType}>
  <header class="b-head">
    <div class="b-brand">
      <div class="b-mark" aria-hidden="true">
        <svg class="ico" viewBox="0 0 24 24"><path d="M3 17h18M6 17a6 6 0 0 1 12 0M12 5v2M5.6 8.6l1.4 1.4M18.4 8.6 17 10" /></svg>
      </div>
      <div>
        <h1>Daily Brief</h1>
        <div class="eyebrow" style="margin-top:4px">{dateLabel} · {timeLabel}</div>
      </div>
    </div>
    <div class="b-prov" title="What this brief was generated from">
      <span class="leadchip" data-testid="brief-lead" role="group" aria-label="Why these cards" use:peek={{ state: briefState, content: whyPeek }}
        >Lead <b>{leadLabel(plan.lead)}</b> · {plan.density} widget{plan.density === 1 ? "" : "s"} · {plan.reason}</span
      >
      {#each plan.provenance as p (p.label)}<span class="prov" role="group" aria-label="{p.n} {p.label}" use:peek={{ state: briefState, content: () => provPeek(p.label) }}><b>{p.n}</b> {p.label}</span>{/each}
    </div>
  </header>
  {#if header}<div class="b-runs">{@render header()}</div>{/if}

  <BriefTodayStrip events={input.calendarToday} now={input.now} dateLabel={dateLabel.toUpperCase()} sample={input.calendarSample ?? false} {onopenmeetings} />

  {#if priorities.length}<BriefPriorities {priorities} decisions={input.decisions} risks={input.risks} prompts={plan.prompts} now={input.now} />{/if}

  {#if allCards}<div class="b-review" data-testid="brief-review">Review mode · every card with evidence, by group · Shift+A to go back</div>{/if}
  <main
    class="b-grid"
    class:review={allCards}
    style={gridStyle(plan.areas, allCards)}
  >
    {#each tiles as t, i (t.key)}
      {#if t.type === "label"}
        <div class="b-review-group eyebrow" data-testid="brief-review-group">{t.text}</div>
      {:else}
        {@const w = t.w}
        {@const entry = entryOf(w.kind)}
        <!-- One-row cards keep their own height (top-aligned); multi-row cards fill their span. -->
        <div
          class="slot"
          class:short={w.rows === 1}
          style="{allCards ? `grid-column:span ${w.cols};grid-row:span ${w.rows}` : `grid-area:${w.kind}`};animation-delay:{i * 70}ms"
          data-widget={w.kind}
          data-reason={w.reason}
          title={w.reason}
        >
          {#if allCards}<span class="kind-tag">{w.kind} · {w.size} · T{w.tier} · {w.score}</span>{/if}
          {#if !entry.ready}
            <div class="w placeholder" data-testid="brief-placeholder">
              <div class="eyebrow">{entry.name}</div>
              <h3>No card yet</h3>
              <div class="sub" style="margin-top:6px">{t.scored.ev.fact}</div>
            </div>
          {:else if w.kind === "sunrise"}
            <BriefSunrise
              total={input.decisions.length}
              {cleared}
              userName={input.userName}
              sub={sunSub}
              {quietLine}
              big={w.cols >= 3}
              {timeline}
              distilled={tl}
              now={input.now}
              lead={leadForHero}
              timeToClearMin={timeToClear}
            />
          {:else if w.kind === "catchup"}
            <BriefCatchUp {input} daysAway={plan.daysAway ?? 0} lead={leadForHero} decisions={needsRows} prompts={plan.prompts} />
          {:else if w.kind === "needs"}
            <BriefNeedsYou decisions={needsRows} prompts={plan.prompts} rows={w.rows} timeToClearMin={input.timeToClearMin ?? null} />
          {:else if w.kind === "oneThing"}
            <!-- The call the entry picked (argmax of what it unblocks); null on a lead-hint-only day. -->
            {@const one = input.decisions.find((d) => d.id === t.scored.ev.items[0]) ?? null}
            <BriefOneThing
              decision={one}
              prompt={one ? plan.prompts[one.id] : undefined}
              leadHint={input.leadHint ?? null}
              because={one && plan.leadPriority?.itemId === one.id ? plan.leadPriority.because : null}
              cols={w.cols}
            />
          {:else if w.kind === "blockedByMe"}
            <BriefBlockedByMe decisions={input.decisions} prompts={plan.prompts} cols={w.cols} rows={w.rows} />
          {:else if w.kind === "incident" && incident}
            <BriefIncident risk={incident} prompt={plan.prompts[incident.id]} rows={w.rows} now={input.now} {incidents} prompts={plan.prompts} />
          {:else if w.kind === "fleetRecovery" && input.fleetIncident}
            <BriefFleetRecovery incident={input.fleetIncident} prompts={plan.prompts} now={input.now} cols={w.cols} rows={w.rows} />
          {:else if w.kind === "resolved"}
            <BriefResolved recovered={input.recovered ?? []} prompts={plan.prompts} now={input.now} rows={w.rows} />
          {:else if w.kind === "risk"}
            <BriefRisk risks={watches} prompts={plan.prompts} rows={w.rows} cols={w.cols} mainHealth={input.mainHealth ?? []} now={input.now} />
          {:else if w.kind === "waiting"}
            <BriefWaiting waiting={input.waitingOn} prompts={plan.prompts} cols={w.cols} hideKinds={handoffsPlaced ? ["handoff"] : []} now={input.now} />
          {:else if w.kind === "carry"}
            <BriefCarry
              carry={input.carry ?? []}
              decisions={input.decisions}
              risks={input.risks}
              prompts={plan.prompts}
              rows={w.rows}
              now={input.now}
              catchUp={plan.dayType === "catch-up"}
            />
          {:else if w.kind === "handoffs"}
            <BriefHandoffs handoffs={input.handoffs ?? []} prompts={plan.prompts} now={input.now} rows={w.rows} />
          {:else if w.kind === "shipped"}
            <BriefShipped
              shipped={input.shipped}
              merged={input.merged ?? null}
              opened={input.opened ?? null}
              cols={w.cols}
              rows={w.rows}
              prWindow={input.prWindow ?? null}
              landedDays={input.landedDays ?? null}
              today={ctx.today}
            />
          {:else if w.kind === "firsts"}
            <BriefFirsts shipped={input.shipped} cols={w.cols} rows={w.rows} prompts={plan.prompts} />
          {:else if w.kind === "releaseTrain"}
            <BriefReleaseTrain
              releases={input.releases ?? []}
              mainHealth={input.mainHealth ?? []}
              prompts={plan.prompts}
              cols={w.cols}
              rows={w.rows}
              now={input.now}
              today={ctx.today}
            />
          {:else if w.kind === "meetings"}
            <BriefMeetings
              meetings={input.meetingsYesterday}
              rows={w.rows}
              cols={w.cols}
              now={input.now}
              windowFrom={plan.dayType === "catch-up" ? input.lastBriefAt : null}
              days={input.days ?? []}
              today={ctx.today}
            />
          {:else if w.kind === "decided"}
            <BriefDecided meetings={input.meetingsYesterday} now={input.now} rows={w.rows} windowFrom={ctx.windowFrom} userName={input.userName} />
          {:else if w.kind === "weekArc"}
            <BriefWeekArc days={input.days ?? []} today={ctx.today} cols={w.cols} rows={w.rows} />
          {:else if w.kind === "team"}
            <BriefTeam team={input.team} rows={w.rows} cols={w.cols} />
          {:else if w.kind === "agenda"}
            <BriefAgenda events={input.calendarToday} rows={w.rows} cols={w.cols} now={input.now} sample={input.calendarSample ?? false} {onopenmeetings} />
          {:else if w.kind === "runway"}
            <BriefRunway events={input.calendarToday} {priorities} prompts={plan.prompts} now={input.now} sample={input.calendarSample ?? false} cols={w.cols} rows={w.rows} />
          {:else if w.kind === "focus"}
            <BriefFocus sessions={input.recentSessions ?? input.sessions} companies={input.companies} now={input.now} cols={w.cols} rows={w.rows} />
          {:else if w.kind === "reminders"}
            <BriefReminders reminders={input.reminders ?? []} prompts={plan.prompts} now={input.now} today={ctx.today} rows={w.rows} cols={w.cols} />
          {/if}
        </div>
      {/if}
    {/each}
  </main>

  {#if notShown.length}
    <div class="b-dropped" data-testid="brief-dropped">
      <span class="eyebrow">Not shown today</span>
      {#each notShown.slice(0, 5) as r, i (`${r.kind}-${i}`)}
        <span class="drop b-glass" data-testid="brief-dropped-row" data-kind={r.kind} title={partsOf(r.kind) ?? r.why}><b>{r.name}</b> {r.why}</span>
      {/each}
      {#if notShown.length > 5}
        <span class="drop b-glass more" role="group" aria-label="More not shown" use:peek={{ state: briefState, content: notShownRest }}>+{notShown.length - 5} more</span>
      {/if}
    </div>
  {/if}

  {#if housekeeping}<BriefHousekeeping {housekeeping} />{/if}

  <BriefPeek />
</div>

<style>
  .prov,
  .leadchip {
    cursor: default;
  }
  .prov {
    border-radius: 6px;
    padding: 2px 4px;
    transition: background 0.15s;
  }
  .prov:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  .b-review {
    margin-top: 12px;
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--b-sun);
  }
  .review .slot {
    position: relative;
  }
  /* A label row is its own short row: review mode flows in source order (never dense), so a later
     group's card cannot climb above an earlier label, and the row minimum lives on the cards. */
  .b-review-group {
    grid-column: 1 / -1;
    align-self: end;
    padding: 10px 2px 0;
    color: var(--b-sun);
  }
  .review .slot {
    min-height: 120px;
  }
  .kind-tag {
    position: absolute;
    z-index: 3;
    top: -8px;
    left: 14px;
    padding: 2px 8px;
    border-radius: 999px;
    font-family: var(--b-mono);
    font-size: 9.5px;
    color: #1b1b1e;
    background: var(--b-sun);
  }
  .b-runs {
    margin: -6px 0 14px;
  }
  .slot {
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .slot > :global(.w) {
    flex: 1;
  }
  .slot.short {
    align-self: start;
  }
  .placeholder {
    border: 1px dashed rgba(255, 255, 255, 0.18);
    background: transparent;
    box-shadow: none;
  }
  .placeholder h3 {
    color: var(--b-t3);
  }
  .b-dropped {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    margin-top: 14px;
    font-family: var(--b-mono);
    font-size: 10.5px;
    color: var(--b-t3);
  }
  .b-dropped .drop {
    padding: 3px 8px;
    border-radius: 8px;
    cursor: default;
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .b-dropped .drop b {
    color: var(--b-t2);
    font-weight: 500;
    margin-right: 6px;
  }
</style>
