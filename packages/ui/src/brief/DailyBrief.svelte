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
  import BriefActionCard from "./BriefActionCard.svelte";
  import BriefConnectApps from "./BriefConnectApps.svelte";
  import FirstViewWhere from "./FirstViewWhere.svelte";
  import FirstViewConnect from "./FirstViewConnect.svelte";
  import FirstViewOneThing from "./FirstViewOneThing.svelte";
  import FirstViewRecent from "./FirstViewRecent.svelte";
  import FirstViewWatch from "./FirstViewWatch.svelte";
  import { getWelcomeAiApps } from "./welcome-ai-apps.js";
  import { matchFoundApps } from "../chat/first-run/found-apps.js";
  import { yourAppsView } from "../chat/first-run/your-apps.js";
  import { buildFirstView, type FirstViewConnectMode } from "./brief-first-view.js";
  import { FV_QUIET_LINE, firstViewStats, firstViewSub } from "./brief-first-view-copy.js";
  import { WELCOME_HARNESS_NAME, type WelcomeAction, type WelcomeHarnessId } from "./brief-welcome-contract.js";
  import type { BriefWelcome } from "./brief-welcome.js";
  import type { FirstViewData } from "./brief-first-view-load.js";
  import { actionCardData, type BriefActions } from "./brief-action-cards.js";
  import { onDestroy, untrack, type Snippet } from "svelte";
  import type { BriefHousekeeping as BriefHousekeepingData } from "./brief-run-files.js";
  import type { BriefDmApi } from "./brief-dms.js";
  import {
    BriefState,
    launchBriefPromptViaClipboard,
    provideBrief,
    type BriefCompanyLogo,
    type BriefItemEvent,
    type BriefLaunch,
  } from "./brief-context.svelte.js";
  import { peek, type PeekContent } from "./brief-context.svelte.js";
  import { BRIEF_ROW_MIN_PX, generateBrief, gridStyle, leadLabel, type BriefWidget } from "./brief-generate.js";
  import { CATALOGUE, SPAN, buildContext, entryOf, rankDecisions, reasonFor, type Scored, type WidgetGroup } from "./brief-catalogue.js";
  import { briefPriorities, watchTitle } from "./brief-peeks.js";
  import type { BriefInput, BriefRisk as BriefRiskRow } from "./brief-types.js";
  import { effortMinutes } from "./brief-hero.js";
  import { briefHover } from "./brief-hover.js";
  import { decoUrl } from "./brief-deco.js";
  import { FIELD, bandRows, clockLabel, inLabel, nextCall, promoteMain, todayCalls, todayStats, withLine, type TodayStatKey } from "./brief-layout.js";
  import { partOfDay } from "./brief-time.js";
  import { CARD_TAG, cardTag, tagIconWidth, tagViewBox } from "./brief-card-tags.js";
  /** Reward cards tilt toward the pointer; every other card only takes the light. The hero has its own. */
  const NO_HOVER_KINDS = new Set(["sunrise", "catchup"]);
  import { distillTimeline, isTimelineSession, sinceLabel } from "./brief-timeline.js";

  interface Props {
    input: BriefInput;
    companies?: readonly BriefCompanyLogo[];
    /** Opens a session with the prompt pre-filled. Defaults to copying it. */
    onlaunch?: BriefLaunch;
    /** Run controls (the history squares), on the title's line after "Daily Brief". */
    header?: Snippet;
    sectionOnly?: boolean;
    summaryOnly?: boolean;
    /** Company sections report completed actions to the shared summary. */
    clearedItemIds?: readonly string[];
    /** Controls on the title row, right-aligned (Create brief / Refresh). */
    tools?: Snippet;
    /** The shown run's housekeeping.json, when it has one. */
    housekeeping?: BriefHousekeepingData | null;
    /** Live DM reads for the Team card. */
    dmApi?: BriefDmApi | null;
    /** Opens the DM with this uid in Messages. */
    onopenthread?: (uid: string) => void;
    /** Opens the Meetings page. */
    onopenmeetings?: () => void;
    /** Records what the person did with an item (dismiss, launch) in the brief log. */
    onlog?: (event: BriefItemEvent) => void;
    /**
     * Report action cards: where each suggested piece of work can be done and
     * how to hand it to the assistant. Left out, the cards are not shown.
     */
    actions?: BriefActions | null;
    /** brief.json `welcome`: inside the welcome report its fields are the edition's components (US-019). */
    welcome?: BriefWelcome | null;
    /** Opens the start-or-join-a-company flow from the edition's company action. */
    onconnectcompany?: () => void;
    /** Inside the welcome report: the run's `welcome` row and the import report on disk, the first view's one data source. */
    firstViewData?: FirstViewData | null;
  }
  let { input, companies = [], onlaunch, header, tools, sectionOnly = false, summaryOnly = false, clearedItemIds = [], housekeeping = null, dmApi = null, onopenthread, onopenmeetings, onlog, actions = null, welcome = null, onconnectcompany, firstViewData = null }: Props = $props();

  const briefState = new BriefState(
    (engine, prompt) => (onlaunch ?? launchBriefPromptViaClipboard)(engine, prompt),
    () => companies,
    { dmApi: () => dmApi, openThread: () => onopenthread, log: () => onlog },
  );
  provideBrief(briefState);

  const plan = $derived(generateBrief(input));
  // The priorities card is the main card: it takes the hero's slot (brief-layout.ts).
  const placed = $derived(promoteMain(plan.areas, plan.widgets));
  const ctx = $derived(buildContext(input));
  const priorities = $derived(briefPriorities(input));
  // Needs rows: the ones a priority points at first, then by what they unblock.
  const needsRows = $derived(rankDecisions(ctx));
  const cleared = $derived(input.decisions.filter((d) => briefState.cleared[d.id] || clearedItemIds.includes(d.id)).length);
  // One card per open decision that carries a launch prompt, in the Needs-you order.
  // A card its own launch cleared stays, with the launch note and no buttons.
  const launchedNote = (id: string): string | null => (briefState.launched[id] ? (briefState.notes[id] ?? null) : null);
  const actionCards = $derived(
    actions
      ? needsRows
          .filter((d) => !briefState.cleared[d.id] || launchedNote(d.id))
          .map((d) => actionCardData(d, plan.prompts))
          .filter((c) => c !== null)
      : [],
  );
  /** A card launch takes the Start path: it logs, clears the item and leaves the Started note. */
  function launchAction(itemId: string, engine: "claude" | "codex", prompt: string): Promise<string> {
    return briefState.start(itemId, prompt, engine);
  }
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
  const leadForHero = $derived(plan.leadPriority ? { text: plan.leadPriority.text, because: plan.leadPriority.because, itemId: plan.leadPriority.itemId } : null);

  // The greeting follows the clock the brief is read at, not the time it was written.
  let clock = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (clock = Date.now()), 60_000);
    return () => clearInterval(t);
  });
  const greeting = $derived(partOfDay(new Date(clock)));
  // Today's calls, less busy holds: the one call count the whole page uses.
  const calls = $derived(todayCalls(input.calendarToday));

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
    else if (!input.decisions.length) {
      // Same counts as the stats above: never "nothing needs you" beside unread DMs or open risks.
      const dms = input.dmCount ?? 0;
      if (dms) parts.push(`${dms} DM${dms === 1 ? "" : "s"} to read.`);
      else if (input.risks.length) parts.push(`${input.risks.length} risk${input.risks.length === 1 ? "" : "s"} to watch.`);
      else parts.push("Nothing needs you right now.");
    }
    // Never call a day with open decisions "a quiet start" (gate review item 9).
    else if (!parts.length)
      parts.push(`${input.decisions.length} decision${input.decisions.length === 1 ? "" : "s"} for you today.`);
    return parts.join(" ") || "A quiet start.";
  });
  const quietLine = $derived(
    calls.length ? `${calls.length} call${calls.length === 1 ? "" : "s"} today.` : "Nothing owed.",
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
  const tiles = $derived((allCards ? reviewTiles : liveTiles).filter(t => t.type === "label" ? !summaryOnly : summaryOnly ? t.w.kind === "sunrise" : !sectionOnly || t.w.kind !== "sunrise"));
  // When the Handoffs card is on the page, the Waiting card leaves handoff rows to it.
  const handoffsPlaced = $derived(tiles.some((t) => t.type === "card" && t.w.kind === "handoffs"));
  // When the Settled card is on the page, it lists the decisions; the Meetings card keeps to the meetings.
  const decidedPlaced = $derived(tiles.some((t) => t.type === "card" && t.w.kind === "decided"));
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

  /** Inside the welcome report the brief opens as its first view (welcome-ai-apps context). */
  const welcomeAiApps = getWelcomeAiApps();
  /**
   * Where Connect goes: "settings" opens the existing Integrations page (or the
   * AI-apps settings for a harness); "expand" opens the connect section inside
   * the card. One-line swap.
   */
  const CONNECT_MODE = "settings" as FirstViewConnectMode;
  const fvOn = $derived(!!welcomeAiApps && !allCards && !sectionOnly && !summaryOnly);
  // The suggested integrations' source, shared with the connect section: the
  // launch scan, and the company's apps so connected ones stay out.
  $effect(() => {
    const cur = welcomeAiApps?.current;
    const s = cur?.session;
    if (!fvOn || !cur || !s) return;
    const suggest = cur.suggest;
    untrack(() => {
      s.detectOnce(cur.detect);
      if (suggest) s.setCompany(suggest.host, suggest.company?.uid ?? null);
    });
  });
  /** The work apps the launch scan found (GitHub, Linear, Slack...), less the ones already connected. */
  const fvSuggested = $derived.by((): { slug: string; name: string }[] => {
    const cur = welcomeAiApps?.current;
    const s = cur?.session;
    if (!fvOn || !cur?.suggest || !s?.scan) return [];
    const matched = matchFoundApps(s.scan);
    const found = matched.apps.filter((app) => !app.excluded);
    const load = cur.suggest.company ? s.load : null;
    const connected = new Set(
      load
        ? yourAppsView({
            found,
            unmatched: matched.unmatched,
            catalog: load.catalog,
            connections: load.connections,
            installations: load.installations,
            canManage: load.canManage,
            runs: s.runs,
            evidence: () => "",
          }).connected.map((c) => c.domain)
        : Object.entries(s.runs).flatMap(([domain, r]) => (r.state === "connected" ? [domain] : [])),
    );
    return found.filter((app) => !connected.has(app.domain)).map((app) => ({ slug: app.domain, name: app.name }));
  });
  const FV_HARNESSES: readonly WelcomeHarnessId[] = ["claude-code", "codex", "cursor"];
  /** The harness whose HQ connection is on in Settings: shown Connected, never Connect. */
  const fvConnectedAi = $derived(FV_HARNESSES.filter((h) => h === welcomeAiApps?.current?.anywhereOnId));
  /** The harnesses whose CLI is installed here, found even with no history. */
  const fvInstalled = $derived.by((): WelcomeHarnessId[] => {
    const cli = welcomeAiApps?.current?.cli;
    return FV_HARNESSES.filter((h) => (h === "claude-code" && cli?.claudeCode) || (h === "codex" && cli?.codex));
  });
  /**
   * Inside the welcome report, outside review mode: the first view. The same
   * page (head, greeting row, grid) with the first-view cards in its slots.
   */
  const firstView = $derived(
    fvOn
      ? buildFirstView({
          welcome: firstViewData?.welcome ?? null,
          importReport: firstViewData?.importReport ?? null,
          suggestedApps: fvSuggested,
          connectedAiApps: fvConnectedAi,
          canRun: canRunWelcome,
          now: input.now,
          userName: input.userName ?? null,
          connectMode: CONNECT_MODE,
        })
      : null,
  );
  const fvStats = $derived(firstView ? firstViewStats(firstView) : []);
  /**
   * The first view's grid areas: the sunrise and Connect on top, One thing
   * with the watch list under it beside your recent work, so One thing is
   * sized to its content. `wide` is six columns, `narrow` four.
   */
  const fvAreas = $derived.by(() => {
    if (!firstView) return { wide: "", narrow: "" };
    const one = !!firstView.oneThing;
    const risk = firstView.watchList.length > 0;
    const focus = firstView.recentWork.length > 0 || firstView.topProjects.length > 0;
    const row = (cells: string[]) => `"${cells.join(" ")}"`;
    const fill = (names: string[], cols: number) => names.flatMap((n, i) => Array(Math.floor(cols / names.length) + (i < cols % names.length ? 1 : 0)).fill(n));
    const side = [one && "oneThing", risk && "risk"].filter(Boolean) as string[];
    const wide = [row([...Array(4).fill("sunrise"), "connect", "connect"])];
    // Narrow windows use five columns so the Connect card keeps room for its status words on one line.
    const narrow = [row(["sunrise", "sunrise", "sunrise", "connect", "connect"])];
    if (focus && side.length) for (const n of side) wide.push(row([n, n, ...Array(4).fill("focus")]));
    else if (focus) wide.push(row(Array(6).fill("focus")));
    else if (side.length) wide.push(row(fill(side, 6)));
    if (side.length) narrow.push(row(fill(side, 5)));
    if (focus) narrow.push(row(Array(5).fill("focus")));
    return { wide: wide.join(" "), narrow: narrow.join(" ") };
  });
  /** "expand" mode: the connect section shows inside the card once Connect is pressed. */
  let connectOpen = $state(false);
  /**
   * A Connect the person started before the report was ready (a sign-in, or
   * one waiting on a new company) keeps the connect section open in the
   * Connect card, so it finishes there. Latched: it stays once the run lands.
   */
  let fvCarried = $state(false);
  $effect(() => {
    const s = welcomeAiApps?.current?.session;
    if (!fvCarried && s && (!!s.pending || Object.values(s.runs).some((r) => r.state === "connecting" || r.state === "checking-docs"))) fvCarried = true;
  });
  /** Open actions in flight, so a double click opens one session. */
  let fvBusy = $state<Record<string, boolean>>({});
  /** The plain line an open came back with when the harness could not open. */
  let fvError = $state<string | null>(null);
  /** The open that failed, for Try again. */
  let fvRetry = $state<{ harness: WelcomeHarnessId; prompt: string } | null>(null);
  const canOpenHarness = (h: WelcomeHarnessId): boolean => !!welcomeAiApps?.openHarness?.harnesses.includes(h);
  function canRunWelcome(a: WelcomeAction): boolean {
    switch (a.kind) {
      case "connect_ai_apps":
        return !!welcomeAiApps?.current?.onopenaiapps || (CONNECT_MODE === "expand" && !!welcomeAiApps?.current);
      case "connect_integration":
        return !!welcomeAiApps?.current?.suggest || (CONNECT_MODE === "expand" && !!welcomeAiApps?.current);
      case "open_harness":
        return !!a.harness && canOpenHarness(a.harness);
      case "connect_company":
        return !!onconnectcompany;
      default:
        return !!a.launch_prompt;
    }
  }
  async function openHarness(harness: WelcomeHarnessId, prompt = ""): Promise<void> {
    const open = welcomeAiApps?.openHarness;
    if (!open || fvBusy[harness]) return;
    fvBusy = { ...fvBusy, [harness]: true };
    try {
      fvError = null;
      fvRetry = null;
      fvError = await open.open(harness, prompt);
    } catch (err) {
      console.warn("[hq-desktop] first view open threw:", err);
      fvError = `Couldn't open ${WELCOME_HARNESS_NAME[harness]}.`;
    } finally {
      if (fvError) fvRetry = { harness, prompt };
      fvBusy = { ...fvBusy, [harness]: false };
    }
  }
  /** Integrations Connect: the company's Integrations page, after the new-company sheet when there is no company yet. */
  async function connectIntegration(): Promise<void> {
    if (CONNECT_MODE === "expand") {
      connectOpen = !connectOpen;
      return;
    }
    const suggest = welcomeAiApps?.current?.suggest;
    if (!suggest) return;
    const uid = suggest.company?.uid ?? (await suggest.onnewcompany?.()) ?? null;
    if (uid) suggest.onopenintegrations?.(uid);
  }
  /** AI-app Connect: the AI-apps settings. */
  function connectAi(): void {
    if (CONNECT_MODE === "expand") {
      connectOpen = !connectOpen;
      return;
    }
    welcomeAiApps?.current?.onopenaiapps?.();
  }
  function runWelcome(a: WelcomeAction): void {
    if (a.kind === "open_harness" && a.harness) void openHarness(a.harness, a.launch_prompt);
    else if (a.kind === "connect_ai_apps") connectAi();
    else if (a.kind === "connect_integration") void connectIntegration();
    else if (a.kind === "connect_company") onconnectcompany?.();
  }
  const welcomeActionLabel = (a: WelcomeAction): string | null =>
    a.kind === "open_harness" ? "Open" : a.kind === "connect_ai_apps" || a.kind === "connect_integration" ? "Connect" : a.kind === "connect_company" ? "Set up" : null;
  // The first view shows an open action it can run, so the report leaves out its own bar.
  // Claimed while the first view first renders, so the bar never shows for a frame.
  const fvShowsOpen = $derived(
    !!firstView && [firstView.whereYouWork.open, firstView.oneThing].some((a) => a?.kind === "open_harness" && canRunWelcome(a)),
  );
  let fvRelease: (() => void) | null = untrack(() => fvShowsOpen) ? (welcomeAiApps?.claimOpenTool?.() ?? null) : null;
  $effect(() => {
    if (fvShowsOpen && !fvRelease) fvRelease = welcomeAiApps?.claimOpenTool?.() ?? null;
    if (!fvShowsOpen && fvRelease) {
      fvRelease();
      fvRelease = null;
    }
  });
  onDestroy(() => fvRelease?.());
</script>

<svelte:window onkeydown={onkey} />

<div class="daily-brief" data-testid="daily-brief" data-lead={plan.lead} data-density={plan.density} data-template={plan.template} data-daytype={plan.dayType}>
  {#if !sectionOnly}
  <header class="b-head">
    <div class="b-brand">
      <div class="b-mark" aria-hidden="true">
        <svg class="ico" viewBox="0 0 24 24"><path d="M3 17h18M6 17a6 6 0 0 1 12 0M12 5v2M5.6 8.6l1.4 1.4M18.4 8.6 17 10" /></svg>
      </div>
      <div class="b-title">
        <!-- The run history's squares sit on the title's line, right after the name. -->
        <span class="b-nameline"><span class="b-name">Daily Brief</span>{#if header}<span class="b-runs">{@render header()}</span>{/if}</span>
        <span class="b-when" style="white-space:nowrap" data-testid="brief-when">{dateLabel} · {timeLabel}</span>
      </div>
    </div>
    <div class="b-tools">
      <!-- The picker's reasoning is for the owner reviewing the catalogue: review mode (Shift+A) only. -->
      {#if allCards}<span class="leadchip pill" data-testid="brief-lead" role="group" aria-label="Why these cards" use:peek={{ state: briefState, content: whyPeek }}
          >Why these cards</span
        >{/if}
      <!-- A quiet pointer to review mode, left of the run button; review mode has its own bar. -->
      {#if firstView}<span class="b-hint" data-testid="first-view-hint">Your first brief</span>
      {:else if !allCards}<span class="b-hint" data-testid="brief-review-hint" aria-label="Shift+A to view every card"><kbd>Shift</kbd><kbd>A</kbd><span>to view every card</span></span>{/if}
      {#if tools}{@render tools()}{/if}
    </div>
  </header>

  <section class="b-top" class:fv-top={!!firstView}>
    {#if firstView}
    {@const fv = firstView}
    <div class="b-hello">
      <h1 class="b-greet" data-testid="brief-greeting">{fv.greeting}</h1>
      {#if fv.countLine}<p class="fv-line" data-testid="first-view-count-line">{fv.countLine}</p>{/if}
      {#if fvError}
        <p class="fv-line fv-error" role="alert" data-testid="first-view-error">
          {fvError}
          {#if fvRetry}
            {@const retry = fvRetry}
            <button type="button" class="fv-retry" data-testid="first-view-retry" onclick={() => void openHarness(retry.harness, retry.prompt)}>Try again</button>
          {/if}
        </p>
      {/if}
      {#if fvStats.length}
        <div class="b-stats">
          {#each fvStats as st, i (st.key)}
            <div class="stat" role="group" aria-label="{st.n} {st.label}, {st.caption}" data-testid="brief-stat" data-stat={st.key}>
              <span class="pill" class:hot={i === 0}>{st.label}</span>
              <b class="num">{st.n}</b>
              <span class="cap">{st.caption}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    {#if fv.whereYouWork.tools.length || fv.whereYouWork.open}
      <aside class="b-next fv-next" data-testid="brief-next">
        <div class="nx-head"><span class="nx-tag"><svg viewBox={tagViewBox(CARD_TAG.focus)} style:width="{tagIconWidth(CARD_TAG.focus)}px" aria-hidden="true"><path d={CARD_TAG.focus.d} /></svg>Where you work</span></div>
        <FirstViewWhere
          tools={fv.whereYouWork.tools}
          open={fv.whereYouWork.open}
          onopen={(a) => runWelcome(a)}
          busy={!!(fv.whereYouWork.open?.harness && fvBusy[fv.whereYouWork.open.harness])}
        />
      </aside>
    {/if}
    {:else}
    <div class="b-hello">
      <h1 class="b-greet" data-testid="brief-greeting">{greeting}{input.userName ? `, ${input.userName}` : ""}.</h1>
      <div class="b-stats">
        {#each stats as st, i (st.key)}
          <div class="stat prov" class:zero={!st.n} role="group" aria-label="{st.n} {st.label}, {st.caption}" data-testid="brief-stat" data-stat={st.key} use:peek={{ state: briefState, content: () => statPeek(st.key), place: "below" }}>
            <span class="pill" class:hot={i === stats.findIndex((x) => x.n > 0)}>{st.label}</span>
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
          <!-- Who is on it, in a few words. -->
          <div class="nx-who" data-testid="brief-next-who">
            <span class="names">{withLine(next.event.attendees)}</span>
          </div>
        {/if}
        </div>
      {:else}
        <div class="nx-time">Free</div>
        <div class="nx-detail"><div class="nx-who"><span class="names">{calls.length ? "No more calls today" : "Nothing on the calendar"}</span></div></div>
      {/if}
      <!-- A quiet orbit: the day around you. On a call two nodes circle it, half a turn apart, so only one is ever in view (the panel shows about a third of the ring); otherwise it is still and empty. -->
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
        {#if next?.live}<g class="spin"><circle class="node" cx="60" cy="14" r="3.5" /><circle class="node" cx="60" cy="106" r="3.5" /></g>{/if}
      </svg>
    </aside>
    {/if}
  </section>
  {/if}

  {#if !summaryOnly && input.sourceNotes?.length}
    {#each input.sourceNotes as note (note)}<p class="b-source-note" data-testid="brief-source-note">{note}</p>{/each}
  {/if}

  {#if allCards}
    <div class="b-review" data-testid="brief-review" role="status">
      <span class="rv-mode">Review mode</span>
      <span class="rv-txt">Every card with evidence, by group</span>
      <span class="rv-keys" aria-label="Shift+A to go back"><kbd>Shift</kbd><kbd>A</kbd><span>to go back</span></span>
    </div>
  {/if}
  {#if firstView}
  {@const fv = firstView}
  <!-- The first view: the brief's own grid with the first-view cards in its slots. -->
  <main class="b-grid fv-grid" data-testid="first-view-grid" data-connect-mode={fv.connect.mode} style:--fv-areas={fvAreas.wide} style:--fv-areas-narrow={fvAreas.narrow}>
    <div class="slot fv-slot" data-field="dusk" data-widget="sunrise" style="grid-area:sunrise">
      <BriefSunrise
        total={0}
        cleared={0}
        userName={input.userName}
        greet={false}
        big
        sub={firstViewSub(fv)}
        eyebrow="Sunrise"
        quietLine={FV_QUIET_LINE}
        now={input.now}
      />
    </div>
    <div class="slot lit fv-slot" data-field="sky" data-widget="connect" style:--b-deco={decoUrl("waiting")} use:briefHover={{ tilt: true }} style="grid-area:connect;animation-delay:70ms">
      {@render fvTag("waiting", "Connect your apps")}
      <FirstViewConnect
        connect={fv.connect}
        connected={fvConnectedAi}
        installed={fvInstalled}
        canOpen={canOpenHarness}
        onconnectintegration={() => void connectIntegration()}
        onconnectai={() => connectAi()}
        onopen={(h) => void openHarness(h)}
        expanded={((CONNECT_MODE === "expand" && connectOpen) || fvCarried) && welcomeAiApps?.current ? fvExpanded : null}
      />
    </div>
    {#if fv.oneThing}
      <div class="slot lit fv-slot" data-field="violet" data-widget="oneThing" style:--b-deco={decoUrl("oneThing")} use:briefHover={{ tilt: true }} style="grid-area:oneThing;animation-delay:140ms">
        {@render fvTag("oneThing", null)}
        <FirstViewOneThing action={fv.oneThing} onaction={runWelcome} actionLabel={welcomeActionLabel(fv.oneThing)} />
      </div>
    {/if}
    {#if fv.recentWork.length || fv.topProjects.length}
      <div class="slot lit fv-slot" data-field="mono" data-widget="focus" style:--b-deco={decoUrl("focus")} use:briefHover={{ tilt: true }} style="grid-area:focus;animation-delay:210ms">
        {@render fvTag("focus", "Your recent work")}
        <FirstViewRecent recent={fv.recentWork} projects={fv.topProjects} now={nowDate} />
      </div>
    {/if}
    {#if fv.watchList.length}
      <div class="slot lit fv-slot" data-field="sunset" data-widget="risk" style:--b-deco={decoUrl("risk")} use:briefHover={{ tilt: true }} style="grid-area:risk;animation-delay:280ms">
        {@render fvTag("risk", "Watch list")}
        <FirstViewWatch list={fv.watchList} />
      </div>
    {/if}
  </main>
  {:else}
  <main
    class="b-grid"
    class:review={allCards}
    style={allCards || sectionOnly || summaryOnly ? gridStyle(plan.areas, true) : [gridStyle(placed.areas, false), bandRows(placed.areas, BRIEF_ROW_MIN_PX)].filter(Boolean).join(";")}
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
          style:--b-deco={decoUrl(String(w.kind))}
          use:briefHover={{ tilt: true }}
          style="{summaryOnly ? 'grid-column:1 / -1' : allCards || sectionOnly ? `grid-column:span ${w.cols};grid-row:span ${w.rows}` : `grid-area:${w.kind}`};animation-delay:{i * 70}ms"
          data-widget={w.kind}
          data-size={w.size}
          data-reason={w.reason}
        >
          <!-- The card's label: mono, all caps, a Phosphor icon on its left. Hover says why the card is here today. -->
          <span class="why" role="note" aria-label="{tag.label}. Why this card: {w.reason}" data-testid="brief-why" use:peek={{ state: briefState, content: () => ({ title: entry.name, status: "Why it is here today", sections: [{ label: "Reason", text: w.reason }] }) }}
            >{#if tag.d}<svg viewBox={tagViewBox(tag)} style:width="{tagIconWidth(tag)}px" aria-hidden="true"><path d={tag.d} /></svg>{/if}{tag.label}</span
          >
          {#if allCards}<span class="kind-tag" title="kind · size · tier · score">{w.kind}<i>{" · "}</i>{w.size}<i>{" · "}</i>T{w.tier}<i>{" · "}</i>{w.score}</span>{/if}
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
            <BriefHandoffs handoffs={input.handoffs ?? []} prompts={plan.prompts} now={input.now} rows={w.rows} cols={w.cols} />
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
              settled={decidedPlaced}
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
  {/if}

  {#if !summaryOnly && !firstView && actions && actionCards.length}
    <section class="b-actions" data-testid="brief-action-cards">
      {#each actionCards as card (card.id)}
        <BriefActionCard
          {card}
          destinations={actions.destinations}
          runId={input.runId ?? null}
          now={input.now}
          onassistant={actions.onassistant}
          onlaunch={(engine, prompt) => launchAction(card.id, engine, prompt)}
          launched={launchedNote(card.id)}
        />
      {/each}
    </section>
  {/if}

  {#if !summaryOnly && !firstView && notShown.length}
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

  {#if !summaryOnly && !firstView && housekeeping}<BriefHousekeeping {housekeeping} />{/if}

  <BriefPeek />
</div>

<!-- A first-view card's label: the brief's mono caps tag with its icon. -->
{#snippet fvTag(kind: string, label: string | null)}
  {@const tag = cardTag(kind, label ?? kind)}
  <span class="why" role="note" data-testid="brief-why">{#if tag.d}<svg viewBox={tagViewBox(tag)} style:width="{tagIconWidth(tag)}px" aria-hidden="true"><path d={tag.d} /></svg>{/if}{label ?? tag.label}</span>
{/snippet}

<!-- "expand" mode: the existing connect section, inside the Connect card. -->
{#snippet fvExpanded()}
  {#if welcomeAiApps?.current}
    {@const connect = welcomeAiApps.current}
    <BriefConnectApps detect={connect.detect} cli={connect.cli} suggest={connect.suggest} session={connect.session} anywhereOnId={connect.anywhereOnId ?? null} />
  {/if}
{/snippet}

<style>
  /* The first view: the brief's grid and top row, sized to the window. The page scrolls; nothing is clipped. */
  .daily-brief :global(.b-top.fv-top) {
    grid-template-columns: minmax(0, 1fr) 320px;
    min-width: 0;
  }
  .daily-brief :global(.b-top.fv-top .b-greet) {
    font-size: 40px;
  }
  .daily-brief :global(.b-top.fv-top .b-stats) {
    margin-top: 28px;
  }
  .fv-line {
    margin: 12px 0 0;
    font-size: 15px;
    line-height: 1.45;
    color: var(--b-t2);
    max-width: 62ch;
  }
  .fv-error {
    color: var(--b-t1);
  }
  .fv-retry {
    margin-left: 8px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid var(--b-line, rgba(255, 255, 255, 0.2));
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .daily-brief :global(.b-next.fv-next) {
    justify-content: flex-start;
    min-height: 0;
  }
  .daily-brief :global(.b-grid.fv-grid) {
    min-width: 0;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    grid-template-areas: var(--fv-areas);
    /* The sunrise scales with the window; the rows under it take their content's height. */
    grid-template-rows: minmax(clamp(240px, 44vh, 460px), auto);
    grid-auto-rows: auto;
    align-items: stretch;
  }
  .fv-slot {
    display: flex;
    min-width: 0;
  }
  .fv-slot > :global(.w) {
    flex: 1;
    min-width: 0;
  }
  /* The Connect card takes its rows' height rather than stretching to the sunrise beside it. */
  .fv-slot[data-widget="connect"] {
    align-self: start;
  }
  @media (max-width: 1180px) {
    .daily-brief :global(.b-top.fv-top) {
      grid-template-columns: minmax(0, 1fr) 280px;
    }
    .daily-brief :global(.b-grid.fv-grid) {
      grid-template-columns: repeat(5, minmax(0, 1fr));
      grid-template-areas: var(--fv-areas-narrow);
    }
  }
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
  /* Review mode, said once and quietly: a soft bar with a mono caps chip, a plain line and the key to leave. */
  .daily-brief {
    --b-page-ink: var(--b-ink);
  }
  /* Same keys and words as the review bar's "Shift A to go back". */
  .b-hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 8px;
    font-size: 12px;
    color: rgb(var(--b-page-ink) / 0.42);
    white-space: nowrap;
  }
  .b-hint span {
    margin-left: 4px;
  }
  .b-actions {
    margin-top: 14px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 10px;
  }
  .b-review {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 8px 8px 8px;
    border-radius: 12px;
    font-size: 13px;
    color: rgb(var(--b-page-ink) / 0.62);
    background: rgb(var(--b-page-ink) / 0.05);
  }
  .rv-mode,
  .b-review kbd,
  .b-hint kbd {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .rv-mode {
    height: 22px;
    padding: 0 9px;
    display: inline-flex;
    align-items: center;
    border-radius: 7px;
    color: rgb(var(--b-page-ink) / 0.86);
    background: rgb(var(--b-page-ink) / 0.08);
  }
  .rv-keys {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding-right: 4px;
  }
  .rv-keys span {
    margin-left: 4px;
  }
  .b-review kbd,
  .b-hint kbd {
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    box-sizing: border-box;
    display: inline-grid;
    place-items: center;
    border-radius: 6px;
    color: rgb(var(--b-page-ink) / 0.8);
    background: rgb(var(--b-page-ink) / 0.08);
  }
  /* The hint is quieter than the review bar: smaller, fainter keys. */
  .b-hint kbd {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 5px;
    font-size: 9px;
    color: rgb(var(--b-page-ink) / 0.48);
    background: rgb(var(--b-page-ink) / 0.05);
  }
  .review .slot {
    position: relative;
  }
  /* A label row is its own short row: review mode flows in source order (never dense), so a later
     group's card cannot climb above an earlier label, and the row minimum lives on the cards. */
  /* Group title: mono caps in the page ink with a hairline running to the edge. */
  .b-review-group {
    grid-column: 1 / -1;
    align-self: end;
    display: flex;
    align-items: center;
    gap: 12px;
    /* Room under the title for the card tags that sit on the cards' top edge. */
    padding: 18px 2px 14px;
    font-family: var(--b-code);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgb(var(--b-page-ink) / 0.55);
  }
  .b-review-group::after {
    content: "";
    flex: 1;
    height: 1px;
    background: rgb(var(--b-page-ink) / 0.1);
  }
  .review .slot {
    min-height: 120px;
  }
  /* The hero keeps its live proportions in review: as tall as the live hero band (two rows at their minimum). */
  .review .slot[data-size="XL"] {
    min-height: 568px;
  }
  /* The card's review tag: a small mono caps chip in the page's own ink, on the card's top edge at the right,
     clear of the card label and anything inside the card. */
  .kind-tag {
    position: absolute;
    z-index: 3;
    top: -9px;
    right: 14px;
    height: 18px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--b-bg);
    background: rgb(var(--b-page-ink) / 0.86);
    pointer-events: none;
  }
  .kind-tag i {
    font-style: normal;
    white-space: pre;
    opacity: 0.45;
  }
  /* One line high, so the squares never push the date down. */
  .b-nameline {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 17px;
  }
  .b-runs {
    display: flex;
    align-items: center;
    min-width: 0;
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
  /* The first view has no items either, but its cards take their content's height. */
  .daily-brief[data-template="1"] .slot.fv-slot {
    min-height: 0;
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
