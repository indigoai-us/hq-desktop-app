<script lang="ts">
  import type { BriefWelcome } from "./brief-welcome.js";
  import { returningWelcomeLine } from "./brief-welcome.js";
  /**
   * `returning` is a person whose account already has companies (US-023).
   * They get "Welcome back" with their companies named, and none of the
   * start-a-company prompts a new person sees.
   */
  let { welcome, onconnectcompany, returning = false, companyNames = [] }: { welcome: BriefWelcome; onconnectcompany?: () => void; returning?: boolean; companyNames?: string[] } = $props();
  const steps = $derived(returning ? welcome.otherSteps : welcome.nextSteps);
</script>

<section class="welcome" data-testid="brief-welcome" data-returning={returning ? "true" : undefined} aria-label="Getting started">
  {#if returning}
    <h2>Welcome back</h2>
    {#if companyNames.length}<p data-testid="brief-welcome-companies">{returningWelcomeLine(companyNames)}</p>{/if}
  {:else}
    <h2>Welcome to your Daily Brief</h2>
    {#if welcome.gettingStarted}<p>{welcome.gettingStarted}</p>{/if}
  {/if}
  {#if welcome.error}<p data-testid="brief-welcome-error">{welcome.error}</p>{/if}
  <dl>
    <div><dt>Local sessions</dt><dd>{welcome.sessions}</dd></div>
    <div><dt>Imported conversations</dt><dd>{welcome.conversations}</dd></div>
    <div><dt>Imported skills</dt><dd>{welcome.skills}</dd></div>
  </dl>
  {#if welcome.apps.length}<p>{welcome.apps.join(" · ")}</p>{/if}
  {#if steps?.length}<ul>{#each steps as reason}<li>{reason}</li>{/each}</ul>{/if}
  {#if welcome.connectCompany && onconnectcompany && !returning}
    <button type="button" onclick={onconnectcompany}>Start or join a company</button>
  {/if}
</section>

<style>
  .welcome { padding: 24px 26px; background: var(--b-bg, var(--bg)); color: var(--b-t1, var(--fg)); font-family: var(--font-ui, "Geist", system-ui, sans-serif); }
  h2 { margin: 0 0 8px; font-size: 20px; font-weight: 500; }
  p, li { color: var(--b-t2, var(--muted)); font-size: 13px; }
  dl { display: flex; flex-wrap: wrap; gap: 24px; margin: 20px 0; }
  dt { color: var(--b-t2, var(--muted)); font-size: 12px; }
  dd { margin: 6px 0 0; font-size: 22px; }
  button { border: 1px solid var(--b-line, var(--border)); border-radius: 8px; background: transparent; color: inherit; padding: 8px 12px; font: inherit; font-size: 13px; cursor: pointer; }
</style>
