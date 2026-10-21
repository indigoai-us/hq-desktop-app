<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import Tooltip from "../../common/Tooltip.svelte";
  import "./doc-card.css";
  /**
   * ArtifactCard — the collapsed tile under a chat bubble for a long
   * structured artifact (`hq dm --details` / `--prompt`, delegation + handoff
   * cards).
   *
   * Deliberately small, and the same card as a file attachment
   * (doc-card.css): a neutral icon tile, the title, a one-line plain-text
   * summary, and the kind and size. No preview body — the card is
   * a handle; the host's right side pane (artifact mode) shows the FULL
   * content. Copy / Open surface on hover and focus, and the whole card is a
   * keyboard-reachable button.
   */
  import {
    artifactSummary,
    chatArtifact,
    type ArtifactKind,
    type ChatArtifact,
  } from "./artifact-model.js";

  interface Props {
    text: string;
    eventId: string;
    kind?: ArtifactKind;
    /** Host opens the artifact in the side pane. */
    onopen?: (artifact: ChatArtifact) => void;
  }

  let { text, eventId, kind = "prompt", onopen }: Props = $props();

  const artifact = $derived(chatArtifact({ text, eventId, kind }));
  const summary = $derived(artifactSummary(text, kind));

  let copied = $state(false);
  let copying = $state(false);

  function open(): void {
    onopen?.(artifact);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    open();
  }

  async function copy(e: MouseEvent): Promise<void> {
    e.stopPropagation();
    const payload = artifact.text.trim();
    if (!payload || copying) return;
    copying = true;
    try {
      await navigator.clipboard.writeText(payload);
      copied = true;
      setTimeout(() => {
        if (copied) copied = false;
      }, 1800);
    } catch (err) {
      console.error("artifact copy failed", err);
    } finally {
      copying = false;
    }
  }
</script>

<div
  class="doc-card artifact-card chat-shell"
  data-testid={kind === "details" ? "message-details" : "message-prompt"}
  data-artifact-card="true"
  data-kind={kind}
  data-event={eventId}
  data-artifact-id={artifact.id}
  role="button"
  tabindex="0"
  aria-label={`Open ${artifact.kindLabel.toLowerCase()} artifact: ${artifact.title}`}
  onclick={open}
  onkeydown={onKeydown}
>
  <!-- Neutral, not kind-tinted: only files carry a kind hue (folder,
       document, image), as on iOS. The gradient mesh tile this replaced was
       the only animated surface in the chat column. -->
  <span class="doc-card-icon" aria-hidden="true">
    <RailIcon name={kind === "prompt" ? "terminal" : "file-text"} size={16} />
  </span>
  <span class="doc-card-copy">
    <span class="doc-card-title artifact-card-title" data-testid="artifact-card-title"
      >{artifact.title}</span
    >
    {#if summary}
      <span class="doc-card-summary artifact-card-summary" data-testid="artifact-card-preview"
        >{summary}</span
      >
    {/if}
    <span class="doc-card-meta artifact-card-meta">
      <span class="artifact-card-kind" data-testid="artifact-card-kind"
        >{artifact.kindLabel}</span
      >
      <span aria-hidden="true">·</span>
      <span class="artifact-card-size" data-testid="artifact-card-size"
        >{artifact.sizeLabel}</span
      >
    </span>
  </span>
  <span class="doc-card-actions artifact-card-actions">
    <Tooltip label={copied ? "Copied" : "Copy"}>
      {#snippet trigger(id)}
        <button
          type="button"
          class="doc-card-btn artifact-card-btn"
          data-testid={kind === "details"
            ? "message-details-copy"
            : "message-prompt-copy"}
          aria-describedby={id || undefined}
          onclick={copy}
          disabled={copying}
          aria-label={copied
            ? `${artifact.kindLabel} copied`
            : `Copy ${artifact.kindLabel.toLowerCase()}`}
        ><RailIcon name={copied ? "check" : "copy"} /></button>
      {/snippet}
    </Tooltip>
    <Tooltip label="Open in side pane">
      {#snippet trigger(id)}
        <button
          type="button"
          class="doc-card-btn artifact-card-btn artifact-card-open"
          data-testid="artifact-card-open"
          aria-describedby={id || undefined}
          onclick={(e) => {
            e.stopPropagation();
            open();
          }}
          aria-label={`Open ${artifact.kindLabel.toLowerCase()} in side pane`}
        ><RailIcon name="external" /></button>
      {/snippet}
    </Tooltip>
  </span>
</div>
