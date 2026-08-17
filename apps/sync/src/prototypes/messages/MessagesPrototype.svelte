<script lang="ts">
  import { onMount } from 'svelte';
  import RoomsVariant from './variants/RoomsVariant.svelte';
  import PriorityVariant from './variants/PriorityVariant.svelte';
  import FocusVariant from './variants/FocusVariant.svelte';
  import CompactMessages from './CompactMessages.svelte';

  const variants = [
    { name: 'Rooms', component: RoomsVariant },
    { name: 'Priority', component: PriorityVariant },
    { name: 'Focus', component: FocusVariant },
  ];

  let current = $state(0);
  let surface = $state<'desktop' | 'compact'>('desktop');
  let replayKey = $state(0);
  let picker: HTMLElement;
  let highlight: HTMLElement;
  let items: HTMLButtonElement[] = [];
  const Variant = $derived(variants[current].component);

  function moveHighlight() {
    const el = items[current];
    if (!el || !highlight) return;
    highlight.style.width = `${el.offsetWidth}px`;
    highlight.style.transform = `translateX(${el.offsetLeft}px)`;
  }

  function setActive(index: number) {
    if (index < 0 || index >= variants.length) return;
    current = index;
    replayKey += 1;
    const url = new URL(location.href);
    url.searchParams.set('v', String(index + 1));
    history.replaceState(null, '', url);
    requestAnimationFrame(moveHighlight);
  }

  function replay() {
    replayKey += 1;
  }

  onMount(() => {
    items = [...picker.querySelectorAll<HTMLButtonElement>('.proto-picker-item:not(.proto-picker-replay)')];
    const requested = Number.parseInt(new URLSearchParams(location.search).get('v') ?? '1', 10) - 1;
    current = Number.isInteger(requested) && requested >= 0 && requested < variants.length ? requested : 0;
    requestAnimationFrame(() => {
      moveHighlight();
      requestAnimationFrame(() => picker.setAttribute('data-ready', ''));
    });

    const onResize = () => moveHighlight();
    const onKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const number = Number.parseInt(event.key, 10);
      if (number >= 1 && number <= variants.length) setActive(number - 1);
      else if (event.key === 'ArrowRight') setActive((current + 1) % variants.length);
      else if (event.key === 'ArrowLeft') setActive((current - 1 + variants.length) % variants.length);
      else if (event.key === 'r' || event.key === 'R') replay();
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKeydown);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKeydown);
    };
  });
</script>

<svelte:head><meta name="color-scheme" content="dark" /></svelte:head>

<div class="prototype-page">
  <div class="ambient ambient-one"></div>
  <div class="ambient ambient-two"></div>
  <div class="surface-switch" role="group" aria-label="Preview surface">
    <button class:active={surface === 'desktop'} onclick={() => surface = 'desktop'}>Desktop</button>
    <button class:active={surface === 'compact'} onclick={() => surface = 'compact'}>Pop-out</button>
  </div>
  <section class="app-window" class:compact-window={surface === 'compact'} aria-label="HQ Messages prototype">
    <header class="titlebar">
      <div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div>
      <button class="sidebar-toggle" aria-label="Toggle sidebar">◫</button>
      <div class="sync-state"><span></span><strong>All synced</strong><small>36 watched · just now</small></div>
      <div class="title-actions"><button aria-label="Search">⌕</button><button>Sync</button><span class="version">App v0.10.39 · <strong>Core v15.0.71</strong></span><span class="account">CE</span></div>
    </header>
    {#if surface === 'desktop'}
    <div class="workspace">
      <aside class="global-nav" aria-label="HQ navigation">
        <nav>
          <button>Inbox <span class="nav-count">4</span></button>
          <button class="active">Messages <span class="nav-count bright">12</span></button>
          <button>Meetings</button>
          <button>Marketplace</button>
          <button>Library</button>
          <button>Files</button>
        </nav>
        <section><h2>Workspaces</h2><button><i class="online"></i> Personal <small>Corey Epstein</small></button></section>
        <section class="companies"><h2>Companies</h2><button><i class="online"></i> Amass</button><button><i class="online"></i> boring-ecom</button><button><i class="online"></i> Indigo</button><button><i></i> Moonflow</button></section>
        <footer><button>Settings</button><small>Corey Epstein</small></footer>
      </aside>
      <div class="variant-stage" id="stage">
        {#key `${current}-${replayKey}`}<Variant />{/key}
      </div>
    </div>
    {:else}
      <CompactMessages />
    {/if}
  </section>
</div>

<nav class="proto-picker" data-position="top" bind:this={picker} aria-label="Prototype variants">
  <span class="proto-picker-highlight" bind:this={highlight} aria-hidden="true"></span>
  {#each variants as variant, index}
    <button class="proto-picker-item" data-active={current === index ? '' : undefined} aria-current={current === index ? 'true' : undefined} onclick={() => setActive(index)}>{variant.name}</button>
  {/each}
  <span class="proto-picker-divider" aria-hidden="true"></span>
  <button class="proto-picker-item proto-picker-replay" aria-label="Replay animation (R)" onclick={replay}>↻</button>
</nav>

<style>
  :global(*) { box-sizing: border-box; }
  :global(html, body, #messages-prototype) { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  :global(body) { font-family: var(--font-sans); color: var(--v4-text-1); background: #080808; }
  :global(button), :global(textarea), :global(input) { font: inherit; }
  :global(button) { color: inherit; }
  .prototype-page { position: relative; width: 100%; height: 100%; min-width: 980px; min-height: 680px; padding: 18px; overflow: hidden; background: radial-gradient(circle at 20% 0%, #3b3b3b 0, transparent 36%), linear-gradient(135deg, #171717, #090909 64%); }
  .ambient { position: absolute; border-radius: 50%; filter: blur(90px); opacity: .28; pointer-events: none; }
  .ambient-one { width: 480px; height: 480px; left: -120px; top: 12%; background: #929292; }
  .ambient-two { width: 420px; height: 420px; right: -80px; bottom: -120px; background: #4d4d4d; }
  .app-window { position: relative; z-index: 1; display: flex; flex-direction: column; width: 100%; height: 100%; overflow: hidden; border: 1px solid rgba(255,255,255,.18); border-radius: 18px; background: rgba(16,16,16,.44); backdrop-filter: blur(30px) saturate(118%); box-shadow: 0 36px 90px rgba(0,0,0,.52), inset 0 1px rgba(255,255,255,.08); }
  .app-window.compact-window { width: min(1120px, calc(100% - 80px)); height: min(760px, calc(100% - 84px)); margin: 42px auto; }
  .surface-switch { position: fixed; z-index: 2147483647; top: 24px; right: 30px; display: flex; gap: 2px; padding: 4px; border: 1px solid rgba(255,255,255,.08); border-radius: 999px; background: rgba(10,10,10,.82); backdrop-filter: blur(12px) saturate(1.4); }
  .surface-switch button { height: 28px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; color: rgba(255,255,255,.55); font-size: 13px; cursor: pointer; }
  .surface-switch button.active { background: rgba(255,255,255,.12); color: #fff; }
  .titlebar { flex: 0 0 58px; display: flex; align-items: center; gap: 14px; padding: 0 16px; border-bottom: 1px solid var(--v4-hairline); background: rgba(25,25,25,.58); backdrop-filter: blur(34px) saturate(120%); }
  .traffic { display: flex; gap: 9px; }
  .traffic i { width: 12px; height: 12px; border-radius: 50%; background: rgba(255,255,255,.2); }
  .sidebar-toggle, .title-actions button { min-width: 34px; height: 32px; border: 1px solid var(--v4-control-border); border-radius: var(--v4-radius-button); background: var(--v4-control-bg); cursor: pointer; }
  .sync-state { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
  .sync-state > span, .online { width: 7px; height: 7px; border-radius: 50%; background: var(--v4-ok); }
  .sync-state strong { font-size: 15px; font-weight: 600; }
  .sync-state small { color: var(--v4-text-3); }
  .title-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .title-actions button { padding: 0 12px; }
  .version { height: 32px; display: grid; place-items: center; padding: 0 12px; border: 1px solid var(--v4-control-border); border-radius: var(--v4-radius-button); background: var(--v4-control-bg); color: var(--v4-text-2); font-family: 'Geist Mono', monospace; font-size: 12px; }
  .account { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--v4-control-border); border-radius: 50%; font-size: 12px; font-weight: 600; }
  .workspace { min-height: 0; flex: 1; display: grid; grid-template-columns: 222px minmax(0,1fr); }
  .global-nav { display: flex; flex-direction: column; min-height: 0; padding: 18px 12px 12px; border-right: 1px solid var(--v4-hairline); background: rgba(22,22,22,.5); backdrop-filter: blur(28px) saturate(115%); }
  .global-nav nav, .global-nav section { display: grid; gap: 2px; }
  .global-nav section { margin-top: 22px; }
  .global-nav h2 { margin: 0 10px 8px; color: var(--v4-text-3); font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
  .global-nav button { display: flex; align-items: center; min-width: 0; height: 34px; padding: 0 10px; border: 0; border-radius: var(--v4-radius-button); background: transparent; text-align: left; cursor: pointer; }
  .global-nav button:hover { background: rgba(255,255,255,.05); }
  .global-nav button.active { background: rgba(255,255,255,.1); font-weight: 600; }
  .global-nav button i { flex: 0 0 auto; width: 7px; height: 7px; margin-right: 9px; border-radius: 50%; background: var(--v4-idle); }
  .global-nav button small { overflow: hidden; margin-left: 6px; color: var(--v4-text-3); text-overflow: ellipsis; white-space: nowrap; }
  .nav-count { margin-left: auto; color: var(--v4-text-3); font-size: 12px; }
  .nav-count.bright { min-width: 22px; padding: 2px 6px; border-radius: var(--v4-radius-pill); background: var(--v4-text-1); color: #111; text-align: center; }
  .companies { min-height: 0; overflow: hidden; }
  .global-nav footer { display: grid; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--v4-rowline); }
  .global-nav footer small { padding: 0 10px; color: var(--v4-text-3); }
  .variant-stage { min-width: 0; min-height: 0; overflow: hidden; }

  .proto-picker { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 2147483647; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 999px; background: rgba(10, 10, 10, 0.82); -webkit-backdrop-filter: blur(12px) saturate(1.4); backdrop-filter: blur(12px) saturate(1.4); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08) inset, 0 8px 24px rgba(0, 0, 0, 0.24), 0 2px 6px rgba(0, 0, 0, 0.12); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; line-height: 1; -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none; }
  .proto-picker-highlight { position: absolute; top: 4px; left: 0; height: 28px; border-radius: 999px; background: rgba(255, 255, 255, 0.12); will-change: transform; }
  .proto-picker[data-ready] .proto-picker-highlight { transition: transform 250ms cubic-bezier(0.23, 1, 0.32, 1), width 250ms cubic-bezier(0.23, 1, 0.32, 1); }
  @media (prefers-reduced-motion: reduce) { .proto-picker[data-ready] .proto-picker-highlight { transition: none; } }
  .proto-picker-item { position: relative; display: flex; align-items: center; height: 28px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; color: rgba(255, 255, 255, 0.55); font: inherit; cursor: pointer; transition: color 150ms ease-out; }
  .proto-picker-item:hover { color: rgba(255, 255, 255, 0.85); }
  .proto-picker-item:active { transform: scale(0.97); }
  .proto-picker-item:focus-visible { outline: 2px solid rgba(255, 255, 255, 0.4); outline-offset: 2px; }
  .proto-picker-item[data-active] { color: #fff; }
  .proto-picker-divider { width: 1px; height: 16px; margin: 0 4px; background: rgba(255, 255, 255, 0.12); }
  .proto-picker-replay { padding: 0 10px; font-size: 14px; }
  .proto-picker[data-position="top"] { bottom: auto; top: 24px; }

  @media (max-width: 1120px) { .workspace { grid-template-columns: 186px minmax(0,1fr); } .global-nav { padding-inline: 8px; } .version { display: none; } }
</style>
