<script lang="ts">
  /** Fleet agents by status, from the sweep. Count-up because it is measured. */
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { countUp } from "./count-up.js";

  let { fleet }: { fleet: { total: number; active: number; dormant: number; provisioning: number } } = $props();
  const brief = useBrief();
  const cells = $derived([
    ...Array.from({ length: fleet.active }, () => "a"),
    ...Array.from({ length: fleet.provisioning }, () => "p"),
    ...Array.from({ length: fleet.dormant }, () => "d"),
  ]);
</script>

<div
  class="w"
  data-testid="brief-fleet"
  role="group"
  aria-label="Fleet"
  use:peek={{
    state: brief,
    content: () => ({
      title: `Fleet · ${fleet.total} agents`,
      status: "From the morning sweep",
      sections: [
        {
          label: "By status",
          lines: [
            { label: "Active", state: String(fleet.active), tone: "ok" },
            { label: "Provisioning", state: String(fleet.provisioning), tone: "warn" },
            { label: "Dormant", state: String(fleet.dormant), tone: "neutral" },
          ],
        },
      ],
    }),
  }}
>
  <div class="eyebrow">Fleet</div>
  <div class="hd"><span class="big" style="font-size:42px" use:countUp={fleet.active}>0</span><span class="sub">of {fleet.total} agents active</span></div>
  <div class="key">
    <span><i class="a"></i>{fleet.active} active</span><span><i class="p"></i>{fleet.provisioning} provisioning</span><span><i class="d"></i>{fleet.dormant} dormant</span>
  </div>
  <div class="dots">{#each cells as c, i (i)}<i class={c}></i>{/each}</div>
</div>

<style>
  .hd {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 6px;
  }
  .key {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 8px;
    font-family: var(--b-mono);
    font-size: 9.5px;
    color: rgba(255, 255, 255, 0.5);
  }
  .key i,
  .dots i {
    display: inline-block;
    border-radius: 2px;
  }
  .key i {
    width: 7px;
    height: 7px;
    margin-right: 5px;
  }
  .dots {
    display: grid;
    grid-template-columns: repeat(11, 1fr);
    gap: 4px;
    margin-top: auto;
    padding-top: 10px;
  }
  .dots i {
    aspect-ratio: 1;
  }
  .a {
    background: var(--b-ok);
  }
  .p {
    background: var(--b-warn);
  }
  .d {
    background: rgba(255, 255, 255, 0.12);
  }
</style>
