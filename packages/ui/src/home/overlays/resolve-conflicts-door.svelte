<script lang="ts">
  import { dismissable } from "../../common/dismissable.js";
  import ReadLoader from "../../common/ReadLoader.svelte";
  /**
   * First-frame door for the resolve-conflicts sheet. The loader paints
   * immediately; the body chunk loads after.
   */
  import { onMount } from "svelte";
  import type { HomeConflict } from "../home-model.js";
  import type { Component } from "svelte";

  type Strategy = "keep-local" | "keep-remote" | "discard";

  interface Props {
    conflicts: readonly HomeConflict[];
    onresolve?: (path: string, strategy: Strategy) => void | Promise<void>;
    onclose?: () => void;
  }

  let { conflicts, onresolve, onclose }: Props = $props();

  let Sheet: Component<Props> | null = $state(null);

  onMount(() => {
    let alive = true;
    void import("./resolve-conflicts-sheet.svelte").then((mod) => {
      if (alive) Sheet = mod.default as Component<Props>;
    });
    return () => {
      alive = false;
    };
  });
</script>

{#if Sheet}
  <Sheet {conflicts} {onresolve} {onclose} />
{:else}
  <div class="rc-scrim" role="presentation"></div>
  <div
    class="rc-sheet"
    use:dismissable={{ onclose }}
    role="dialog"
    aria-label="Resolve conflicts"
    aria-busy="true"
    data-testid="resolve-conflicts-sheet"
  >
    <header class="rc-h">Resolve conflicts<span class="sub">Loading choices</span></header>
    <ReadLoader testid="resolve-conflicts-loading" />
  </div>
{/if}

<style>
  .rc-scrim {
    position: fixed;
    inset: 0;
    z-index: 10020;
    background: rgba(0, 0, 0, 0.45);
  }
  .rc-sheet {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 10021;
    width: min(680px, calc(100vw - 32px));
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--overlay-bg, var(--v4-popover));
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    color: var(--v4-text-1);
  }
  .rc-h { display: flex; gap: 8px; font-size: 15px; font-weight: 600; }
  .sub { font-weight: 400; color: var(--v4-text-3); font-size: 13px; }
</style>
