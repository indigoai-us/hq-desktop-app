<script lang="ts">
  /**
   * OWNER-R21: Billing inside the one Settings list. Payment method and
   * invoices live in Stripe; Manage payment opens the Stripe customer portal
   * in the system browser. The old account Billing page listed sample
   * invoices that were never read from a server; they are not carried over.
   */
  import RailButton from "../common/button/RailButton.svelte";
  import { managePaymentUrl } from "../account/account-pages.js";

  let { openExternal }: { openExternal?: (url: string) => void } = $props();
</script>

<div class="proto-stack" data-testid="settings-billing-pane">
  <div class="set-row">
    <div>
      <div class="sn">Payment and invoices</div>
      <div class="sd">Your card, receipts and invoices are kept in Stripe.</div>
    </div>
    <RailButton icon="external" type="button" data-testid="manage-payment" onclick={() => openExternal?.(managePaymentUrl())}>Manage payment</RailButton>
  </div>
  <div class="set-row">
    <div>
      <div class="sn">Company plans</div>
      <div class="sd">Each company's plan and seats are under that company's Billing in the company panel.</div>
    </div>
  </div>
</div>
