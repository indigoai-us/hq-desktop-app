<script lang="ts">
  // Design stage for the Daily Brief: renders the real DailyBrief with fixture
  // days so card and layout work can iterate with hot reload, no bot or Tauri.
  //   ?view=brief-design&day=oct8|oct11|quiet|catchup|everything
  // Shift+A on the page toggles review mode (every card in the catalogue).
  //   &theme=dark|light|system  appearance (sets data-force-theme on <html>, as the QA override does).
  //   &at=HH:MM  pin the Oct 8 day's clock, e.g. at=14:10 to see a call in progress.
  import DailyBrief from '../../../packages/ui/src/brief/DailyBrief.svelte';
  import { octoberEightBrief } from '../../../packages/ui/src/brief/brief-fixture';
  import {
    octoberEleven,
    quietSaturday,
    catchUpThursday,
    everything,
  } from '../../../packages/ui/src/brief/brief-catalogue-fixtures';

  const DAYS = {
    oct8: { label: 'Oct 8 · real sweep', make: () => octoberEightBrief(pinnedNow()) },
    oct11: { label: 'Oct 11', make: octoberEleven },
    quiet: { label: 'Quiet Saturday', make: quietSaturday },
    catchup: { label: 'Catch-up Thursday', make: catchUpThursday },
    everything: { label: 'Everything', make: everything },
  } as const;
  type Day = keyof typeof DAYS;

  const params = new URLSearchParams(location.search);
  // &at=14:10 pins the Oct 8 day's clock (default: the real time, so the page moves through the day).
  function pinnedNow(): Date {
    const m = /^(\d{1,2}):(\d{2})$/.exec(params.get('at') ?? '');
    if (!m) return new Date();
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  }
  const initial = params.get('day');
  let day = $state<Day>(initial && initial in DAYS ? (initial as Day) : 'oct8');
  /**
   * Preview the page as production shows it with live sources: the fixtures mark their
   * made-up rows `sample` (and the calendar `calendarSample`), which the brief labels
   * "Sample". Strip those flags here so the design stage shows no dev-only markers.
   */
  function asProduction<T>(value: T): T {
    if (Array.isArray(value)) return value.map(asProduction) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) if (k !== 'sample' && k !== 'calendarSample') out[k] = asProduction(v);
      return out as T;
    }
    return value;
  }
  const input = $derived(asProduction(DAYS[day].make()));
  // The fixtures' companies, as a signed-in host would pass them (real icons resolve by slug).
  const companies = [
    { uid: 'cmp_indigo', slug: 'indigo', label: 'Indigo' },
    { uid: 'cmp_liverecover', slug: 'liverecover', label: 'LiveRecover' },
  ];

  type Theme = 'dark' | 'light' | 'system';
  const THEMES: Theme[] = ['dark', 'light', 'system'];
  const t0 = params.get('theme');
  // Default follows the system, as the app does.
  let theme = $state<Theme>(t0 === 'light' || t0 === 'dark' ? t0 : 'system');
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
        {@const name = t === 'dark' ? 'Dark' : t === 'light' ? 'Light' : 'System'}
        <button class="icon" class:on={theme === t} onclick={() => (theme = t)} aria-label={name} aria-pressed={theme === t} title={name}>
          <!-- Phosphor icons (regular weight, MIT), inlined: Moon, Sun, Monitor. -->
          <svg viewBox="0 0 256 256" aria-hidden="true">
            {#if t === 'dark'}
              <path d="M108.11,28.11A96.09,96.09,0,0,0,227.89,147.89,96,96,0,1,1,108.11,28.11Z" />
            {:else if t === 'light'}
              <circle cx="128" cy="128" r="56" />
              <path d="M128 16v24M128 216v24M16 128h24M216 128h24M48.8 48.8l17 17M190.2 190.2l17 17M48.8 207.2l17-17M190.2 65.8l17-17" />
            {:else}
              <rect x="32" y="48" width="192" height="144" rx="16" />
              <path d="M96 224h64" />
            {/if}
          </svg>
        </button>
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
  /* Room under the last row so the floating bar never covers a card. */
  .brief-stage :global(.daily-brief) {
    padding-bottom: 84px;
  }
  .seg {
    display: inline-flex;
    gap: 2px;
  }
  .days button.icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: 999px;
  }
  .icon svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 16;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .sep {
    width: 1px;
    height: 16px;
    margin: 0 4px;
    background: var(--bar-line);
  }
  /* A floating control for the preview, not part of the brief: centred at the
     bottom, lifted by a clear drop shadow, and coloured against the mode in
     use (dark bar on the dark brief, light bar on the light one). */
  .days {
    --bar-bg: rgba(28, 28, 31, 0.94);
    --bar-line: rgba(255, 255, 255, 0.14);
    --bar-ink: rgba(255, 255, 255, 0.62);
    --bar-ink-on: #fff;
    --bar-on: rgba(255, 255, 255, 0.14);
    --bar-hint: rgba(255, 255, 255, 0.4);
    position: fixed;
    left: 50%;
    bottom: 18px;
    translate: -50% 0;
    z-index: 1000;
    display: flex;
    gap: 2px;
    align-items: center;
    padding: 4px;
    border-radius: 999px;
    background: var(--bar-bg);
    border: 1px solid var(--bar-line);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18), 0 14px 36px rgba(0, 0, 0, 0.32);
    font: 500 11px/1 system-ui, sans-serif;
    white-space: nowrap;
  }
  @media (prefers-color-scheme: light) {
    :global(:root:not([data-force-theme='dark'])) .days {
      --bar-bg: rgba(255, 255, 255, 0.96);
      --bar-line: rgba(0, 0, 0, 0.1);
      --bar-ink: rgba(0, 0, 0, 0.55);
      --bar-ink-on: #111;
      --bar-on: rgba(0, 0, 0, 0.07);
      --bar-hint: rgba(0, 0, 0, 0.38);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08), 0 14px 36px rgba(0, 0, 0, 0.18);
    }
  }
  :global(:root[data-force-theme='light']) .days {
    --bar-bg: rgba(255, 255, 255, 0.96);
    --bar-line: rgba(0, 0, 0, 0.1);
    --bar-ink: rgba(0, 0, 0, 0.55);
    --bar-ink-on: #111;
    --bar-on: rgba(0, 0, 0, 0.07);
    --bar-hint: rgba(0, 0, 0, 0.38);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08), 0 14px 36px rgba(0, 0, 0, 0.18);
  }
  .days button {
    font: inherit;
    color: var(--bar-ink);
    background: transparent;
    border: 0;
    padding: 8px 11px;
    border-radius: 999px;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }
  .days button:hover {
    color: var(--bar-ink-on);
  }
  .days button.on {
    color: var(--bar-ink-on);
    background: var(--bar-on);
  }
  .hint {
    color: var(--bar-hint);
    padding: 0 10px 0 6px;
  }
</style>
