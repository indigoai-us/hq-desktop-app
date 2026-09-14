<script lang="ts">
  import type {CallTile} from './call-view-model.js';
  let {tile,disabled=false,onmuterequest,onmuteforce,onremovepeer}:{tile:CallTile;disabled?:boolean;onmuterequest?:(tile:CallTile)=>void|Promise<void>;onmuteforce?:(tile:CallTile)=>void|Promise<void>;onremovepeer?:(tile:CallTile)=>void|Promise<void>}=$props();
  let open=$state(false),confirming=$state(false);
  let trigger:HTMLButtonElement;let cancel=$state<HTMLButtonElement>();let root:HTMLDivElement;
  let left=$state(0),top=$state(0);
  function toggle(){const rect=trigger.getBoundingClientRect();left=Math.max(8,Math.min(window.innerWidth-211,rect.right-195));top=Math.max(8,Math.min(window.innerHeight-210,rect.bottom+6));open=!open;confirming=false;}
  $effect(()=>{if(confirming)cancel?.focus();});
  function close(restore=true){open=false;confirming=false;if(restore)trigger?.focus();}
</script>
<svelte:window onpointerdown={e=>{if(open&&!root?.contains(e.target as Node))close(false);}} onresize={()=>close(false)}/>
<div bind:this={root} class="participant-actions" class:expanded={open} onkeydown={e=>{if(e.key==='Escape'){e.stopPropagation();close();}}} role="group" aria-label={`Actions for ${tile.label}`}>
  <button class="trigger" bind:this={trigger} aria-label={`Actions for ${tile.label}`} aria-expanded={open} onclick={toggle} data-testid="participant-actions-trigger">•••</button>
  {#if open}
    <div class="panel" style:left={`${left}px`} style:top={`${top}px`}>
      {#if confirming}
        <div role="alertdialog" aria-modal="false" aria-label={`Remove ${tile.label}`}>
          <p>Remove {tile.label} from this call?</p>
          <button bind:this={cancel} onclick={()=>close()}>Cancel</button>
          <button class="danger" disabled={disabled} data-testid="participant-remove-confirm" onclick={()=>{close();void onremovepeer?.(tile);}}>Remove from call</button>
        </div>
      {:else}
        <strong>{tile.label}</strong>
        <button disabled={disabled} data-testid="participant-mute-request" onclick={()=>{close();void onmuterequest?.(tile);}}>Ask to mute</button>
        <button disabled={disabled} data-testid="participant-mute-force" onclick={()=>{close();void onmuteforce?.(tile);}}>Mute microphone</button>
        <button class="danger" disabled={disabled} data-testid="participant-remove" onclick={()=>confirming=true}>Remove from call…</button>
      {/if}
    </div>
  {/if}
</div>
<style>
.participant-actions{position:absolute;top:12px;right:12px;z-index:5}.trigger{opacity:0;transition:opacity .12s;background:#101714bb;border:1px solid #ffffff30;border-radius:7px;color:#eef4ef;width:32px;height:30px;cursor:pointer}.participant-actions:focus-within .trigger,.expanded .trigger,:global(.tile:hover) .trigger{opacity:1}.panel{position:fixed;z-index:100;width:195px;box-sizing:border-box;background:#202b24;border:1px solid #ffffff25;border-radius:10px;box-shadow:0 12px 32px #0006;padding:7px;display:grid;gap:3px}.panel strong{font-size:11px;color:#a8b8ae;padding:8px}.panel button{display:block;width:100%;border:0;border-radius:5px;text-align:left;font:inherit;font-size:12px;color:#e4eee7;background:transparent;padding:9px;cursor:pointer}.panel button:hover{background:#ffffff0d}.panel .danger{color:#f0a69f}.panel p{font-size:12px;line-height:1.5;margin:8px}.panel button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:2px solid #b2d8c4;outline-offset:2px}@media(hover:none){.trigger{opacity:1}}
</style>
