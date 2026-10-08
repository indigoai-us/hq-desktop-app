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
   */
  import { onMount, untrack } from "svelte";
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
    firstRunTalkLabel,
    firstRunToolsTitle,
    nextFirstRunStep,
    prevFirstRunStep,
    runtimeLabel,
    type FirstRunCreation,
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
  }: Props = $props();

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

  const total = $derived(steps.length);
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

  function goTo(next: FirstRunStepId | null): void {
    if (next) step = next;
  }

  function confirmName(next: string, finish: boolean): void {
    if (!nameLocked) {
      name = next;
      onconfirmname(next, draft.runtime);
    }
    goTo(finish ? firstRunFinishTarget(runtimeReady, steps) : nextFirstRunStep("name", steps));
  }

  function patchDraft(patch: Partial<CreateBotDraft>): void {
    draft = { ...draft, ...patch };
    if (patch.runtime) onruntime?.(patch.runtime);
  }

  async function leave(kind: "talk" | "chat"): Promise<void> {
    if (leaving) return;
    leaving = kind;
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
  <main class="new-bot-takeover-stage">
    <div
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
            current={firstRunStepNumber("name", steps)}
            title={FIRST_RUN_NAME_TITLE}
            issueFor={assistantNameIssue}
            showHandle={false}
            nextLabel={firstRunNextLabel("name", steps)}
            onfinish={firstRunOffersFinish("name", steps) ? (next) => confirmName(next, true) : null}
            note={nameLocked ? FIRST_RUN_COPY.nameLocked : ""}
            locked={nameLocked}
            oninput={(next) => { if (!nameLocked) name = next; }}
            oncontinue={(next) => confirmName(next, false)}
          />
        {:else}
          {@const title = step === "tools" ? toolsTitle : doneTitle}
          {@const isLast = nextFirstRunStep(step, steps) === null}
          {@const canLeave = firstRunCanLeave(step, runtimeReady)}
          <NewBotStepHead
            {total}
            current={firstRunStepNumber(step, steps)}
            onback={() => goTo(prevFirstRunStep(step, steps))}
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
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="failed" aria-live="polite">
                {creation.reason}
                <button type="button" class="new-bot-inline-link" data-testid="first-run-retry" onclick={onretry}>{FIRST_RUN_COPY.retry}</button>
                <span aria-hidden="true">·</span>
                <button type="button" class="new-bot-inline-link" data-testid="first-run-failed-chat" disabled={leaving !== null} onclick={() => void leave("chat")}>{FIRST_RUN_COPY.continueInChat}</button>
              </p>
            {:else if creation.state === "creating" && !isLast}
              <!-- On Done the held button already says it. -->
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="creating" aria-live="polite">Getting {shownName} ready…</p>
            {:else if creation.state === "ready" && step !== "done"}
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="ready" aria-live="polite">{shownName} is ready.</p>
            {:else if creation.state === "idle" && !ready}
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="waiting" aria-live="polite">{shownName} starts as soon as a coding tool is signed in.</p>
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
              {@const offersFinish = firstRunOffersFinish(step, steps)}
              <div class="new-bot-foot-actions" class:single={!offersFinish}>
                <button
                  type="button"
                  class={offersFinish ? "new-bot-create-next" : "new-bot-create-submit"}
                  data-testid="first-run-next"
                  disabled={!canLeave}
                  onclick={() => goTo(nextFirstRunStep(step, steps))}
                >{firstRunNextLabel(step, steps)}<RailIcon name="arrow-right" /></button>
                {#if offersFinish}
                  <button
                    type="button"
                    class="new-bot-create-submit"
                    data-testid="first-run-finish"
                    disabled={!canLeave}
                    onclick={() => goTo(firstRunFinishTarget(runtimeReady, steps))}
                  >{FIRST_RUN_COPY.finish}</button>
                {/if}
              </div>
            {/if}
          </footer>
        {/if}
      </div>
    </div>
  </main>
</div>

<style>
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
</style>
