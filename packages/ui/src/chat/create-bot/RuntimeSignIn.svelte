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
  }

  let { runtime, api, onconnected, oncancel, pollMs = 1500 }: Props = $props();

  let phase = $state<RuntimeSignInState["state"]>("disconnected");
  let message = $state("");
  let busy = $state(false);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const label = $derived(localBotRuntimeLabel(runtime));

  function stopPolling(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  async function apply(result: RuntimeSignInState, token: number): Promise<void> {
    if (token !== generation) return;
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
    if (busy) return;
    stopPolling();
    busy = true;
    message = "";
    const token = ++generation;
    try {
      await apply(await api.loginStart(runtime), token);
    } catch {
      if (token === generation) {
        phase = "error";
        message = "Could not open sign-in. Check that the app is installed, then try again.";
      }
    } finally {
      if (token === generation) busy = false;
    }
  }

  async function cancel(): Promise<void> {
    stopPolling();
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
