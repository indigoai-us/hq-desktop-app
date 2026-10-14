<!--
  ForwardedBlock — the forwarded part of a forwarded message (US-008).

  The header is fixed text built from the server's structured `forwardedFrom`
  field. Body text is never parsed for it, so a message that merely starts
  with "Forwarded from" cannot produce this header. The caller renders the
  forwarded body, artifact cards and attachments as `children` with the same
  components it uses for any message. No left accent bar; theme tokens only.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    omittedAttachmentsLabel,
    type ForwardedFromModel,
  } from "./channelMessageModels";

  interface Props {
    forwardedFrom: ForwardedFromModel;
    omittedAttachments?: number;
    children: Snippet;
  }

  let { forwardedFrom, omittedAttachments = 0, children }: Props = $props();

  const omittedLabel = $derived(omittedAttachmentsLabel(omittedAttachments));
  const originalTime = $derived.by(() => {
    const t = Date.parse(forwardedFrom.originalCreatedAt);
    return Number.isNaN(t) ? undefined : new Date(t).toLocaleString();
  });
</script>

<div class="forwarded-block" data-testid="forwarded-block">
  <div class="forwarded-header" data-testid="forwarded-header" title={originalTime}>
    Forwarded from {forwardedFrom.senderName}
  </div>
  <div class="forwarded-body">
    {@render children()}
  </div>
  {#if omittedLabel}
    <div class="forwarded-omitted" data-testid="forwarded-omitted">{omittedLabel}</div>
  {/if}
</div>

<style>
  .forwarded-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-1);
  }
  .forwarded-header,
  .forwarded-omitted {
    font-size: var(--text-sm);
    color: var(--muted);
  }
  .forwarded-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
</style>
