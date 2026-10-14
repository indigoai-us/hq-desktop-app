<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * ArtifactCard — the collapsed tile under a chat bubble for a long
   * structured artifact (`hq dm --details` / `--prompt`, delegation + handoff
   * cards).
   *
   * Deliberately small: an icon well, the title, a one-line plain-text
   * summary, and the size. No preview body — the card is a handle; the host's
   * right side pane (artifact mode) shows the FULL content. Copy / Open are
   * icon buttons that surface on hover and keyboard focus, and the whole card
   * is a keyboard-reachable button.
   *
   * It shares `doc-card.css` with the file attachment card. Both say "there
   * is more here than the message shows", so they are the same object with
   * different contents — the animated gradient mesh tile this used to carry
   * made it read as something else, and was the only gradient in the shell.
   */
  import Tooltip from "../../common/Tooltip.svelte";
  import "./doc-card.css";
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
    // Only the card itself. Enter / Space on Copy or Open bubble up here, and
    // swallowing them would open the pane instead of pressing that button.
    if (e.target !== e.currentTarget) return;
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
  <span class="doc-card-icon" aria-hidden="true">
    {#if kind === "prompt"}
      <RailIcon name="terminal-window" size={16} />
    {:else}
      <RailIcon name="file-text" size={16} />
    {/if}
  </span>
  <span class="doc-card-copy">
    <span class="doc-card-title" data-testid="artifact-card-title"
      >{artifact.title}</span
    >
    {#if summary}
      <span class="doc-card-summary" data-testid="artifact-card-preview"
        >{summary}</span
      >
    {/if}
    <span class="doc-card-meta">
      <span data-testid="artifact-card-kind">{artifact.kindLabel}</span>
      <span aria-hidden="true">·</span>
      <span data-testid="artifact-card-size">{artifact.sizeLabel}</span>
    </span>
  </span>
  <span class="doc-card-actions">
    <Tooltip label={copied ? "Copied" : "Copy"} delay={250} align="end">
      {#snippet trigger(tipId: string)}
        <button
          type="button"
          class="doc-card-btn"
          data-testid={kind === "details"
            ? "message-details-copy"
            : "message-prompt-copy"}
          aria-describedby={tipId || undefined}
          onclick={copy}
          disabled={copying}
          aria-label={copied
            ? `${artifact.kindLabel} copied`
            : `Copy ${artifact.kindLabel.toLowerCase()}`}
        >
          <RailIcon name={copied ? "check" : "copy"} size={15} />
        </button>
      {/snippet}
    </Tooltip>
    <Tooltip label="Open" delay={250} align="end">
      {#snippet trigger(tipId: string)}
        <button
          type="button"
          class="doc-card-btn is-primary"
          data-testid="artifact-card-open"
          aria-describedby={tipId || undefined}
          onclick={(e) => {
            e.stopPropagation();
            open();
          }}
          aria-label={`Open ${artifact.kindLabel.toLowerCase()} in side pane`}
        >
          <RailIcon name="external" size={15} />
        </button>
      {/snippet}
    </Tooltip>
  </span>
</div>

<style>
  /* Shell, type and buttons all come from `doc-card.css`, which the file
     attachment card uses too, so the two cannot drift apart. */
  .artifact-card:active {
    transform: scale(0.995);
  }

  @media (prefers-reduced-motion: reduce) {
    .artifact-card:active {
      transform: none;
    }
  }
</style>
