<script lang="ts">
  /** Company logo + repo or org, on every item, so sources are easy to tell apart. */
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import { useBrief } from "./brief-context.svelte.js";
  import type { BriefOrigin } from "./brief-types.js";

  let { origin }: { origin: BriefOrigin } = $props();
  const brief = useBrief();
  const company = $derived(brief.company(origin.companyUid));
  const repo = $derived(origin.repo ? (origin.repo.includes("/") ? origin.repo.split("/").slice(1).join("/") : origin.repo) : "");
</script>

{#if company || repo}
  <span class="org" title={origin.repo ?? ""} data-testid="brief-origin">
    {#if company}
      <span class="lgo"><CompanyLabel name={company.label} iconUrl={company.iconUrl} companyUid={company.uid} size={16} iconOnly /></span>
    {/if}
    {#if repo}<b>{repo}</b>{/if}
  </span>
{/if}
