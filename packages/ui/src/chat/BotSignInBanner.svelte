<script lang="ts">
  /**
   * Above the composer in a local bot's conversation when its coding tool's
   * sign-in has expired (`runtimeSignIn.state === "expired"` from
   * `hq bot list`). One button forces the vendor sign-in, waits for it, and
   * restarts the paused bots so they pick up the waiting message right away.
   */
  import { onDestroy } from "svelte";
  import type { LocalBotRow } from "@hq/platform";
  import {
    expiredRuntimeOf,
    signInAgain,
    signInAgainCopy,
    type SignInAgainDeps,
  } from "./runtime-sign-in-again.js";

  interface Props {
    bot: LocalBotRow;
    sessions: SignInAgainDeps["sessions"];
    bots?: SignInAgainDeps["bots"];
    /** Re-read the bot list once the sign-in worked. */
    ondone?: () => void | Promise<void>;
    /** Poll interval; tests shorten it. */
    pollMs?: number;
  }

  let { bot, sessions, bots = null, ondone, pollMs }: Props = $props();

  let phase = $state<"idle" | "opening" | "waiting" | "done" | "error">("idle");
  let errorText = $state("");
  let gone = false;

  const copy = $derived(signInAgainCopy(bot));

  async function start(): Promise<void> {
    if (phase === "opening" || phase === "waiting") return;
    phase = "opening";
    errorText = "";
    const result = await signInAgain(expiredRuntimeOf(bot), {
      sessions,
      bots,
      pollMs,
      onwaiting: () => {
        if (!gone) phase = "waiting";
      },
      cancelled: () => gone,
    });
    if (gone) return;
    if (!result.ok) {
      if (result.cancelled) return;
      phase = "error";
      errorText = result.reason;
      return;
    }
    phase = "done";
    await ondone?.();
  }

  onDestroy(() => {
    gone = true;
  });
</script>

<div class="bot-signin" data-testid="bot-signin-banner" data-state={phase} role="status" aria-live="polite">
  {#if phase === "waiting"}
    <span class="bot-signin-text">{copy.waiting}</span>
  {:else if phase === "done"}
    <span class="bot-signin-text">Signed in. {bot.name} is picking up where it left off.</span>
  {:else}
    <span class="bot-signin-text">
      {copy.lead}
      {#if phase === "error"}
        <span class="bot-signin-error" data-testid="bot-signin-error">{errorText}</span>
      {/if}
    </span>
    <button
      type="button"
      class="bot-signin-btn"
      data-testid="bot-signin-start"
      disabled={phase === "opening"}
      onclick={() => void start()}
    >
      {phase === "opening" ? "Opening sign-in…" : phase === "error" ? "Try again" : copy.action}
    </button>
  {/if}
</div>

<style>
  .bot-signin {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: 12px 16px 4px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--line2);
    color: var(--t1);
    font-size: 12px;
    line-height: 1.4;
  }
  .bot-signin-text {
    flex: 1 1 240px;
    min-width: 0;
  }
  .bot-signin-error {
    display: block;
    margin-top: 2px;
    color: var(--danger, #d05f5f);
  }
  .bot-signin-btn {
    font: inherit;
    font-weight: 600;
    padding: 4px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel-bg, transparent);
    color: var(--t1);
    cursor: pointer;
  }
  .bot-signin-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .bot-signin-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--line));
    outline-offset: 1px;
  }
</style>
