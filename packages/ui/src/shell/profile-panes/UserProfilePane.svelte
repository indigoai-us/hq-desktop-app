<script lang="ts">
  import { PROFILE_PANE_WIDTH, profilePhase, type UserProfileSnapshot } from "./profile-pane-model.js";

  interface Props {
    snapshot: UserProfileSnapshot | null;
    onclose?: () => void;
    onmessage?: () => void;
    onatlas?: () => void;
  }

  let { snapshot, onclose, onmessage, onatlas }: Props = $props();
  const phase = $derived(profilePhase(snapshot?.name));
  const initials = $derived((snapshot?.name ?? "?").slice(0, 2).toUpperCase());
</script>

<aside
  class="pane"
  style:width="{PROFILE_PANE_WIDTH}px"
  aria-label={snapshot ? `${snapshot.name} profile` : "Profile"}
  data-testid="user-profile-pane"
  data-phase={phase}
>
  <header class="head">
    <span>Profile</span>
    <span class="grow"></span>
    <button type="button" class="icon" data-testid="user-profile-close" aria-label="Close profile" onclick={() => onclose?.()}>✕</button>
  </header>
  {#if phase === "shimmer" || !snapshot}
    <div class="body" data-testid="user-profile-shimmer" aria-busy="true">
      <div class="shimmer id"></div>
      <div class="shimmer row"></div>
      <div class="shimmer block"></div>
    </div>
  {:else}
    <div class="body">
      <div class="idn">
        <span class="av" aria-hidden="true">{initials}{#if snapshot.live}<i class="ld"></i>{/if}</span>
        <div>
          <div class="nm">{snapshot.name}</div>
          {#if snapshot.email}<div class="em">{snapshot.email}</div>{/if}
        </div>
      </div>
      {#if snapshot.roleChips.length}
        <div class="chips">{#each snapshot.roleChips as chip (chip)}<span class="chip">{chip}</span>{/each}</div>
      {/if}
      <div class="acts">
        <button type="button" class="btn primary" data-testid="user-profile-message" onclick={() => onmessage?.()}>Message</button>
        <button type="button" class="btn" data-testid="user-profile-atlas" onclick={() => onatlas?.()}>View in Atlas</button>
      </div>
      <div class="k">Presence</div>
      <div class="kv">
        <span class="k">Now</span><span class:live={snapshot.live}>{snapshot.now}</span>
        <span class="k">Session</span><span>{snapshot.session}</span>
        {#if snapshot.localTime}<span class="k">Local time</span><span>{snapshot.localTime}</span>{/if}
        <span class="k">Last seen</span><span>{snapshot.lastSeen}</span>
      </div>
      {#if snapshot.bots.length}
        <div class="k">Bots they own</div>
        {#each snapshot.bots as bot (bot.name)}
          <div class="li"><span class="sq" class:on={bot.live} aria-hidden="true">⌁</span><div><div>{bot.name}</div><div class="mm">{bot.note}</div></div></div>
        {/each}
      {/if}
      {#if snapshot.channels.length}
        <div class="k">Shared channels</div>
        <div class="chan">{#each snapshot.channels as ch (ch)}<span>{ch}</span>{/each}</div>
      {/if}
      {#if snapshot.files.length}
        <div class="k">Recent shared files</div>
        {#each snapshot.files as file (file.name)}
          <div class="li"><span class="fi">FILE</span><div><div>{file.name}</div><div class="mm">{file.meta}</div></div></div>
        {/each}
      {/if}
      <div class="manage"><span>Access follows company membership.</span><span class="link">Manage access</span></div>
    </div>
  {/if}
</aside>

<style>
  .pane {
    box-sizing: border-box; max-width: 100%; height: 100%; min-height: 0;
    display: flex; flex-direction: column;
    background: var(--side-bg, var(--v4-secondary-sidebar));
    box-shadow: inset 1px 0 0 var(--v4-glass-highlight, transparent);
    color: var(--v4-text-1);
  }
  .head {
    height: 52px; flex: none; display: flex; align-items: center; gap: 8px;
    padding: 0 10px 0 16px; border-bottom: 1px solid var(--v4-rowline, var(--line));
    font-size: var(--type-section, 15px); font-weight: 600;
  }
  .grow { flex: 1; }
  .icon { width: 24px; height: 24px; border: 0; background: transparent; color: var(--v4-text-3); cursor: pointer; }
  .body { overflow: auto; padding: 16px; min-height: 0; }
  .idn { display: flex; gap: 12px; align-items: center; }
  .av {
    width: 48px; height: 48px; border-radius: 50%; position: relative; flex: none;
    display: grid; place-items: center; font-weight: 600;
    background: var(--v4-control-bg); color: var(--v4-text-1);
  }
  .ld {
    position: absolute; right: 0; bottom: 0; width: 11px; height: 11px; border-radius: 50%;
    background: var(--v4-ok); border: 2px solid var(--v4-ground, var(--side-bg));
  }
  .nm { font-size: var(--type-section, 15px); font-weight: 600; }
  .em { font-size: var(--type-metadata, 12px); color: var(--v4-text-3); margin-top: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .chip { padding: 2px 7px; border-radius: var(--v4-radius-pill, 999px); background: var(--v4-control-bg); color: var(--v4-text-2); font-size: 11px; }
  .acts { display: flex; gap: 6px; margin-top: 14px; }
  .btn {
    border: 1px solid var(--v4-control-border, var(--line));
    background: var(--v4-control-faint, transparent);
    color: var(--v4-text-1); border-radius: var(--v4-radius-button, 6px);
    padding: 4px 8px; font: inherit; cursor: pointer;
  }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
  .k {
    font-family: var(--font-mono, "Geist Mono", monospace);
    font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--v4-text-2); margin: 18px 0 6px;
  }
  .kv { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 4px 8px; font-size: var(--type-metadata, 12px); }
  .kv .k { margin: 0; font-weight: 400; color: var(--v4-text-3); letter-spacing: 0; text-transform: none; font-family: inherit; font-size: inherit; }
  .live { color: var(--v4-ok); }
  .li { display: flex; gap: 10px; align-items: center; padding: 6px 0; }
  .sq, .fi {
    width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; flex: none;
    background: var(--v4-control-bg); font-size: 9px;
  }
  .sq.on { box-shadow: inset 0 0 0 1px var(--v4-ok); }
  .fi { font-family: var(--font-mono, "Geist Mono", monospace); font-size: 8px; color: var(--v4-text-2); }
  .mm { font-size: 11px; color: var(--v4-text-3); }
  .chan { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: var(--type-metadata, 12px); color: var(--v4-text-2); }
  .chan span::before { content: "#"; font-family: var(--font-mono, "Geist Mono", monospace); color: var(--v4-text-3); margin-right: 2px; }
  .manage { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--v4-rowline, var(--line)); display: flex; gap: 8px; font-size: var(--type-metadata, 12px); color: var(--v4-text-3); }
  .link { color: var(--v4-text-2); text-decoration: underline; text-underline-offset: 3px; }
  .shimmer { border-radius: 6px; background: var(--v4-control-faint, rgba(255,255,255,0.06)); margin-bottom: 8px; }
  .shimmer.id { height: 48px; }
  .shimmer.row { height: 14px; }
  .shimmer.block { height: 64px; }
</style>
