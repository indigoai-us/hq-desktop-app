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
  import { NAME_MAX, NAME_STEP_TITLE, botHandle, newBotNameIssue, type StepTitle } from "./create-bot-model.js";

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
    /** Heading and copy. Default: the New bot name step's. */
    title?: StepTitle;
    /** The name rule. Default: `newBotNameIssue`. */
    issueFor?: (name: string) => string | null;
    /** Show "Teammates mention it as @handle." under the field. */
    showHandle?: boolean;
    /** The forward button's label ("Next: Your coding tools"). Default "Continue". */
    nextLabel?: string;
    /**
     * "Finish with defaults" beside the forward button. Without it the step
     * has the one forward button.
     */
    onfinish?: ((name: string) => void) | null;
    /** A quiet line under the field (why it cannot be changed now). */
    note?: string;
    /** The field cannot be changed, but the step still moves on. */
    locked?: boolean;
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
    title = NAME_STEP_TITLE,
    issueFor = newBotNameIssue,
    showHandle = true,
    nextLabel = "",
    onfinish = null,
    note = "",
    locked = false,
  }: Props = $props();

  // Seeded once: the field is the person's from here on.
  let name = $state(untrack(() => initialName));
  let attempted = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);
  const issue = $derived(issueFor(name));
  const handle = $derived(botHandle({ name, handle: "" }));

  onMount(() => {
    void tick().then(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  });

  function submit(finish = false): void {
    if (disabled) return;
    attempted = true;
    if (issue) return;
    if (finish && onfinish) onfinish(name.trim());
    else oncontinue(name.trim());
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
  kicker={title.kicker}
  lead={title.lead}
  em={title.em}
/>

<div class="new-bot-create-scroll" data-testid="new-bot-create-scroll">
  <section class="new-bot-step" data-testid="new-bot-step-name">
    <p class="new-bot-create-copy">{title.copy}</p>
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
      disabled={disabled || locked}
      onkeydown={onKeydown}
      oninput={(event) => {
        name = (event.currentTarget as HTMLInputElement).value;
        oninput?.(name);
      }}
    />
    {#if showHandle && handle && !issue}
      <p class="new-bot-price" data-testid="new-bot-name-handle">Teammates mention it as @{handle}.</p>
    {/if}
    {#if note}
      <p class="new-bot-price" data-testid="new-bot-name-note">{note}</p>
    {/if}
  </section>
</div>

<footer class="new-bot-create-foot">
  {#if attempted && issue}
    <p id="new-bot-name-issue" class="new-bot-create-error" role="alert" data-testid="new-bot-name-issue">{issue}</p>
  {/if}
  {#if onfinish}
    <!-- "Next: <step>" and "Finish with defaults", side by side. -->
    <div class="new-bot-foot-actions">
      <button
        type="button"
        class="new-bot-create-next"
        data-testid="new-bot-continue-name"
        {disabled}
        onclick={() => submit()}
      >{nextLabel || "Continue"}<RailIcon name="arrow-right" /></button>
      <button
        type="button"
        class="new-bot-create-submit"
        data-testid="new-bot-finish-name"
        {disabled}
        onclick={() => submit(true)}
      >Finish with defaults</button>
    </div>
  {:else}
    <button
      type="button"
      class="new-bot-create-submit"
      data-testid="new-bot-continue-name"
      {disabled}
      onclick={() => submit()}
    ><RailIcon name="arrow-right" />{nextLabel || "Continue"}</button>
  {/if}
</footer>
