<script lang="ts">
  /**
   * The local "Start from" step: Blank (the default) or one of the company's
   * workers, as a grid of cards that fits the card without scrolling. With
   * more templates than fit, "More templates" swaps the next page in place.
   */
  import type { LocalBotWorkerOption } from "@hq/platform";
  import { templateBringsLine, templateCard, type CreateBotDraft, type TemplateCard } from "./create-bot-model.js";

  interface Props {
    draft: CreateBotDraft;
    templates: readonly LocalBotWorkerOption[];
    disabled?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
    /** Cards per page, Blank included on the first. */
    pageSize?: number;
  }

  let { draft, templates, disabled = false, onpatch, pageSize = 6 }: Props = $props();

  const cards = $derived.by<TemplateCard[]>(() => {
    const seen = new Set<string>();
    const out: TemplateCard[] = [];
    for (const option of templates) {
      const card = templateCard(option);
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      out.push(card);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });
  /** Page 0 holds Blank and the first templates; later pages hold templates only. */
  const firstPageTemplates = $derived(Math.max(1, pageSize - 1));
  const pages = $derived(
    cards.length <= firstPageTemplates ? 1 : 1 + Math.ceil((cards.length - firstPageTemplates) / pageSize),
  );
  let page = $state(0);
  const shown = $derived(
    page === 0
      ? cards.slice(0, firstPageTemplates)
      : cards.slice(firstPageTemplates + (page - 1) * pageSize, firstPageTemplates + page * pageSize),
  );
  const chosen = $derived(
    draft.kind === "template" && draft.templateId ? (cards.find((c) => c.id === draft.templateId) ?? null) : null,
  );
  const bringsLine = $derived(chosen ? templateBringsLine(chosen) : "");

  function pickBlank(): void {
    if (disabled) return;
    onpatch({ kind: "blank", templateId: undefined });
  }

  function pickTemplate(id: string): void {
    if (disabled) return;
    onpatch({ kind: "template", templateId: id });
  }

  function onKey(event: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const buttons = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    event.preventDefault();
    buttons[(at + (forward ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }
</script>

<div class="new-bot-step-body" data-testid="create-bot-template-step">
  <div class="new-bot-options new-bot-options--3" role="radiogroup" aria-label="Start from" data-testid="create-bot-templates" tabindex="-1" onkeydown={onKey}>
    {#if page === 0}
      <button
        type="button"
        class="new-bot-option"
        role="radio"
        aria-checked={draft.kind === "blank"}
        data-testid="create-bot-kind-blank"
        {disabled}
        onclick={pickBlank}
      >
        <span class="new-bot-option-title">Blank</span>
        <span class="new-bot-option-sub">A general helper with your permissions.</span>
      </button>
    {/if}
    {#each shown as card (card.id)}
      <button
        type="button"
        class="new-bot-option"
        role="radio"
        aria-checked={draft.kind === "template" && draft.templateId === card.id}
        data-testid="create-bot-template-card"
        data-template={card.id}
        title={card.summary || card.name}
        {disabled}
        onclick={() => pickTemplate(card.id)}
      >
        <span class="new-bot-option-title">{card.name}</span>
        {#if card.summary}<span class="new-bot-option-sub new-bot-option-sub--clamp">{card.summary}</span>{/if}
      </button>
    {/each}
  </div>
  <div class="new-bot-step-meta">
    {#if bringsLine}
      <p class="new-bot-option-note" data-testid="chat-bot-template-brings">{bringsLine}</p>
    {/if}
    {#if pages > 1}
      <button
        type="button"
        class="new-bot-more"
        data-testid="create-bot-templates-more"
        {disabled}
        onclick={() => (page = (page + 1) % pages)}
      >{page + 1 < pages ? "More templates" : "Back to the first templates"}</button>
    {/if}
  </div>
</div>
