<script lang="ts">
  /**
   * OWNER-R5: the one way a person or bot is shown. Name in normal text, then
   * the email (or "Bot") in the muted style. Never a raw id.
   */
  import type { PersonIdentity } from "./people.js";

  let { person, compact = false }: { person: PersonIdentity; compact?: boolean } = $props();
</script>

<span class="person-name" data-testid="person-name" data-person-key={person.resolved ? "resolved" : "unresolved"}>
  <span class="pn-name">{person.name}</span>
  {#if person.detail && !compact}
    <span class="pn-detail">{person.detail}</span>
  {/if}
</span>

<style>
  .person-name {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
  }
  .pn-name {
    color: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pn-detail {
    color: var(--v4-text-3, var(--t3));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
</style>
