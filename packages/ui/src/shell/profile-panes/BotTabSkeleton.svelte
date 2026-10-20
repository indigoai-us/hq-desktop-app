<script lang="ts">
  import ReadLoader from '../../common/ReadLoader.svelte';
  let { kind, onretry }: { kind: 'channels' | 'routines' | 'apps' | 'brain'; onretry?: () => Promise<void> } = $props();
</script>

<div class="skeleton" aria-busy="true" aria-label={`Loading ${kind}`} data-testid={`bot-${kind}-loading`}>
  <div class="heading"><span class="caption">{kind === 'brain' ? 'Brain' : kind === 'apps' ? 'Apps' : kind === 'routines' ? 'Routines' : 'Channels'}</span><ReadLoader {onretry} /></div>
  <div class="shapes" aria-hidden="true">
    <div class="toolbar"><span class="bar search"></span><span class="bar action"></span></div>
    <div class="cards" class:grid={kind === 'apps'}>
      {#each [0, 1, 2, ...(kind === 'apps' ? [3, 4, 5] : [])] as item}
        <div class="card" style={`--delay:${item * 90}ms`}>
          <div class="identity"><span class="tile"></span><div class="lines"><span class="bar title"></span><span class="bar subtitle"></span></div><span class="pill"></span></div>
          {#if kind === 'routines' || kind === 'brain'}<span class="bar detail"></span>{/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .skeleton { display:grid; gap:16px; min-width:0; }
  .heading { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:28px; }
  .caption { color:var(--v4-text-3); font:italic 400 18px/1.4 Georgia,serif; }
  .shapes { display:grid; gap:14px; }
  .toolbar { display:flex; gap:10px; height:34px; }
  .bar,.tile,.pill { display:block; background:color-mix(in srgb,var(--v4-text-1) 7%,transparent); border-radius:6px; }
  .bar { height:8px; }.search { flex:1; height:100%; border-radius:10px; }.action { width:80px; height:100%; border-radius:999px; }
  .cards { display:grid; gap:10px; }.cards.grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .card { position:relative; overflow:hidden; padding:16px; border:1px solid var(--v4-rowline,var(--line)); border-radius:12px; display:grid; gap:18px; background:color-mix(in srgb,var(--v4-text-1) 2%,transparent); }
  .card::after { content:''; position:absolute; inset:0; background:linear-gradient(105deg,transparent 25%,color-mix(in srgb,var(--v4-text-1) 4%,transparent) 50%,transparent 75%); transform:translateX(-100%); animation:sweep 2.4s ease-in-out infinite; animation-delay:var(--delay); }
  .identity { display:flex; align-items:center; gap:12px; }.tile { width:34px; height:34px; flex:none; border-radius:10px; }.lines { display:grid; gap:10px; flex:1; min-width:0; }.title { width:70%; }.subtitle { width:45%; height:6px; }.pill { width:46px; height:24px; border-radius:999px; }.detail { width:78%; height:6px; }.grid .pill { display:none; }
  @keyframes sweep { 60%,100% { transform:translateX(100%); } }
  @media(prefers-reduced-motion:reduce) { .card::after { animation:none; display:none; } }
  @media(max-width:380px) { .cards.grid { grid-template-columns:1fr; } }
</style>
