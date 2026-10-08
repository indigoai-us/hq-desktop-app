<script lang="ts">
  /** Work in companies outside this brief: counted only, never detailed. */
  import { countUp } from "./count-up.js";

  let { count, rows }: { count: number; rows: number } = $props();
</script>

<div class="w" data-testid="brief-other-work">
  <div class="top">
    <div class="eyebrow">Other company work</div>
    <div class="lock" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg></div>
  </div>
  <div class="big" style="font-size:{rows > 1 ? 64 : 42}px;margin-top:{rows > 1 ? 14 : 4}px" use:countUp={count}>0</div>
  <div class="sub">session{count === 1 ? "" : "s"} in another company yesterday.</div>
  {#if rows > 1}
    <p class="sub note">Details stay in that company. This brief only counts them.</p>
  {/if}
</div>

<style>
  .top {
    display: flex;
    justify-content: space-between;
  }
  .lock {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    box-shadow: var(--b-well);
  }
  .lock svg {
    width: 16px;
    height: 16px;
    stroke: rgba(255, 255, 255, 0.56);
    fill: none;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .note {
    margin: auto 0 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.32);
  }
</style>
