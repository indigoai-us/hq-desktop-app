<script lang="ts">
  /**
   * Renders a door's body once it has loaded. Until then it renders the
   * caller's loading frame (the `skeleton` snippet) synchronously, so the click paints its frame at once.
   */
  import type { Snippet } from "svelte";
  import type { Door } from "./lazy-doors.js";

  interface Props {
    door: Door;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props: Record<string, any>;
    skeleton?: Snippet;
  }

  let { door, props, skeleton }: Props = $props();

  let Body = $state(door.peek());

  $effect(() => {
    if (Body) return;
    let live = true;
    door.load().then(
      (loaded) => {
        if (live) Body = loaded;
      },
      (err) => console.error("[lazy-door] load failed", err),
    );
    return () => {
      live = false;
    };
  });
</script>

{#if Body}
  <Body {...props} />
{:else if skeleton}
  {@render skeleton()}
{/if}
