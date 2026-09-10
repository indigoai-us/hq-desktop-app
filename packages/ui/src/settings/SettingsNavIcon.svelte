<script lang="ts">
  /**
   * Settings nav glyphs.
   *
   * One lookup rather than a nine-branch `{#if}` chain around a single inline
   * <svg>: the branches only ever differed by which paths they drew, so the
   * chain was a hand-rolled icon set pretending to be markup.
   */
  import ArrowsClockwise from "phosphor-svelte/lib/ArrowsClockwise";
  import Bell from "phosphor-svelte/lib/Bell";
  import Buildings from "phosphor-svelte/lib/Buildings";
  import DownloadSimple from "phosphor-svelte/lib/DownloadSimple";
  import GearSix from "phosphor-svelte/lib/GearSix";
  import PaintBrush from "phosphor-svelte/lib/PaintBrush";
  import Robot from "phosphor-svelte/lib/Robot";
  import UserCircle from "phosphor-svelte/lib/UserCircle";
  import VideoCamera from "phosphor-svelte/lib/VideoCamera";

  interface Props {
    name:
      | "profile"
      | "companies"
      | "general"
      | "agents"
      | "appearance"
      | "notifications"
      | "sync"
      | "meetings"
      | "updates";
  }
  let { name }: Props = $props();
</script>

{#if name === "profile"}<UserCircle class="nav-ico" size={14} aria-hidden="true" />
{:else if name === "companies"}<Buildings class="nav-ico" size={14} aria-hidden="true" />
{:else if name === "general"}<GearSix class="nav-ico" size={14} aria-hidden="true" />
{:else if name === "agents"}<Robot class="nav-ico" size={14} aria-hidden="true" />
{:else if name === "appearance"}<PaintBrush class="nav-ico" size={14} aria-hidden="true" />
{:else if name === "notifications"}<Bell class="nav-ico" size={14} aria-hidden="true" />
{:else if name === "sync"}<ArrowsClockwise class="nav-ico" size={14} aria-hidden="true" />
{:else if name === "meetings"}<VideoCamera class="nav-ico" size={14} aria-hidden="true" />
{:else}<DownloadSimple class="nav-ico" size={14} aria-hidden="true" />
{/if}

<style>
  .nav-ico {
    display: block;
    flex: 0 0 auto;
  }
</style>
