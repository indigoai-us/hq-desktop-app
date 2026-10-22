<script lang="ts">
  import CompanySignInSession from "./CompanySignInSession.svelte";
  import type { CompanySignInRole } from "./company-signin-model.js";
  import type { CompanySignInPost } from "./company-signin-client.js";

  interface Props {
    role: CompanySignInRole;
    companyUid: string;
    outpostId?: string;
    /** Transport for POST /outpost/company/signin, e.g. agents.companyOutpostSignIn. */
    post: CompanySignInPost;
  }

  let { role, companyUid, outpostId, post }: Props = $props();

  // One session per company, box and role. Any change tears the old one down
  // (timers, in-flight results, link, code field, notices) and starts fresh.
  const sessionKey = $derived(`${companyUid}:${outpostId ?? ""}:${role}`);
</script>

{#key sessionKey}
  <CompanySignInSession {role} {companyUid} {outpostId} {post} />
{/key}
