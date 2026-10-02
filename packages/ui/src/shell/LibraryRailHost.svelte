<script lang="ts">
  /**
   * Rail mount for personal Library. The page chunk loads after the first
   * frame. The skeleton is that frame.
   */
  import { onMount } from "svelte";
  import type { LibraryApi, PlatformAdapter } from "@hq/platform";
  import type { Component } from "svelte";

  interface Props {
    accountId?: string;
    adapter?: PlatformAdapter | null;
    library?: LibraryApi | null;
  }

  let { accountId = "local", adapter = null, library = null }: Props = $props();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Page = $state<Component<any> | null>(null);

  onMount(() => {
    let live = true;
    void import("../library/PersonalLibraryPage.svelte").then(
      (mod) => {
        if (live) Page = mod.default;
      },
      (err) => console.error("[library-rail] load failed", err),
    );
    return () => {
      live = false;
    };
  });
</script>

<div class="host" data-testid="library-host">
  {#if Page}
    <Page {accountId} {adapter} {library} />
  {:else}
    <div class="skeleton" data-testid="library-skeleton" aria-busy="true">
      <aside><div class="bar"></div><div class="bar"></div><div class="bar"></div></aside>
      <main><div class="title"></div><div class="body"></div></main>
    </div>
  {/if}
</div>

<style>
  .host { height: 100%; min-height: 0; }
  .skeleton {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    height: 100%;
    gap: 16px;
    padding: 16px;
  }
  .bar, .title, .body {
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
    animation: lib-skel 1.1s linear infinite;
  }
  .bar { height: 28px; margin-bottom: 8px; }
  .title { height: 28px; width: 180px; }
  .body { height: 120px; margin-top: 16px; }
  @keyframes lib-skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
</style>
