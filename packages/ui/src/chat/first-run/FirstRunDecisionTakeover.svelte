<script lang="ts">
  /**
   * The first run after the blocking install (US-007). The knowledge tree
   * fills in from this computer at once, with no question up front, then one
   * question with two equal answers: continue in the coding tool used most
   * here, or name the assistant. A person with no coding tool is offered only
   * the assistant.
   *
   * It replaces the step-through takeover's company, Bring it in, Coding tools
   * and separate name screens. Each screen has one primary action. Sign-in
   * state is read from the host's stored readiness, never a model turn
   * (policy `indigo-onboarding-setup-steps-stay-deterministic`).
   *
   * The host owns the create (`creation`, `onconfirmname`, `onretry`) and
   * where "Continue in <tool>" goes (`oncontinueintool`).
   */
  import { onDestroy, onMount, untrack } from "svelte";
  import LazyDoor from "../../shell/LazyDoor.svelte";
  import { firstRunImportDoor } from "../../shell/lazy-doors.js";
  import {
    createImportRunner,
    importResultOf,
    type ImportRunView,
    type ImportScanHost,
  } from "./knowledge-tree/import-runner.js";
  import { createSceneClock } from "./knowledge-tree/scene-clock.js";
  import { hostComputerNoun, subscribeHostComputerNoun } from "@hq/platform";
  import { portal } from "../portal.js";
  import { newBotWallpaper } from "../create-bot/new-bot-wallpapers.js";
  import { SETUP_BOT_RUNTIME_ORDER } from "../setup-bot.js";
  import {
    FIRST_RUN_COPY,
    FIRST_RUN_DECISION_COPY as COPY,
    assistantNameIssue,
    decisionToolFor,
    firstRunTalkLabel,
    normalizeAssistantName,
    runtimeLabel,
    type FirstRunCreation,
    type FirstRunFlowScreen,
    type FirstRunImportHandoff,
    type FirstRunRuntime,
    type FirstRunToolUsage,
  } from "./visual-first-run.js";
  import { createScreenTimer, type FirstRunTimingSink } from "./first-run-timing.js";
  import "../create-bot/new-bot-takeover.css";

  interface Props {
    /** The suggested bot name the name field opens with. */
    initialName: string;
    /** Runs the context scan on this computer. Null: the question shows at once. */
    importHost?: ImportScanHost | null;
    /** Per-tool session counts from the same scan, once it reports them. */
    scanTools?: readonly FirstRunToolUsage[] | null;
    /** The coding tools installed and signed in here (stored readiness). */
    installed?: Record<string, boolean> | null;
    /** Where creating the bot stands (the host runs it). */
    creation: FirstRunCreation;
    /** The name is confirmed: the host starts creating the bot. */
    onconfirmname: (name: string, runtime: FirstRunRuntime) => void;
    onretry: () => void;
    /** Done: open the bot's chat. */
    ontalk: () => void | Promise<void>;
    /** "Continue in <tool>": open HQ in that coding tool. */
    oncontinueintool: (runtime: FirstRunRuntime) => void | Promise<void>;
    /** Done without a signed-in tool: the setup chat takes it from there. */
    oncontinueinchat: () => void | Promise<void>;
    /** The scan finished: its counts and report path, for the handoff. */
    onimport?: ((result: FirstRunImportHandoff) => void) | null;
    /** Test seam: null follows prefers-reduced-motion. */
    reducedMotion?: boolean | null;
    /** Test and harness seam: open on this screen. */
    initialScreen?: FirstRunFlowScreen;
    /** Test and harness seam: open on the bot path. */
    initialChoseBot?: boolean;
    /** Receives the `kind=screen surface=takeover` timing lines. */
    timingLog?: FirstRunTimingSink | null;
  }

  let {
    initialName,
    importHost = null,
    scanTools = null,
    installed = null,
    creation,
    onconfirmname,
    onretry,
    ontalk,
    oncontinueintool,
    oncontinueinchat,
    onimport = null,
    reducedMotion = null,
    initialScreen = "decision",
    initialChoseBot = false,
    timingLog = null,
  }: Props = $props();

  let hostNoun = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((noun) => (hostNoun = noun)));

  let screen = $state<FirstRunFlowScreen>(untrack(() => initialScreen));
  /** One enter and one leave timing line per screen shown. Instrumentation only. */
  const screenTimer = createScreenTimer("takeover", (message) => timingLog?.(message));
  $effect(() => {
    const shown = screen;
    untrack(() => screenTimer.show(shown));
  });

  // ── the tree ───────────────────────────────────────────────────────────
  const clock = createSceneClock();
  let run = $state.raw<ImportRunView>({ phase: "idle", scanStart: null, events: [], failure: null });
  let reported = false;
  const importRunner = createImportRunner(
    untrack(() => importHost),
    () => clock.now(),
    (view) => {
      run = view;
      if (view.phase === "done" && !reported) {
        reported = true;
        const result = importResultOf(view.events);
        if (result) onimport?.(result);
      }
    },
  );
  let announcement = $state("");

  /** How often a failed load of the scene is tried again. */
  const IMPORT_DOOR_RETRY_MS = 5000;
  let importDoorFailed = $state(false);
  /** Bumped when the scene loads after a failed load, so it mounts. */
  let importDoorKey = $state(0);
  let doorLive = true;
  let doorTimer: ReturnType<typeof setTimeout> | null = null;
  function loadDoor(): void {
    if (firstRunImportDoor.peek()) return;
    firstRunImportDoor.load().then(
      () => {
        if (!doorLive || !importDoorFailed) return;
        importDoorFailed = false;
        importDoorKey += 1;
      },
      (error: unknown) => {
        console.warn("[first-run] the context scene did not load; trying again", error);
        if (!doorLive) return;
        importDoorFailed = true;
        doorTimer = setTimeout(loadDoor, IMPORT_DOOR_RETRY_MS);
      },
    );
  }

  onMount(() => {
    loadDoor();
    // Detect and offer: the scan starts with no question first.
    if (untrack(() => importHost)) untrack(() => importRunner.start());
  });
  onDestroy(() => {
    doorLive = false;
    if (doorTimer) clearTimeout(doorTimer);
    screenTimer.close();
    importRunner.dispose();
    clock.dispose();
  });

  // ── the question ───────────────────────────────────────────────────────
  /** The question waits for the tree, so the person sees what HQ found first. */
  const answered = $derived(
    importHost === null || run.phase === "done" || run.phase === "failed" || run.phase === "skipped",
  );
  const tool = $derived(decisionToolFor(scanTools, installed));
  const toolName = $derived(tool ? runtimeLabel(tool) : "");
  let choseBot = $state(untrack(() => initialChoseBot));
  const showBot = $derived(choseBot || tool === null);

  let name = $state(untrack(() => initialName));
  let tried = $state(false);
  const issue = $derived(assistantNameIssue(name));
  let pressed = $state<"tool" | "name" | "talk" | "chat" | "retry" | null>(null);

  async function press(kind: NonNullable<typeof pressed>, action: () => void | Promise<void>): Promise<void> {
    if (pressed !== null) return;
    pressed = kind;
    try {
      await action();
    } catch (error) {
      console.warn(`[first-run] ${kind} failed`, error);
    } finally {
      pressed = null;
    }
  }

  function confirmName(event: SubmitEvent): void {
    event.preventDefault();
    tried = true;
    if (issue || pressed !== null) return;
    const runtime = tool ?? SETUP_BOT_RUNTIME_ORDER[0];
    void press("name", () => {
      onconfirmname(normalizeAssistantName(name), runtime);
      screen = "done";
    });
  }

  const shownName = $derived(
    creation.state === "idle" ? normalizeAssistantName(name) || initialName : creation.name,
  );

  const question = $derived(
    !answered ? "" : screen === "done" ? "" : showBot ? COPY.botQuestion : COPY.toolQuestion,
  );
  const liveText = $derived(
    screen === "done" && creation.state === "failed"
      ? creation.reason
      : [announcement, question].filter(Boolean).join(" "),
  );

  function onKeydown(event: KeyboardEvent): void {
    // Escape does not leave a first run by accident.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet decision()}
  <div class="fr-decision" data-testid="first-run-decision" data-screen={screen} data-path={showBot ? "bot" : "tool"}>
    {#if !answered}
      <p class="fr-decision-wait" data-testid="first-run-decision-scanning">{COPY.scanning}</p>
    {:else if screen === "done"}
      {#if creation.state === "failed"}
        <div class="fr-decision-head">
          <p class="fr-decision-lead fr-decision-failed" data-testid="first-run-done-failed">{creation.reason}</p>
        </div>
        <div class="new-bot-foot-actions single">
          <button
            type="button"
            class="new-bot-create-submit"
            data-testid="first-run-done-retry"
            disabled={pressed !== null}
            aria-busy={pressed === "retry" ? "true" : undefined}
            onclick={() => void press("retry", onretry)}
          >{pressed === "retry" ? FIRST_RUN_COPY.retrying : FIRST_RUN_COPY.retry}</button>
        </div>
      {:else if creation.state === "idle"}
        <div class="new-bot-foot-actions single">
          <button
            type="button"
            class="new-bot-create-submit"
            data-testid="first-run-done-continue"
            disabled={pressed !== null}
            aria-busy={pressed === "chat" ? "true" : undefined}
            onclick={() => void press("chat", oncontinueinchat)}
          >{pressed === "chat" ? FIRST_RUN_COPY.opening : COPY.botPrimary}</button>
        </div>
      {:else}
        <div class="new-bot-foot-actions single">
          <button
            type="button"
            class="new-bot-create-submit"
            data-testid="first-run-talk"
            disabled={creation.state === "creating" || pressed !== null}
            aria-busy={creation.state === "creating" || pressed === "talk" ? "true" : undefined}
            onclick={() => void press("talk", ontalk)}
          >{pressed === "talk"
            ? FIRST_RUN_COPY.opening
            : creation.state === "creating"
              ? `Getting ${shownName} ready…`
              : firstRunTalkLabel(shownName)}</button>
        </div>
      {/if}
    {:else if showBot}
      <form id="first-run-bot-form" class="fr-decision-head" novalidate onsubmit={confirmName}>
        <p class="fr-decision-q" data-testid="first-run-decision-question">{COPY.botQuestion}</p>
        <p class="fr-decision-lead">{COPY.botLead}</p>
        <label class="new-bot-create-label" for="first-run-bot-name">Name</label>
        <input
          id="first-run-bot-name"
          class="new-bot-create-input"
          data-testid="first-run-bot-name"
          type="text"
          autocomplete="off"
          spellcheck="false"
          bind:value={name}
          aria-invalid={tried && issue ? "true" : undefined}
          aria-describedby={tried && issue ? "first-run-bot-name-issue" : undefined}
        />
        {#if tried && issue}
          <p id="first-run-bot-name-issue" class="new-bot-create-error" role="alert">{issue}</p>
        {/if}
      </form>
      <div class="new-bot-foot-actions single">
        <button
          type="submit"
          form="first-run-bot-form"
          class="new-bot-create-submit"
          data-testid="first-run-decision-primary"
          disabled={pressed !== null}
          aria-busy={pressed === "name" ? "true" : undefined}
        >{COPY.botPrimary}</button>
      </div>
      {#if tool}
        <p class="fr-skip-row">
          <button
            type="button"
            class="fr-link fr-skip"
            data-testid="first-run-decision-other"
            disabled={pressed !== null}
            onclick={() => (choseBot = false)}
          >{COPY.backToTool(toolName)}</button>
        </p>
      {/if}
    {:else if tool}
      <div class="fr-decision-head">
        <p class="fr-decision-q" data-testid="first-run-decision-question">{COPY.toolQuestion}</p>
        <p class="fr-decision-lead" data-testid="first-run-decision-lead">{COPY.toolLead(toolName, hostNoun)}</p>
      </div>
      <!-- Two equal paths (owner, 2026-10-15): the tool, or naming the assistant. -->
      <div class="new-bot-foot-actions">
        <button
          type="button"
          class="new-bot-create-submit"
          data-testid="first-run-decision-primary"
          disabled={pressed !== null}
          aria-busy={pressed === "tool" ? "true" : undefined}
          onclick={() => void press("tool", () => oncontinueintool(tool))}
        >{pressed === "tool" ? FIRST_RUN_COPY.opening : COPY.toolPrimary(toolName)}</button>
        <button
          type="button"
          class="new-bot-create-submit"
          data-testid="first-run-decision-other"
          disabled={pressed !== null}
          onclick={() => (choseBot = true)}
        >{COPY.toolOther}</button>
      </div>
    {/if}
  </div>
{/snippet}

<div
  class="new-bot-takeover chat-shell"
  data-testid="first-run-takeover"
  data-step={screen}
  style={`--new-bot-wallpaper: url("${newBotWallpaper(0)}")`}
  use:portal
>
  <div class="new-bot-takeover-shade" aria-hidden="true"></div>
  <header class="new-bot-takeover-header">
    <span class="new-bot-takeover-wordmark">HQ</span>
  </header>
  <div
    class="first-run-import-host"
    role="dialog"
    aria-modal="true"
    aria-labelledby="new-bot-takeover-title"
    tabindex="-1"
  >
    <div class="first-run-import-step" data-testid="first-run-step" data-step={screen} role="group">
      {#key importDoorKey}
        <LazyDoor
          door={firstRunImportDoor}
          props={{
            name: "HQ",
            stepNumber: 1,
            total: 0,
            run,
            clock,
            nextLabel: "",
            offersFinish: false,
            onstart: () => importRunner.start(),
            onskip: () => importRunner.skip(),
            onretry: () => importRunner.retry(),
            onrecheck: () => importRunner.recheck(),
            onnext: () => {},
            onfinish: () => {},
            reducedMotion,
            onannounce: (text: string) => (announcement = text),
            actions: decision,
          }}
        >
          {#snippet skeleton()}
            <div class="first-run-import-loading" data-testid="first-run-import-loading" aria-hidden="true"></div>
          {/snippet}
        </LazyDoor>
      {/key}
    </div>
  </div>
  <p class="first-run-live" data-testid="first-run-live" aria-live="polite" aria-atomic="true">{liveText}</p>
</div>

<style>
  /* The tree fills the window under the header. */
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
  .new-bot-takeover-header {
    position: relative;
    z-index: 3;
  }
  /* The footer sits just above the ground line: the primary button stays
     there, and the question above it grows upward. */
  .fr-decision {
    position: relative;
  }
  .fr-decision-head {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    display: flex;
    flex-direction: column;
    padding-bottom: 16px;
  }
  .fr-decision-q {
    margin: 0;
    color: #fff;
    font-size: 17px;
    font-weight: 500;
    line-height: 24px;
  }
  .fr-decision-lead,
  .fr-decision-wait {
    margin: 6px 0 0;
    color: rgba(255, 255, 255, 0.62);
    font-size: 13px;
    line-height: 19px;
  }
  .fr-decision-wait {
    margin: 0;
  }
  .fr-decision-failed {
    color: rgba(255, 220, 210, 0.86);
  }
  .fr-decision-head .new-bot-create-label {
    margin-top: 16px;
  }
  .fr-decision .new-bot-foot-actions {
    margin: 0;
  }
  /* Read by screen readers only; the visible lines say the same. */
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
