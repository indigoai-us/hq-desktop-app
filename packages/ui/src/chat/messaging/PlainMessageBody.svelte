<script lang="ts">
  /**
   * Renders a "heavy" message body (agent log/JSON dumps, very long replies)
   * as escaped plain text. Full Markdown on these bodies freezes the click
   * loop, so `renderMessageBodyMarkdown` routes them here as plain text — but
   * historically it hard-clipped to `MESSAGE_PLAIN_DISPLAY_CHARS` and appended
   * an ellipsis with NO way to read the rest (see the 2026-09-05 DM smoke).
   *
   * This component keeps the clipped preview by default (small a11y tree / fast
   * click loop for the common case of many bubbles) and adds an accessible
   * "Show more" / "Show less" toggle so the full body is reachable on demand,
   * one bubble at a time. The toggle is a real <button> (keyboard reachable,
   * carries `aria-expanded`). Text stays selectable; newlines are preserved.
   */
  import {
    clipMessageBodyForDisplay,
    MESSAGE_PLAIN_DISPLAY_CHARS,
  } from "../../common/messageMarkdown.js";

  interface Props {
    body: string;
  }

  let { body }: Props = $props();

  let expanded = $state(false);

  const overflows = $derived(body.length > MESSAGE_PLAIN_DISPLAY_CHARS);
  const shown = $derived(
    expanded || !overflows ? body : clipMessageBodyForDisplay(body),
  );
</script>

<div class="plain-body-wrap">
  <pre class="plain-body" class:plain-body-expanded={expanded}>{shown}</pre>
  {#if overflows}
    <button
      type="button"
      class="plain-body-toggle"
      aria-expanded={expanded}
      data-testid="plain-body-toggle"
      onclick={(e) => {
        e.stopPropagation();
        expanded = !expanded;
      }}
    >
      {expanded ? "Show less" : "Show more"}
    </button>
  {/if}
</div>

<style>
  .plain-body-wrap {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .plain-body {
    margin: 0;
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--raised, rgba(255, 255, 255, 0.04));
    color: var(--t1, var(--message-markdown-text, inherit));
    font: 12px/1.4 var(--font-mono, ui-monospace, Menlo, monospace);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* When expanded, cap the height so an enormous dump stays scrollable rather
     than pushing the whole thread. Collapsed content is already short. */
  .plain-body-expanded {
    max-height: 480px;
    overflow: auto;
  }

  .plain-body-toggle {
    appearance: none;
    border: none;
    background: none;
    padding: 2px 0;
    color: var(--vio-ink, var(--accent, #7c8cff));
    font: 600 12px/1.2 inherit;
    cursor: pointer;
  }

  .plain-body-toggle:hover {
    text-decoration: underline;
  }

  .plain-body-toggle:focus-visible {
    outline: 2px solid var(--vio-ink, var(--accent, #7c8cff));
    outline-offset: 2px;
    border-radius: 4px;
  }
</style>
