<script lang="ts">
  import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
  import Check from "phosphor-svelte/lib/Check";
  import CopySimple from "phosphor-svelte/lib/CopySimple";
  import FileText from "phosphor-svelte/lib/FileText";
  import Terminal from "phosphor-svelte/lib/Terminal";
  /**
   * ArtifactCard — the collapsed tile under a chat bubble for a long
   * structured artifact (`hq dm --details` / `--prompt`, delegation + handoff
   * cards).
   *
   * Deliberately small: an icon well, the title, a one-line plain-text
   * summary, and the size. No preview body — the card is a handle; the host's
   * right side pane (artifact mode) shows the FULL content. Copy / Open
   * surface on hover and focus, and the whole card is a keyboard-reachable
   * button.
   *
   * It shares `doc-card.css` with the file attachment card. Both say "there
   * is more here than the message shows", so they are the same object with
   * different contents — the animated gradient mesh tile this used to carry
   * made it read as something else entirely, and was the only gradient in
   * the shell.
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
      <Terminal size={15} aria-hidden="true" />
    {:else}
      <FileText size={15} aria-hidden="true" />
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
      <span class="doc-card-kind" data-testid="artifact-card-kind"
        >{artifact.kindLabel}</span
      >
      <span aria-hidden="true">·</span>
      <span data-testid="artifact-card-size">{artifact.sizeLabel}</span>
    </span>
  </span>
  <span class="doc-card-actions">
    <Tooltip label={copied ? "Copied" : "Copy"} delay={250}>
      {#snippet trigger(tipId)}
        <button
          type="button"
          class="doc-card-btn"
          data-testid={kind === "details"
            ? "message-details-copy"
            : "message-prompt-copy"}
          aria-describedby={tipId}
          onclick={copy}
          disabled={copying}
          aria-label={copied
            ? `${artifact.kindLabel} copied`
            : `Copy ${artifact.kindLabel.toLowerCase()}`}
        >
          {#if copied}
            <Check size={15} weight="bold" aria-hidden="true" />
          {:else}
            <CopySimple size={15} aria-hidden="true" />
          {/if}
        </button>
      {/snippet}
    </Tooltip>
    <Tooltip label="Open" delay={250}>
      {#snippet trigger(tipId)}
        <button
          type="button"
          class="doc-card-btn is-primary"
          data-testid="artifact-card-open"
          aria-describedby={tipId}
          onclick={(e) => {
            e.stopPropagation();
            open();
          }}
          aria-label={`Open ${artifact.kindLabel.toLowerCase()} in side pane`}
        >
          <ArrowSquareOut size={15} aria-hidden="true" />
        </button>
      {/snippet}
    </Tooltip>
  </span>
</div>

<style>
  /* Shell, type and buttons all come from `doc-card.css`, which the file
     attachment card uses too. The only thing left here is the icon glyph
     sizing — the shared well is sized for a three-letter file type. */
  .artifact-card :global(.doc-card-icon svg) {
    width: 15px;
    height: 15px;
  }
</style>
