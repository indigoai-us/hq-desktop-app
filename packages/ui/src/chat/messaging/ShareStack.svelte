<script lang="ts">
  /**
   * Back-to-back share messages from one sender, drawn as one stack of cards.
   * Collapsed it shows the first item with the rest layered behind it; opening
   * it lays every item out as the normal attachment cards.
   */
  import type { ImagePreviewCache } from "./image-preview-cache";
  import type { FileAttachmentModel } from "./channelMessageModels";
  import MessageAttachments from "./MessageAttachments.svelte";
  import { attachmentBadgeLabel } from "./chat-attachments";
  import { shareStackSummary } from "./share-stack";

  interface Props {
    attachments: FileAttachmentModel[];
    previewCache?: ImagePreviewCache | null;
    vaultCompanyUid?: string | null;
    onopen?: (attachment: FileAttachmentModel) => void;
    resolveUrl?: (attachment: FileAttachmentModel) => Promise<string | null>;
    onreleaseurl?: (url: string) => void;
  }

  let { attachments, previewCache, vaultCompanyUid, onopen, resolveUrl, onreleaseurl }: Props = $props();
  let expanded = $state(false);

  const VISIBLE_NAMES = 2;
  const summary = $derived(shareStackSummary(attachments));
  const front = $derived(attachments[0]);
  const layers = $derived(Math.min(attachments.length - 1, 2));
  const namesLine = $derived.by(() => {
    const names = attachments.slice(0, VISIBLE_NAMES).map((item) => item.name);
    const rest = attachments.length - names.length;
    return rest > 0 ? `${names.join(", ")} +${rest} more` : names.join(", ");
  });
  const countLabel = $derived.by(() => {
    const allFolders = attachments.every((item) => item.kind === "folder");
    const allFiles = attachments.every((item) => item.kind !== "folder");
    const noun = allFolders ? "folders" : allFiles ? "files" : "items";
    return `${attachments.length} ${noun}`;
  });
</script>

<div class="share-stack" data-testid="share-stack" data-count={attachments.length}>
  <div class="dm-bubble-body msg-body share-stack-summary">{summary}</div>
  {#if expanded}
    <MessageAttachments
      {attachments}
      {previewCache}
      {vaultCompanyUid}
      {onopen}
      {resolveUrl}
      {onreleaseurl}
    />
    <button
      type="button"
      class="share-stack-toggle"
      data-testid="share-stack-collapse"
      onclick={() => (expanded = false)}
    >Show less</button>
  {:else if front}
    <button
      type="button"
      class="share-stack-deck"
      style:--layers={layers}
      data-testid="share-stack-expand"
      aria-expanded="false"
      aria-label={`${summary} Show all ${attachments.length}`}
      onclick={() => (expanded = true)}
    >
      {#each { length: layers } as _, i (i)}
        <span class="share-stack-layer" style:--depth={layers - i} aria-hidden="true"></span>
      {/each}
      <span class="share-stack-card">
        <span class="share-stack-icon" aria-hidden="true">{attachmentBadgeLabel(front)}</span>
        <span class="share-stack-copy">
          <span class="share-stack-count">{countLabel}</span>
          <span class="share-stack-names">{namesLine}</span>
        </span>
      </span>
    </button>
  {/if}
</div>

<style>
  .share-stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  .share-stack-deck {
    appearance: none;
    position: relative;
    display: block;
    width: min(320px, 100%);
    margin-top: 8px;
    padding: 0 0 calc(var(--layers, 0) * 6px);
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .share-stack-layer {
    position: absolute;
    left: calc(var(--depth) * 8px);
    right: calc(var(--depth) * 8px);
    top: calc(var(--depth) * 6px);
    bottom: calc((var(--layers) - var(--depth)) * 6px);
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    background: var(--sel, rgba(255, 255, 255, 0.05));
    opacity: calc(1 - var(--depth) * 0.25);
  }

  .share-stack-card {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    background: var(--panel, var(--bg, #1b1b1d));
  }

  .share-stack-deck:hover .share-stack-card {
    background: var(--hover, rgba(255, 255, 255, 0.08));
  }

  .share-stack-icon {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    min-width: 28px;
    height: 28px;
    padding: 0 5px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--t2);
    font: 500 9px/1 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.04em;
  }

  .share-stack-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .share-stack-count {
    color: var(--t1);
    font: 500 12px/1.3 var(--font-ui);
  }

  .share-stack-names {
    overflow: hidden;
    color: var(--t3, var(--t2));
    font: 400 11px/1.3 var(--font-ui);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .share-stack-toggle {
    appearance: none;
    margin-top: 6px;
    padding: 2px 0;
    border: 0;
    background: none;
    color: var(--t2);
    font: 400 12px/1.3 var(--font-ui);
    cursor: pointer;
  }

  .share-stack-toggle:hover {
    color: var(--t1);
  }
</style>
