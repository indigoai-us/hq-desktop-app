<script lang="ts">
  // Design stage for the Daily Brief: renders the real DailyBrief with fixture
  // days so card and layout work can iterate with hot reload, no bot or Tauri.
  //   ?view=brief-design&day=oct8|oct11|quiet|catchup|everything
  // Shift+A on the page toggles review mode (every card in the catalogue).
  //   &theme=dark|light|system  appearance (sets data-force-theme on <html>, as the QA override does).
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
  // The fixtures' companies, as a signed-in host would pass them (real icons resolve by slug).
  const companies = [
    { uid: 'cmp_indigo', slug: 'indigo', label: 'Indigo' },
    { uid: 'cmp_liverecover', slug: 'liverecover', label: 'LiveRecover' },
  ];

  type Theme = 'dark' | 'light' | 'system';
  const THEMES: Theme[] = ['dark', 'light', 'system'];
  const t0 = params.get('theme');
  let theme = $state<Theme>(t0 === 'light' || t0 === 'system' ? t0 : 'dark');
  $effect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.forceTheme;
    else root.dataset.forceTheme = theme;
    const url = new URL(location.href);
    url.searchParams.set('theme', theme);
    history.replaceState(null, '', url);
  });

  function pick(next: Day) {
    day = next;
    const url = new URL(location.href);
    url.searchParams.set('day', next);
    history.replaceState(null, '', url);
  }
</script>

<div class="brief-stage">
  <nav class="days" aria-label="Fixture day">
    <span class="seg" role="group" aria-label="Appearance">
      {#each THEMES as t (t)}
        <button class:on={theme === t} onclick={() => (theme = t)}>{t === 'dark' ? 'Dark' : t === 'light' ? 'Light' : 'System'}</button>
      {/each}
    </span>
    <span class="sep"></span>
    {#each Object.entries(DAYS) as [key, d] (key)}
      <button class:on={day === key} onclick={() => pick(key as Day)}>{d.label}</button>
    {/each}
    <span class="hint">Shift+A · every card</span>
  </nav>
  {#key day}
    <DailyBrief {input} {companies} />
  {/key}
</div>

<style>
  /* The brief scrolls itself; the stage is just the window, edge to edge. */
  .brief-stage {
    position: fixed;
    inset: 0;
    overflow: hidden;
  }
  .seg {
    display: inline-flex;
    gap: 2px;
  }
  .sep {
    width: 1px;
    height: 16px;
    margin: 0 4px;
    background: rgba(255, 255, 255, 0.15);
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
