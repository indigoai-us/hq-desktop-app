<script lang="ts">
  /**
   * Company rail mount for Company Outpost.
   * The page shows the shared loader until the first list read returns.
   * Preparing polls every pollMs. The Claude sign-in card from the sign-in
   * lane mounts in the page's signInCard slot; until then it stays unset.
   */
  import CompanyOutpostPage from "../company-outpost/CompanyOutpostPage.svelte";
  import { createCompanyOutpostClient, type CompanyOutpostApi } from "../company-outpost/company-outpost-client.js";
  import { canManageRole, type CompanyOutpostRole } from "../company-outpost/company-outpost-model.js";
  import type { NavigationDestination } from "./navigation-history.js";

  interface Props {
    companyUid: string;
    role: CompanyOutpostRole;
    api?: CompanyOutpostApi | null;
    pollMs?: number | null;
    /** Opens the outpost-jobs route. Returns false when the app cannot open it yet. */
    onOpenJob?: (destination: NavigationDestination) => boolean | Promise<boolean>;
    /** Starts the HQ sign-in flow after an expired sign-in. */
    onsignin?: () => void | Promise<void>;
  }

  let { companyUid, role, api = null, pollMs = 10_000, onOpenJob, onsignin }: Props = $props();

  const client = $derived(
    createCompanyOutpostClient({
      companyUid,
      canManage: canManageRole(role),
      api,
    }),
  );
</script>

<div class="host" data-testid="company-outpost-host">
  <CompanyOutpostPage {companyUid} {role} {client} {pollMs} {onOpenJob} onSignIn={onsignin} />
</div>

<style>
  .host { height: 100%; min-height: 0; }
</style>
