<script lang="ts">
  /**
   * Company rail mount for Company Outpost.
   * The page shows the shared loader until the first list read returns.
   */
  import CompanyOutpostPage from "../company-outpost/CompanyOutpostPage.svelte";
  import { createCompanyOutpostClient, type CompanyOutpostApi } from "../company-outpost/company-outpost-client.js";
  import { canManageRole, type CompanyOutpostRole } from "../company-outpost/company-outpost-model.js";

  interface Props {
    companyUid: string;
    role: CompanyOutpostRole;
    api?: CompanyOutpostApi | null;
  }

  let { companyUid, role, api = null }: Props = $props();

  const client = $derived(
    createCompanyOutpostClient({
      companyUid,
      canManage: canManageRole(role),
      api,
    }),
  );
</script>

<div class="host" data-testid="company-outpost-host">
  <CompanyOutpostPage {companyUid} {role} {client} />
</div>

<style>
  .host { height: 100%; min-height: 0; }
</style>
