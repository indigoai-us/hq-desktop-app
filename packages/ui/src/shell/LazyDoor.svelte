<script lang="ts">
  /**
   * Renders a door's body once it has loaded. Until then it renders the
   * caller's loading frame (the `skeleton` snippet) synchronously, so the click paints its frame at once.
   * The door retries a failed chunk load (lazy-doors.ts) and reports the
   * final failure. Then this shows a short failed line with Try again, the
   * same treatment as the Daily Brief host; no error text is shown.
   */
  import type { Snippet } from "svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import type { Door } from "./lazy-doors.js";

  interface Props {
    door: Door;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props: Record<string, any>;
    skeleton?: Snippet;
    /**
     * The caller handles a failed load itself (the first-run import step
     * keeps its loading frame, offers Continue in chat and tries again), so
     * the door keeps showing the loading frame instead of its failed line.
     */
    keepLoadingOnFailure?: boolean;
  }

  let { door, props, skeleton, keepLoadingOnFailure = false }: Props = $props();

  let Body = $state(door.peek());
  let failed = $state(false);
  let attempt = $state(0);

  $effect(() => {
    void attempt;
    if (Body) return;
    let live = true;
    door.load().then(
      (loaded) => {
        if (live) Body = loaded;
      },
      () => {
        // Logged and reported by the door after its retries.
        if (live) failed = true;
      },
    );
    return () => {
      live = false;
    };
  });

  function retry() {
    failed = false;
    attempt += 1;
  }
</script>

{#if Body}
  <Body {...props} />
{:else if failed && !keepLoadingOnFailure}
  <div class="door-failed" role="status" data-testid="lazy-door-failed">
    <p>This didn’t load. Try again in a moment.</p>
    <RailButton icon="refresh" data-testid="lazy-door-retry" onclick={retry}>Try again</RailButton>
  </div>
{:else if skeleton}
  {@render skeleton()}
{/if}

<style>
  .door-failed {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px;
  }
  .door-failed p {
    margin: 0;
    color: var(--v4-text-3, var(--t3, #8a8a8a));
    font-size: var(--type-secondary, var(--text-sm, 11px));
    line-height: 1.35;
  }
</style>
