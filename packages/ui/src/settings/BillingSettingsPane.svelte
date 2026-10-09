<script lang="ts">
  /**
   * OWNER-R21: Billing inside the one Settings list. Payment method and
   * invoices live in Stripe; Manage payment opens a Stripe portal session
   * hq-pro mints for the signed-in person, in the system browser. The old
   * account Billing page listed sample invoices that were never read from a
   * server; they are not carried over.
   */
  import type { CompanyApi } from "@hq/platform";
  import RailButton from "../common/button/RailButton.svelte";
  import { managePaymentUrl } from "../account/account-pages.js";

  let { openExternal, company = null }: { openExternal?: (url: string) => void; company?: CompanyApi | null } = $props();

  let opening = $state(false);

  async function openPortal(): Promise<void> {
    if (opening) return;
    opening = true;
    try {
      openExternal?.(await managePaymentUrl(company));
    } finally {
      opening = false;
    }
  }
</script>

<div class="proto-stack" data-testid="settings-billing-pane">
  <div class="set-row">
    <div>
      <div class="sn">Payment and invoices</div>
      <div class="sd">Your card, receipts and invoices are kept in Stripe.</div>
    </div>
    <RailButton icon="external" type="button" data-testid="manage-payment" disabled={opening} onclick={() => void openPortal()}>Manage payment</RailButton>
  </div>
  <div class="set-row">
    <div>
      <div class="sn">Company plans</div>
      <div class="sd">Each company's plan and seats are under that company's Billing in the company panel.</div>
    </div>
  </div>
</div>
