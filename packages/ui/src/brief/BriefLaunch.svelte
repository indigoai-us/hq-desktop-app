<script lang="ts" module>
  /** The prompt with the pick written in, so the session starts from the answer. */
  export function promptWithPick(base: string, pick: string): string {
    const text = base.trim();
    return `${text}${/[.!?]$/.test(text) ? "" : "."} My pick: ${pick.trim()}.`;
  }
</script>

<script lang="ts">
  /**
   * The brief's action pattern: a primary "Start in <engine>" button with its
   * own hover, a small engine switcher, and a copy-prompt icon. Nothing here
   * calls an API: the prompt goes to a new session or to the clipboard.
   *
   * With `choices` (a decide item's two answers) the primary pill splits on
   * hover into choices[0] | choices[1]; picking one starts the prompt with the
   * pick appended, so the session knows the call before it begins.
   */
  import { ENGINES, copyBriefPrompt, useBrief, type BriefEngine } from "./brief-context.svelte.js";
  import { BRAND_ICONS, type BrandIconName } from "../common/button/rail-icons.js";

  /** The same brand marks the rail's launch buttons use. */
  const MARK: Record<BriefEngine, BrandIconName> = { claude: "claude-code", codex: "codex", grok: "grok" };

  interface Props {
    id: string;
    prompt: string;
    compact?: boolean;
    /** For a decide item: the two answers the pill splits into on hover. */
    choices?: [string, string] | null;
  }
  let { id, prompt, compact = false, choices = null }: Props = $props();
  const brief = useBrief();
  let copied = $state(false);
  const engine = $derived(ENGINES.find((e) => e.id === brief.engine)!);
  const label = $derived(compact ? engine.label : `Start in ${engine.label}`);

  async function copy(): Promise<void> {
    copied = await copyBriefPrompt(prompt);
    if (copied) setTimeout(() => (copied = false), 1400);
  }
</script>

<span class="launch" data-testid="brief-launch">
  {#if choices}
    <!-- Decide: the pill reads as the start button until hovered, then offers the two answers. -->
    <span class="go choice" role="group" aria-label="Choose an answer" data-testid="brief-start-split">
      <span class="lbl" aria-hidden="true">{label}</span>
      <span class="alt">
        <button type="button" data-testid="brief-choice" onclick={() => void brief.start(id, promptWithPick(prompt, choices[0]))}>{choices[0]}</button>
        <button type="button" data-testid="brief-choice" onclick={() => void brief.start(id, promptWithPick(prompt, choices[1]))}>{choices[1]}</button>
      </span>
    </span>
  {:else}
    <button type="button" class="go" data-testid="brief-start" onclick={() => void brief.start(id, prompt)}>
      {label}
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
    </button>
  {/if}
  <span class="eng" role="group" aria-label="Engine">
    {#each ENGINES as e (e.id)}
      {@const mark = BRAND_ICONS[MARK[e.id]]}
      <button
        type="button"
        aria-pressed={brief.engine === e.id}
        aria-label={e.label}
        title={e.label}
        data-engine={e.id}
        onclick={() => brief.setEngine(e.id)}
      ><svg class="mark" class:clay={mark.fill === "clay"} viewBox={mark.viewBox} width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d={mark.d} /></svg></button>
    {/each}
  </span>
  <button type="button" class="copy" class:copied aria-label="Copy prompt" title={copied ? "Copied" : "Copy prompt"} data-testid="brief-copy" onclick={() => void copy()}>
    {#if copied}
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg>
    {:else}
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
    {/if}
  </button>
</span>

<style>
  /* At rest the pill is just its label, sized to it; on hover (or when an answer
     has focus) it swaps to the two answers. The answers never widen the resting pill. */
  .choice {
    display: inline-flex;
    align-items: center;
    cursor: default;
  }
  .choice > .alt {
    display: none;
    align-items: center;
  }
  .choice:hover > .lbl,
  .choice:focus-within > .lbl {
    display: none;
  }
  .choice:hover > .alt,
  .choice:focus-within > .alt {
    display: inline-flex;
  }
  .alt button {
    all: unset;
    cursor: pointer;
    font: inherit;
    font-weight: 500;
    color: inherit;
    padding: 1px 9px;
    border-radius: 6px 0 0 6px;
    transition: background 0.2s, color 0.2s;
  }
  .alt button + button {
    border-left: 1px solid rgba(42, 26, 92, 0.2);
    border-radius: 0 6px 6px 0;
  }
  .alt button:hover,
  .alt button:focus-visible {
    background: #2a1a5c;
    color: #fff;
    outline: none;
  }
</style>
