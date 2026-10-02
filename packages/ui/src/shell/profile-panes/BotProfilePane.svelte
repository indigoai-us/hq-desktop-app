<script lang="ts">
  /**
   * 340 px bot profile. Atlas inspector grammar: mono section labels, hairline
   * groups, background selection only. Paints from the cached snapshot.
   */
  import {
    PROFILE_PANE_WIDTH,
    metadata,
    profilePhase,
    type BotProfileSnapshot,
  } from "./profile-pane-model.js";

  interface Props {
    snapshot: BotProfileSnapshot | null;
    onclose?: () => void;
    onmessage?: () => void;
    onsession?: () => void;
    onedit?: () => void;
    onpause?: () => void;
  }

  let { snapshot, onclose, onmessage, onsession, onedit, onpause }: Props = $props();

  const phase = $derived(profilePhase(snapshot?.name));
  void metadata;
</script>

<aside
  class="pane"
  style:width="{PROFILE_PANE_WIDTH}px"
  aria-label={snapshot ? `${snapshot.name} profile` : "Bot profile"}
  data-testid="bot-profile-pane"
  data-phase={phase}
  data-live={snapshot?.live ? "true" : "false"}
>
  <header class="phead">
    <span class="mark" aria-hidden="true">⌁</span>
    <b>{snapshot?.name ?? "Profile"}</b>
    <span>Profile</span>
    <button type="button" class="icon" data-testid="bot-profile-close" aria-label="Close profile" onclick={() => onclose?.()}>✕</button>
  </header>
  {#if phase === "shimmer" || !snapshot}
    <div class="body" data-testid="bot-profile-shimmer" aria-busy="true">
      <div class="shimmer id"></div>
      <div class="shimmer row"></div>
      <div class="shimmer row"></div>
      <div class="shimmer block"></div>
    </div>
  {:else}
    <div class="body">
      <div class="top">
        <span class="mark lg" aria-hidden="true">⌁{#if snapshot.live}<i class="ld"></i>{/if}</span>
        <div>
          <div class="nm">{snapshot.name}</div>
          <div class="hd">{snapshot.handle} · {snapshot.email}</div>
          <div class="hd"><b>bot</b> · owned by {snapshot.owner}</div>
        </div>
      </div>
      <div class="act">
        <button type="button" class="btn primary" data-testid="bot-profile-message" onclick={() => onmessage?.()}>Message</button>
        <button type="button" class="btn" data-testid="bot-profile-pause" onclick={() => onpause?.()}>{snapshot.live ? "Pause" : "Wake"}</button>
        <button type="button" class="btn" data-testid="bot-profile-session" onclick={() => onsession?.()}>Open session</button>
        <button type="button" class="btn" data-testid="bot-profile-edit" onclick={() => onedit?.()}>Edit bot</button>
      </div>
      <section class="g">
        <div class="k">Now</div>
        <div class="now">
          <div class="st" class:live={snapshot.live}>
            {snapshot.live ? "Live · working" : snapshot.idleNote}
          </div>
          {snapshot.nowTitle}
          {#if snapshot.nowMeta.length}
            <div class="m">{#each snapshot.nowMeta as bit (bit)}<span>{bit}</span>{/each}</div>
          {/if}
        </div>
      </section>
      <section class="g">
        <div class="k">Runtime {#if snapshot.runtimeVersion}<span class="count">{snapshot.runtimeVersion}</span>{/if}</div>
        <div class="kv">
          {#each snapshot.runtime as row (row.label)}
            <b>{row.label}</b><span>{row.value}</span>
          {/each}
        </div>
      </section>
      {#if snapshot.companies.length}
        <section class="g">
          <div class="k">Companies <span class="count">{snapshot.companies.length}</span></div>
          {#each snapshot.companies as co (co.name)}
            <div class="co"><span class="tile">{co.mark}</span>{co.name}<span class="r">{co.role}</span></div>
          {/each}
        </section>
      {/if}
      {#if snapshot.capabilities.length}
        <section class="g">
          <div class="k">Capabilities <button type="button" class="link" onclick={() => onedit?.()}>Edit</button></div>
          <div class="chips">{#each snapshot.capabilities as cap (cap)}<span class="chip">{cap}</span>{/each}</div>
        </section>
      {/if}
      {#if snapshot.runs.length}
        <section class="g">
          <div class="k">Recent runs</div>
          {#each snapshot.runs as run (run.id)}
            <div class="run"><span class="mk" class:live={run.state === "live"} class:err={run.state === "failed"}></span><div><div class="t">{run.title}</div><span class="meta">{run.meta}</span></div><span class="trail" class:err={run.state === "failed"}>{run.trailing}</span></div>
          {/each}
        </section>
      {/if}
      {#if snapshot.jobs.length}
        <section class="g">
          <div class="k">Scheduled jobs <span class="count">{snapshot.jobs.length}</span></div>
          {#each snapshot.jobs as job (job.id)}
            <div class="run"><span class="mk"></span><div><div class="t">{job.title}</div><span class="meta">{job.meta}</span></div><span class="trail">{job.trailing}</span></div>
          {/each}
        </section>
      {/if}
      {#if snapshot.grants.length}
        <section class="g">
          <div class="k">Vault access</div>
          {#each snapshot.grants as grant (grant.path)}
            <div class="va"><span class="d">{grant.path}</span><span class:w={grant.level.includes("write")}>{grant.level}</span></div>
          {/each}
        </section>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .pane {
    box-sizing: border-box;
    max-width: 100%;
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: 52px minmax(0, 1fr);
    background: var(--v4-secondary-sidebar, var(--side-bg));
    color: var(--v4-text-2);
    font-size: var(--type-metadata, 12px);
  }
  .phead {
    height: 52px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px 0 18px;
    border-bottom: 1px solid var(--v4-rowline, var(--line));
    color: var(--v4-text-3);
  }
  .phead b { font-weight: 600; color: var(--v4-text-1); font-size: var(--type-body, 14px); }
  .icon {
    margin-left: auto;
    width: 24px;
    height: 24px;
    border: 0;
    background: transparent;
    color: var(--v4-text-3);
    cursor: pointer;
  }
  .body { min-height: 0; overflow: auto; padding: 14px 18px 20px; display: flex; flex-direction: column; gap: 14px; }
  .top { display: flex; gap: 12px; align-items: flex-start; }
  .mark {
    width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center;
    background: var(--v4-control-bg); color: var(--v4-text-1); font-size: 11px; flex: none;
  }
  .mark.lg { width: 44px; height: 44px; border-radius: 12px; font-size: 18px; position: relative; }
  .ld {
    position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px; border-radius: 50%;
    background: var(--v4-ok); border: 2px solid var(--v4-secondary-sidebar, var(--side-bg));
  }
  .nm { font-size: var(--type-section, 15px); font-weight: 600; color: var(--v4-text-1); }
  .hd { color: var(--v4-text-3); margin-top: 3px; }
  .hd b { font-weight: 500; color: var(--v4-text-2); }
  .act { display: flex; gap: 4px; flex-wrap: wrap; }
  .btn {
    border: 1px solid var(--v4-control-border, var(--line));
    background: var(--v4-control-faint, transparent);
    color: var(--v4-text-1);
    border-radius: var(--v4-radius-button, 6px);
    padding: 4px 8px;
    font: inherit;
    cursor: pointer;
  }
  .btn.primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); border-color: transparent; }
  .g { border-top: 1px solid var(--v4-rowline, var(--line)); padding-top: 10px; }
  .k {
    font-family: var(--font-mono, "Geist Mono", monospace);
    font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--v4-text-3);
    display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  }
  .count, .link {
    margin-left: auto; letter-spacing: 0; text-transform: none;
    font-family: var(--font-sans, Geist, sans-serif); font-size: 11px; font-weight: 400;
  }
  .link { border: 0; background: none; color: var(--v4-text-3); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .now { color: var(--v4-text-1); font-size: var(--type-secondary, 13px); line-height: 1.45; }
  .st { display: flex; gap: 6px; color: var(--v4-text-3); font-size: var(--type-metadata, 12px); margin-bottom: 3px; }
  .st.live { color: var(--v4-ok); font-weight: 500; }
  .m { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 3px; color: var(--v4-text-3); font-size: var(--type-metadata, 12px); }
  .kv { display: grid; grid-template-columns: 76px 1fr; gap: 5px 10px; color: var(--v4-text-1); }
  .kv b { font-weight: 400; color: var(--v4-text-3); }
  .co { display: flex; align-items: center; gap: 8px; padding: 5px 0; color: var(--v4-text-1); }
  .tile {
    width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center;
    background: var(--v4-control-bg); font-size: 9px;
  }
  .r { margin-left: auto; color: var(--v4-text-3); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { padding: 2px 7px; border-radius: var(--v4-radius-pill, 999px); background: var(--v4-control-bg); color: var(--v4-text-2); font-size: 11px; }
  .run { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 5px 0; border-bottom: 1px solid var(--v4-rowline, var(--line)); color: var(--v4-text-1); }
  .run:last-child { border-bottom: 0; }
  .mk { width: 6px; height: 6px; border-radius: 50%; background: var(--v4-text-3); margin-top: 6px; }
  .mk.live { background: var(--v4-ok); }
  .mk.err { background: var(--v4-error); }
  .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta, .trail { font-family: var(--font-mono, "Geist Mono", monospace); font-size: 10px; color: var(--v4-text-3); }
  .meta { display: block; margin-top: 2px; }
  .trail.err { color: var(--v4-error); }
  .va { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; font-family: var(--font-mono, "Geist Mono", monospace); font-size: 11px; }
  .va .d { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--v4-text-3); }
  .va .w { color: var(--v4-text-1); }
  .shimmer { border-radius: 6px; background: var(--v4-control-faint, rgba(255,255,255,0.06)); }
  .shimmer.id { height: 44px; }
  .shimmer.row { height: 14px; }
  .shimmer.block { height: 72px; }
</style>
