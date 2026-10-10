<script lang="ts">
  /**
   * Daily Brief page. The generator picks the lead and the widget count from
   * the day's data and places widgets into a 6x3 grid; this component renders
   * that plan. Styles and the effect legend live in brief.css.
   *
   * Actions never call product APIs. Each actionable item hands its prompt to
   * a new Claude, Codex or Grok session (through `onlaunch`) or the
   * clipboard, and is marked done in this brief only.
   */
  import "./brief.css";
  import BriefAgenda from "./BriefAgenda.svelte";
  import BriefCatchUp from "./BriefCatchUp.svelte";
  import BriefFleet from "./BriefFleet.svelte";
  import BriefIncident from "./BriefIncident.svelte";
  import BriefMeetings from "./BriefMeetings.svelte";
  import BriefNeedsYou from "./BriefNeedsYou.svelte";
  import BriefOneThing from "./BriefOneThing.svelte";
  import BriefOtherWork from "./BriefOtherWork.svelte";
  import BriefPeek from "./BriefPeek.svelte";
  import BriefRisk from "./BriefRisk.svelte";
  import BriefShipped from "./BriefShipped.svelte";
  import BriefSunrise from "./BriefSunrise.svelte";
  import BriefTeam from "./BriefTeam.svelte";
  import BriefTodayStrip from "./BriefTodayStrip.svelte";
  import BriefWaiting from "./BriefWaiting.svelte";
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
  import { generateBrief, leadLabel } from "./brief-generate.js";
  import type { BriefInput } from "./brief-types.js";

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

  const state = new BriefState(
    (engine, prompt) => (onlaunch ?? launchBriefPromptViaClipboard)(engine, prompt),
    () => companies,
    { dmApi: () => dmApi, openThread: () => onopenthread },
  );
  provideBrief(state);

  const plan = $derived(generateBrief(input));
  const cleared = $derived(input.decisions.filter((d) => state.cleared[d.id]).length);
  const incident = $derived(input.risks.find((r) => r.severity === "incident") ?? null);
  const watch = $derived(input.risks.find((r) => r.severity === "watch") ?? null);
  const nowDate = $derived(new Date(input.now));
  const dateLabel = $derived(
    nowDate.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }).replace(",", " ·"),
  );
  const timeLabel = $derived(nowDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));

  /** One line under the greeting, from what the day holds. */
  const sunSub = $derived.by(() => {
    const parts: string[] = [];
    if (input.merged != null) {
      parts.push(`Yesterday you merged ${input.merged}${input.opened != null ? ` and opened ${input.opened}` : ""}.`);
    } else if (input.shipped.length) {
      parts.push(`Yesterday ${input.shipped.length} thing${input.shipped.length === 1 ? "" : "s"} shipped.`);
    } else if (input.meetingsYesterday.length) {
      parts.push(`Yesterday had ${input.meetingsYesterday.length} meeting${input.meetingsYesterday.length === 1 ? "" : "s"}.`);
    }
    if (incident) parts.push(`${incident.title} is the one fire.`);
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
      .filter((s) => !s.company || input.companies.some((c) => c.toLowerCase() === s.company!.toLowerCase()))
      .filter((s) => {
        const t = Date.parse(s.startedAt);
        return t > end - 24 * 3600_000 && t <= end;
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((s) => ({ at: s.startedAt, title: s.title }));
  });
</script>

<div class="daily-brief" data-testid="daily-brief" data-lead={plan.lead} data-density={plan.density}>
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
      <span class="leadchip" data-testid="brief-lead">Lead <b>{leadLabel(plan.lead)}</b> · {plan.density} widgets · {plan.reason}</span>
      {#each plan.provenance as p (p.label)}<span><b>{p.n}</b> {p.label}</span>{/each}
    </div>
  </header>
  {#if header}<div class="b-runs">{@render header()}</div>{/if}

  <BriefTodayStrip events={input.calendarToday} now={input.now} dateLabel={dateLabel.toUpperCase()} sample={input.calendarSample ?? false} {onopenmeetings} />

  <main class="b-grid" style="grid-template-areas:{plan.areas.map((a) => `'${a}'`).join(' ')}">
    {#each plan.widgets as w, i (w.kind)}
      <div class="slot" style="grid-area:{w.kind};animation-delay:{i * 70}ms" data-widget={w.kind}>
        {#if w.kind === "sunrise"}
          <BriefSunrise
            total={input.decisions.length}
            {cleared}
            userName={input.userName}
            sub={sunSub}
            {quietLine}
            big={w.cols >= 3}
            {timeline}
            now={input.now}
          />
        {:else if w.kind === "needs"}
          <BriefNeedsYou decisions={input.decisions} prompts={plan.prompts} rows={w.rows} />
        {:else if w.kind === "team"}
          <BriefTeam team={input.team} rows={w.rows} />
        {:else if w.kind === "incident" && incident}
          <BriefIncident risk={incident} prompt={plan.prompts[incident.id]} rows={w.rows} />
        {:else if w.kind === "shipped"}
          <BriefShipped shipped={input.shipped} merged={input.merged ?? null} opened={input.opened ?? null} cols={w.cols} rows={w.rows} prWindow={input.prWindow ?? null} />
        {:else if w.kind === "fleet" && input.fleet}
          <BriefFleet fleet={input.fleet} />
        {:else if w.kind === "waiting"}
          <BriefWaiting waiting={input.waitingOn} prompts={plan.prompts} />
        {:else if w.kind === "meetings"}
          <BriefMeetings meetings={input.meetingsYesterday} rows={w.rows} />
        {:else if w.kind === "risk" && watch}
          <BriefRisk risk={watch} prompt={plan.prompts[watch.id]} />
        {:else if w.kind === "agenda"}
          <BriefAgenda events={input.calendarToday} rows={w.rows} />
        {:else if w.kind === "otherWork"}
          <BriefOtherWork count={plan.sessions.otherCompanyCount} rows={w.rows} />
        {:else if w.kind === "oneThing" && input.decisions[0]}
          <BriefOneThing decision={input.decisions[0]} prompt={plan.prompts[input.decisions[0].id]} />
        {:else if w.kind === "catchup"}
          <BriefCatchUp {input} daysAway={plan.daysAway ?? 0} />
        {/if}
      </div>
    {/each}
  </main>

  {#if housekeeping}<BriefHousekeeping {housekeeping} />{/if}

  <BriefPeek />
</div>

<style>
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
</style>
