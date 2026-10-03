<script lang="ts">
  /**
   * Test-only host for Sidepane: mimics DesktopApp's Home wiring, where the
   * child (ChatSidebar) remounts per model key and owns `.chat-scroll`.
   */
  import Sidepane from "./Sidepane.svelte";
  import type { SidepaneScrollMemory } from "./sidepane-models.js";

  interface Props {
    modelKey: string;
    memory?: SidepaneScrollMemory;
  }

  let { modelKey, memory }: Props = $props();
</script>

<Sidepane {modelKey} {memory} scrollSelector=".chat-scroll">
  {#key modelKey}
    <div class="chat-scroll" data-testid="probe-scroll" data-key={modelKey}>
      {#each { length: 50 } as _, i (i)}<div>row {i}</div>{/each}
    </div>
  {/key}
</Sidepane>
