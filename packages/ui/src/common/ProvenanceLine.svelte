<script lang="ts">
  import {
    provenanceView,
    type WorkKind,
    type WorkProvenance,
  } from "./provenance";

  interface Props {
    provenance?: WorkProvenance | null;
    kind: WorkKind;
    testid?: string;
    compact?: boolean;
    unavailable?: boolean;
  }

  let {
    provenance = null,
    kind,
    testid = "work-provenance",
    compact = false,
    unavailable = false,
  }: Props = $props();

  const view = $derived(provenanceView(provenance, kind, unavailable));
  // The normalizer always supplies this fallback. Keep it explicit here too so
  // a future display-model change can never leave a blank source label.
  const sourceLabel = $derived(
    view.origin || (unavailable ? "Attribution unavailable" : "Unknown source"),
  );
  const compactSummary = $derived(
    [
      ...view.people.map((person) => `${person.role} ${person.label}`),
      sourceLabel,
    ].join(" · "),
  );
</script>

<div
  class="provenance-line"
  class:is-compact={compact}
  data-testid={testid}
  aria-label={view.ariaLabel}
  title={view.ariaLabel}
>
  {#if compact}
    <span class="compact-summary">{compactSummary}</span>
  {:else}
    {#if view.people.length > 0}
      {#each view.people as person (`${person.role}:${person.label}`)}
        <span class="person">
          <span class="role">{person.role}</span>
          <span class="label">{person.label}</span>
        </span>
      {/each}
    {/if}
    <span class="source">{sourceLabel}</span>
  {/if}
</div>

<style>
  .provenance-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 9px;
    min-width: 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro, 10px));
    line-height: 1.25;
  }

  .person,
  .source {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
  }

  .person::after {
    margin-left: 5px;
    color: var(--v4-hairline);
    content: "·";
  }

  .role {
    flex: 0 0 auto;
    color: var(--v4-text-3);
  }

  .label {
    overflow: hidden;
    color: var(--v4-text-2);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source {
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .is-compact {
    flex-wrap: nowrap;
    overflow: hidden;
  }

  .compact-summary {
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
