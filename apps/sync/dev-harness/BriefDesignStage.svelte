<script lang="ts">
  // Design stage for the Daily Brief: renders the real DailyBrief with fixture
  // days so card and layout work can iterate with hot reload, no bot or Tauri.
  //   ?view=brief-design&day=oct8|oct11|quiet|catchup|everything
  // Shift+A on the page toggles review mode (every card in the catalogue).
  import DailyBrief from '../../../packages/ui/src/brief/DailyBrief.svelte';
  import { octoberEightBrief } from '../../../packages/ui/src/brief/brief-fixture';
  import {
    octoberEleven,
    quietSaturday,
    catchUpThursday,
    everything,
  } from '../../../packages/ui/src/brief/brief-catalogue-fixtures';

  const DAYS = {
    oct8: { label: 'Oct 8 · real sweep', make: () => octoberEightBrief() },
    oct11: { label: 'Oct 11', make: octoberEleven },
    quiet: { label: 'Quiet Saturday', make: quietSaturday },
    catchup: { label: 'Catch-up Thursday', make: catchUpThursday },
    everything: { label: 'Everything', make: everything },
  } as const;
  type Day = keyof typeof DAYS;

  const params = new URLSearchParams(location.search);
  const initial = params.get('day');
  let day = $state<Day>(initial && initial in DAYS ? (initial as Day) : 'oct8');
  const input = $derived(DAYS[day].make());

  function pick(next: Day) {
    day = next;
    const url = new URL(location.href);
    url.searchParams.set('day', next);
    history.replaceState(null, '', url);
  }
</script>

<div class="stage">
  <nav class="days" aria-label="Fixture day">
    {#each Object.entries(DAYS) as [key, d] (key)}
      <button class:on={day === key} onclick={() => pick(key as Day)}>{d.label}</button>
    {/each}
    <span class="hint">Shift+A · every card</span>
  </nav>
  {#key day}
    <DailyBrief {input} />
  {/key}
</div>

<style>
  .stage {
    height: 100vh;
    overflow: auto;
  }
  .days {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 1000;
    display: flex;
    gap: 4px;
    align-items: center;
    padding: 4px;
    border-radius: 10px;
    background: rgba(20, 20, 22, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.1);
    font: 500 11px/1 system-ui, sans-serif;
  }
  .days button {
    font: inherit;
    color: rgba(255, 255, 255, 0.65);
    background: transparent;
    border: 0;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .days button.on {
    color: #fff;
    background: rgba(255, 255, 255, 0.12);
  }
  .hint {
    color: rgba(255, 255, 255, 0.4);
    padding: 0 6px;
  }
</style>
