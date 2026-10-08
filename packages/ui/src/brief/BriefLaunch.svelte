<script lang="ts">
  /**
   * The brief's action pattern: a primary "Start in <engine>" button with its
   * own hover, a small engine switcher, and a copy-prompt icon. Nothing here
   * calls an API: the prompt goes to a new session or to the clipboard.
   */
  import { ENGINES, copyBriefPrompt, useBrief } from "./brief-context.svelte.js";

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
      <button type="button" aria-pressed={brief.engine === e.id} title={e.label} onclick={() => brief.setEngine(e.id)}>{e.short}</button>
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
