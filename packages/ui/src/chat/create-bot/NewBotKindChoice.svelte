<script lang="ts">
  import { onMount, tick } from "svelte";
  import NewBotOrbIcon from "./NewBotOrbIcon.svelte";
  import NewBotStepHead from "./NewBotStepHead.svelte";

  export type NewBotKind = "cloud" | "local";

  interface Props {
    /** The name given on the step before. The heading asks where it should live. */
    name?: string;
    /** Why Cloud cannot be picked. Null when it can. */
    cloudReason?: string | null;
    /** Why Local cannot be picked. Null when it can. */
    localReason?: string | null;
    /** Step dots: how many steps the whole flow has, and this one's place. */
    total?: number;
    current?: number;
    /** Back to the name. Without it the step has no Back. */
    onback?: (() => void) | null;
    backTestId?: string;
    backDisabled?: boolean;
    onpick: (kind: NewBotKind) => void;
    /**
     * "Connect it": how to bring in a bot that already runs somewhere else.
     * Without it the line under the tiles is not shown.
     */
    onconnectexternal?: (() => void) | null;
  }

  let {
    onconnectexternal = null,
    name = "",
    cloudReason = null,
    localReason = null,
    total = 0,
    current = 2,
    onback = null,
    backTestId = "new-bot-back-to-name",
    backDisabled = false,
    onpick,
  }: Props = $props();

  const shownName = $derived(name.trim() || "your bot");
  const SUBLINE = "Pick one. You can add the other kind of bot any time.";

  const options = $derived<
    ReadonlyArray<{
      kind: NewBotKind;
      title: string;
      body: string;
      reason: string | null;
    }>
  >([
    {
      kind: "cloud",
      title: "Cloud",
      body: "Always on. Access anywhere.",
      reason: cloudReason,
    },
    {
      kind: "local",
      title: "Local",
      body: "Runs on this machine.",
      reason: localReason,
    },
  ]);

  let listEl = $state<HTMLDivElement | null>(null);

  function enabledButtons(): HTMLButtonElement[] {
    return listEl ? [...listEl.querySelectorAll<HTMLButtonElement>("button:not([disabled])")] : [];
  }

  // The first option that can be picked takes focus, so arrows and Enter
  // work at once.
  onMount(() => {
    void tick().then(() => enabledButtons()[0]?.focus());
  });

  function onKeydown(event: KeyboardEvent): void {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!forward && !backward) return;
    const buttons = enabledButtons();
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      index === -1
        ? 0
        : forward
          ? (index + 1) % buttons.length
          : (index - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
</script>

<div class="new-bot-choice" data-testid="new-bot-kind-choice">
  {#if total > 0}
    <NewBotStepHead
      {total}
      {current}
      {onback}
      {backTestId}
      {backDisabled}
      kicker="A new teammate"
      lead="Where should"
      em={shownName}
      tail="live?"
    >
      <p class="new-bot-choice-sub" data-testid="new-bot-choice-sub">{SUBLINE}</p>
    </NewBotStepHead>
  {:else}
    <p class="new-bot-takeover-kicker">A new teammate</p>
    <h1 id="new-bot-takeover-title">Where should <em>{shownName}</em> live?</h1>
    <p class="new-bot-choice-sub" data-testid="new-bot-choice-sub">{SUBLINE}</p>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={listEl}
    class="new-bot-choice-options"
    role="group"
    aria-label={`Where ${shownName} runs`}
    onkeydown={onKeydown}
  >
    {#each options as option (option.kind)}
      <button
        type="button"
        class="new-bot-choice-option"
        data-kind={option.kind}
        data-testid={`new-bot-choice-${option.kind}`}
        disabled={option.reason !== null}
        aria-describedby={`new-bot-choice-${option.kind}-body`}
        onclick={() => onpick(option.kind)}
      >
        <NewBotOrbIcon kind={option.kind} />
        <span class="new-bot-choice-title">{option.title}</span>
        <span class="new-bot-choice-body" id={`new-bot-choice-${option.kind}-body`}>
          {option.reason ?? option.body}
        </span>
      </button>
    {/each}
  </div>
  {#if onconnectexternal}
    <p class="new-bot-choice-external" data-testid="new-bot-connect-external-line">
      Already have a bot running somewhere else?
      <button type="button" class="new-bot-inline-link" data-testid="new-bot-connect-external" onclick={onconnectexternal}>Connect it</button>
    </p>
  {/if}
</div>
