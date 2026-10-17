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
    firstRunOpeningLabel,
    FIRST_RUN_DECISION_COPY as COPY,
    assistantNameIssue,
    decisionToolFor,
    normalizeAssistantName,
    runtimeLabel,
    toolSessionCount,
    type FirstRunCreation,
    type FirstRunFlowScreen,
    type FirstRunImportHandoff,
    type FirstRunRuntime,
    type FirstRunToolUsage,
  } from "./visual-first-run.js";
  import { createScreenTimer, formatSignIn, writeFirstRunLine, type FirstRunTimingSink, type SignInEvent } from "./first-run-timing.js";
  import { FIRST_RUN_SIGNIN_COPY, type FirstRunSignInHost } from "./first-run-signin.js";
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
    /**
     * "Continue in <tool>": land on the welcome report. HQ Anywhere is
     * installed only when `enableHqAnywhere` is true. The tool stays closed
     * until Open. A returned sentence is shown here and the takeover stays up.
     */
    oncontinueintool: (
      runtime: FirstRunRuntime,
      choice: { enableHqAnywhere: boolean },
    ) => string | null | void | Promise<string | null | void>;
    /** Skip tool sign-in: keep the welcome report held, without opening the tool. */
    onskipintool?: (runtime: FirstRunRuntime) => void | Promise<void>;
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
    /**
     * Signs the detected coding tool in before "Continue in <tool>" and the
     * name path go on. Null: neither waits on a sign-in.
     */
    signin?: FirstRunSignInHost | null;
    /**
     * The hq-anywhere-runtime kill switch. Null while it is still being read.
     * Continue waits, and does not show the callout or start the handoff,
     * until this resolves.
     */
    hqAnywhereFlag?: boolean | null;
    /** An installer exists. False hides the callout, the same as the real install. */
    canInstallHq?: boolean;
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
    onskipintool = () => oncontinueinchat(),
    onimport = null,
    reducedMotion = null,
    initialScreen = "decision",
    initialChoseBot = false,
    timingLog = null,
    signin = null,
    hqAnywhereFlag = null,
    canInstallHq = false,
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
  /**
   * The callout uses the same predicate as the install. Hidden at once for
   * Grok, no tool, or no installer, so Continue never opens this step.
   * Pending means the kill switch is still unread: Continue waits, with no
   * box and no "Setting up…", until it resolves.
   */
  const calloutPhase = $derived.by((): "hidden" | "pending" | "shown" => {
    if (!tool || tool === "grok" || !canInstallHq) return "hidden";
    if (hqAnywhereFlag === null) return "pending";
    return hqAnywhereFlag ? "shown" : "hidden";
  });
  /** Unset until the person presses Enable or Not now. Neither starts selected. */
  let anywhereChoice = $state<"unset" | "enable" | "later">("unset");
  /** The callout's own step, after Continue in Claude Code or Codex. */
  let anywhereStep = $state(false);
  /** Continue was pressed while the kill switch was still unread. */
  let waitingForAnywhereFlag = $state(false);
  $effect(() => {
    if (calloutPhase !== "hidden") return;
    if (anywhereChoice !== "unset") anywhereChoice = "unset";
    if (anywhereStep) anywhereStep = false;
  });
  const toolSessions = $derived(tool ? toolSessionCount(scanTools, tool) : null);
  let choseBot = $state(untrack(() => initialChoseBot));
  const showBot = $derived(choseBot || tool === null);

  let name = $state(untrack(() => initialName));
  let tried = $state(false);
  const issue = $derived(assistantNameIssue(name));
  let pressed = $state<"tool" | "name" | "talk" | "chat" | "retry" | null>(null);
  /** A sentence from Continue, shown on the takeover, or null. */
  let toolError = $state<string | null>(null);

  async function continueInTool(runtime: FirstRunRuntime): Promise<void> {
    toolError = null;
    try {
      const enableHqAnywhere = calloutPhase === "shown" && anywhereChoice === "enable";
      toolError = (await oncontinueintool(runtime, { enableHqAnywhere })) || null;
    } catch (error) {
      console.warn("[first-run] tool failed", error);
      toolError = `Could not open ${toolName}. Try again.`;
    }
  }

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

  /** Sign in, then continue. A failed handoff retries from here. Skip never installs. */
  function handoffChosenTool(runtime: FirstRunRuntime): void {
    void press("tool", async () => {
      const connected = toolError !== null || (await signInFirst(runtime));
      if (!live) return;
      if (connected) await continueInTool(runtime);
      else await onskipintool(runtime);
    });
  }

  /**
   * Continue on the question opens the callout when this press can install.
   * An unread flag waits, with no box and no "Setting up…". A hidden callout
   * goes straight on. Continue on the callout step is the handoff.
   */
  function continueInChosenTool(): void {
    if (!tool || pressed !== null || waitingForAnywhereFlag) return;
    if (anywhereStep) {
      handoffChosenTool(tool);
      return;
    }
    if (calloutPhase === "shown") {
      anywhereStep = true;
      return;
    }
    if (calloutPhase === "pending") {
      waitingForAnywhereFlag = true;
      return;
    }
    handoffChosenTool(tool);
  }

  $effect(() => {
    if (!waitingForAnywhereFlag || calloutPhase === "pending") return;
    const phase = calloutPhase;
    const runtime = tool;
    waitingForAnywhereFlag = false;
    if (!runtime) return;
    if (phase === "shown") {
      anywhereStep = true;
      return;
    }
    untrack(() => handoffChosenTool(runtime));
  });

  // ── the coding tool's sign-in (owner, 2026-10-16) ──────────────────────
  /** The sign-in on screen: waiting on the browser, or did not finish. */
  let signinView = $state<{ runtime: FirstRunRuntime; state: "waiting" | "failed" } | null>(null);
  /** Lets the action that asked for the sign-in go on (signed in or skipped). */
  let signinGoOn: ((connected: boolean) => void) | null = null;
  /** Bumped by Skip and by leaving: an older attempt's answer is dropped. */
  let signinAttempt = 0;
  let live = true;
  onDestroy(() => {
    live = false;
    // Leaving stops the browser sign-in and lets the waiting press() end;
    // the callers check `live` and do not go on.
    if (signinView?.state === "waiting") cancelSignIn(signinView.runtime);
    signinAttempt += 1;
    goOnAfterSignIn();
  });

  function logSignIn(event: SignInEvent, runtime: FirstRunRuntime): void {
    writeFirstRunLine(timingLog, formatSignIn(event, runtime));
  }

  /**
   * The one sign-in step before "Continue in <tool>" and the name path go
   * on. Resolves at once when `runtime` is signed in (or the host has no
   * sign-in); otherwise true after connecting, or false after Skip.
   * Never rejects.
   */
  async function signInFirst(runtime: FirstRunRuntime): Promise<boolean> {
    const host = signin;
    if (!host || installed?.[runtime] === true) return true;
    try {
      if (await host.signedIn(runtime)) return true;
    } catch (error) {
      console.warn("[first-run] sign-in check failed", error);
    }
    if (!live) return false;
    return new Promise<boolean>((resolve) => {
      signinGoOn = resolve;
      void attemptSignIn(runtime);
    });
  }

  async function attemptSignIn(runtime: FirstRunRuntime): Promise<void> {
    const host = signin;
    if (!host) return;
    const mine = ++signinAttempt;
    signinView = { runtime, state: "waiting" };
    logSignIn("start", runtime);
    let connected = false;
    try {
      connected = await host.run(runtime, { cancelled: () => mine !== signinAttempt });
    } catch (error) {
      console.warn("[first-run] sign-in failed", error);
    }
    if (mine !== signinAttempt) return;
    if (connected) {
      logSignIn("done", runtime);
      focusHq();
      goOnAfterSignIn(true);
    } else {
      logSignIn("failed", runtime);
      focusHq();
      signinView = { runtime, state: "failed" };
    }
  }

  /** The browser sign-in left the browser in front: bring HQ back. */
  function focusHq(): void {
    const focus = signin?.focus;
    if (!focus) return;
    void Promise.resolve()
      .then(() => focus())
      .catch((error: unknown) => console.warn("[first-run] focus after sign-in failed", error));
  }

  function goOnAfterSignIn(connected = false): void {
    signinView = null;
    const goOn = signinGoOn;
    signinGoOn = null;
    goOn?.(connected);
  }

  /** Stops the running browser sign-in; the host refreshes readiness if it had connected. */
  function cancelSignIn(runtime: FirstRunRuntime): void {
    const cancel = signin?.cancel;
    if (!cancel) return;
    void cancel(runtime).catch((error: unknown) => console.warn("[first-run] sign-in cancel failed", error));
  }

  /** Skip for now: go on without a sign-in; the welcome report waits on it as before. */
  function skipSignIn(): void {
    const view = signinView;
    if (!view) return;
    signinAttempt += 1;
    logSignIn("skipped", view.runtime);
    if (view.state === "waiting") cancelSignIn(view.runtime);
    focusHq();
    goOnAfterSignIn();
  }

  function retrySignIn(): void {
    if (signinView?.state === "failed") void attemptSignIn(signinView.runtime);
  }

  /**
   * The name path's sign-in, kept in this one function so it can be taken off
   * the name path alone: only a tool the scan or the stored logins found.
   */
  async function signInBeforeNaming(): Promise<void> {
    if (tool) await signInFirst(tool);
  }

  function confirmName(event: SubmitEvent): void {
    event.preventDefault();
    tried = true;
    if (issue || pressed !== null) return;
    const runtime = tool ?? SETUP_BOT_RUNTIME_ORDER[0];
    void press("name", async () => {
      await signInBeforeNaming();
      if (!live) return;
      onconfirmname(normalizeAssistantName(name), runtime);
      screen = "done";
    });
  }

  const shownName = $derived(
    creation.state === "idle" ? normalizeAssistantName(name) || initialName : creation.name,
  );

  const question = $derived(
    !answered || screen === "done" || anywhereStep ? "" : showBot ? COPY.botQuestion : COPY.toolQuestion,
  );
  const signinText = $derived(
    signinView === null
      ? ""
      : signinView.state === "waiting"
        ? FIRST_RUN_SIGNIN_COPY.waiting(runtimeLabel(signinView.runtime))
        : FIRST_RUN_SIGNIN_COPY.failed,
  );
  const liveText = $derived(
    signinText
      ? signinText
      : screen === "done" && creation.state === "failed"
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
    {#if signinView}
      <div class="fr-decision-head">
        {#if signinView.state === "waiting"}
          <p class="fr-decision-lead" data-testid="first-run-signin-waiting" aria-busy="true">{signinText}</p>
        {:else}
          <p class="fr-decision-lead fr-decision-failed" data-testid="first-run-signin-failed">{signinText}</p>
        {/if}
      </div>
      {#if signinView.state === "failed"}
        <div class="new-bot-foot-actions single">
          <button
            type="button"
            class="new-bot-create-submit"
            data-testid="first-run-signin-retry"
            onclick={retrySignIn}
          >{FIRST_RUN_COPY.retry}</button>
        </div>
      {/if}
      <p class="fr-skip-row">
        <button
          type="button"
          class="fr-link fr-skip"
          data-testid="first-run-signin-skip"
          onclick={skipSignIn}
        >{FIRST_RUN_SIGNIN_COPY.skip}</button>
      </p>
    {:else if !answered}
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
              : FIRST_RUN_COPY.openHq}</button>
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
    {:else if tool && anywhereStep}
      <div class="fr-decision-head">
        {#if toolError && pressed === null}
          <p class="fr-decision-lead fr-decision-failed" role="alert" data-testid="first-run-decision-error">{toolError}</p>
        {/if}
        <div
          class="fr-anywhere"
          id="first-run-anywhere-callout"
          data-testid="first-run-anywhere-slot"
          data-state={anywhereChoice}
        >
          {#if anywhereChoice === "unset"}
            <p class="fr-anywhere-title">{COPY.anywhereTitle}</p>
            <p class="fr-anywhere-body">{COPY.anywhereBody(toolName)}</p>
            <div class="fr-anywhere-actions">
              <button
                type="button"
                class="new-bot-create-next"
                data-testid="first-run-anywhere-enable"
                disabled={pressed !== null}
                onclick={() => (anywhereChoice = "enable")}
              >{COPY.anywhereEnable}</button>
              <button
                type="button"
                class="fr-anywhere-later"
                data-testid="first-run-anywhere-not-now"
                disabled={pressed !== null}
                onclick={() => (anywhereChoice = "later")}
              >{COPY.anywhereNotNow}</button>
            </div>
          {:else if anywhereChoice === "enable"}
            <p class="fr-anywhere-line" data-testid="first-run-anywhere-on">
              {COPY.anywhereOn}
              <button
                type="button"
                class="fr-anywhere-undo"
                data-testid="first-run-anywhere-undo"
                disabled={pressed !== null}
                onclick={() => (anywhereChoice = "unset")}
              >{COPY.anywhereUndo}</button>
            </p>
          {:else}
            <p class="fr-anywhere-line" data-testid="first-run-anywhere-off">{COPY.anywhereOff}</p>
          {/if}
        </div>
      </div>
      <div class="new-bot-foot-actions single">
        <button
          type="button"
          class="new-bot-create-submit"
          data-testid="first-run-decision-primary"
          disabled={pressed !== null}
          aria-busy={pressed === "tool" ? "true" : undefined}
          aria-describedby="first-run-anywhere-callout"
          onclick={continueInChosenTool}
        >{pressed === "tool"
          ? firstRunOpeningLabel(toolName)
          : toolError
            ? FIRST_RUN_COPY.retry
            : COPY.toolPrimary(toolName)}</button>
      </div>
    {:else if tool}
      <div class="fr-decision-head">
        <p class="fr-decision-q" data-testid="first-run-decision-question">{COPY.toolQuestion}</p>
        <p class="fr-decision-lead" data-testid="first-run-decision-lead">{COPY.toolLead(toolName, hostNoun, toolSessions)}</p>
        {#if toolError && pressed === null}
          <p class="fr-decision-lead fr-decision-failed" role="alert" data-testid="first-run-decision-error">{toolError}</p>
        {/if}
      </div>
      <!-- Two equal paths (owner, 2026-10-15): the tool, or naming the assistant. -->
      <div class="new-bot-foot-actions">
        <button
          type="button"
          class="new-bot-create-submit"
          data-testid="first-run-decision-primary"
          disabled={pressed !== null || waitingForAnywhereFlag}
          aria-busy={pressed === "tool" ? "true" : undefined}
          onclick={continueInChosenTool}
        >{pressed === "tool"
          ? firstRunOpeningLabel(toolName)
          : toolError
            ? FIRST_RUN_COPY.retry
            : COPY.toolPrimary(toolName)}</button>
        <button
          type="button"
          class="new-bot-create-submit"
          data-testid="first-run-decision-other"
          disabled={pressed !== null || waitingForAnywhereFlag}
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
  /* Raised card above Continue, inside the head so it grows upward and
     Continue stays on the ground line. The opaque surface token follows
     the app theme; the translucent raised token disappears on this wallpaper. */
  .fr-anywhere {
    --raised: var(--v4-surface-solid);
    --line: var(--v4-hairline);
    --t1: var(--v4-text-1);
    --t2: var(--v4-text-2);
    margin: 12px 0 0;
    padding: 14px 16px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--raised);
    color: var(--t1);
  }
  .fr-anywhere-title {
    margin: 0;
    font-size: 15px;
    font-weight: 500;
    line-height: 20px;
  }
  .fr-anywhere-body,
  .fr-anywhere-line {
    margin: 6px 0 0;
    color: var(--t2);
    font-size: 13px;
    font-weight: 400;
    line-height: 18px;
  }
  .fr-anywhere-line {
    margin: 0;
  }
  .fr-anywhere-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }
  .fr-anywhere-actions .new-bot-create-next {
    padding: 8px 14px;
    border-color: var(--line);
    color: var(--t1);
  }
  .fr-anywhere-actions .new-bot-create-next:hover:not(:disabled) {
    background: var(--v4-raised);
  }
  .fr-anywhere-actions .new-bot-create-next:focus-visible {
    outline-color: var(--t1);
  }
  .fr-anywhere-later,
  .fr-anywhere-undo {
    border: 0;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    cursor: pointer;
  }
  .fr-anywhere-undo {
    margin-left: 8px;
    color: var(--t1);
    text-decoration: underline;
  }
  .fr-anywhere-later:disabled,
  .fr-anywhere-undo:disabled {
    opacity: 0.5;
    cursor: default;
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
