<script lang="ts">
  /**
   * Preview of the first-run company step (?view=onboarding-company).
   * ?scenario=create (default) | join | paused. Uses its own in-page answers
   * for the server so every screen of the step can be reached in a browser:
   * name the company, pick a plan, open checkout, and the checkout return
   * (the harness emits `messages:open-setup` for "Simulate checkout return").
   */
  import { emit, listen } from '@tauri-apps/api/event';
  import { open } from '@tauri-apps/plugin-shell';
  import '../src/styles/design-system.css';
  import '../src/components/onboarding/welcome/welcome.css';
  import CompanyStep, {
    type CompanyStepEvent,
    type CompanyStepResult,
  } from '../src/components/onboarding/CompanyStep.svelte';
  import type { FirstRunCompanyPath, InvokeFn } from '../src/lib/first-run-company';

  const params = new URLSearchParams(window.location.search);
  const scenario = params.get('scenario') ?? 'create';

  const card = {
    v: 1,
    type: 'lifecycle_card',
    kind: 'create_company',
    cardId: 'card_create_company',
    state: 'open',
    title: 'Name your company',
    summary: null,
    fields: [
      { id: 'name', label: 'Company name', control: 'text', required: true, value: '' },
      {
        id: 'slug',
        label: 'Company handle',
        control: 'text',
        required: true,
        value: '',
        constraints: { pattern: '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$', minLength: 3, maxLength: 40, description: 'Lowercase letters, numbers and dashes.' },
      },
      { id: 'website', label: 'Website', control: 'text', required: false, value: '' },
    ],
    actions: [{ id: 'submit', label: 'Create company', style: 'primary' }],
    viewer: { canAct: true },
  };

  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  (window as Window & { __companyStepCalls?: typeof calls }).__companyStepCalls = calls;

  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    switch (command) {
      case 'run_card_action':
        if (args?.cardId === 'companies_summary') throw new Error('[not_found] Request failed (status 404)');
        return { state: 'done', companyUid: 'cmp_preview', companyChannelId: 'ch_preview' };
      case 'fetch_channel':
        return {
          channelId: 'setup',
          messages: [{ eventId: 'evt_card', createdAt: new Date().toISOString(), messageKind: 'system', systemEvent: card }],
        };
      case 'check_company_slug': {
        const slug = String(args?.slug ?? '');
        const taken = slug === 'acme';
        return {
          valid: true,
          available: !taken,
          normalized: slug,
          suggestion: taken ? 'acme-hq' : null,
          reasons: taken ? ['taken'] : [],
        };
      }
      case 'run_company_tab_action':
        return { state: 'done' };
      case 'claim_pending_company_invite':
        return { ok: true, claimedSlugs: ['northwind'], message: 'Joined' };
      case 'hq_pro_fetch':
        if (scenario === 'paused') {
          return { status: 503, body: JSON.stringify({ code: 'team_signup_disabled' }) };
        }
        return { status: 200, body: JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_preview' }) };
      default:
        return null;
    }
  }) as unknown as InvokeFn;

  const path: Exclude<FirstRunCompanyPath, { kind: 'existing' }> =
    scenario === 'join'
      ? { kind: 'join', invites: [{ slug: 'northwind', displayName: 'Northwind' }] }
      : { kind: 'create' };

  let events = $state<CompanyStepEvent[]>([]);
  let result = $state<CompanyStepResult | null>(null);
</script>

<div class="hq-welcome motion-failed company-preview">
  <section class="scene s-follow-on s-company on" data-scene="company">
    <div class="panel-block">
      {#if result}
        <p class="body" data-testid="company-preview-result">Finished: {JSON.stringify(result)}</p>
      {:else}
        <CompanyStep
          {path}
          {invoke}
          openUrl={(url) => open(url)}
          listen={(event, handler) => listen(event, (message) => handler(message.payload))}
          onTelemetry={(event) => (events = [...events, event])}
          oncomplete={(next) => (result = next)}
        />
      {/if}
    </div>
  </section>
  <button
    class="simulate"
    type="button"
    data-testid="company-preview-return"
    onclick={() => void emit('messages:open-setup', { companyUid: 'cmp_preview', checkout: 'done' })}
  >Simulate checkout return</button>
  <pre class="events" data-testid="company-preview-events">{events.map((event) => event.action).join('\n')}</pre>
</div>

<style>
  .company-preview {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    overflow: auto;
  }
  .company-preview .scene {
    position: relative;
    opacity: 1;
    visibility: visible;
    width: min(560px, 92vw);
    pointer-events: auto;
  }
  .company-preview .scene :global(.panel-block) {
    position: relative;
    left: auto;
    transform: none;
    width: 100%;
  }
  .company-preview :global(.follow-on *) {
    opacity: 1;
  }
  .simulate {
    position: fixed;
    right: 12px;
    bottom: 12px;
    font-size: 11px;
    opacity: 0.6;
  }
  .events {
    position: fixed;
    left: 12px;
    bottom: 12px;
    font-size: 10px;
    opacity: 0.5;
    margin: 0;
  }
</style>
