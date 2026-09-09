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
    type SetupRunPermissionDecision,
    type SetupRunState,
  } from "./setup-run";

  /** Which face the card shows. `live` reads the rest from `state`. */
  /** `done` is the remembered outcome after a finished run (no live session). */
  export type SetupRunCardMode = "live" | "resume" | "stopped" | "done";

  interface Props {
    mode: SetupRunCardMode;
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
  }

  let {
    mode,
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
  }: Props = $props();

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
  data-setup-run-step={currentStep}
  aria-live="polite"
>
  <span class="eyebrow">{eyebrow}</span>

  {#if done}
    <h3 class="run-title" data-testid="setup-run-done-title">{SETUP_RUN_DONE.title}</h3>
    <p class="run-body" data-testid="setup-run-summary">{run?.summary || SETUP_RUN_DONE.summary}</p>
  {:else if stopped}
    <h3 class="run-title" data-testid="setup-run-stopped-title">{SETUP_RUN_STOPPED.title}</h3>
    <p class="run-body">{SETUP_RUN_STOPPED.body}</p>
  {/if}

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
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
            </svg>
          {:else if status === "running"}
            <span class="step-pulse"></span>
          {/if}
        </span>
        <span class="step-text">
          <span class="step-label">{step.label}</span>
          {#if status === "running" && mode === "live" && !stopped && run?.statusLine && !question}
            <span class="step-status" data-testid="setup-run-status">{run.statusLine}</span>
          {/if}
        </span>
      </li>
    {/each}
  </ol>

  {#if question}
    <div class="question" data-testid="setup-run-question" data-question-kind={question.kind}>
      <p class="question-text">{question.text}</p>
      {#if question.kind === "choice" && question.options.length > 0}
        <div class="choices" role="group" aria-label="Your answer">
          {#each question.options as option (option.label)}
            <button
              type="button"
              class="launch-btn choice"
              class:choice--picked={picked.includes(option.label)}
              data-testid="setup-run-choice"
              aria-pressed={question.multiSelect ? picked.includes(option.label) : undefined}
              disabled={busy}
              onclick={() => choose(option.label)}
            >
              <span class="choice-label">{option.label}</span>
              {#if option.description}
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
        Show details
      </button>
    {/if}
  </div>
</div>

<style>
  .run-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 12px);
    color: #ffffff;
  }

  .eyebrow {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: var(--text-micro, 11px);
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.62);
  }

  .run-title {
    margin: 0;
    max-width: 22ch;
    font-size: var(--type-detail, 24px);
    font-weight: 500;
    line-height: 1.15;
    letter-spacing: -0.012em;
    color: #ffffff;
  }

  .run-body {
    margin: 0;
    max-width: 52ch;
    font-size: var(--text-base, 13px);
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.74);
  }

  /* ---- Stepper -------------------------------------------------------- */

  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .step {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    align-items: start;
    column-gap: 10px;
    color: rgba(255, 255, 255, 0.55);
    font-size: var(--text-base, 13px);
    line-height: 1.45;
  }

  .step--running {
    color: #ffffff;
  }

  .step--done {
    color: rgba(255, 255, 255, 0.82);
  }

  .step-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-top: 1px;
    border: 1px solid rgba(255, 255, 255, 0.38);
    border-radius: 50%;
    color: #0a0b0d;
  }

  .step--done .step-mark {
    border-color: #ffffff;
    background: #ffffff;
  }

  .step--running .step-mark {
    border-color: #ffffff;
  }

  .step-pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ffffff;
    animation: setup-run-pulse 1.4s ease-in-out infinite;
  }

  @keyframes setup-run-pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.8);
    }
    50% {
      opacity: 1;
      transform: scale(1);
    }
  }

  .step-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .step-label {
    font-weight: 500;
  }

  .step-status {
    color: rgba(255, 255, 255, 0.72);
    max-width: 60ch;
  }

  /* ---- Question ------------------------------------------------------- */

  .question {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    padding-top: 2px;
  }

  .question-text {
    margin: 0;
    max-width: 52ch;
    font-size: var(--text-base, 13px);
    font-weight: 500;
    line-height: 1.5;
    color: #ffffff;
  }

  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 8px);
  }

  .choice {
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    min-height: 30px;
    padding: 6px 12px;
    white-space: normal;
    text-align: left;
    max-width: 22rem;
  }

  .choice--picked {
    border-color: #ffffff;
    background: rgba(255, 255, 255, 0.18);
  }

  .choice-label {
    font-weight: 500;
  }

  .choice-desc {
    font-size: var(--text-micro, 11px);
    font-weight: 400;
    color: rgba(255, 255, 255, 0.72);
  }

  .answer--other {
    margin-top: 8px;
  }

  .answer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2, 8px);
    max-width: 32rem;
  }

  .answer-input {
    flex: 1 1 14rem;
    min-height: 30px;
    padding: 0 10px;
    border: 1px solid rgba(255, 255, 255, 0.38);
    border-radius: 0;
    background: rgba(6, 6, 6, 0.28);
    color: #ffffff;
    font: inherit;
    font-size: var(--text-base, 13px);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  .answer-input::placeholder {
    color: rgba(255, 255, 255, 0.5);
  }

  .answer-input:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
  }

  /* ---- Buttons (mirrors the hero) ------------------------------------ */

  .launch-btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.38);
    border-radius: 0;
    background: rgba(6, 6, 6, 0.28);
    color: #ffffff;
    font: inherit;
    font-size: var(--text-base, 13px);
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    transition:
      background 140ms ease,
      color 140ms ease,
      border-color 140ms ease;
  }

  .launch-btn:hover:not(:disabled) {
    border-color: rgba(255, 255, 255, 0.7);
    background: rgba(255, 255, 255, 0.12);
  }

  .launch-btn.primary {
    border-color: #ffffff;
    background: #ffffff;
    color: #0a0b0d;
  }

  .launch-btn.primary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.9);
    border-color: rgba(255, 255, 255, 0.9);
  }

  .launch-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .launch-btn:focus-visible {
    outline: 2px solid #ffffff;
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
    color: rgba(255, 255, 255, 0.72);
    font: inherit;
    font-size: var(--text-base, 13px);
    text-decoration: underline;
    text-underline-offset: 0.16em;
    cursor: pointer;
  }

  .quiet-btn:hover:not(:disabled) {
    color: #ffffff;
  }

  .quiet-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .quiet-btn:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
  }

  .run-error {
    margin: 0;
    max-width: 32rem;
    font-size: var(--text-base, 13px);
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.85);
  }

  .run-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3, 12px);
  }

  @media (prefers-reduced-motion: reduce) {
    .launch-btn {
      transition: none;
    }
    .step-pulse {
      animation: none;
      opacity: 1;
    }
  }
</style>
