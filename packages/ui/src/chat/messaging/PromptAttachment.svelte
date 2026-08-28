<script lang="ts">
  /**
   * Highlighted attachment card under a chat bubble.
   * Short preview of `hq dm --prompt` / `--details` + one-click copy.
   */
  import { copyableText, promptPreview } from "./conversation-copy.js";

  interface Props {
    text: string;
    eventId: string;
    kind?: "prompt" | "details";
  }

  let { text, eventId, kind = "prompt" }: Props = $props();

  let copied = $state(false);
  let copying = $state(false);

  const label = $derived(kind === "details" ? "Details" : "Prompt");
  const copyLabel = $derived(
    kind === "details" ? "Copy details" : "Copy prompt",
  );
  const preview = $derived(promptPreview(text));

  async function copy(): Promise<void> {
    const payload = kind === "details" ? { details: text } : { prompt: text };
    const copiedText = copyableText(payload, kind);
    if (!copiedText || copying) return;
    copying = true;
    try {
      await navigator.clipboard.writeText(copiedText);
      copied = true;
      setTimeout(() => {
        if (copied) copied = false;
      }, 1800);
    } catch (err) {
      console.error("prompt copy failed", err);
    } finally {
      copying = false;
    }
  }
</script>

<div
  class="prompt-card chat-shell"
  data-testid={kind === "details" ? "message-details" : "message-prompt"}
  data-kind={kind}
  data-event={eventId}
>
  <div class="prompt-card-head">
    <span class="prompt-card-label">{label}</span>
    <button
      type="button"
      class="prompt-card-copy"
      data-testid={kind === "details"
        ? "message-details-copy"
        : "message-prompt-copy"}
      onclick={copy}
      disabled={copying}
      aria-label={copied ? `${label} copied` : copyLabel}
    >
      {copied ? "Copied!" : copyLabel}
    </button>
  </div>
  <pre class="prompt-card-preview">{preview}</pre>
</div>

<style>
  .prompt-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 2px;
    padding: 10px 12px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    background: var(--sel, rgba(255, 255, 255, 0.06));
  }

  .prompt-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .prompt-card-label {
    color: var(--t2, rgba(255, 255, 255, 0.56));
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .prompt-card-copy {
    appearance: none;
    flex: 0 0 auto;
    padding: 3px 8px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.12));
    border-radius: 6px;
    background: var(--btn-bg, rgba(255, 255, 255, 0.07));
    color: var(--t1, rgba(255, 255, 255, 0.95));
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .prompt-card-copy:hover:not(:disabled) {
    background: var(--hover, rgba(255, 255, 255, 0.08));
  }

  .prompt-card-copy:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .prompt-card-preview {
    margin: 0;
    color: var(--t1, rgba(255, 255, 255, 0.88));
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
    line-height: 16px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
