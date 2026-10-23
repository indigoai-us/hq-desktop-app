<!--
  Custom domain sheet on fixture data, for screenshots:
  ?view=custom-domain-shot&state=empty|card|pending|apex|live|member|failed
  Answers follow hq-deploy's /api/apps/:id/domains shapes; names are fictional.
-->
<script lang="ts">
  import CustomDomainForm from '../../../packages/ui/src/company/files-connect/CustomDomainForm.svelte';
  import '../src/desktop-alt/v4/tokens.css';
  import '../../../packages/ui/src/home/tokens.css';
  import '../../../packages/ui/src/chat/chat-tokens.css';

  const params = new URLSearchParams(window.location.search);
  const state = params.get('state') ?? 'empty';
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  const domain = state === 'apex' ? 'mysite.com' : 'app.mysite.com';
  const listed = state === 'pending' || state === 'apex' || state === 'live' || state === 'member';
  const validationState = state === 'live' ? 'validated' : 'pending';

  async function request(_scope: string, method: string, path: string) {
    if (method === 'GET') {
      if (state === 'failed') return ok({ status: 503, body: {} });
      return ok({ status: 200, body: { appId: 'app_1', domains: listed ? [{ domain, environment: 'production', validationState }] : [] } });
    }
    if (method === 'POST' && path.endsWith('/domains')) {
      return ok({ status: 402, body: { error: { status: 402, code: 'PAYMENT_METHOD_REQUIRED', message: 'A payment method is required' } } });
    }
    if (method === 'POST') {
      return ok({ status: 200, body: { ok: true, validationState: 'pending', certStatus: 'PENDING_VALIDATION', serving: false, dnsInstructions: [{ type: 'CNAME', name: `_3f1c9a.${domain}.`, value: '_8d2e47.acm-validations.aws.' }] } });
    }
    return ok({ status: 200, body: { ok: true, remaining: 0 } });
  }
</script>

<div class="stage chat-shell">
  <div class="sheet" role="dialog" aria-label="Custom domain">
    <header class="sh"><span>Custom domain</span></header>
    <CustomDomainForm
      appId="app_1"
      appName="launch-notes"
      appUrl="https://launch-notes.indigo-hq.com"
      scope="acme"
      {request}
      canManage={state !== 'member'}
      retryDelays={[0, 0]}
      loadPrices={async () => ({ standardUsd: 20, premiumUsd: 500 })}
      cardEntryUrl={async () => null}
      openExternal={() => {}}
      onclose={() => {}}
    />
  </div>
</div>

<style>
  /* The company Deployments sheet frame (FilesConnectPage.svelte), on the app ground. */
  .stage { min-height: 100vh; display: grid; place-items: center; background: var(--v4-ground); font: 400 13px/1.45 var(--font-ui, var(--font-sans)); color: var(--t1, var(--v4-text-1)); }
  .sheet { width: min(480px, calc(100vw - 32px)); border: 1px solid var(--panel-border, var(--v4-hairline)); border-radius: 8px; background: var(--overlay-bg, var(--panel-bg, var(--v4-popover))); overflow: hidden; }
  .sh { display: flex; align-items: center; height: 52px; padding: 0 20px; border-bottom: 1px solid var(--panel-border, var(--v4-hairline)); font-weight: 500; }
</style>
