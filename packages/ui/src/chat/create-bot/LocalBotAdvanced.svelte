<script lang="ts">
  /**
   * The Local bot's "Fine-tune" step, the last optional one: the @handle it
   * is created under, permissions and memory. None of them can change after
   * the bot exists, so each keeps its default unless the person changes it
   * here. Who it is for has its own step; the title, avatar and model are
   * asked in the bot's first message (`newBotKickoff`).
   */
  import { hostComputerNoun } from "@hq/platform";
  import {
    botHandle,
    localHandleIssue,
    type BotMemory,
    type CreateBotDraft,
  } from "./create-bot-model.js";
  import "./create-bot.css";

  interface Props {
    draft: CreateBotDraft;
    existingNames: readonly string[];
    /**
     * Bumped each time Finish sends the person here to fix the handle,
     * including when they are already here: the field takes focus each time.
     */
    focusHandle?: number;
    disabled?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
  }

  let { draft, existingNames, focusHandle = 0, disabled = false, onpatch }: Props = $props();

  /** "Mac", "PC" or "computer", read once so the copy never renames the machine mid-flow. */
  const hostNoun = hostComputerNoun();
  const handle = $derived(botHandle(draft));
  const handleError = $derived(localHandleIssue(draft, existingNames));

  let handleInput = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if (focusHandle > 0) handleInput?.focus();
  });
</script>

<div class="cb-step new-bot-tune" data-testid="chat-bot-advanced">
  <div class="cb-field">
    <label class="cb-label" for="create-bot-handle">Handle</label>
    <input
      id="create-bot-handle"
      class="cb-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-testid="chat-bot-handle"
      bind:this={handleInput}
      placeholder="scout-2"
      aria-describedby="create-bot-handle-help"
      aria-invalid={handleError ? "true" : undefined}
      value={handle}
      {disabled}
      oninput={(event) => onpatch({ handle: (event.currentTarget as HTMLInputElement).value })}
    />
    <p class="cb-help" class:error={handleError} id="create-bot-handle-help" data-testid="chat-bot-handle-help">
      {handleError ?? `@${handle} is how the bot is mentioned and what the CLI calls it.`}
    </p>
  </div>

  <div class="cb-field">
    <span class="cb-label" id="create-bot-approve-label">Permissions</span>
    <button
      type="button"
      class="cb-switch"
      role="switch"
      aria-checked={draft.autoApprove}
      aria-labelledby="create-bot-approve-label"
      data-testid="chat-bot-auto-approve"
      {disabled}
      onclick={() => onpatch({ autoApprove: !draft.autoApprove })}
    >
      {draft.autoApprove ? "Pre-approve every action" : "Ask before each action"}
    </button>
    <p class="cb-help">
      {draft.autoApprove
        ? "The bot runs tools and commands without asking. It can't answer prompts on its own."
        : "Gated commands will fail. A bot can't answer approval prompts."}
    </p>
  </div>

  <div class="cb-field">
    <span class="cb-label" id="create-bot-memory-label">Memory</span>
    <div class="cb-pills" role="radiogroup" aria-labelledby="create-bot-memory-label">
      {#each [{ id: "synced", label: "HQ synced" }, { id: "local", label: `This ${hostNoun} only` }] as const as option (option.id)}
        <button
          type="button"
          class="cb-pill"
          role="radio"
          aria-checked={draft.memory === option.id}
          data-testid={`chat-bot-memory-${option.id}`}
          {disabled}
          onclick={() => onpatch({ memory: option.id as BotMemory })}
        >
          {option.label}
        </button>
      {/each}
    </div>
    <p class="cb-help">
      {draft.memory === "synced"
        ? "What the bot learns syncs with your HQ, so it follows you across machines."
        : `Notes and memory stay on this ${hostNoun}.`}
    </p>
  </div>
</div>
