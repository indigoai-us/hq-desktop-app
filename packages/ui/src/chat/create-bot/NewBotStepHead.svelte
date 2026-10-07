<script lang="ts">
  /**
   * The head of a New bot step in the takeover: Back and the step bars on
   * one line, then the small kicker and the title with its key word set
   * apart ("Enter a <name.>"). The cloud create screen and the local steps both use it, so
   * the two flows read as one.
   */
  import type { Snippet } from "svelte";
  import RailIcon from "../../common/button/RailIcon.svelte";

  interface Props {
    /** How many steps the flow has, and which one (1-based) is on screen. */
    total: number;
    current: number;
    /** Back from this step. Without it the step has no Back. */
    onback?: (() => void) | null;
    backTestId?: string;
    backDisabled?: boolean;
    kicker: string;
    lead: string;
    em: string;
    /** Words after the set-apart one ("or from a template."). */
    tail?: string;
    /** A line under the title (the local steps' identity line). */
    children?: Snippet;
  }

  let {
    total,
    current,
    onback = null,
    backTestId,
    backDisabled = false,
    kicker,
    lead,
    em,
    tail = "",
    children,
  }: Props = $props();
</script>

<div class="new-bot-create-head">
  <!-- One line: Back on the left, the step bars on the right. -->
  <div class="new-bot-step-top">
    {#if onback}<button type="button" class="new-bot-back" data-testid={backTestId} disabled={backDisabled} onclick={onback}><RailIcon name="arrow-left" />Back</button>{/if}
    <div class="new-bot-progress" data-testid="new-bot-progress" role="img" aria-label={`Step ${current} of ${total}`}>{#each Array(total) as _, index}<span class:done={index + 1 < current} class:active={index + 1 === current}></span>{/each}</div>
  </div>
  <p class="new-bot-takeover-kicker">{kicker}</p>
  <h1 id="new-bot-takeover-title">{lead} <em>{em}</em>{#if tail}{" "}{tail}{/if}</h1>
  {@render children?.()}
</div>
