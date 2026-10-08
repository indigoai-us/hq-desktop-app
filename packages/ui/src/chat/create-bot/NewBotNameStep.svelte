<script lang="ts">
  /**
   * The first New bot step on every path: the bot's name. It is asked before
   * Cloud or Local, so the rule is the one both homes share
   * (`newBotNameIssue`). The parent owns the `.new-bot-create` wrapper; this
   * renders the head, the field and the footer inside it.
   */
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { onMount, tick, untrack } from "svelte";
  import NewBotStepHead from "./NewBotStepHead.svelte";
  import { NAME_MAX, NAME_STEP_TITLE, botHandle, newBotNameIssue } from "./create-bot-model.js";

  interface Props {
    /** The name to start with: one typed earlier, a suggestion, or "". */
    name: string;
    total: number;
    current?: number;
    /** Back from the name. Without it the step has no Back. */
    onback?: (() => void) | null;
    backTestId?: string;
    disabled?: boolean;
    /** Every change, so a parent that keeps the draft keeps what is typed. */
    oninput?: ((name: string) => void) | null;
    oncontinue: (name: string) => void;
  }

  let {
    name: initialName,
    total,
    current = 1,
    onback = null,
    backTestId,
    disabled = false,
    oninput = null,
    oncontinue,
  }: Props = $props();

  // Seeded once: the field is the person's from here on.
  let name = $state(untrack(() => initialName));
  let attempted = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);
  const issue = $derived(newBotNameIssue(name));
  const handle = $derived(botHandle({ name, handle: "" }));

  onMount(() => {
    void tick().then(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  });

  function submit(): void {
    if (disabled) return;
    attempted = true;
    if (issue) return;
    oncontinue(name.trim());
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    submit();
  }
</script>

<NewBotStepHead
  {total}
  {current}
  {onback}
  {backTestId}
  backDisabled={disabled}
  kicker={NAME_STEP_TITLE.kicker}
  lead={NAME_STEP_TITLE.lead}
  em={NAME_STEP_TITLE.em}
/>

<div class="new-bot-create-scroll" data-testid="new-bot-create-scroll">
  <section class="new-bot-step" data-testid="new-bot-step-name">
    <p class="new-bot-create-copy">{NAME_STEP_TITLE.copy}</p>
    <label class="new-bot-create-label" for="new-bot-name">Name</label>
    <input
      bind:this={inputEl}
      id="new-bot-name"
      class="new-bot-create-input"
      data-testid="new-bot-name"
      type="text"
      value={name}
      maxlength={NAME_MAX + 20}
      autocomplete="off"
      spellcheck="false"
      aria-invalid={attempted && issue ? "true" : undefined}
      aria-describedby="new-bot-name-issue"
      {disabled}
      onkeydown={onKeydown}
      oninput={(event) => {
        name = (event.currentTarget as HTMLInputElement).value;
        oninput?.(name);
      }}
    />
    {#if handle && !issue}
      <p class="new-bot-price" data-testid="new-bot-name-handle">Teammates mention it as @{handle}.</p>
    {/if}
  </section>
</div>

<footer class="new-bot-create-foot">
  {#if attempted && issue}
    <p id="new-bot-name-issue" class="new-bot-create-error" role="alert" data-testid="new-bot-name-issue">{issue}</p>
  {/if}
  <button
    type="button"
    class="new-bot-create-submit"
    data-testid="new-bot-continue-name"
    {disabled}
    onclick={submit}
  ><RailIcon name="arrow-right" />Continue</button>
</footer>
