<script lang="ts">
  /**
   * A single-line text field inside a card modal: a label, the field, an
   * optional hint, and a line for what is wrong with what was typed.
   */
  import { CARD_MODAL_AUTOFOCUS } from "./card-modal.js";

  interface Props {
    label: string;
    value?: string;
    placeholder?: string;
    /** A quiet line under the field. Hidden while there is an error. */
    hint?: string | null;
    /** What is wrong, in one sentence. The field is marked invalid. */
    error?: string | null;
    disabled?: boolean;
    type?: "text" | "url" | "email" | "password";
    name?: string;
    /** Take focus when the modal opens. */
    autofocus?: boolean;
    oninput?: (value: string) => void;
    /** Enter was pressed in the field. */
    onsubmit?: (value: string) => void;
  }

  let {
    label,
    value = $bindable(""),
    placeholder = "",
    hint = null,
    error = null,
    disabled = false,
    type = "text",
    name,
    autofocus = false,
    oninput,
    onsubmit,
  }: Props = $props();

  const uid = $props.id();
  const inputId = `card-modal-field-${uid}`;
  const noteId = `card-modal-field-note-${uid}`;
  const autofocusMark = $derived(autofocus ? { [CARD_MODAL_AUTOFOCUS]: "" } : {});
</script>

<div class="card-modal-field" data-testid="card-modal-field" data-invalid={error ? "true" : "false"}>
  <label class="card-modal-field-label" for={inputId}>{label}</label>
  <input
    id={inputId}
    class="card-modal-field-input"
    {type}
    {name}
    {placeholder}
    {disabled}
    autocomplete="off"
    spellcheck="false"
    aria-invalid={error ? "true" : undefined}
    aria-describedby={error || hint ? noteId : undefined}
    bind:value
    oninput={() => oninput?.(value)}
    onkeydown={(event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        onsubmit?.(value);
      }
    }}
    {...autofocusMark}
  />
  {#if error}
    <p class="card-modal-field-error" data-testid="card-modal-field-error" id={noteId} role="alert">{error}</p>
  {:else if hint}
    <p class="card-modal-field-hint" id={noteId}>{hint}</p>
  {/if}
</div>
