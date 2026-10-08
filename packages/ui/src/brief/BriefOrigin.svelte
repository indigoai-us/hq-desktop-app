<script lang="ts">
  /** Company logo + repo or org, on every item, so sources are easy to tell apart. */
  import CompanyIcon from "../company/CompanyIcon.svelte";
  import { railInitials } from "../shell/app-rail.js";
  import { useBrief } from "./brief-context.svelte.js";
  import type { BriefOrigin } from "./brief-types.js";

  let { origin }: { origin: BriefOrigin } = $props();
  const brief = useBrief();
  const company = $derived(brief.company(origin.companyUid));
  const repo = $derived(origin.repo ? (origin.repo.includes("/") ? origin.repo.split("/").slice(1).join("/") : origin.repo) : "");
</script>

{#if company || repo}
  <span class="org" title={[company?.label, origin.repo].filter(Boolean).join(" · ")} data-testid="brief-origin">
    {#if company}
      <span class="lgo">
        {#if company.iconUrl}
          <CompanyIcon iconUrl={company.iconUrl} size={16} label={company.label} decorative />
        {:else}
          {railInitials(company.label)}
        {/if}
      </span>
    {/if}
    {#if repo}<b>{repo}</b>{/if}
  </span>
{/if}
