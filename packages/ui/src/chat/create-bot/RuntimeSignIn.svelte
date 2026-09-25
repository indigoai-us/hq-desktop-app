<script lang="ts">
  /**
   * Inline runtime sign-in for the New bot flow's Home step. Opens the
   * runtime's browser sign-in through the host and polls until connected —
   * the same loop `SetupConnectStep` runs on #welcome, without leaving the
   * modal. Reports `onconnected` so the host can refresh readiness.
   */
  import { onDestroy } from "svelte";
  import type { BotRuntime } from "./create-bot-model.js";
  import { localBotRuntimeLabel } from "../local-bots.js";
  import { RUNTIME_SIGNIN_OPEN_TIMEOUT_MS, runtimeSignInTimeoutMessage } from "./runtime-status.js";

  export interface RuntimeSignInState {
    state: "disconnected" | "waiting" | "connected" | "error";
    message?: string;
  }

  export interface RuntimeSignInApi {
    loginStart(runtime: BotRuntime): Promise<RuntimeSignInState>;
    loginStatus(runtime: BotRuntime): Promise<RuntimeSignInState>;
    loginCancel?(runtime: BotRuntime): Promise<RuntimeSignInState>;
  }

  interface Props {
    runtime: BotRuntime;
    api: RuntimeSignInApi;
    onconnected: (runtime: BotRuntime) => void | Promise<void>;
    oncancel?: () => void;
    /** Poll interval; tests shorten it. */
    pollMs?: number;
    /**
     * How long "Opening … sign-in…" may last before it says something.
     *
     * A `loginStart` that never settles is what the owner hit: the host spawns
     * a CLI that is not there, the promise stays pending, and the line sits
     * unchanged for ever. A spinner with no end is the worst possible report of
     * a failure, so there is always a deadline behind it.
     */
    openTimeoutMs?: number;
  }

  let {
    runtime,
    api,
    onconnected,
    oncancel,
    pollMs = 1500,
    openTimeoutMs = RUNTIME_SIGNIN_OPEN_TIMEOUT_MS,
  }: Props = $props();

  let phase = $state<RuntimeSignInState["state"]>("disconnected");
  let message = $state("");
  let busy = $state(false);
  /**
   * Re-entrancy guard for `start`, deliberately NOT `$state`.
   *
   * `start` runs from an `$effect`, so anything reactive it READS becomes a
   * dependency of that effect — and `busy` is something it also writes. Using
   * `busy` as the guard made the open-deadline's `busy = false` re-run the
   * effect, which started another sign-in, which armed another deadline: a
   * spin that never settles. The guard is plain so the effect depends on
   * `runtime` and nothing else.
   */
  let starting = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;

  const label = $derived(localBotRuntimeLabel(runtime));

  function stopPolling(): void {
    clearTimeout(timer);
    timer = undefined;
    clearTimeout(openTimer);
    openTimer = undefined;
  }

  async function apply(result: RuntimeSignInState, token: number): Promise<void> {
    if (token !== generation) return;
    clearTimeout(openTimer);
    openTimer = undefined;
    phase = result.state;
    message = result.message ?? "";
    if (result.state === "connected") {
      stopPolling();
      await onconnected(runtime);
    } else if (result.state === "waiting") {
      timer = setTimeout(() => void poll(token), pollMs);
    }
  }

  async function poll(token: number): Promise<void> {
    try {
      await apply(await api.loginStatus(runtime), token);
    } catch {
      if (token === generation) {
        phase = "error";
        message = "Could not check sign-in. Please try again.";
      }
    }
  }

  async function start(): Promise<void> {
    if (starting) return;
    starting = true;
    stopPolling();
    busy = true;
    message = "";
    const token = ++generation;
    // The deadline runs alongside the call, not after it: a `loginStart` that
    // never settles would otherwise never reach the code that reports it.
    openTimer = setTimeout(() => {
      if (token !== generation) return;
      phase = "error";
      message = runtimeSignInTimeoutMessage(label);
      busy = false;
      starting = false;
    }, openTimeoutMs);
    try {
      await apply(await api.loginStart(runtime), token);
    } catch (error) {
      if (token === generation) {
        clearTimeout(openTimer);
        openTimer = undefined;
        phase = "error";
        // The host's own words when it has them — a spawn error or a non-zero
        // exit says far more than a generic line — and the generic line only
        // when it does not.
        const reason = error instanceof Error ? error.message.trim() : "";
        message = reason
          ? `Could not open ${label} sign-in — ${reason}`
          : `Could not open ${label} sign-in. Check that it is installed, then try again.`;
      }
    } finally {
      // Whatever the outcome, the line stops saying "Opening…": the error
      // branch below it is what the person needs to read.
      if (token === generation) {
        starting = false;
        busy = false;
      }
    }
  }

  async function cancel(): Promise<void> {
    stopPolling();
    starting = false;
    const token = ++generation;
    if (api.loginCancel) {
      try {
        await api.loginCancel(runtime);
      } catch {
        /* cancelling is best effort */
      }
    }
    if (token !== generation) return;
    phase = "disconnected";
    message = "";
    oncancel?.();
  }

  $effect(() => {
    void runtime;
    void start();
  });

  onDestroy(() => {
    ++generation;
    stopPolling();
  });
</script>

<div class="signin" data-testid="runtime-signin" data-runtime={runtime} data-state={phase} aria-live="polite">
  {#if phase === "waiting"}
    <span class="signin-text">Finish signing in to {label} in your browser — HQ will notice on its own.</span>
    <button type="button" class="signin-btn" data-testid="runtime-signin-cancel" onclick={() => void cancel()}>Cancel</button>
  {:else if phase === "connected"}
    <span class="signin-text ok">{label} is signed in.</span>
  {:else if busy}
    <span class="signin-text">Opening {label} sign-in…</span>
  {:else}
    <span class="signin-text" class:error={phase === "error"}>{message || "Sign-in did not complete."}</span>
    <button type="button" class="signin-btn" data-testid="runtime-signin-retry" onclick={() => void start()}>Try again</button>
    <button type="button" class="signin-btn quiet" data-testid="runtime-signin-cancel" onclick={() => void cancel()}>Cancel</button>
  {/if}
</div>

<style>
  .signin {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    background: var(--v4-control-faint, rgba(127, 127, 127, 0.08));
    font-size: 12px;
    color: var(--t2);
  }
  .signin-text {
    flex: 1 1 200px;
    line-height: 1.4;
  }
  .signin-text.ok {
    color: var(--v4-ok, #2e9e5b);
  }
  .signin-text.error {
    color: var(--v4-error, #d9534f);
  }
  .signin-btn {
    font: inherit;
    font-size: 12px;
    padding: 4px 10px;
    border: 1px solid var(--v4-control-border, var(--border));
    border-radius: 6px;
    background: var(--v4-control-bg, transparent);
    color: var(--t1);
    cursor: pointer;
  }
  .signin-btn.quiet {
    border-color: transparent;
    color: var(--t3);
  }
  .signin-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 1px;
  }
</style>
