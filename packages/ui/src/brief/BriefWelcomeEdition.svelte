<script lang="ts">
  /**
   * The welcome edition after the rise (round 11b final frame): the risen sky
   * behind the greeting, "Your day, ready to read." with three cards, and one
   * short section per company. Same page offsets as BriefRise (in normal flow), so the reveal
   * hands off without a jump. The theme follows the welcome report around it.
   *
   * With brief.json `welcome` fields (US-019) the cards are IF YOU DO ONE
   * THING, the watch list and the timeline, and each welcome action runs its
   * own flow: the connect card opens here, the open action opens the harness
   * it names (never the tool picked at Continue), the company flow and
   * launches go to the page.
   */
  import { onDestroy, untrack } from "svelte";
  import BriefConnectApps from "./BriefConnectApps.svelte";
  import BriefDawn from "./BriefDawn.svelte";
  import { WELCOME_HORIZON_Y, welcomeSunX } from "./brief-dawn.js";
  import { RISE_CRUMB, riseDateLine } from "./brief-rise.js";
  import { WELCOME_EDITION_EYEBROW, WELCOME_EDITION_HEAD, type WelcomeEdition, type WelcomeEditionAction } from "./brief-welcome-edition.js";
  import type { WelcomeAction, WelcomeActionKind } from "./brief-welcome-contract.js";
  import { getWelcomeAiApps } from "./welcome-ai-apps.js";

  interface Props {
    edition: WelcomeEdition;
    now: Date;
    /** Hands a card's prompt to a session; resolves with the note to show. */
    onlaunch: (itemId: string, prompt: string) => Promise<string | null> | void;
    /** The note a launched card shows in place of its link. */
    launched?: (itemId: string) => string | null;
    onopenmeetings?: () => void;
    /** Opens the start-or-join-a-company flow. */
    onconnectcompany?: () => void;
  }
  let { edition, now, onlaunch, launched = () => null, onopenmeetings, onconnectcompany }: Props = $props();

  /** The welcome report's connect inputs and open action; absent outside the report. */
  const welcomeApps = getWelcomeAiApps();
  /** The connect card, opened in the edition from a connect action. */
  let connectOpen = $state(false);
  /** The short link on a watch-list row; the row's title already names the action. */
  const ROW_LINK: Record<WelcomeActionKind, string> = {
    connect_ai_apps: "Connect",
    connect_integration: "Connect",
    open_harness: "Open",
    connect_company: "Get started",
    import_history: "Import",
    open_tree: "Open",
  };
  const welcomeActions = $derived(
    edition.cards.flatMap((c) => [c.action, ...(c.rows ?? []).map((r) => r.action)]).flatMap((a) => (a?.kind === "welcome" ? [a.action] : [])),
  );
  // The edition shows the open action itself, so the report leaves out its own bar.
  // Claimed while the edition first renders, so the bar never shows for a frame.
  const showsOpen = $derived(welcomeActions.some((a) => a.kind === "open_harness"));
  let release: (() => void) | null = untrack(() => showsOpen) ? (welcomeApps?.claimOpenTool?.() ?? null) : null;
  $effect(() => {
    if (showsOpen && !release) release = welcomeApps?.claimOpenTool?.() ?? null;
    if (!showsOpen && release) {
      release();
      release = null;
    }
  });
  onDestroy(() => release?.());

  let host = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  let theme = $state<"dark" | "light">("dark");
  $effect(() => {
    const around = (host?.parentElement?.closest("[data-theme]") as HTMLElement | null)?.dataset.theme;
    const forced = globalThis.document?.documentElement?.dataset?.forceTheme;
    const picked = around ?? forced;
    theme =
      picked === "light" || picked === "dark"
        ? picked
        : typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
  });

  const sunX = $derived(welcomeSunX(width));
  const dateLine = $derived(riseDateLine(now));

  function canRunWelcome(a: WelcomeAction): boolean {
    switch (a.kind) {
      case "connect_ai_apps":
      case "connect_integration":
        return !!welcomeApps?.current || !!a.launch_prompt;
      case "open_harness":
        return !!a.harness && !!welcomeApps?.openHarness?.harnesses.includes(a.harness);
      case "connect_company":
        return !!onconnectcompany;
      default:
        return !!a.launch_prompt;
    }
  }
  function canRun(action: WelcomeEditionAction | null): boolean {
    if (!action) return false;
    if (action.kind === "welcome") return canRunWelcome(action.action);
    return action.kind === "launch" || !!onopenmeetings;
  }
  const busyFor = (action: WelcomeEditionAction | null): boolean => {
    if (action?.kind === "launch") return !!busy[action.itemId];
    if (action?.kind !== "welcome") return false;
    return !!busy[action.action.id];
  };
  /** The plain line from a harness that could not open, by action id. */
  let errors = $state<Record<string, string | null>>({});
  const errorFor = (action: WelcomeEditionAction | null): string | null =>
    action?.kind === "welcome" ? (errors[action.action.id] ?? null) : null;
  /** Items whose launch is still in flight; their link is disabled so a double click starts one session. */
  let busy = $state<Record<string, boolean>>({});
  async function run(action: WelcomeEditionAction | null): Promise<void> {
    if (!action) return;
    if (action.kind === "meetings") {
      onopenmeetings?.();
      return;
    }
    let itemId: string;
    let prompt: string;
    if (action.kind === "welcome") {
      const a = action.action;
      if ((a.kind === "connect_ai_apps" || a.kind === "connect_integration") && welcomeApps?.current) {
        connectOpen = !connectOpen;
        return;
      }
      if (a.kind === "connect_company") {
        onconnectcompany?.();
        return;
      }
      if (a.kind === "open_harness") {
        await openHarness(a);
        return;
      }
      if (!a.launch_prompt) return;
      itemId = a.id;
      prompt = a.launch_prompt;
    } else {
      itemId = action.itemId;
      prompt = action.prompt;
    }
    if (busy[itemId]) return;
    busy = { ...busy, [itemId]: true };
    try {
      await onlaunch(itemId, prompt);
    } catch {
      // The launch failed before it could say why; the link stays so the person can try again.
    } finally {
      busy = { ...busy, [itemId]: false };
    }
  }
  async function openHarness(a: WelcomeAction): Promise<void> {
    const host = welcomeApps?.openHarness;
    if (!host || !a.harness || busy[a.id]) return;
    busy = { ...busy, [a.id]: true };
    errors = { ...errors, [a.id]: null };
    try {
      errors = { ...errors, [a.id]: await host.open(a.harness, a.launch_prompt) };
    } catch {
      errors = { ...errors, [a.id]: "HQ could not open. Try again in a moment." };
    } finally {
      busy = { ...busy, [a.id]: false };
    }
  }
  const noteFor = (action: WelcomeEditionAction | null) =>
    action?.kind === "launch" ? launched(action.itemId) : action?.kind === "welcome" ? launched(action.action.id) : null;
  const actionId = (action: WelcomeEditionAction | null) =>
    action?.kind === "welcome" ? action.action.id : action?.kind === "launch" ? action.itemId : undefined;
</script>

<div
  class="edition"
  class:zero={edition.zero}
  class:welcome={edition.welcome}
  data-testid="welcome-edition"
  data-theme={theme}
  bind:this={host}
  bind:clientWidth={width}
  style:--sun-x="{sunX}px"
  style:--hz="{WELCOME_HORIZON_Y}px"
>
  <BriefDawn progress={1} phase="ready" size="page" {theme} reflection={false} layout="welcome" sea={false} />
  <header class="top">
    <span>{RISE_CRUMB}</span>
    <span data-testid="welcome-edition-date">{dateLine}</span>
  </header>
  <div class="hero">
    <p class="lede">{WELCOME_EDITION_EYEBROW}</p>
    <h2 data-testid="welcome-edition-greeting">{edition.headline}</h2>
    <p class="sub">{edition.sub}</p>
    {#if edition.note}<p class="run" data-testid="welcome-edition-run">{edition.note}</p>{/if}
  </div>
  <article class="brief">
    <div class="head">
      <h3>{WELCOME_EDITION_HEAD}</h3>
    </div>
    <div class="cards">
      {#each edition.cards as card (card.id)}
        {@const note = noteFor(card.action)}
        {@const error = errorFor(card.action)}
        <section class="card" class:lead={card.id === "decision" || card.id === "one-thing"} class:list={!!card.rows} data-testid="welcome-edition-card" data-card={card.id}>
          <div class="kicker">
            {#if card.pill}<span class="pill">{card.pill}</span>{/if}
            <span>{card.kicker}</span>
          </div>
          {#if card.title}<h3>{card.title}</h3>{/if}
          {#if card.lines.length}<p>{#each card.lines as line, i (i)}{#if i}<br />{/if}{line}{/each}</p>{/if}
          {#if card.rows}
            <ul class="rows">
              {#each card.rows as row (row.id)}
                {@const rowNote = noteFor(row.action)}
                {@const rowError = errorFor(row.action)}
                <li class="row" data-testid="welcome-edition-row">
                  <div class="row-text">
                    <h4>{row.title}</h4>
                    {#if row.detail}<p>{row.detail}</p>{/if}
                    {#if rowNote}<p class="note" data-testid="welcome-edition-note">{rowNote}</p>{/if}
                    {#if rowError}<p class="note" data-testid="welcome-edition-error">{rowError}</p>{/if}
                  </div>
                  {#if !rowNote && row.action?.kind === "welcome" && canRun(row.action)}
                    <button type="button" class="link" data-testid="welcome-edition-action" data-action={actionId(row.action)} disabled={busyFor(row.action)} onclick={() => void run(row.action)}>{ROW_LINK[row.action.action.kind]}</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if note}
            <p class="note" data-testid="welcome-edition-note">{note}</p>
          {:else if card.label && canRun(card.action)}
            <button type="button" class="link" data-testid="welcome-edition-action" data-action={actionId(card.action)} disabled={busyFor(card.action)} onclick={() => void run(card.action)}>{card.label}</button>
          {/if}
          {#if error}<p class="note" data-testid="welcome-edition-error">{error}</p>{/if}
        </section>
      {/each}
    </div>
    {#if connectOpen && welcomeApps?.current}
      {@const connect = welcomeApps.current}
      <div class="connect" data-testid="welcome-edition-connect">
        <BriefConnectApps detect={connect.detect} cli={connect.cli} suggest={connect.suggest} session={connect.session} anywhereOnId={connect.anywhereOnId ?? null} {theme} />
      </div>
    {/if}
    <div class="sections" style:--cols={Math.max(1, Math.min(edition.sections.length, 4))}>
      {#each edition.sections as section (section.name)}
        <section class="section" data-testid="welcome-edition-section">
          <h3>{section.name}</h3>
          <p>{#each section.lines as line, i (i)}{#if i}<br />{/if}{line}{/each}</p>
        </section>
      {/each}
    </div>
  </article>
</div>

<style>
  /* Pixel offsets follow the round 11b final frame (window minus its 46 px title bar and 76 px rail). */
  .edition {
    --pad: 52px;
    --serif: "Fraunces", "Iowan Old Style", Georgia, serif;
    --ink: rgba(255, 244, 236, 0.96);
    --ink-2: rgba(255, 236, 226, 0.72);
    --card: #302534;
    --card-line: #58445b;
    --lead: #382a3b;
    --lead-line: #b68a6260;
    --rule: rgba(255, 236, 226, 0.14);
    --shadow: none;
    position: relative;
    box-sizing: border-box;
    min-height: 854px;
    padding: 29px 48px 28px var(--pad);
    /* Clips the sky sideways only, so a long brief grows the page and is never cut off at the bottom. */
    overflow-x: clip;
    background: rgb(20, 18, 25);
    color: var(--ink);
    font-family: var(--font-ui, "Geist", system-ui, sans-serif);
  }
  .edition[data-theme="light"] {
    --ink: #1a1210;
    --ink-2: rgba(42, 28, 22, 0.74);
    --card: #fffaf0;
    --card-line: #ba985f38;
    --lead: #fffaf0;
    --lead-line: #bc854c65;
    --rule: #ae864b38;
    --shadow: 0 8px 28px #9e65140a;
    background: rgb(255, 247, 231);
  }
  .edition :global(.dawn.page) {
    --sky-h: 100%;
    position: absolute;
    inset: 0;
    height: 100%;
    min-height: 100%;
    border-radius: 0;
  }
  .edition :global(.dawn .sky) {
    height: 100%;
  }
  .edition :global(.dawn .copy) {
    display: none;
  }
  /* Normal flow, so long titles and narrow windows grow the page instead of clipping it. */
  .top,
  .hero,
  .brief {
    position: relative;
  }
  .top {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--ink-2);
  }
  .hero {
    box-sizing: border-box;
    width: 630px;
    max-width: 100%;
    min-height: 278px;
    padding-top: 46px;
  }
  .lede {
    margin: 0 0 16px;
    font-size: 12px;
    letter-spacing: 0.08em;
    color: var(--ink-2);
  }
  h2 {
    margin: 0;
    font: 500 52px/1.08 var(--serif);
    letter-spacing: -1.6px;
    text-wrap: balance;
  }
  .sub {
    margin: 20px 0 0;
    max-width: 430px;
    font-size: 15px;
    line-height: 1.7;
    color: var(--ink-2);
  }
  h3 {
    margin: 0;
    font-weight: 400;
  }
  /* The mockup's brief head: the title alone, 18 px above the cards. */
  .head {
    margin-bottom: 18px;
  }
  .head h3 {
    font: 400 23px var(--serif);
  }
  /* The run line sits in the sky with the greeting, clear of the waterline rows
     (the mockup keeps the head row for the title alone). */
  .run {
    margin: 12px 0 0;
    max-width: 430px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--ink-2);
  }
  .cards {
    display: grid;
    grid-template-columns: 1.05fr 1.1fr 1fr;
    gap: 14px;
  }
  .zero .cards {
    grid-template-columns: 1.5fr 1fr;
  }
  .card {
    box-sizing: border-box;
    min-height: 206px;
    padding: 20px;
    border-radius: 18px;
    border: 1px solid var(--card-line);
    background: var(--card);
    box-shadow: var(--shadow);
  }
  .card.lead {
    border-color: var(--lead-line);
    background: var(--lead);
  }
  .kicker {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 12px;
    font-size: 11px;
    color: var(--ink-2);
  }
  .pill {
    font-size: 11px;
    font-weight: 500;
    padding: 5px 8px;
    border-radius: 5px;
    border: 1px solid #bc854c60;
    background: #b6752720;
    color: var(--ink);
  }
  .card h3 {
    font: 400 23px/1.15 var(--serif);
    letter-spacing: -0.35px;
    text-wrap: pretty;
  }
  .card.lead h3 {
    font-size: 27px;
    line-height: 1.12;
  }
  .card p {
    margin: 10px 0 0;
    font-size: 12px;
    line-height: 1.6;
    color: var(--ink-2);
  }
  .link {
    margin-top: 12px;
    padding: 0;
    border: 0;
    background: none;
    font: 12px var(--font-ui, "Geist", system-ui, sans-serif);
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 4px;
    cursor: pointer;
  }
  .link:disabled {
    cursor: progress;
    opacity: 0.6;
  }
  .link:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 4px;
  }
  /* The welcome components: a lead card with room for its sentence, then two list cards. */
  .welcome .cards {
    grid-template-columns: 1.15fr 1fr 1fr;
  }
  .card.list h3 {
    font-size: 21px;
  }
  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 11px 0;
    border-top: 1px solid var(--rule);
  }
  .row:first-child {
    padding-top: 2px;
    border-top: 0;
  }
  .row-text {
    min-width: 0;
  }
  .row h4 {
    margin: 0;
    font: 400 17px/1.25 var(--serif);
    letter-spacing: -0.2px;
  }
  .row p {
    margin: 4px 0 0;
  }
  .row .link {
    flex: none;
    margin-top: 0;
  }
  .note {
    font-style: italic;
  }
  .connect {
    margin-top: 14px;
  }
  .sections {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    margin-top: 24px;
  }
  .zero .sections {
    grid-template-columns: 1fr 1fr;
  }
  /* One row for up to four sections, so none sits alone on a second row. */
  .welcome .sections {
    grid-template-columns: repeat(var(--cols), 1fr);
  }
  @media (max-width: 1100px) {
    .welcome .sections {
      grid-template-columns: 1fr 1fr;
    }
  }
  .section {
    min-height: 94px;
    padding-top: 16px;
    border-top: 1px solid var(--rule);
  }
  .section h3 {
    margin-bottom: 5px;
    font: 400 20px var(--serif);
  }
  .section p {
    margin: 0;
    font-size: 13px;
    line-height: 1.7;
    color: var(--ink-2);
  }
  @media (max-width: 900px) {
    .cards,
    .zero .cards,
    .welcome .cards,
    .sections {
      grid-template-columns: 1fr;
    }
  }
</style>
