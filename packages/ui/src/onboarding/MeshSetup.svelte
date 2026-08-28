<script lang="ts">
  /**
   * Shared Install + Sync card (desktop MeshUpgrade + web first-access).
   * Platform-pure: the host owns apply.sh / doctor and feeds progress in.
   */
  import {
    MESH_BODY,
    MESH_TITLE,
    meshBandsFromProgress,
    type MeshDoctorProgress,
  } from "./onboarding-mesh.js";

  interface Props {
    progress: MeshDoctorProgress | null;
    error?: string | null;
    backgroundUrl?: string;
    onretry?: () => void;
  }

  let { progress, error = null, backgroundUrl = "", onretry }: Props = $props();

  const bands = $derived(meshBandsFromProgress(progress));
  const bg = $derived(backgroundUrl ? `url("${backgroundUrl}")` : "none");
</script>

<div
  class="mesh-page"
  data-testid="mesh-upgrade"
  style={`--onboarding-bg-url: ${bg};`}
>
  <section class="panel" aria-labelledby="mesh-upgrade-title">
    <h2 class="h" id="mesh-upgrade-title">{MESH_TITLE}</h2>
    <p class="body">{MESH_BODY}</p>
    <div class="list" aria-label="Work Mesh install">
      {#each bands as band}
        <div class:muted={band.status === "pending"} class="li">
          {#if band.status === "active"}
            <span class="st spin" aria-hidden="true"></span>
          {:else if band.status === "done"}
            <span class="st ok" aria-hidden="true">✓</span>
          {:else}
            <span class="st pend" aria-hidden="true"></span>
          {/if}
          <span class="lt">{band.label}</span>
        </div>
      {/each}
    </div>
    {#if error}
      <p class="err" role="alert">{error}</p>
      {#if onretry}
        <button type="button" class="retry" onclick={() => onretry()}
          >Retry</button
        >
      {/if}
    {/if}
  </section>
</div>

<style>
  .mesh-page {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100vw;
    height: 100vh;
    background:
      linear-gradient(180deg, rgba(12, 14, 18, 0.35), rgba(12, 14, 18, 0.72)),
      var(--onboarding-bg-url) center / cover no-repeat,
      #111;
    color: #f4f4f5;
  }

  .panel {
    width: min(520px, calc(100vw - 48px));
    padding: 28px 28px 24px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    background: rgba(22, 24, 28, 0.88);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
  }

  .h {
    margin: 0 0 8px;
    font-size: 22px;
    font-weight: 600;
  }

  .body {
    margin: 0 0 18px;
    color: #a1a1aa;
    font-size: 14px;
    line-height: 1.45;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
  }

  .li.muted {
    color: #71717a;
  }

  .st {
    flex: 0 0 auto;
    width: 14px;
    text-align: center;
  }

  .st.ok {
    color: #34c759;
  }

  .st.spin {
    width: 10px;
    height: 10px;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: #f4f4f5;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .err {
    margin: 16px 0 0;
    color: #f87171;
    font-size: 13px;
  }

  .retry {
    margin-top: 12px;
    padding: 8px 14px;
    border: 1px solid #3f3f46;
    border-radius: 8px;
    background: #27272a;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
