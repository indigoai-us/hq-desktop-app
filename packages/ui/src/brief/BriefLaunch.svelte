<script lang="ts">
  /**
   * The brief's action pattern: a primary "Start in <engine>" button with its
   * own hover, a small engine switcher, and a copy-prompt icon. Nothing here
   * calls an API: the prompt goes to a new session or to the clipboard.
   */
  import { ENGINES, copyBriefPrompt, useBrief, type BriefEngine } from "./brief-context.svelte.js";
  import { BRAND_ICONS, type BrandIconName } from "../common/button/rail-icons.js";

  /** The same brand marks the rail's launch buttons use. */
  const MARK: Record<BriefEngine, BrandIconName> = { claude: "claude-code", codex: "codex", grok: "grok" };

  let { id, prompt, compact = false }: { id: string; prompt: string; compact?: boolean } = $props();
  const brief = useBrief();
  let copied = $state(false);
  const engine = $derived(ENGINES.find((e) => e.id === brief.engine)!);

  async function copy(): Promise<void> {
    copied = await copyBriefPrompt(prompt);
    if (copied) setTimeout(() => (copied = false), 1400);
  }
</script>

<span class="launch" data-testid="brief-launch">
  <button type="button" class="go" data-testid="brief-start" onclick={() => void brief.start(id, prompt)}>
    {compact ? engine.label : `Start in ${engine.label}`}
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
  </button>
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
