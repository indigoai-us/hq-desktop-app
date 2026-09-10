<script lang="ts">
  interface Props {
    open: boolean;
    messageBody: string;
    notes: string;
    pending?: boolean;
    error?: string;
    onnotes: (value: string) => void;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    open,
    messageBody,
    notes,
    pending = false,
    error = "",
    onnotes,
    onconfirm,
    oncancel,
  }: Props = $props();

  function onKey(e: KeyboardEvent): void {
    if (!open || pending) return;
    if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    }
  }

  function portal(node: HTMLElement) {
    if (typeof document === "undefined") return {};
    const host =
      document.querySelector<HTMLElement>(".desktop-shell") ?? document.body;
    host.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="generate-backdrop"
    data-testid="generate-task-notes"
    role="presentation"
    use:portal
    onclick={(e) => {
      if (e.target === e.currentTarget && !pending) oncancel();
    }}
  >
    <div
      class="generate-card"
      role="dialog"
      aria-modal="true"
      aria-label="Generate task from message"
    >
      <h2>Generate task</h2>
      <p class="hint">A background session will write a full Board task from this message.</p>
      <blockquote data-testid="generate-task-source">{messageBody || "(empty message)"}</blockquote>
      <label>
        Notes for the session (optional)
        <textarea
          value={notes}
          maxlength="2000"
          disabled={pending}
          placeholder="Anything the session should know"
          oninput={(e) => onnotes(e.currentTarget.value)}
        ></textarea>
      </label>
      {#if error}<p role="alert">{error}</p>{/if}
      <div class="actions">
        <button type="button" disabled={pending} onclick={oncancel}>Cancel</button>
        <button type="button" disabled={pending} onclick={onconfirm}>
          {pending ? "Starting…" : "Generate task"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .generate-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40000;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.62);
  }
  .generate-card {
    width: min(480px, 100%);
    padding: 18px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 10px;
    background: var(--v4-surface-solid, var(--elevated, #1e1e24));
    color: var(--t1);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  }
  h2 {
    margin: 0;
    font: 600 14px/1.3 var(--font-ui);
  }
  .hint {
    margin: 8px 0 0;
    color: var(--t2);
    font: 400 13px/1.45 var(--font-ui);
  }
  blockquote {
    margin: 12px 0;
    padding: 8px 10px;
    border-left: 2px solid var(--line2, rgba(255, 255, 255, 0.2));
    color: var(--t2);
    font: 400 13px/1.45 var(--font-ui);
    white-space: pre-wrap;
    max-height: 8rem;
    overflow: auto;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font: 500 12px/1.3 var(--font-ui);
  }
  textarea {
    min-height: 72px;
    resize: vertical;
    font: 400 13px/1.4 var(--font-ui);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
</style>
