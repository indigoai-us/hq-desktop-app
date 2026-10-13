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
  import BriefDayTimeline from "./BriefDayTimeline.svelte";
  import BriefWaiting from "./BriefWaiting.svelte";
  import BriefWeekArc from "./BriefWeekArc.svelte";
  import BriefHousekeeping from "./BriefHousekeeping.svelte";
  import type { Snippet } from "svelte";
  import type { BriefHousekeeping as BriefHousekeepingData } from "./brief-run-files.js";
  import type { BriefDmApi } from "./brief-dms.js";
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
  import { briefPriorities, watchTitle } from "./brief-peeks.js";
  import type { BriefInput, BriefRisk as BriefRiskRow } from "./brief-types.js";
  import { effortMinutes } from "./brief-hero.js";
  import { briefHover } from "./brief-hover.js";
  import { FIELD, clockLabel, inLabel, nextCall, promoteMain, todayStats, withLine, type TodayStatKey } from "./brief-layout.js";
  import { CARD_TAG, cardTag, tagIconWidth, tagViewBox } from "./brief-card-tags.js";
  /** Reward cards tilt toward the pointer; every other card only takes the light. The hero has its own. */
  const REWARD_KINDS = new Set(["shipped", "firsts", "resolved"]);
  const NO_HOVER_KINDS = new Set(["sunrise", "catchup"]);
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
  }
  let { input, companies = [], onlaunch, header, housekeeping = null, dmApi = null, onopenthread, onopenmeetings }: Props = $props();

  const briefState = new BriefState(
    (engine, prompt) => (onlaunch ?? launchBriefPromptViaClipboard)(engine, prompt),
    () => companies,
    { dmApi: () => dmApi, openThread: () => onopenthread },
  );
  provideBrief(briefState);

  const plan = $derived(generateBrief(input));
  // The priorities card is the main card: it takes the hero's slot (brief-layout.ts).
  const placed = $derived(promoteMain(plan.areas, plan.widgets));
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

  // The counts under the greeting, all about today.
  const stats = $derived(todayStats({ ...input, timeToClearMin: timeToClear }));
  // Hover detail for each count: the full list behind the number.
  function statPeek(key: TodayStatKey): PeekContent {
    const line = (l: string, st: string | number = "") => ({ label: l, state: String(st) });
    if (key === "decide") {
      return { title: `${input.decisions.length} to decide today`, sections: [{ label: "", lines: input.decisions.map((d) => line(d.title)) }] };
    }
    if (key === "calls") {
      const calls = input.calendarToday.filter((e) => !e.busy);
      return { title: `${calls.length} call${calls.length === 1 ? "" : "s"} today`, sections: [{ label: "", lines: calls.map((e) => line(e.title, clockLabel(e.start))) }] };
    }
    if (key === "dms") {
      const people = input.team.filter((t) => t.dmCount).sort((a, b) => (b.dmCount ?? 0) - (a.dmCount ?? 0));
      return { title: `${input.dmCount ?? 0} DMs to read`, sections: [{ label: "From", lines: people.map((t) => line(t.name, t.dmCount ?? "")) }] };
    }
    return {
      title: `${input.risks.length} risk${input.risks.length === 1 ? "" : "s"} to watch`,
      sections: [{ label: "", lines: input.risks.map((r) => line(r.title, r.severity === "incident" ? "Incident" : "Watch")) }],
    };
  }
  const next = $derived(nextCall(input.calendarToday, input.now));
  const callsLeft = $derived(input.calendarToday.filter((e) => !e.busy && Date.parse(e.start) >= (next ? Date.parse(next.event.start) : Infinity)).length);
  const nextTime = $derived.by(() => {
    if (!next) return { t: "", ap: "" };
    const d = new Date(next.event.start);
    const m = d.getMinutes();
    return { t: `${d.getHours() % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}`, ap: d.getHours() >= 12 ? "PM" : "AM" };
  });


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
        { label: `Lead: ${leadLabel(plan.lead)}`, lines: [{ label: `${plan.density} card${plan.density === 1 ? "" : "s"} · ${plan.reason}`, state: "" }] },
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
  const liveTiles = $derived.by((): Tile[] => placed.widgets.map((w) => ({ type: "card", key: w.kind, w, scored: plan.scored.find((s) => s.kind === w.kind)! })));
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
      <div class="b-title">
        <span class="b-name">Daily Brief</span>
        <span class="b-when" data-testid="brief-when">{dateLabel} · {timeLabel}</span>
      </div>
    </div>
    <div class="b-tools">
      <!-- The picker's reasoning is for the owner reviewing the catalogue: review mode (Shift+A) only. -->
      {#if allCards}<span class="leadchip pill" data-testid="brief-lead" role="group" aria-label="Why these cards" use:peek={{ state: briefState, content: whyPeek }}
          >Why these cards</span
        >{/if}
    </div>
  </header>
  {#if header}<div class="b-runs">{@render header()}</div>{/if}

  <section class="b-top">
    <div class="b-hello">
      <h1 class="b-greet">Morning{input.userName ? `, ${input.userName}` : ""}.</h1>
      <div class="b-stats">
        {#each stats as st, i (st.key)}
          <div class="stat prov" role="group" aria-label="{st.n} {st.label}, {st.caption}" data-testid="brief-stat" data-stat={st.key} use:peek={{ state: briefState, content: () => statPeek(st.key), place: "below" }}>
            <span class="pill" class:hot={i === 0}>{st.label}</span>
            <b class="num">{st.n}</b>
            <span class="cap">{st.caption}</span>
          </div>
        {/each}
      </div>
    </div>
    <BriefDayTimeline events={input.calendarToday} now={input.now} sample={input.calendarSample ?? false} {onopenmeetings} />
    <aside class="b-next" data-testid="brief-next">
      <div class="nx-head"><span class="nx-tag"><svg viewBox={tagViewBox(CARD_TAG.meetings)} style:width="{tagIconWidth(CARD_TAG.meetings)}px" aria-hidden="true"><path d={CARD_TAG.meetings.d} /></svg>{next ? (next.live ? "On a call" : "Next call") : "Calls today"}</span></div>
      {#if next}
        <div class="nx-time">{nextTime.t}<span>{nextTime.ap}{next.live ? "" : ` · ${inLabel(next.inMin, false)}`}</span></div>
        <div class="nx-detail">
        <div class="nx-title">{next.event.title}</div>
        {#if next.event.attendees?.length}
          {@const people = next.event.attendees}
          <!-- Who is on it, in a few words. -->
          <div class="nx-who" data-testid="brief-next-who">
            <span class="names">{withLine(people)}</span>
          </div>
        {:else}
          <!-- The time to the call is already beside the hour; this line says what follows. -->
          <div class="nx-in">{callsLeft > 1 ? `${callsLeft - 1} more after` : "Last call today"}</div>
        {/if}
        </div>
      {:else}
        <div class="nx-time">Free</div>
        <div class="nx-detail"><div class="nx-title">{input.calendarToday.length ? "No more calls today" : "Nothing on the calendar"}</div></div>
      {/if}
      <!-- A quiet orbit: the day around you. On a call three nodes circle it and a soft ring pulses; otherwise it is still and empty. -->
      <svg class="orbit" class:live={next?.live} class:idle={!next} viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          <radialGradient id="b-orb-fill" cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" stop-color="currentColor" stop-opacity="0.1" />
            <stop offset="1" stop-color="currentColor" stop-opacity="0.02" />
          </radialGradient>
        </defs>
        {#if next?.live}<circle class="pulse" cx="60" cy="60" r="28" />{/if}
        <circle class="orb" cx="60" cy="60" r="28" fill="url(#b-orb-fill)" />
        <circle class="path" cx="60" cy="60" r="46" />
        {#if next?.live}<g class="spin"><circle class="node" cx="60" cy="14" r="4.5" /><circle class="node trail" cx="99.8" cy="83" r="3.5" /><circle class="node trail" cx="20.2" cy="83" r="3.5" /></g>{/if}
      </svg>
    </aside>
  </section>

  {#if allCards}<div class="b-review" data-testid="brief-review">Review mode · every card with evidence, by group · Shift+A to go back</div>{/if}
  <main
    class="b-grid"
    class:review={allCards}
    style={gridStyle(allCards ? plan.areas : placed.areas, allCards)}
  >
    {#each tiles as t, i (t.key)}
      {#if t.type === "label"}
        <div class="b-review-group eyebrow" data-testid="brief-review-group">{t.text}</div>
      {:else}
        {@const w = t.w}
        {@const entry = entryOf(w.kind)}
        {@const tag = cardTag(String(w.kind), entry.name)}
        <!-- Every card fills its grid area, so a short card never leaves a hole under it; its footer pins to the bottom. -->
        <div
          class="slot"
          class:short={w.rows === 1}
          class:lit={!NO_HOVER_KINDS.has(String(w.kind))}
          data-field={FIELD[String(w.kind)] ?? "teal"}
          use:briefHover={{ tilt: REWARD_KINDS.has(String(w.kind)) }}
          style="{allCards ? `grid-column:span ${w.cols};grid-row:span ${w.rows}` : `grid-area:${w.kind}`};animation-delay:{i * 70}ms"
          data-widget={w.kind}
          data-reason={w.reason}
        >
          <!-- The card's label: mono, all caps, a Phosphor icon on its left. Hover says why the card is here today. -->
          <span class="why" role="note" aria-label="{tag.label}. Why this card: {w.reason}" data-testid="brief-why" use:peek={{ state: briefState, content: () => ({ title: entry.name, status: "Why it is here today", sections: [{ label: "Reason", text: w.reason }] }) }}
            >{#if tag.d}<svg viewBox={tagViewBox(tag)} style:width="{tagIconWidth(tag)}px" aria-hidden="true"><path d={tag.d} /></svg>{/if}{tag.label}</span
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
              greet={false}
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
            <BriefNeedsYou decisions={needsRows} prompts={plan.prompts} rows={w.rows} timeToClearMin={input.timeToClearMin ?? null} {priorities} risks={input.risks} now={input.now} />
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
        <span class="drop b-glass" data-testid="brief-dropped-row" data-kind={r.kind} data-parts={partsOf(r.kind) ?? r.why}><b>{r.name}</b> {r.why}</span>
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
  /* Hover gives the stat a roomy tile; the negative margin keeps it in place. */
  .prov {
    border-radius: 10px;
    padding: 12px 14px;
    margin: -12px -14px;
    transition: background 0.15s;
  }
  .prov:hover {
    background: rgb(var(--b-ink) / 0.06);
  }
  .b-review {
    margin-top: 12px;
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
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
    /* Look: the shared highlight label (brief.css). */
  }
  .b-runs {
    margin: -6px 0 14px;
  }
  .slot {
    display: flex;
    min-width: 0;
    min-height: 0;
    will-change: transform;
  }
  .slot > :global(.w) {
    flex: 1;
  }
  /* A quiet day is one hero: let it hold the window instead of leaving the lower half empty. */
  .daily-brief[data-template="1"] .slot {
    min-height: clamp(360px, calc(100vh - 220px), 640px);
  }
  .placeholder {
    border: 1px dashed rgb(var(--b-ink) / 0.18);
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
    font-size: 11px;
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
