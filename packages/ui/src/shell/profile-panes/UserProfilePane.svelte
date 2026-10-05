<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import ReadLoader from "../../common/ReadLoader.svelte";
  import { PROFILE_PANE_WIDTH, profilePhase, type UserProfileSnapshot } from "./profile-pane-model.js";

  interface Props {
    snapshot: UserProfileSnapshot | null;
    onclose?: () => void;
    onmessage?: () => void;
    onatlas?: () => void;
    /** Opens the company Team page, where membership and access are managed. */
    onmanage?: () => void;
  }

  let { snapshot, onclose, onmessage, onatlas, onmanage }: Props = $props();
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
    <button type="button" class="icon" data-testid="user-profile-close" aria-label="Close profile" onclick={() => onclose?.()}>×</button>
  </header>
  {#if phase === "shimmer" || !snapshot}
    <div class="body" aria-busy="true">
      <ReadLoader testid="user-profile-loading" />
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
        <button type="button" class="btn primary" data-testid="user-profile-message" onclick={() => onmessage?.()}><RailIcon name="send" />Message</button>
        {#if onatlas}<button type="button" class="btn" data-testid="user-profile-atlas" onclick={() => onatlas?.()}><RailIcon name="eye" />View in Atlas</button>{/if}
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
          <div class="li"><span class="sq" class:on={bot.live} aria-hidden="true">{bot.name.slice(0, 1).toUpperCase()}</span><div><div>{bot.name}</div><div class="mm">{bot.note}</div></div></div>
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
      <div class="manage"><span>Access follows company membership.</span>{#if onmanage}<button type="button" class="link" data-testid="user-profile-manage" onclick={() => onmanage?.()}><RailIcon name="settings" />Manage access</button>{/if}</div>
    </div>
  {/if}
</aside>

<style>
  .pane {
    box-sizing: border-box; max-width: 100%; height: 100%; min-height: 0;
    display: flex; flex-direction: column;
    background: var(--side-bg, var(--v4-secondary-sidebar));
    color: var(--v4-text-1);
    font: 400 13px/1.45 var(--font-ui, var(--font-sans));
  }
  .head {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: 12px 14px; border-bottom: 1px solid var(--v4-rowline, var(--line));
    font-size: 13px; font-weight: 500;
  }
  .grow { flex: 1; }
  .icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: var(--v4-text-2); font-size: 13px; cursor: pointer;
  }
  .icon:hover { background: var(--hover, var(--v4-hover)); color: var(--v4-text-1); }
  .body { overflow: auto; padding: 24px 20px; min-height: 0; }
  .idn { display: flex; gap: 12px; align-items: center; }
  .av {
    width: 48px; height: 48px; border-radius: 50%; position: relative; flex: none;
    display: grid; place-items: center; font-weight: 500;
    background: var(--v4-control-bg); color: var(--v4-text-1);
  }
  .ld {
    position: absolute; right: 0; bottom: 0; width: 11px; height: 11px; border-radius: 50%;
    background: var(--v4-ok); border: 2px solid var(--v4-ground, var(--side-bg));
  }
  .nm { font-size: 20px; line-height: 1.25; font-weight: 500; }
  .em { color: var(--v4-text-3); margin-top: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .chip { padding: 1px 7px; border-radius: var(--v4-radius-pill, 999px); background: var(--v4-control-bg); color: var(--v4-text-2); }
  .acts { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; margin-top: 16px; }
  .btn {
    height: 32px; padding: 0 10px;
    border: 1px solid var(--v4-control-border, var(--line2));
    background: transparent;
    color: var(--v4-text-1); border-radius: 8px;
    font: inherit; white-space: nowrap; cursor: pointer;
  }
  .btn:hover { background: var(--hover, var(--v4-hover)); }
  .btn.primary { background: var(--v4-primary-bg, var(--t1)); color: var(--v4-primary-fg, var(--v4-bg)); border-color: transparent; font-weight: 500; }
  .btn.primary:hover { filter: brightness(1.08); }
  .k { font-weight: 500; color: var(--v4-text-2); margin: 20px 0 6px; }
  .kv { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 6px 12px; }
  .kv .k { margin: 0; font-weight: 400; color: var(--v4-text-3); }
  .live { display: inline-flex; align-items: center; gap: 6px; color: var(--v4-text-1); }
  .live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--v4-ok); }
  .li { display: flex; gap: 10px; align-items: center; min-height: 31px; }
  .sq, .fi {
    width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; flex: none;
    background: var(--v4-control-bg); font-size: 10px;
  }
  .sq.on { box-shadow: inset 0 0 0 1px var(--v4-ok); }
  .fi { font-family: var(--font-mono, "Geist Mono", monospace); font-size: 8px; color: var(--v4-text-2); }
  .mm { color: var(--v4-text-3); }
  .chan { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--v4-text-2); }
  .chan span::before { content: "#"; color: var(--v4-text-3); margin-right: 2px; }
  .manage { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--v4-rowline, var(--line)); display: flex; align-items: baseline; gap: 8px; color: var(--v4-text-3); }
  .link { flex: none; margin-left: auto; padding: 0; border: 0; background: none; font: inherit; color: var(--v4-text-2); white-space: nowrap; cursor: pointer; }
  .link:hover { color: var(--v4-text-1); text-decoration: underline; text-underline-offset: 3px; }
</style>
