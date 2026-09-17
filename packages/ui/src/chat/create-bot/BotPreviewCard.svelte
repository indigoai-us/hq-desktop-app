<script lang="ts">
  /**
   * Live preview of the bot being created: avatar (or generated mark), name,
   * its title, the Cloud/Local chip and "thinks with …". Right rail on wide
   * windows, top on narrow — the host decides with `placement`.
   */
  import BotKindChip from "../BotKindChip.svelte";
  import IdentityMark from "../messaging/IdentityMark.svelte";
  import type { BotHome, BotRuntime } from "./create-bot-model.js";

  interface Props {
    name: string;
    /** Cloud only: the @handle it will be created under. */
    handle?: string;
    home: BotHome;
    runtime: BotRuntime;
    /** "thinks with Claude Code" / "hosted by Indigo". */
    thinksWith: string;
    /** Optional job title, shown under the name. */
    title?: string;
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
    handle = "",
    home,
    runtime,
    thinksWith,
    title = "",
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
    {#if handle.trim()}
      <span class="preview-handle" data-testid="bot-preview-handle">@{handle.trim()}</span>
    {/if}
    {#if title.trim()}
      <span class="preview-title" data-testid="bot-preview-title">{title.trim()}</span>
    {/if}
    {#if kindLine}
      <span class="preview-kind" data-testid="bot-preview-kind">{kindLine}</span>
    {/if}
    <span class="preview-thinks" data-testid="bot-preview-thinks">{thinksWith}</span>
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
  .preview-handle {
    color: var(--t3);
    font: 500 11px/1.2 var(--font-mono);
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
  .preview-title {
    color: var(--t2);
    font-size: 12px;
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
</style>
