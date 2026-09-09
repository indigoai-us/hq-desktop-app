<script lang="ts">
  /**
   * SetupRunCard — the live setup run inside the #welcome hero.
   *
   * One card, four steps (Tools · HQ Cloud · About you · Your first moves),
   * one plain status sentence, and at most one question at a time. It never
   * shows a command, a tool name, or a transcript; "Show details" opens the
   * underlying session on the Sessions page for anyone who wants the raw
   * view. Presentational only: the state comes from `interpretSetupRun`, the
   * answers go back up through callbacks (the intro owns the host API).
   *
   * Lives on the wallpaper, so colours are image-relative (white on dark)
   * exactly like the hero's `.launch-btn` / `.quiet-btn`.
   */
  import {
    SETUP_RUN_DONE,
    SETUP_RUN_PERMISSION,
    SETUP_RUN_STEPS,
    SETUP_RUN_STOPPED,
    setupRunContinueLabel,
    type SetupCard,
    type SetupRunPermissionDecision,
    type SetupRunState,
    type SetupSecretCard,
  } from "./setup-run";

  /** Which face the card shows. `live` reads the rest from `state`. */
  /** `done` is the remembered outcome after a finished run (no live session). */
  export type SetupRunCardMode = "live" | "resume" | "stopped" | "done";

  /**
   * `panel`: stepper + question (the original card). `steps`: stepper only,
   * for the hero. `prompt`: the question / cards / actions only, for the
   * channel's reply area while the Setup Agent talks in the chat.
   */
  export type SetupRunCardVariant = "panel" | "steps" | "prompt";

  interface Props {
    mode: SetupRunCardMode;
    variant?: SetupRunCardVariant;
    /** Interpreted session state; required for `live`. */
    run?: SetupRunState | null;
    /** Last known step for the `resume` face (before re-attaching). */
    resumeStep?: number;
    /** An answer / attach is in flight: controls disable, no double sends. */
    busy?: boolean;
    /** A host error, shown in the card in plain words. */
    error?: string | null;
    onanswer?: (requestId: string, questionId: string, values: string[]) => void;
    onpermission?: (requestId: string, decision: SetupRunPermissionDecision) => void;
    onsend?: (text: string) => void;
    onshowdetails?: () => void;
    oncontinue?: () => void;
    onrunagain?: () => void;
    /**
     * Store a credential from the secret card into the vault. Resolves when
     * stored; rejects with a plain message otherwise. Without it the secret
     * card is not offered and the plain question shows.
     */
    onstoresecret?: (card: SetupSecretCard, value: string) => Promise<void> | void;
  }

  let {
    mode,
    variant = "panel",
    run = null,
    resumeStep = 0,
    busy = false,
    error = null,
    onanswer,
    onpermission,
    onsend,
    onshowdetails,
    oncontinue,
    onrunagain,
    onstoresecret,
  }: Props = $props();

  /** The guided component paired with the open question, when the host can serve it. */
  const card = $derived.by((): SetupCard | null => {
    if (!question || question.kind !== "choice") return null;
    const next = run?.card ?? null;
    if (!next) return null;
    if (next.kind === "secret" && !onstoresecret) return null;
    return next;
  });

  const done = $derived(mode === "done" || (mode === "live" && Boolean(run?.done)));
  const stopped = $derived(mode === "stopped" || (mode === "live" && Boolean(run?.ended)));
  const question = $derived(mode === "live" && !done && !stopped ? (run?.question ?? null) : null);
  const currentStep = $derived(mode === "resume" ? resumeStep : (run?.step ?? 0));

  function statusOf(index: number): "pending" | "running" | "done" {
    if (mode === "resume") {
      return index < resumeStep ? "done" : index === resumeStep ? "running" : "pending";
    }
    const id = SETUP_RUN_STEPS[index]!.id;
    return run?.stepStatuses[id] ?? "pending";
  }

  let answerText = $state("");
  /** Multi-select choice questions collect labels before Send. */
  let picked = $state<string[]>([]);

  // A new question starts with an empty field / selection.
  $effect(() => {
    void question?.text;
    answerText = "";
    picked = [];
  });

  function choose(label: string): void {
    if (busy || !question || question.kind !== "choice") return;
    if (question.multiSelect) {
      picked = picked.includes(label) ? picked.filter((entry) => entry !== label) : [...picked, label];
      return;
    }
    onanswer?.(question.requestId, question.questionId, [label]);
  }

  function sendPicked(): void {
    if (busy || !question || question.kind !== "choice" || picked.length === 0) return;
    onanswer?.(question.requestId, question.questionId, picked);
  }

  // --- secret card -----------------------------------------------------------
  let secretValue = $state("");
  let secretBusy = $state(false);
  let secretError = $state<string | null>(null);
  $effect(() => {
    void question?.text;
    secretValue = "";
    secretError = null;
  });

  /** The option that means "it's in the vault", by label, else a literal Done. */
  function doneLabel(): string {
    if (!question || question.kind !== "choice") return "Done";
    const hit = question.options.find((option) => /^(done|stored|saved|connected)$/i.test(option.label.trim()));
    return hit?.label ?? "Done";
  }

  /** Options the card does not already stand for (e.g. Skip) stay as quiet buttons. */
  const spareOptions = $derived.by(() => {
    if (!question || question.kind !== "choice" || !card) return [];
    if (card.kind === "secret") {
      return question.options.filter((option) => !/^(done|stored|saved|connected)$/i.test(option.label.trim()));
    }
    if (card.kind === "integrations") {
      const names = new Set(card.items.map((item) => item.name.toLowerCase()));
      return question.options.filter((option) => !names.has(option.label.trim().toLowerCase()));
    }
    return [];
  });

  async function storeSecret(event?: Event): Promise<void> {
    event?.preventDefault();
    const value = secretValue;
    if (busy || secretBusy || !card || card.kind !== "secret" || !question || question.kind !== "choice") return;
    if (!value.trim()) return;
    secretBusy = true;
    secretError = null;
    try {
      await onstoresecret?.(card, value);
      secretValue = "";
      onanswer?.(question.requestId, question.questionId, [doneLabel()]);
    } catch (err) {
      secretError = err instanceof Error ? err.message : String(err);
    } finally {
      secretBusy = false;
    }
  }

  // --- integrations card -----------------------------------------------------
  function toggleIntegration(name: string): void {
    if (busy || !question || question.kind !== "choice") return;
    if (!question.multiSelect) {
      onanswer?.(question.requestId, question.questionId, [name]);
      return;
    }
    picked = picked.includes(name) ? picked.filter((entry) => entry !== name) : [...picked, name];
  }

  function sendText(event?: Event): void {
    event?.preventDefault();
    const text = answerText.trim();
    if (busy || !text || !question) return;
    if (question.kind === "text") {
      onsend?.(text);
    } else if (question.kind === "choice") {
      // A typed answer always counts, options or not (the CLI's "Other").
      onanswer?.(question.requestId, question.questionId, [text]);
    }
  }

  const eyebrow = $derived(
    done ? "Setup complete" : stopped ? "Setup paused" : mode === "resume" ? "Setup in progress" : "Setting up this Mac",
  );
</script>

<div
  class="run-card"
  data-testid="setup-run-card"
  data-setup-run-mode={done ? "done" : stopped ? "stopped" : mode}
  data-setup-run-variant={variant}
  data-setup-run-step={currentStep}
  aria-live="polite"
>
  {#if variant !== "prompt"}
    <span class="eyebrow">{eyebrow}</span>
  {/if}

  {#if done && variant !== "steps"}
    <h3 class="run-title" data-testid="setup-run-done-title">{SETUP_RUN_DONE.title}</h3>
    {#if variant !== "prompt"}
      <p class="run-body" data-testid="setup-run-summary">{run?.summary || SETUP_RUN_DONE.summary}</p>
    {/if}
  {:else if stopped && variant !== "steps"}
    <h3 class="run-title" data-testid="setup-run-stopped-title">{SETUP_RUN_STOPPED.title}</h3>
    {#if variant !== "prompt"}
      <p class="run-body">{SETUP_RUN_STOPPED.body}</p>
    {/if}
  {/if}

  {#if variant !== "prompt"}
  <ol class="steps" aria-label="Setup steps" data-testid="setup-run-steps">
    {#each SETUP_RUN_STEPS as step, index (step.id)}
      {@const status = done ? "done" : statusOf(index)}
      <li
        class="step"
        class:step--done={status === "done"}
        class:step--running={status === "running"}
        data-testid={`setup-run-step-${step.id}`}
        data-step-status={status}
        aria-current={status === "running" ? "step" : undefined}
      >
        <span class="step-mark" aria-hidden="true">
          {#if status === "done"}
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
            </svg>
          {:else}
            <span class="step-index">{index + 1}</span>
          {/if}
        </span>
        <span class="step-label">{step.label}</span>
      </li>
    {/each}
  </ol>
  {#if !done && !stopped && mode === "live" && run?.statusLine && !question}
    <p class="run-status" data-testid="setup-run-status">{run.statusLine}</p>
  {/if}
  {/if}

  {#if variant !== "steps"}

  {#if question && !(variant === "prompt" && question.kind === "text")}
    <div class="question" data-testid="setup-run-question" data-question-kind={question.kind}>
      {#if variant !== "prompt"}
        <p class="question-text">{question.text}</p>
      {/if}
      {#if card?.kind === "found" && card.items.length > 0}
        <div class="found" data-testid="setup-run-found">
          <span class="found-title">{card.title || "Here’s what I found"}</span>
          <ul class="found-list">
            {#each card.items as item (item.label)}
              <li class="found-item">
                {#if item.count !== null && item.count !== undefined}
                  <span class="found-count">{item.count}</span>
                {/if}
                <span class="found-label">{item.label}</span>
                {#if item.detail}<span class="found-detail">{item.detail}</span>{/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if card?.kind === "secret" && question.kind === "choice"}
        <form class="secret" data-testid="setup-run-secret" onsubmit={storeSecret}>
          <label class="secret-label" for="setup-run-secret-input">
            {card.label || card.name}
            <span class="secret-name">{card.name} · {card.scope === "company" ? (card.company ? `${card.company} vault` : "company vault") : "your personal vault"}</span>
          </label>
          <div class="secret-row">
            <input
              id="setup-run-secret-input"
              class="answer-input"
              type="password"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="Paste it here"
              data-testid="setup-run-secret-input"
              bind:value={secretValue}
              disabled={busy || secretBusy}
            />
            <button
              type="submit"
              class="launch-btn primary"
              data-testid="setup-run-secret-store"
              disabled={busy || secretBusy || secretValue.trim().length === 0}
              aria-busy={secretBusy}
            >
              {secretBusy ? "Storing…" : "Store securely"}
            </button>
          </div>
          <p class="secret-hint">
            {card.hint || "Stored in your HQ vault on save. It never goes into the chat."}
          </p>
          {#if secretError}
            <p class="run-error" role="alert" data-testid="setup-run-secret-error">{secretError}</p>
          {/if}
          {#if spareOptions.length > 0}
            <div class="choices" role="group" aria-label="Other choices">
              {#each spareOptions as option (option.label)}
                <button type="button" class="quiet-btn" data-testid="setup-run-choice" disabled={busy || secretBusy} onclick={() => choose(option.label)}>
                  {option.label}
                </button>
              {/each}
            </div>
          {/if}
        </form>
      {:else if card?.kind === "integrations" && question.kind === "choice"}
        <div class="apps" role="group" aria-label="Apps to connect" data-testid="setup-run-integrations">
          {#each card.items as item (item.name)}
            {@const connected = item.status === "connected"}
            {@const on = picked.includes(item.name)}
            <button
              type="button"
              class="app"
              class:app--connected={connected}
              class:app--picked={on}
              data-testid="setup-run-app"
              data-app-status={connected ? "connected" : on ? "picked" : "available"}
              aria-pressed={connected ? undefined : on}
              disabled={busy || connected}
              onclick={() => toggleIntegration(item.name)}
            >
              <span class="app-mark" aria-hidden="true">
                {#if connected || on}
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                  </svg>
                {/if}
              </span>
              <span class="app-text">
                <span class="app-name">{item.name}</span>
                <span class="app-desc">
                  {#if connected}Connected{:else if item.description}{item.description}{:else if item.auth === "oauth"}Sign in with your account{:else if item.auth === "key"}Uses an API key{:else}Ready to connect{/if}
                </span>
              </span>
            </button>
          {/each}
        </div>
        <div class="choices" role="group" aria-label="Your answer">
          {#if question.multiSelect}
            <button
              type="button"
              class="launch-btn primary"
              data-testid="setup-run-send-choices"
              disabled={busy || picked.length === 0}
              onclick={sendPicked}
            >
              {picked.length > 1 ? `Connect ${picked.length} apps` : "Connect"}
            </button>
          {/if}
          {#each spareOptions as option (option.label)}
            <button type="button" class="quiet-btn" data-testid="setup-run-choice" disabled={busy} onclick={() => choose(option.label)}>
              {option.label}
            </button>
          {/each}
        </div>
      {:else if question.kind === "choice" && question.options.length > 0}
        <div
          class="choices"
          class:choices--stacked={variant !== "prompt" && question.options.some((option) => Boolean(option.description))}
          role="group"
          aria-label="Your answer"
        >
          {#each question.options as option (option.label)}
            <button
              type="button"
              class="launch-btn choice"
              class:choice--picked={picked.includes(option.label)}
              data-testid="setup-run-choice"
              title={variant === "prompt" ? (option.description ?? undefined) : undefined}
              aria-pressed={question.multiSelect ? picked.includes(option.label) : undefined}
              disabled={busy}
              onclick={() => choose(option.label)}
            >
              <span class="choice-label">{option.label}</span>
              {#if option.description && variant !== "prompt"}
                <span class="choice-desc">{option.description}</span>
              {/if}
            </button>
          {/each}
        </div>
        {#if question.multiSelect}
          <button
            type="button"
            class="launch-btn primary"
            data-testid="setup-run-send-choices"
            disabled={busy || picked.length === 0}
            onclick={sendPicked}
          >
            Send
          </button>
        {/if}
        {#if variant !== "prompt"}
        <form class="answer answer--other" onsubmit={sendText}>
          <input
            class="answer-input"
            type="text"
            autocomplete="off"
            aria-label={`Your own answer: ${question.text}`}
            placeholder="Or type your own answer"
            data-testid="setup-run-answer"
            bind:value={answerText}
            disabled={busy}
          />
          <button
            type="submit"
            class="launch-btn"
            data-testid="setup-run-send"
            disabled={busy || answerText.trim().length === 0}
          >
            Send
          </button>
        </form>
        {/if}
      {:else if question.kind === "permission"}
        <div class="choices" role="group" aria-label="Your answer">
          <button
            type="button"
            class="launch-btn primary"
            data-testid="setup-run-allow-session"
            disabled={busy}
            onclick={() => onpermission?.(question.requestId, "allowSession")}
          >
            {SETUP_RUN_PERMISSION.allowSession}
          </button>
          <button
            type="button"
            class="launch-btn"
            data-testid="setup-run-allow-once"
            disabled={busy}
            onclick={() => onpermission?.(question.requestId, "allowOnce")}
          >
            {SETUP_RUN_PERMISSION.allowOnce}
          </button>
          <button
            type="button"
            class="quiet-btn"
            data-testid="setup-run-deny"
            disabled={busy}
            onclick={() => onpermission?.(question.requestId, "deny")}
          >
            {SETUP_RUN_PERMISSION.deny}
          </button>
        </div>
      {:else if variant === "prompt"}
        <!-- A plain question: the composer under the messages is the reply box. -->
      {:else}
        <form class="answer" onsubmit={sendText}>
          <input
            class="answer-input"
            type="text"
            autocomplete="off"
            aria-label={question.text}
            placeholder="Type your answer"
            data-testid="setup-run-answer"
            bind:value={answerText}
            disabled={busy}
          />
          <button
            type="submit"
            class="launch-btn primary"
            data-testid="setup-run-send"
            disabled={busy || answerText.trim().length === 0}
          >
            Send
          </button>
        </form>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="run-error" role="alert" data-testid="setup-run-error">{error}</p>
  {/if}

  <div class="run-actions">
    {#if mode === "resume"}
      <button
        type="button"
        class="launch-btn primary"
        data-testid="setup-run-continue"
        disabled={busy}
        aria-busy={busy}
        onclick={() => oncontinue?.()}
      >
        {busy ? "Reconnecting…" : setupRunContinueLabel(resumeStep)}
      </button>
    {:else if stopped}
      <button
        type="button"
        class="launch-btn primary"
        data-testid="setup-run-again"
        disabled={busy}
        onclick={() => onrunagain?.()}
      >
        Run Setup
      </button>
    {:else if done && onrunagain}
      <button
        type="button"
        class="quiet-btn"
        data-testid="setup-run-again"
        disabled={busy}
        onclick={() => onrunagain?.()}
      >
        Run again
      </button>
    {/if}
    {#if onshowdetails && mode !== "resume"}
      <button type="button" class="quiet-btn" data-testid="setup-run-details" onclick={() => onshowdetails?.()}>
        Open setup chat
      </button>
    {/if}
  </div>
  {/if}
  {#if variant === "steps" && onshowdetails && mode !== "resume"}
    <button type="button" class="quiet-btn" data-testid="setup-run-details" onclick={() => onshowdetails?.()}>
      Open setup chat
    </button>
  {/if}
</div>

<style>
  /* The run panel sits on the app surface (not the hero art): every color is
     a shell token so it reads in light and dark alike. */
  .run-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    color: var(--text-1, inherit);
  }

  /* Under the messages: no box, no repeated question — just small chips,
     the same weight as the quick-reply controls elsewhere in the chat. */
  .run-card[data-setup-run-variant="prompt"] {
    gap: 8px;
  }
  .run-card[data-setup-run-variant="prompt"] .question {
    gap: 8px;
  }
  .run-card[data-setup-run-variant="prompt"] .run-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2, inherit);
  }
  .run-card[data-setup-run-variant="prompt"] .choices {
    gap: 6px;
  }
  .run-card[data-setup-run-variant="prompt"] .choice,
  .run-card[data-setup-run-variant="prompt"] .launch-btn,
  .run-card[data-setup-run-variant="prompt"] .app {
    min-height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
    max-width: none;
  }
  .run-card[data-setup-run-variant="prompt"] .choice {
    flex-direction: row;
    align-items: center;
  }
  .run-card[data-setup-run-variant="prompt"] .apps {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .run-card[data-setup-run-variant="prompt"] .app {
    align-items: center;
    gap: 6px;
    padding: 0 10px 0 6px;
  }
  .run-card[data-setup-run-variant="prompt"] .app-desc {
    display: none;
  }
  .run-card[data-setup-run-variant="prompt"] .app-mark {
    width: 14px;
    height: 14px;
    margin: 0;
  }
  .run-card[data-setup-run-variant="prompt"] .found {
    padding: 0;
    border: 0;
    background: transparent;
  }
  .run-card[data-setup-run-variant="prompt"] .answer-input {
    min-height: 28px;
    border-radius: 999px;
    font-size: 12px;
  }
  .run-card[data-setup-run-variant="prompt"] .run-actions {
    gap: 8px;
  }

  /* Over the hero art the stepper is always on dark wallpaper. */
  .run-card[data-setup-run-variant="steps"] {
    --text-1: #ffffff;
    --text-2: rgba(255, 255, 255, 0.82);
    --text-3: rgba(255, 255, 255, 0.6);
    --border: rgba(255, 255, 255, 0.35);
    gap: 10px;
  }
  .run-card[data-setup-run-variant="steps"] .steps {
    border-bottom: 0;
    padding-bottom: 0;
  }

  .eyebrow {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-3, rgba(127, 127, 127, 0.9));
  }

  .run-title {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.25;
  }

  .run-body {
    margin: -6px 0 0;
    max-width: 56ch;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-2, inherit);
  }

  /* ---- Stepper: one horizontal row --------------------------------------- */
  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    margin: 0;
    padding: 0 0 12px;
    list-style: none;
    border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  }

  .step {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    color: var(--text-3, rgba(127, 127, 127, 0.9));
  }

  .step--running {
    color: var(--text-1, inherit);
    font-weight: 600;
  }

  .step--done {
    color: var(--text-2, inherit);
  }

  .step-mark {
    display: inline-flex;
    width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 999px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .step--running .step-mark {
    border-color: var(--text-1, currentColor);
    color: var(--text-1, currentColor);
  }

  .step--done .step-mark {
    border-color: transparent;
    background: var(--accent, #22c55e);
    color: #fff;
  }

  .run-status {
    margin: -4px 0 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-2, inherit);
  }

  /* ---- Question ------------------------------------------------------------ */
  .question {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .question-text {
    margin: 0;
    max-width: 60ch;
    font-size: 14px;
    font-weight: 550;
    line-height: 1.45;
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .choices--stacked {
    flex-direction: column;
    align-items: stretch;
  }

  .choice {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-height: 34px;
    padding: 7px 12px;
    white-space: normal;
    text-align: left;
    max-width: 22rem;
    min-width: 0;
  }

  .choices--stacked .choice {
    width: 100%;
    max-width: 100%;
    height: auto;
    padding: 10px 14px;
  }

  .choices--stacked .choice-desc,
  .choices--stacked .choice-label {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .choice--picked {
    border-color: var(--text-1, currentColor);
    background: var(--raised, rgba(127, 127, 127, 0.12));
  }

  .choice-label {
    font-weight: 550;
  }

  .choice-desc {
    font-size: 12px;
    font-weight: 400;
    line-height: 1.4;
    color: var(--text-2, inherit);
  }

  /* ---- Found card ----------------------------------------------------------- */
  .found {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--raised, rgba(127, 127, 127, 0.1));
    border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  }
  .found-title {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3, rgba(127, 127, 127, 0.9));
  }
  .found-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .found-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
  }
  .found-count {
    min-width: 2ch;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .found-detail {
    color: var(--text-2, inherit);
    font-size: 12px;
  }

  /* ---- Secret card ---------------------------------------------------------- */
  .secret {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .secret-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 13px;
    font-weight: 550;
  }
  .secret-name {
    font-weight: 400;
    font-size: 12px;
    color: var(--text-2, inherit);
  }
  .secret-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .secret-hint {
    margin: 0;
    font-size: 12px;
    color: var(--text-3, rgba(127, 127, 127, 0.9));
  }

  /* ---- Integrations card ---------------------------------------------------- */
  .apps {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
  }
  .app {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    text-align: left;
    font: inherit;
    color: inherit;
    border-radius: 10px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
    background: transparent;
    cursor: pointer;
  }
  .app:hover:not(:disabled) {
    background: var(--raised, rgba(127, 127, 127, 0.1));
  }
  .app--picked {
    border-color: var(--text-1, currentColor);
    background: var(--raised, rgba(127, 127, 127, 0.12));
  }
  .app--connected {
    cursor: default;
    opacity: 0.8;
  }
  .app-mark {
    display: inline-flex;
    width: 18px;
    height: 18px;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    border-radius: 999px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
    margin-top: 1px;
  }
  .app--picked .app-mark,
  .app--connected .app-mark {
    border-color: transparent;
    background: var(--accent, #22c55e);
    color: #fff;
  }
  .app-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .app-name {
    font-size: 13px;
    font-weight: 600;
  }
  .app-desc {
    font-size: 12px;
    color: var(--text-2, inherit);
  }

  /* ---- Inputs and buttons --------------------------------------------------- */
  .answer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    max-width: 36rem;
  }
  .answer--other {
    margin-top: 2px;
  }

  .answer-input {
    flex: 1 1 14rem;
    min-height: 34px;
    padding: 0 12px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
    border-radius: 8px;
    background: transparent;
    color: var(--text-1, inherit);
    font: inherit;
    font-size: 13px;
  }
  .answer-input::placeholder {
    color: var(--text-3, rgba(127, 127, 127, 0.9));
  }
  .answer-input:focus-visible {
    outline: 2px solid var(--text-2, currentColor);
    outline-offset: 1px;
  }

  .launch-btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    min-height: 34px;
    padding: 0 14px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
    border-radius: 8px;
    background: transparent;
    color: var(--text-1, inherit);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease,
      border-color 140ms ease;
  }
  .launch-btn:hover:not(:disabled) {
    background: var(--raised, rgba(127, 127, 127, 0.1));
  }
  .launch-btn.primary {
    border-color: transparent;
    background: var(--text-1, #111);
    color: var(--bg, #fff);
  }
  .launch-btn.primary:hover:not(:disabled) {
    background: var(--text-1, #111);
    opacity: 0.92;
  }
  .launch-btn:disabled,
  .quiet-btn:disabled,
  .app:disabled {
    cursor: default;
  }
  .launch-btn:disabled {
    opacity: 0.55;
  }
  .launch-btn:focus-visible,
  .quiet-btn:focus-visible,
  .app:focus-visible,
  .choice:focus-visible {
    outline: 2px solid var(--text-2, currentColor);
    outline-offset: 2px;
  }

  .quiet-btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    min-height: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-2, inherit);
    font: inherit;
    font-size: 13px;
    text-decoration: underline;
    text-underline-offset: 0.16em;
    cursor: pointer;
  }

  .reply-hint {
    margin: 0;
    font-size: 12px;
    color: var(--text-3, rgba(127, 127, 127, 0.9));
  }

  .run-error {
    margin: 0;
    max-width: 40rem;
    font-size: 13px;
    line-height: 1.4;
    color: var(--danger, #d9534f);
  }

  .run-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  @media (prefers-reduced-motion: reduce) {
    .launch-btn {
      transition: none;
    }
  }
</style>
