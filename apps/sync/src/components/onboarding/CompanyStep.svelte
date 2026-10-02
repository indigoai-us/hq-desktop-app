<script lang="ts">
  /**
   * First-run company step. Shown once the install is done to a person with no
   * active company: join a pending invite, or name a company (handle, optional
   * website, teammates), then pick Starter or Workforce. Workforce opens the
   * Stripe checkout in the browser; the `hq-desktop://setup` return comes back
   * through the deep-link handler as `messages:open-setup`.
   *
   * The company form is the server's own `create_company` card, so the fields
   * shown are whatever hq-pro declares (today: name, handle, website).
   */
  import { onDestroy } from 'svelte';
  import {
    createSlugWatcher,
    openCreateCompanyDraft,
    slugBlocksSubmit,
    slugFieldOf,
    submitCreateCompany,
    SLUG_IDLE,
    type CompanyDraftForm,
    type SlugState,
    type SlugWatcher,
  } from '@hq/ui';
  import {
    createFirstRunCompanyApi,
    isCheckoutReturnFor,
    parseInviteEmails,
    startWorkforceCheckout,
    WORKFORCE_PRICE_LABEL,
    type FirstRunCompanyPath,
    type FirstRunPlan,
    type InvokeFn,
  } from '../../lib/first-run-company';

  export type CompanyStepEvent =
    | { action: 'company_created'; companyUid: string; inviteCount: number; inviteFailureCount: number }
    | { action: 'company_create_failed'; blocked: boolean }
    | { action: 'invite_joined'; inviteCount: number }
    | { action: 'invite_join_failed' }
    | { action: 'plan_chosen'; companyUid: string; plan: FirstRunPlan }
    | { action: 'checkout_opened'; companyUid: string }
    | { action: 'checkout_failed'; companyUid: string }
    | { action: 'checkout_returned'; companyUid: string };

  export type CompanyStepResult =
    | { outcome: 'created'; companyUid: string; plan: FirstRunPlan; paid: boolean }
    | { outcome: 'joined' }
    | { outcome: 'skipped' };

  interface Props {
    path: Exclude<FirstRunCompanyPath, { kind: 'existing' }>;
    invoke: InvokeFn;
    openUrl: (url: string) => Promise<void>;
    listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
    onTelemetry?: (event: CompanyStepEvent) => void;
    oncomplete: (result: CompanyStepResult) => void;
  }

  let { path, invoke, openUrl, listen, onTelemetry, oncomplete }: Props = $props();

  type Phase = 'join' | 'loading' | 'details' | 'plan' | 'checkout';

  // svelte-ignore state_referenced_locally
  const api = createFirstRunCompanyApi(invoke);
  const idempotencyKey = `first-run-company-${crypto.randomUUID()}`;

  // svelte-ignore state_referenced_locally
  let phase = $state<Phase>(path.kind === 'join' ? 'join' : 'loading');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);

  let form = $state<CompanyDraftForm | null>(null);
  let values = $state<Record<string, string>>({});
  let slugEdited = false;
  let slugFieldId = $state<string | null>(null);
  let slugState = $state<SlugState>(SLUG_IDLE);
  let slugWatcher: SlugWatcher | null = null;
  let inviteText = $state('');

  let companyUid = $state<string | null>(null);
  let plan = $state<FirstRunPlan>('starter');
  let checkoutUrl = $state<string | null>(null);
  let stopCheckoutListen: (() => void) | null = null;

  const invites = $derived(parseInviteEmails(inviteText));
  const missing = $derived(
    (form?.fields ?? []).filter((field) => field.required && !(values[field.id] ?? '').trim()),
  );
  const canCreate = $derived(
    !busy && form !== null && missing.length === 0 && !slugBlocksSubmit(slugState) && invites.invalid.length === 0,
  );

  function toHandle(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  async function loadForm(): Promise<void> {
    phase = 'loading';
    error = null;
    const draft = await openCreateCompanyDraft(api, { idempotencyKey: `${idempotencyKey}-open` });
    if (!draft.ok) {
      error = draft.reason;
      phase = 'details';
      return;
    }
    form = draft.form;
    values = Object.fromEntries(draft.form.fields.map((field) => [field.id, field.value ?? '']));
    slugFieldId = slugFieldOf(draft.form.fields);
    slugWatcher?.cancel();
    slugWatcher = slugFieldId
      ? createSlugWatcher({
          check: (slug) => invoke<unknown>('check_company_slug', { slug }),
          constraints: draft.form.fields.find((field) => field.id === slugFieldId)?.constraints ?? null,
          onstate: (next) => (slugState = next),
          onerror: (err) => console.warn('onboarding: company handle check failed', err),
        })
      : null;
    phase = 'details';
  }

  function setValue(fieldId: string, value: string): void {
    values = { ...values, [fieldId]: value };
    if (fieldId === slugFieldId) {
      slugEdited = true;
      slugWatcher?.input(value);
    } else if (fieldId === form?.nameFieldId && slugFieldId && !slugEdited) {
      const handle = toHandle(value);
      values = { ...values, [slugFieldId]: handle };
      slugWatcher?.input(handle);
    }
  }

  function takeSuggestion(): void {
    if (!slugFieldId || !slugState.suggestion) return;
    slugEdited = true;
    values = { ...values, [slugFieldId]: slugState.suggestion };
    slugWatcher?.input(slugState.suggestion);
  }

  async function createCompany(): Promise<void> {
    if (!form || !canCreate) return;
    busy = true;
    error = null;
    const result = await submitCreateCompany(
      api,
      form,
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])),
      invites.valid.map((email) => ({ email, role: 'member' })),
      { idempotencyKey: `${idempotencyKey}-submit` },
    );
    busy = false;
    if (!result.ok) {
      error = result.reason;
      onTelemetry?.({ action: 'company_create_failed', blocked: result.blocked });
      return;
    }
    if (!result.company.companyUid) {
      // The company exists but the server did not name it; plan choice needs
      // the uid, so hand over to #setup where the plan card lives.
      error = null;
      oncomplete({ outcome: 'skipped' });
      return;
    }
    slugWatcher?.cancel();
    companyUid = result.company.companyUid;
    onTelemetry?.({
      action: 'company_created',
      companyUid,
      inviteCount: invites.valid.length,
      inviteFailureCount: result.company.inviteFailures.length,
    });
    note =
      result.company.inviteFailures.length > 0
        ? `Some invites did not go out: ${result.company.inviteFailures.map((failure) => failure.email).join(', ')}. You can invite them again from the Team tab.`
        : null;
    phase = 'plan';
  }

  async function confirmPlan(): Promise<void> {
    if (!companyUid || busy) return;
    onTelemetry?.({ action: 'plan_chosen', companyUid, plan });
    if (plan === 'starter') {
      oncomplete({ outcome: 'created', companyUid, plan, paid: false });
      return;
    }
    await openCheckout();
  }

  async function openCheckout(): Promise<void> {
    if (!companyUid) return;
    busy = true;
    error = null;
    const result = await startWorkforceCheckout(invoke, companyUid);
    if (!result.ok) {
      busy = false;
      error = result.reason;
      onTelemetry?.({ action: 'checkout_failed', companyUid });
      return;
    }
    checkoutUrl = result.url;
    await watchCheckoutReturn(companyUid);
    try {
      await openUrl(result.url);
    } catch (err) {
      console.warn('onboarding: could not open checkout in the browser', err);
      error = 'HQ could not open your browser. Use the link below to finish checkout.';
    }
    busy = false;
    onTelemetry?.({ action: 'checkout_opened', companyUid });
    phase = 'checkout';
  }

  async function watchCheckoutReturn(uid: string): Promise<void> {
    if (stopCheckoutListen) return;
    try {
      stopCheckoutListen = await listen('messages:open-setup', (payload) => {
        if (!isCheckoutReturnFor(payload, uid)) return;
        onTelemetry?.({ action: 'checkout_returned', companyUid: uid });
        finish(true);
      });
    } catch (err) {
      // Without the event the person still has the "I finished checkout" button.
      console.warn('onboarding: could not watch for the checkout return', err);
    }
  }

  function finish(paid: boolean): void {
    stopCheckoutListen?.();
    stopCheckoutListen = null;
    if (!companyUid) return;
    oncomplete({ outcome: 'created', companyUid, plan: paid ? 'workforce' : plan, paid });
  }

  async function joinInvite(slug: string | null): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const result = await invoke<{ ok: boolean; claimedSlugs: string[]; message: string; upgradeUrl?: string }>(
        'claim_pending_company_invite',
        { companySlug: slug },
      );
      if (!result.ok) {
        error = result.message || 'HQ could not accept the invite.';
        onTelemetry?.({ action: 'invite_join_failed' });
        return;
      }
      onTelemetry?.({ action: 'invite_joined', inviteCount: result.claimedSlugs.length });
      oncomplete({ outcome: 'joined' });
    } catch (err) {
      console.warn('onboarding: accepting the invite failed', err);
      error = typeof err === 'string' ? err : 'HQ could not accept the invite. Try again or skip for now.';
      onTelemetry?.({ action: 'invite_join_failed' });
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    if (path.kind === 'create' && phase === 'loading' && !form) void loadForm();
  });

  onDestroy(() => {
    slugWatcher?.cancel();
    stopCheckoutListen?.();
  });
</script>

<div class="follow-on on" data-testid="onboarding-company">
  {#if phase === 'join' && path.kind === 'join'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>You have an invite</h2>
    <p class="body">
      {#if path.invites.length === 1}
        You were invited to {path.invites[0]!.displayName}. Join to see their files and work with the team.
      {:else}
        You were invited to {path.invites.length} companies. Join them to see their files and work with each team.
      {/if}
    </p>
    {#if error}<p class="note inline-note warning" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
    <div class="btns split">
      <button
        class="btn btn-primary"
        type="button"
        data-testid="onboarding-company-join"
        disabled={busy}
        aria-busy={busy}
        onclick={() => void joinInvite(path.invites.length === 1 ? path.invites[0]!.slug : null)}
      >{busy ? 'Joining…' : path.invites.length === 1 ? `Join ${path.invites[0]!.displayName}` : 'Join all'}</button>
      <button
        class="btn btn-secondary"
        type="button"
        data-testid="onboarding-company-create-instead"
        disabled={busy}
        onclick={() => void loadForm()}
      >Make my own company</button>
    </div>
  {:else if phase === 'loading'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>Name your company</h2>
    <p class="note inline-note" role="status" aria-live="polite">Getting things ready…</p>
  {:else if phase === 'details'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>Name your company</h2>
    <p class="body">Your company is where your team shares files, bots and work in HQ.</p>
    {#if error}<p class="note inline-note warning" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
    {#if form}
      <form
        class="invite-form company-form"
        onsubmit={(event) => {
          event.preventDefault();
          void createCompany();
        }}
      >
        {#each form.fields as field (field.id)}
          <label for={`onboarding-company-${field.id}`}>
            {field.label}{field.required ? '' : ' (optional)'}
          </label>
          <input
            id={`onboarding-company-${field.id}`}
            data-testid={`onboarding-company-field-${field.id}`}
            type={field.id === 'website' ? 'url' : 'text'}
            value={values[field.id] ?? ''}
            oninput={(event) => setValue(field.id, event.currentTarget.value)}
            required={field.required}
            disabled={busy}
            aria-invalid={field.id === slugFieldId && (slugState.status === 'taken' || slugState.status === 'invalid')}
            aria-describedby={field.id === slugFieldId ? 'onboarding-company-slug-status' : undefined}
          />
          {#if field.id === slugFieldId && slugState.message}
            <p class="note inline-note" id="onboarding-company-slug-status" role="status" aria-live="polite">
              {slugState.message}
              {#if slugState.suggestion}
                <button class="link" type="button" onclick={takeSuggestion}>Use {slugState.suggestion}</button>
              {/if}
            </p>
          {:else if field.error}
            <p class="note inline-note warning">{field.error}</p>
          {/if}
        {/each}
        <label for="onboarding-company-invites">Invite teammates (optional)</label>
        <textarea
          id="onboarding-company-invites"
          data-testid="onboarding-company-invites"
          rows="2"
          placeholder="name@company.com, another@company.com"
          bind:value={inviteText}
          disabled={busy}
          aria-invalid={invites.invalid.length > 0}
        ></textarea>
        {#if invites.invalid.length > 0}
          <p class="note inline-note warning" role="alert">Check these addresses: {invites.invalid.join(', ')}</p>
        {/if}
        <div class="btns split">
          <button
            class="btn btn-primary"
            type="submit"
            data-testid="onboarding-company-create"
            disabled={!canCreate}
            aria-busy={busy}
          >{busy ? 'Creating…' : 'Create company'}</button>
          <button
            class="btn btn-secondary"
            type="button"
            data-testid="onboarding-company-skip"
            disabled={busy}
            onclick={() => oncomplete({ outcome: 'skipped' })}
          >Skip for now</button>
        </div>
      </form>
    {:else}
      <div class="btns split">
        <button class="btn btn-primary" type="button" data-testid="onboarding-company-retry" onclick={() => void loadForm()}>Try again</button>
        <button
          class="btn btn-secondary"
          type="button"
          data-testid="onboarding-company-skip"
          onclick={() => oncomplete({ outcome: 'skipped' })}
        >Skip for now</button>
      </div>
    {/if}
  {:else if phase === 'plan'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>Choose a plan</h2>
    <p class="body">Your company is ready. Pick how you want to start. You can change plans later.</p>
    {#if note}<p class="note inline-note" role="status">{note}</p>{/if}
    {#if error}<p class="note inline-note warning" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
    <fieldset class="plan-options" disabled={busy}>
      <legend class="sr-only">Plan</legend>
      <label class="plan-option" class:selected={plan === 'starter'}>
        <input type="radio" name="onboarding-plan" value="starter" bind:group={plan} data-testid="onboarding-plan-starter" />
        <span class="plan-name">Starter</span>
        <span class="plan-detail">Free. Shared files and HQ for a small team.</span>
      </label>
      <label class="plan-option" class:selected={plan === 'workforce'}>
        <input type="radio" name="onboarding-plan" value="workforce" bind:group={plan} data-testid="onboarding-plan-workforce" />
        <span class="plan-name">Workforce · {WORKFORCE_PRICE_LABEL}</span>
        <span class="plan-detail">Hosted agents, Slack bots and meeting recording for the whole team.</span>
      </label>
    </fieldset>
    <div class="btns split">
      <button
        class="btn btn-primary"
        type="button"
        data-testid="onboarding-plan-continue"
        disabled={busy}
        aria-busy={busy}
        onclick={() => void confirmPlan()}
      >{busy ? 'Opening checkout…' : plan === 'workforce' ? 'Continue to checkout' : 'Continue'}</button>
    </div>
  {:else if phase === 'checkout'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>Finish checkout in your browser</h2>
    <p class="body">
      Checkout is open in your browser. When you finish, HQ comes back here and turns on Workforce for your company.
    </p>
    {#if error}<p class="note inline-note warning" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
    {#if checkoutUrl}
      <p class="note inline-note">
        <button class="link" type="button" data-testid="onboarding-checkout-reopen" onclick={() => checkoutUrl && void openUrl(checkoutUrl)}>Open checkout again</button>
      </p>
    {/if}
    <div class="btns split">
      <button class="btn btn-primary" type="button" data-testid="onboarding-checkout-done" onclick={() => finish(false)}>I finished checkout</button>
      <button
        class="btn btn-secondary"
        type="button"
        data-testid="onboarding-checkout-starter"
        onclick={() => {
          plan = 'starter';
          finish(false);
        }}
      >Start on Starter for now</button>
    </div>
  {/if}
</div>

<style>
  .company-form textarea {
    font: inherit;
    resize: vertical;
  }
  .plan-options {
    border: 0;
    margin: 0 0 16px;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .plan-option {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 10px;
    padding: 12px;
    border: 1px solid var(--hairline, rgba(255, 255, 255, 0.16));
    border-radius: 10px;
    cursor: pointer;
  }
  .plan-option.selected {
    border-color: var(--accent, currentColor);
  }
  .plan-option input {
    grid-row: span 2;
    align-self: center;
  }
  .plan-name {
    font-weight: 600;
  }
  .plan-detail {
    opacity: 0.75;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
