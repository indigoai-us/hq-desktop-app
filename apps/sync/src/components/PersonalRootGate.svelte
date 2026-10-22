<script lang="ts">
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import PersonalRootReview from './PersonalRootReview.svelte';
  import {
    approveNextPhase,
    loadPersonalRoot,
    personalRootAllowsSetup,
    recheckPersonalRoot,
    requestAdoptionPlan,
    type PersonalRootInvoke,
    type PersonalRootView,
  } from '../lib/personal-root';

  /**
   * H8 (gated): shows the adoption review in the desktop window when the
   * launch check holds personal sync for an installed folder. With the gate
   * off `personal_root_state` returns `legacy` and nothing renders.
   */
  interface Props {
    invokeFn: PersonalRootInvoke;
  }

  let { invokeFn }: Props = $props();

  let view = $state<PersonalRootView | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let dismissed = $state(false);

  const visible = $derived(!!view && !dismissed && !personalRootAllowsSetup(view));

  async function refresh(): Promise<void> {
    try {
      view = await loadPersonalRoot(invokeFn);
      dismissed = false;
    } catch {
      // The review is optional surface; the hold itself lives in the app.
    }
  }

  async function run(step: () => Promise<PersonalRootView>): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      view = await step();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void refresh();
    const pending = listen('personal-root:changed', () => void refresh()).catch(
      () => () => {},
    );
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  });
</script>

{#if visible && view}
  <div class="personal-root-backdrop" role="presentation" data-testid="personal-root-gate">
    <div class="personal-root-sheet" role="dialog" aria-modal="true">
      <PersonalRootReview
        {view}
        {busy}
        {error}
        onreview={() => void run(() => requestAdoptionPlan(invokeFn))}
        onapprove={() => view && void run(() => approveNextPhase(invokeFn, view!))}
        onretry={() => void run(() => recheckPersonalRoot(invokeFn))}
      />
      <div class="later">
        <button type="button" onclick={() => (dismissed = true)}>Not now</button>
        <p>Personal sync stays paused until you finish. Company sync keeps running.</p>
      </div>
    </div>
  </div>
{/if}

<style>
  .personal-root-backdrop {
    position: fixed;
    inset: 0;
    z-index: 49400;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: color-mix(in srgb, var(--pop-text, #000) 24%, transparent);
  }

  .personal-root-sheet {
    box-sizing: border-box;
    width: min(520px, 100%);
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    padding: 20px;
    border: 1px solid var(--pop-border);
    border-radius: var(--radius-popover, 12px);
    background: var(--pop-bg);
    box-shadow: var(--pop-shadow);
    color: var(--pop-text);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  }

  .later {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
    font-size: 12px;
    opacity: 0.85;
  }

  .later p {
    margin: 0;
  }

  .later button {
    padding: 4px 10px;
    border-radius: 8px;
    border: 1px solid var(--pop-border);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
</style>
