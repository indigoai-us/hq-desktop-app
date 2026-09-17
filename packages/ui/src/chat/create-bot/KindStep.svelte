<script lang="ts">
  /**
   * Step A — What kind of bot? Two cards: Blank (picks and moves on) and
   * From a template, which reveals the company worker library (search,
   * grouped by company). Arrow keys move within a list, Enter picks.
   */
  import type { LocalBotWorkerOption } from "@hq/platform";
  import {
    groupTemplates,
    type BotKindChoice,
    type CreateBotDraft,
  } from "./create-bot-model.js";
  import "./create-bot.css";

  interface Props {
    draft: CreateBotDraft;
    templates: readonly LocalBotWorkerOption[];
    disabled?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
    /** Blank advances on pick; a template advances on Enter or double-click. */
    onadvance?: () => void;
  }

  let { draft, templates, disabled = false, onpatch, onadvance }: Props = $props();

  let query = $state("");
  const groups = $derived(groupTemplates(templates, query));
  const hasTemplates = $derived(templates.length > 0);

  const KINDS: ReadonlyArray<{ id: BotKindChoice; title: string; sub: string }> = [
    { id: "blank", title: "Blank", sub: "A general helper with your permissions." },
    { id: "template", title: "From a template", sub: "Start from a worker your company already has." },
  ];

  function kindEnabled(id: BotKindChoice): boolean {
    if (disabled) return false;
    if (id === "template") return hasTemplates;
    return true;
  }

  function pickKind(id: BotKindChoice): void {
    if (!kindEnabled(id)) return;
    onpatch({ kind: id });
  }

  /** A click (or Enter/Space) on a card. Blank needs nothing more, so it moves on. */
  function chooseKind(id: BotKindChoice): void {
    if (!kindEnabled(id)) return;
    if (id === "blank") {
      onpatch({ kind: "blank", templateId: undefined });
      onadvance?.();
      return;
    }
    onpatch({ kind: id });
  }

  function pickTemplate(id: string): void {
    onpatch({ kind: "template", templateId: id });
  }

  /** Roving arrows inside a card list; Enter/Space activate the focused card. */
  function onListKey(event: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (at + 1) % buttons.length;
    else next = (at - 1 + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
  }

  function onRadioKey(event: KeyboardEvent): void {
    onListKey(event);
    const el = document.activeElement as HTMLElement | null;
    const id = el?.dataset.kind as BotKindChoice | undefined;
    if (id && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) pickKind(id);
  }
</script>

<div class="cb-step" data-testid="create-bot-kind-step">
  <p class="cb-lede">Every AI teammate is a bot. Start blank, or from one of your company's workers.</p>
  <div class="cb-cards" role="radiogroup" aria-label="What kind of bot?" data-testid="create-bot-kinds" tabindex="-1" onkeydown={onRadioKey}>
    {#each KINDS as kind (kind.id)}
      <button
        type="button"
        class="cb-card"
        role="radio"
        aria-checked={draft.kind === kind.id}
        data-testid={`create-bot-kind-${kind.id}`}
        data-kind={kind.id}
        disabled={!kindEnabled(kind.id)}
        tabindex={draft.kind === kind.id ? 0 : -1}
        onclick={() => chooseKind(kind.id)}
      >
        <span class="cb-card-ic" aria-hidden="true">
          {#if kind.id === "blank"}
            <svg viewBox="0 0 16 16" fill="none"><rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.3" /><path d="M8 6v4M6 8h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
          {:else}
            <svg viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M3 8h10M3 11.5h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
          {/if}
        </span>
        <span class="cb-card-title">{kind.title}</span>
        <span class="cb-card-sub">
          {kind.id === "template" && !hasTemplates ? "Your companies have no workers to start from yet." : kind.sub}
        </span>
      </button>
    {/each}
  </div>

  {#if draft.kind === "template" && hasTemplates}
    <div class="cb-field">
      <label class="cb-label" for="create-bot-template-search">Templates</label>
      <input
        id="create-bot-template-search"
        class="cb-search"
        type="search"
        placeholder="Search templates by name, company, or what they do"
        autocomplete="off"
        data-testid="create-bot-template-search"
        bind:value={query}
        onkeydown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            (event.currentTarget.parentElement?.querySelector('[data-testid="create-bot-template-card"]:not([disabled])') as HTMLButtonElement | null)?.focus();
          }
        }}
      />
      <div class="cb-library" role="listbox" aria-label="Templates" data-testid="create-bot-templates" tabindex="-1" onkeydown={onListKey}>
        {#if groups.length === 0}
          <p class="cb-empty" data-testid="create-bot-templates-empty">No templates match “{query}”.</p>
        {/if}
        {#each groups as group (group.company)}
          <div class="cb-group" role="group" aria-label={group.label}>
            <span class="cb-group-title">{group.label}</span>
            {#each group.templates as card (card.id)}
              <button
                type="button"
                class="cb-card"
                role="option"
                aria-selected={draft.templateId === card.id}
                data-testid="create-bot-template-card"
                data-template={card.id}
                disabled={disabled}
                onclick={() => pickTemplate(card.id)}
                ondblclick={() => {
                  pickTemplate(card.id);
                  onadvance?.();
                }}
                onkeydown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    pickTemplate(card.id);
                    onadvance?.();
                  }
                }}
              >
                <span class="cb-card-row">
                  <span class="cb-card-title">{card.name}</span>
                  {#if card.skillCount != null}
                    <span class="cb-card-meta">{card.skillCount === 1 ? "1 skill" : `${card.skillCount} skills`}</span>
                  {/if}
                  <span class="cb-card-meta">{group.label}</span>
                </span>
                {#if card.summary}
                  <span class="cb-card-sub">{card.summary}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
