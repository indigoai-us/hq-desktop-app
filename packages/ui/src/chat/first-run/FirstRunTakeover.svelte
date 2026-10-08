<script lang="ts">
  /**
   * Visual first-run setup (slice 1): the New bot takeover's step-through
   * screens, opened on a first run instead of the setup bot's chat. Name
   * your HQ assistant, Your coding tools, Done. The steps come from
   * `FIRST_RUN_STEPS`, so later slices add screens without touching the
   * bars or the footers here.
   *
   * The host owns the create (`creation`, `onconfirmname`, `onretry`): it
   * starts as soon as the name is confirmed and a coding tool is ready, and
   * runs while the person is on the later screens. Every async action shows
   * its pending state at once and holds duplicate presses.
   *
   * Slice 4 adds "Bring in your context" (the knowledge tree) when the host
   * can scan this computer (`importHost`). The scan runs here, one at a
   * time; leaving the step (Next, Finish, Back, Continue in chat) cancels a
   * scan that is still running. A finished scan's counts and report path go
   * to the host (`onimport`) for the setup bot's handoff.
   */
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import LazyDoor from "../../shell/LazyDoor.svelte";
  import { firstRunImportDoor } from "../../shell/lazy-doors.js";
  import {
    createImportRunner,
    importResultOf,
    type ImportRunView,
    type ImportScanHost,
  } from "./knowledge-tree/import-runner.js";
  import { createSceneClock, type SceneClock } from "./knowledge-tree/scene-clock.js";
  import { hostComputerNoun, subscribeHostComputerNoun } from "@hq/platform";
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { suspendShortcuts } from "../../common/keyboard-shortcuts.js";
  import { portal } from "../portal.js";
  import NewBotNameStep from "../create-bot/NewBotNameStep.svelte";
  import NewBotStepHead from "../create-bot/NewBotStepHead.svelte";
  import NewBotOrbIcon from "../create-bot/NewBotOrbIcon.svelte";
  import HomeStep from "../create-bot/HomeStep.svelte";
  import type { RuntimeSignInApi } from "../create-bot/RuntimeSignIn.svelte";
  import type { RuntimeStatus } from "../create-bot/runtime-status.js";
  import { initialDraft, type BotRuntime, type CreateBotDraft } from "../create-bot/create-bot-model.js";
  import { newBotWallpaper } from "../create-bot/new-bot-wallpapers.js";
  import type {
    AiTools,
    AssistantId,
    CodingTool,
    InstallOutcome,
  } from "../../install-choice/install-choice.js";
  import { SETUP_BOT_RUNTIME_ORDER } from "../setup-bot.js";
  import {
    FIRST_RUN_COPY,
    FIRST_RUN_NAME_TITLE,
    FIRST_RUN_STEPS,
    anyToolReady,
    assistantNameIssue,
    firstRunCanLeave,
    firstRunDoneTitle,
    firstRunFinishTarget,
    firstRunNextLabel,
    firstRunOffersFinish,
    firstRunStepNumber,
    firstRunStepsFor,
    firstRunTalkLabel,
    firstRunToolsTitle,
    nextFirstRunStep,
    normalizeAssistantName,
    prevFirstRunStep,
    runtimeLabel,
    type FirstRunCreation,
    type FirstRunImportHandoff,
    type FirstRunStep,
    type FirstRunStepId,
  } from "./visual-first-run.js";
  import "../create-bot/new-bot-takeover.css";

  interface Props {
    /** The suggested name the name step opens with. */
    initialName: string;
    steps?: readonly FirstRunStep[];
    /** Test and harness seam: open on this step. */
    initialStep?: FirstRunStepId;
    runtimeReady: Record<string, boolean> | null;
    runtimeStatus?: Record<string, RuntimeStatus> | null;
    signInApi?: RuntimeSignInApi | null;
    onsignedin?: ((runtime: BotRuntime) => void | Promise<void>) | null;
    onrecheck?: (() => void | Promise<void>) | null;
    aiTools?: AiTools | null;
    hqFolderPath?: string;
    onopenassistant?: (assistant: AssistantId, url: string) => Promise<InstallOutcome>;
    onassistedinstall?: (tool: CodingTool) => Promise<InstallOutcome>;
    onrequestaitools?: () => void;
    pollMs?: number;
    /** Where creating the assistant stands (the host runs it). */
    creation: FirstRunCreation;
    /**
     * The name is confirmed: the host starts creating the assistant now if a
     * coding tool is ready, and as soon as one is otherwise.
     */
    onconfirmname: (name: string, runtime: BotRuntime) => void;
    /** The coding tool the person picked on the tools step. */
    onruntime?: ((runtime: BotRuntime) => void) | null;
    onretry: () => void;
    /** Done: open the assistant's chat. */
    ontalk: () => void | Promise<void>;
    /** Leave for the setup chat (every screen, and the failure line). */
    oncontinueinchat: () => void | Promise<void>;
    /**
     * Runs the context scan on this computer. Without it the flow has no
     * "Bring in your context" step.
     */
    importHost?: ImportScanHost | null;
    /** The scan finished: its counts and report path, for the handoff. */
    onimport?: ((result: FirstRunImportHandoff) => void) | null;
    /** Test seam for the context step: null follows prefers-reduced-motion. */
    reducedMotion?: boolean | null;
  }

  let {
    initialName,
    steps = FIRST_RUN_STEPS,
    initialStep = "name",
    runtimeReady,
    runtimeStatus = null,
    signInApi = null,
    onsignedin = null,
    onrecheck = null,
    aiTools = null,
    hqFolderPath = "",
    onopenassistant,
    onassistedinstall,
    onrequestaitools,
    pollMs = 1500,
    creation,
    onconfirmname,
    onruntime = null,
    onretry,
    ontalk,
    oncontinueinchat,
    importHost = null,
    onimport = null,
    reducedMotion = null,
  }: Props = $props();

  /** The steps this host can show (no context step without a scan host). */
  const shownSteps = $derived(firstRunStepsFor({ canImport: !!importHost }, steps));

  let step = $state<FirstRunStepId>(untrack(() => initialStep));
  /** The name as typed or confirmed. */
  let name = $state(untrack(() => initialName));
  /** The coding tool card that is picked. Starts on the first ready one. */
  let draft = $state<CreateBotDraft>(
    untrack(() =>
      initialDraft(
        { canLocal: true, canCloud: false, existingNames: [], companies: [], runtimeReady },
        null,
        null,
        "local",
        initialName || "assistant",
      ),
    ),
  );
  let hostNoun = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((next) => (hostNoun = next)));
  // The takeover owns the keyboard while it is open (as NewBotTakeover does).
  onMount(() => suspendShortcuts());

  /** One leave at a time: Talk or Continue in chat, whichever was pressed. */
  let leaving = $state<"talk" | "chat" | null>(null);

  const total = $derived(shownSteps.length);
  const ready = $derived(anyToolReady(runtimeReady));
  /** The name is part of setup now: changing it would not reach the bot. */
  const nameLocked = $derived(creation.state === "creating" || creation.state === "ready");
  const shownName = $derived((creation.state === "idle" ? name : creation.name).trim() || "your assistant");
  const doneTitle = $derived(firstRunDoneTitle(shownName));
  const toolsTitle = $derived(firstRunToolsTitle(shownName, hostNoun));
  const botRuntime = $derived<BotRuntime | null>(
    runtimeReady?.[draft.runtime] === true
      ? draft.runtime
      : (SETUP_BOT_RUNTIME_ORDER.find((runtime) => runtimeReady?.[runtime] === true) ?? null),
  );

  // A tool signed in later: the picked card follows to a ready one, so the
  // assistant thinks with what the person sees picked.
  $effect(() => {
    const current = untrack(() => draft.runtime);
    if (runtimeReady?.[current] === true) return;
    const first = SETUP_BOT_RUNTIME_ORDER.find((runtime) => runtimeReady?.[runtime] === true);
    if (first && first !== current) {
      draft = { ...untrack(() => draft), runtime: first };
      onruntime?.(first);
    }
  });

  // ── Bring in your context ──────────────────────────────────────────────
  /** The context scene's clock, started the first time the step opens. */
  let importClock = $state.raw<SceneClock | null>(null);
  let importRun = $state.raw<ImportRunView>({ phase: "idle", scanStart: null, events: [], failure: null });
  let importReported = false;
  const importRunner = createImportRunner(
    untrack(() => importHost),
    () => importClock?.now() ?? 0,
    (view) => {
      importRun = view;
      if (view.phase === "done" && !importReported) {
        importReported = true;
        const result = importResultOf(view.events);
        if (result) onimport?.(result);
      }
    },
  );
  $effect(() => {
    if (step !== "context" || importClock) return;
    untrack(() => {
      importClock = createSceneClock();
    });
  });
  onMount(() => {
    // Warm the scene's chunk while the person is on the earlier steps.
    if (untrack(() => importHost)) firstRunImportDoor.preload();
  });
  onDestroy(() => {
    importRunner.dispose();
    importClock?.dispose();
  });

  /** A scan still running stops when the person leaves its step, however they leave. */
  function leaveContext(): void {
    if (importRunner.current().phase === "running") importRunner.cancel();
    importAnnouncement = "";
  }
  /** What the context step asks the one live region to say (its scan's state). */
  let importAnnouncement = $state("");

  function goTo(next: FirstRunStepId | null): void {
    if (!next) return;
    if (step === "context" && next !== "context") leaveContext();
    step = next;
  }

  function confirmName(next: string, finish: boolean): void {
    if (!nameLocked) {
      name = normalizeAssistantName(next);
      onconfirmname(name, draft.runtime);
    }
    goTo(finish ? firstRunFinishTarget(runtimeReady, shownSteps) : nextFirstRunStep("name", shownSteps));
  }

  function patchDraft(patch: Partial<CreateBotDraft>): void {
    draft = { ...draft, ...patch };
    if (patch.runtime) onruntime?.(patch.runtime);
  }

  async function leave(kind: "talk" | "chat"): Promise<void> {
    if (leaving) return;
    leaving = kind;
    leaveContext();
    try {
      await (kind === "talk" ? ontalk() : oncontinueinchat());
    } finally {
      leaving = null;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    // Escape does not leave a first run by accident: the header's
    // "Continue in chat" is the way out.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * What the one live region says. It stays mounted for the whole takeover
   * and only its text changes, so screen readers hear every change of the
   * create, on every screen. On the context step it says how the scan is
   * going (the step has no live region of its own).
   */
  const announcement = $derived(
    step === "context" && importAnnouncement
      ? importAnnouncement
      : creation.state === "failed"
      ? creation.reason
      : creation.state === "creating"
        ? `Getting ${shownName} ready…`
        : creation.state === "ready"
          ? `${shownName} is ready.`
          : "",
  );

  let cardEl = $state<HTMLDivElement | null>(null);
  /**
   * Focus stays in the dialog: on open, and after every step change (the
   * pressed button is gone). The name step focuses its field itself, unless
   * the field is locked, when Next takes it.
   */
  $effect(() => {
    void step;
    const locked = nameLocked;
    const card = cardEl;
    if (!card) return;
    void tick().then(() => {
      const active = document.activeElement;
      if (active && active !== card && card.contains(active)) return;
      const target =
        (step === "name" && locked
          ? card.querySelector<HTMLElement>('[data-testid="new-bot-continue-name"]')
          : card.querySelector<HTMLElement>(
              'input:not([disabled]), [data-testid="first-run-import-start"]:not([disabled]), [data-testid="first-run-next"]:not([disabled]), [data-testid="first-run-talk"]:not([disabled])',
            )) ?? card;
      target.focus();
    });
  });

  const talkLabel = $derived(
    leaving === "talk"
      ? FIRST_RUN_COPY.opening
      : creation.state === "creating"
        ? `Getting ${shownName} ready…`
        : firstRunTalkLabel(shownName),
  );
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="new-bot-takeover chat-shell"
  data-testid="first-run-takeover"
  data-step={step}
  style={`--new-bot-wallpaper: url("${newBotWallpaper(0)}")`}
  use:portal
>
  <div class="new-bot-takeover-shade" aria-hidden="true"></div>
  <header class="new-bot-takeover-header">
    <span class="new-bot-takeover-wordmark">HQ</span>
    <button
      type="button"
      class="new-bot-takeover-cancel"
      data-testid="first-run-continue-in-chat"
      disabled={leaving !== null}
      aria-busy={leaving === "chat" ? "true" : undefined}
      onclick={() => void leave("chat")}
    >{leaving === "chat" ? FIRST_RUN_COPY.opening : FIRST_RUN_COPY.continueInChat}</button>
  </header>
  {#if step === "context"}
    <!-- Bring in your context: a full-window scene instead of the card. -->
    <div
      bind:this={cardEl}
      class="first-run-import-host"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-bot-takeover-title"
      tabindex="-1"
    >
      <div class="first-run-import-step" data-testid="first-run-step" data-step={step} role="group">
        {#if importClock}
          <LazyDoor
            door={firstRunImportDoor}
            props={{
              name: shownName,
              stepNumber: firstRunStepNumber("context", shownSteps),
              total,
              run: importRun,
              clock: importClock,
              nextLabel: firstRunNextLabel("context", shownSteps),
              offersFinish: firstRunOffersFinish("context", shownSteps),
              finishLabel: FIRST_RUN_COPY.finish,
              leaving: leaving !== null,
              onback: () => goTo(prevFirstRunStep("context", shownSteps)),
              onstart: () => importRunner.start(),
              onskip: () => {
                importRunner.skip();
                goTo(nextFirstRunStep("context", shownSteps));
              },
              onretry: () => importRunner.retry(),
              onrecheck: () => importRunner.recheck(),
              onnext: () => goTo(nextFirstRunStep("context", shownSteps)),
              onfinish: () => goTo(firstRunFinishTarget(runtimeReady, shownSteps)),
              reducedMotion,
              onannounce: (text: string) => (importAnnouncement = text),
            }}
          >
            {#snippet skeleton()}
              <div class="first-run-import-loading" data-testid="first-run-import-loading" aria-hidden="true"></div>
            {/snippet}
          </LazyDoor>
        {/if}
      </div>
    </div>
  {:else}
  <main class="new-bot-takeover-stage">
    <div
      bind:this={cardEl}
      class="new-bot-takeover-card new-bot-takeover-card--flow new-bot-takeover-card--steps"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-bot-takeover-title"
      tabindex="-1"
    >
      <div class="new-bot-create" data-testid="first-run-step" data-step={step} role="group">
        {#if step === "name"}
          <NewBotNameStep
            name={creation.state === "idle" ? name : creation.name}
            {total}
            current={firstRunStepNumber("name", shownSteps)}
            title={FIRST_RUN_NAME_TITLE}
            issueFor={assistantNameIssue}
            showHandle={false}
            nextLabel={firstRunNextLabel("name", shownSteps)}
            onfinish={firstRunOffersFinish("name", shownSteps) ? (next) => confirmName(next, true) : null}
            note={nameLocked ? FIRST_RUN_COPY.nameLocked : ""}
            locked={nameLocked}
            oninput={(next) => { if (!nameLocked) name = next; }}
            oncontinue={(next) => confirmName(next, false)}
          />
        {:else}
          {@const title = step === "tools" ? toolsTitle : doneTitle}
          {@const isLast = nextFirstRunStep(step, shownSteps) === null}
          {@const canLeave = firstRunCanLeave(step, runtimeReady)}
          <NewBotStepHead
            {total}
            current={firstRunStepNumber(step, shownSteps)}
            onback={() => goTo(prevFirstRunStep(step, shownSteps))}
            backTestId="first-run-back"
            backDisabled={leaving !== null}
            kicker={title.kicker}
            lead={title.lead}
            em={title.em}
          />
          <section class="new-bot-step new-bot-step--fit" data-testid={`first-run-${step}`}>
            <p class="new-bot-create-copy">{title.copy}</p>
            {#if step === "tools"}
              <HomeStep
                runtimeOnly
                {draft}
                canLocal={true}
                canCloud={false}
                runtimeReady={runtimeReady}
                {runtimeStatus}
                companies={[]}
                onpatch={patchDraft}
                {signInApi}
                onsignedin={onsignedin ?? undefined}
                onrecheck={onrecheck ?? undefined}
                {pollMs}
                {aiTools}
                {hqFolderPath}
                {onopenassistant}
                {onassistedinstall}
                {onrequestaitools}
              />
            {:else if step === "done"}
              <ul class="first-run-summary" data-testid="first-run-summary">
                <li>
                  <span class="first-run-summary-orb" aria-hidden="true"><NewBotOrbIcon kind="local" size={34} /></span>
                  <span class="first-run-summary-text">
                    <span class="first-run-summary-label">Your HQ assistant</span>
                    <span class="first-run-summary-value" data-testid="first-run-summary-name">{shownName}</span>
                  </span>
                </li>
                <li>
                  <span class="first-run-summary-dot" class:ready={!!botRuntime} aria-hidden="true"></span>
                  <span class="first-run-summary-text">
                    <span class="first-run-summary-label">Coding tool</span>
                    <span class="first-run-summary-value" data-testid="first-run-summary-tool">
                      {botRuntime ? `${runtimeLabel(botRuntime)}, signed in` : "None signed in yet"}
                    </span>
                  </span>
                </li>
              </ul>
            {/if}
          </section>

          <footer class="new-bot-create-foot">
            <!-- Creating the assistant runs behind the screens: one quiet line. -->
            {#if creation.state === "failed"}
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="failed">
                {creation.reason}
                <button type="button" class="new-bot-inline-link" data-testid="first-run-retry" onclick={onretry}>{FIRST_RUN_COPY.retry}</button>
                <span aria-hidden="true">·</span>
                <button type="button" class="new-bot-inline-link" data-testid="first-run-failed-chat" disabled={leaving !== null} onclick={() => void leave("chat")}>{FIRST_RUN_COPY.continueInChat}</button>
              </p>
            {:else if creation.state === "creating" && !isLast}
              <!-- On Done the held button already says it. -->
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="creating">Getting {shownName} ready…</p>
            {:else if creation.state === "ready" && step !== "done"}
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="ready">{shownName} is ready.</p>
            {:else if creation.state === "idle" && !ready}
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="waiting">{shownName} starts as soon as a coding tool is signed in.</p>
            {/if}
            {#if isLast}
              <div class="new-bot-foot-actions single">
                <button
                  type="button"
                  class="new-bot-create-submit"
                  data-testid="first-run-talk"
                  disabled={creation.state !== "ready" || leaving !== null}
                  aria-busy={creation.state === "creating" || leaving === "talk" ? "true" : undefined}
                  onclick={() => void leave("talk")}
                >{talkLabel}</button>
              </div>
            {:else}
              {@const offersFinish = firstRunOffersFinish(step, shownSteps)}
              <div class="new-bot-foot-actions" class:single={!offersFinish}>
                <button
                  type="button"
                  class={offersFinish ? "new-bot-create-next" : "new-bot-create-submit"}
                  data-testid="first-run-next"
                  disabled={!canLeave}
                  onclick={() => goTo(nextFirstRunStep(step, shownSteps))}
                >{firstRunNextLabel(step, shownSteps)}<RailIcon name="arrow-right" /></button>
                {#if offersFinish}
                  <button
                    type="button"
                    class="new-bot-create-submit"
                    data-testid="first-run-finish"
                    disabled={!canLeave}
                    onclick={() => goTo(firstRunFinishTarget(runtimeReady, shownSteps))}
                  >{FIRST_RUN_COPY.finish}</button>
                {/if}
              </div>
            {/if}
          </footer>
        {/if}
      </div>
    </div>
  </main>
  {/if}
  <!-- The one live region: always here, only its text changes. -->
  <p class="first-run-live" data-testid="first-run-live" aria-live="polite" aria-atomic="true">{announcement}</p>
</div>

<style>
  /* Bring in your context fills the window under the header. */
  .first-run-import-host,
  .first-run-import-step,
  .first-run-import-loading {
    position: absolute;
    inset: 0;
  }
  .first-run-import-host {
    z-index: 0;
    outline: none;
  }
  .first-run-import-loading {
    background: rgba(0, 0, 0, 0.72);
  }
  .new-bot-takeover[data-step="context"] .new-bot-takeover-header {
    position: relative;
    z-index: 3;
  }
  .first-run-summary {
    display: grid;
    gap: 10px;
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
  }
  .first-run-summary li {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 58px;
    border: 1px solid var(--new-bot-line);
    border-radius: 12px;
    padding: 10px 14px;
    background: rgba(9, 9, 11, 0.36);
  }
  .first-run-summary-orb {
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    width: 34px;
    height: 34px;
  }
  .first-run-summary-dot {
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    margin: 0 12px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.3);
  }
  .first-run-summary-dot.ready {
    background: #4ade80;
    box-shadow: 0 0 10px rgba(74, 222, 128, 0.55);
  }
  .first-run-summary-text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .first-run-summary-label {
    color: var(--new-bot-muted);
    font-size: 12px;
  }
  .first-run-summary-value {
    overflow: hidden;
    font-size: 15px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .first-run-status {
    margin: 0;
  }
  /* Read by screen readers only; the visible line says the same. */
  .first-run-live {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
