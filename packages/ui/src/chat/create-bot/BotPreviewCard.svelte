<script lang="ts">
  /**
   * Live preview of the bot being created: avatar (or generated mark), name,
   * Cloud/Local chip, "thinks with …", and the intro line. Right rail on wide
   * windows, top on narrow — the host decides with `placement`.
   */
  import BotKindChip from "../BotKindChip.svelte";
  import IdentityMark from "../messaging/IdentityMark.svelte";
  import type { BotHome, BotRuntime } from "./create-bot-model.js";

  interface Props {
    name: string;
    home: BotHome;
    runtime: BotRuntime;
    /** "thinks with Claude Code" / "hosted by Indigo". */
    thinksWith: string;
    intro?: string;
    /** Chosen avatar (a pack tile). */
    avatarUrl?: string | null;
    /** Seed for the generated mark while no avatar is chosen. */
    markSeed?: string;
    /** Kind line under the name: "Blank bot", "From Iris Cx". */
    kindLine?: string;
    placement?: "rail" | "top";
  }

  let {
    name,
    home,
    runtime,
    thinksWith,
    intro = "",
    avatarUrl = null,
    markSeed = "",
    kindLine = "",
    placement = "rail",
  }: Props = $props();

  const shownName = $derived(name.trim() || "your bot");
</script>

<aside class="preview" class:top={placement === "top"} data-testid="bot-preview-card" aria-label="Preview">
  <div class="preview-mark">
    <IdentityMark kind="agent" label={shownName} avatarUrl={avatarUrl} agentUid={markSeed || `agt_preview_${shownName}`} />
  </div>
  <div class="preview-body">
    <div class="preview-name-row">
      <span class="preview-name" data-testid="bot-preview-name">{shownName}</span>
      <BotKindChip kind={home} runtime={home === "local" ? runtime : null} variant="label" />
    </div>
    {#if kindLine}
      <span class="preview-kind" data-testid="bot-preview-kind">{kindLine}</span>
    {/if}
    <span class="preview-thinks" data-testid="bot-preview-thinks">{thinksWith}</span>
    {#if intro.trim()}
      <p class="preview-intro" data-testid="bot-preview-intro">“{intro.trim()}”</p>
    {:else}
      <p class="preview-intro muted">{home === "cloud" ? "Says hello once it's set up." : "Says hello when it comes online."}</p>
    {/if}
  </div>
</aside>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 20px 16px;
    border: 1px solid var(--v4-hairline);
    border-radius: 12px;
    background: var(--v4-control-faint, rgba(127, 127, 127, 0.06));
    text-align: center;
  }
  .preview.top {
    flex-direction: row;
    align-items: center;
    text-align: left;
    padding: 12px 14px;
  }
  .preview-mark {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    overflow: hidden;
    flex: 0 0 auto;
    font-size: 20px;
  }
  .preview-mark :global(.identity) {
    width: 56px;
    height: 56px;
  }
  .preview.top .preview-mark,
  .preview.top .preview-mark :global(.identity) {
    width: 40px;
    height: 40px;
  }
  .preview-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .preview.top .preview-body {
    align-items: flex-start;
  }
  .preview-name-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .preview.top .preview-name-row {
    justify-content: flex-start;
  }
  .preview-name {
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .preview-kind {
    color: var(--t2);
    font-size: 12px;
  }
  .preview-thinks {
    color: var(--t3);
    font-size: 12px;
  }
  .preview-intro {
    margin: 4px 0 0;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .preview-intro.muted {
    color: var(--t3);
    font-style: italic;
  }
</style>
