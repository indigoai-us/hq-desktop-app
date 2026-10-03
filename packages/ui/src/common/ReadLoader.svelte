<script lang="ts">
  /**
   * BLANK-3: the one loading state for a pending page read. An animated loader
   * at once, a rotating waiting line once the wait is noticeable, and a quiet
   * Try again after a long wait. It never says the read failed: the read keeps
   * going and the page swaps this out when the answer arrives.
   */
  import { onMount } from "svelte";
  import RailButton from "./button/RailButton.svelte";
  import {
    LOADING_MESSAGE_AFTER_MS,
    LOADING_MESSAGE_ROTATE_MS,
    LOADING_RETRY_AFTER_MS,
  } from "./read-deadline.js";
  import { loadingMessages, type LoadingSurface } from "./loading-messages.js";

  interface Props {
    /** Starts a fresh read; offered after LOADING_RETRY_AFTER_MS. */
    onretry?: (() => void) | null;
    surface?: LoadingSurface | null;
    testid?: string;
  }

  let { onretry = null, surface = null, testid = "read-loader" }: Props = $props();

  const lines = loadingMessages(surface);
  let line = $state<string | null>(null);
  let longWait = $state(false);

  onMount(() => {
    let index = Math.floor(Math.random() * lines.length);
    let rotate: ReturnType<typeof setInterval> | null = null;
    const first = setTimeout(() => {
      line = lines[index % lines.length]!;
      rotate = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        index += 1;
        line = lines[index % lines.length]!;
      }, LOADING_MESSAGE_ROTATE_MS);
    }, LOADING_MESSAGE_AFTER_MS);
    const long = setTimeout(() => (longWait = true), LOADING_RETRY_AFTER_MS);
    return () => {
      clearTimeout(first);
      clearTimeout(long);
      if (rotate) clearInterval(rotate);
    };
  });
</script>

<div class="read-loader" role="status" aria-live="polite" data-testid={testid}>
  <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
  {#if line}<p data-testid="{testid}-message">{line}</p>{:else}<span class="sr-only">Loading</span>{/if}
  {#if longWait && onretry}
    <RailButton icon="refresh" data-testid="{testid}-retry" onclick={onretry}>Try again</RailButton>
  {/if}
</div>

<style>
  .read-loader {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-height: 31px;
    padding: 8px;
  }
  .read-loader p {
    margin: 0;
    color: var(--v4-text-3, var(--t3, #8a8a8a));
    font-size: var(--type-secondary, var(--text-sm, 11px));
    line-height: 1.35;
  }
  .dots {
    display: inline-flex;
    gap: 4px;
  }
  .dots span {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--v4-text-3, var(--t3, #8a8a8a));
    animation: read-loader-pulse 1.2s ease-in-out infinite;
  }
  .dots span:nth-child(2) { animation-delay: 0.15s; }
  .dots span:nth-child(3) { animation-delay: 0.3s; }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @keyframes read-loader-pulse {
    0%, 100% { opacity: 0.25; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .dots span { animation: none; opacity: 0.6; }
  }
</style>
