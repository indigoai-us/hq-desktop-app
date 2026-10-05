<script lang="ts">
  import { onMount, tick } from "svelte";
  import { hostComputerNoun } from "@hq/platform";
  import RailIcon from "../../common/button/RailIcon.svelte";

  export type NewBotKind = "cloud" | "local";

  interface Props {
    /** Why Cloud cannot be picked. Null when it can. */
    cloudReason?: string | null;
    /** Why Local cannot be picked. Null when it can. */
    localReason?: string | null;
    onpick: (kind: NewBotKind) => void;
  }

  let { cloudReason = null, localReason = null, onpick }: Props = $props();

  /** "Mac", "PC" or "computer", read once. */
  const hostNoun = hostComputerNoun();

  const options = $derived<
    ReadonlyArray<{ kind: NewBotKind; title: string; body: string; icon: "cloud" | "laptop"; reason: string | null }>
  >([
    {
      kind: "cloud",
      title: "Cloud",
      body: `Runs in your company's cloud. Always on, even when this ${hostNoun} is asleep.`,
      icon: "cloud",
      reason: cloudReason,
    },
    {
      kind: "local",
      title: "Local",
      body: `Runs on this ${hostNoun} with your coding tool.`,
      icon: "laptop",
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
  <p class="new-bot-takeover-kicker">A new teammate</p>
  <h1 id="new-bot-takeover-title">Where should it run?</h1>
  <p class="new-bot-takeover-copy">Pick Cloud or Local. You can change it on the next step.</p>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={listEl}
    class="new-bot-choice-options"
    role="group"
    aria-label="Where the bot runs"
    onkeydown={onKeydown}
  >
    {#each options as option (option.kind)}
      <button
        type="button"
        class="new-bot-choice-option"
        data-testid={`new-bot-choice-${option.kind}`}
        disabled={option.reason !== null}
        aria-describedby={`new-bot-choice-${option.kind}-body`}
        onclick={() => onpick(option.kind)}
      >
        <RailIcon name={option.icon} size={20} />
        <span class="new-bot-choice-text">
          <span class="new-bot-choice-title">{option.title}</span>
          <span class="new-bot-choice-body" id={`new-bot-choice-${option.kind}-body`}>
            {option.reason ?? option.body}
          </span>
        </span>
      </button>
    {/each}
  </div>
</div>
