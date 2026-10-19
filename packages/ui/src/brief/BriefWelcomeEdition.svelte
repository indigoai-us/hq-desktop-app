<script lang="ts">
  /**
   * The welcome edition after the rise (round 11b final frame): the risen sky
   * behind the greeting, "Your day, ready to read." with three cards, and one
   * short section per company. Same page offsets as BriefRise (in normal flow), so the reveal
   * hands off without a jump. The theme follows the welcome report around it.
   */
  import BriefDawn from "./BriefDawn.svelte";
  import { WELCOME_HORIZON_Y, welcomeSunX } from "./brief-dawn.js";
  import { RISE_CRUMB, riseDateLine } from "./brief-rise.js";
  import { WELCOME_EDITION_EYEBROW, WELCOME_EDITION_HEAD, type WelcomeEdition, type WelcomeEditionAction } from "./brief-welcome-edition.js";

  interface Props {
    edition: WelcomeEdition;
    now: Date;
    /** Hands a card's prompt to a session; resolves with the note to show. */
    onlaunch: (itemId: string, prompt: string) => Promise<string | null> | void;
    /** The note a launched card shows in place of its link. */
    launched?: (itemId: string) => string | null;
    onopenmeetings?: () => void;
  }
  let { edition, now, onlaunch, launched = () => null, onopenmeetings }: Props = $props();

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

  function canRun(action: WelcomeEditionAction | null): boolean {
    if (!action) return false;
    return action.kind === "launch" || !!onopenmeetings;
  }
  /** Items whose launch is still in flight; their link is disabled so a double click starts one session. */
  let busy = $state<Record<string, boolean>>({});
  async function run(action: WelcomeEditionAction | null): Promise<void> {
    if (!action) return;
    if (action.kind === "meetings") {
      onopenmeetings?.();
      return;
    }
    if (busy[action.itemId]) return;
    busy = { ...busy, [action.itemId]: true };
    try {
      await onlaunch(action.itemId, action.prompt);
    } catch {
      // The launch failed before it could say why; the link stays so the person can try again.
    } finally {
      busy = { ...busy, [action.itemId]: false };
    }
  }
  const noteFor = (action: WelcomeEditionAction | null) => (action?.kind === "launch" ? launched(action.itemId) : null);
</script>

<div
  class="edition"
  class:zero={edition.zero}
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
  </div>
  <article class="brief">
    <div class="head">
      <h3>{WELCOME_EDITION_HEAD}</h3>
      {#if edition.note}<span class="run" data-testid="welcome-edition-run">{edition.note}</span>{/if}
    </div>
    <div class="cards">
      {#each edition.cards as card (card.id)}
        {@const note = noteFor(card.action)}
        <section class="card" class:lead={card.id === "decision"} data-testid="welcome-edition-card" data-card={card.id}>
          <div class="kicker">
            {#if card.pill}<span class="pill">{card.pill}</span>{/if}
            <span>{card.kicker}</span>
          </div>
          <h3>{card.title}</h3>
          {#if card.lines.length}<p>{#each card.lines as line, i (i)}{#if i}<br />{/if}{line}{/each}</p>{/if}
          {#if note}
            <p class="note" data-testid="welcome-edition-note">{note}</p>
          {:else if card.label && canRun(card.action)}
            <button type="button" class="link" data-testid="welcome-edition-action" disabled={card.action?.kind === "launch" && !!busy[card.action.itemId]} onclick={() => void run(card.action)}>{card.label}</button>
          {/if}
        </section>
      {/each}
    </div>
    <div class="sections">
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
    overflow: hidden;
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
  /* The mockup's brief head: the title left, one quiet run line right, set on the
     bottom of the title row and nudged 4 px lower so it keeps about 16 px clear of
     the horizon rows above it, still well above the cards. */
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 16px;
    margin-bottom: 18px;
  }
  .head h3 {
    font: 400 23px var(--serif);
  }
  .run {
    position: relative;
    top: 4px;
    font-size: 12px;
    color: var(--ink-2);
    text-align: right;
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
  .sections {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    margin-top: 24px;
  }
  .zero .sections {
    grid-template-columns: 1fr 1fr;
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
    .sections {
      grid-template-columns: 1fr;
    }
  }
</style>
