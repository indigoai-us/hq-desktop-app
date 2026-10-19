<script lang="ts">
  import CompanySignInCard from "./CompanySignInCard.svelte";
  import { COMPANY_OUTPOST_BOX_DETAIL_SIGNIN_SLOT, signInPreviewFrame } from "./company-signin-preview.js";

  interface Props {
    /** not-signed-in, preparing, code-entry, signed-in, expired, failed, not-available, member-signed, member-unsigned */
    state?: string;
  }

  let { state = "not-signed-in" }: Props = $props();
  const frame = $derived(signInPreviewFrame(state));
</script>

<section class="preview" data-testid="company-outpost-signin-preview">
  <p class="note">Preview. The box detail screen mounts the sign-in card in the slot below.</p>
  <div
    id={COMPANY_OUTPOST_BOX_DETAIL_SIGNIN_SLOT}
    data-testid={COMPANY_OUTPOST_BOX_DETAIL_SIGNIN_SLOT}
    data-slot={COMPANY_OUTPOST_BOX_DETAIL_SIGNIN_SLOT}
  >
    <CompanySignInCard
      role={frame.role}
      view={frame.view}
      failure={frame.failure}
      codeError={frame.codeError}
      now={frame.now}
    />
  </div>
</section>

<style>
  .preview { padding: 24px; background: var(--v4-ground, transparent); color: var(--v4-text-1, inherit); min-height: 100%; }
  .note { margin: 0 0 16px; font: 400 13px/1.45 sans-serif; color: var(--v4-text-3, rgba(0, 0, 0, 0.62)); }
</style>
