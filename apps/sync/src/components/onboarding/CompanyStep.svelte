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
    requestCompanyProvisioning,
    waitForProvisioning,
    parseInviteEmails,
    startWorkforceCheckout,
    WORKFORCE_PRICE_LABEL,
    type FirstRunCompanyPath,
    type FirstRunPlan,
    type InvokeFn,
    type PlanLimitRefusal,
  } from '../../lib/first-run-company';
  import PlanUpgradeAction from '../PlanUpgradeAction.svelte';
  import { flushPendingCompanyInvites, queuePendingCompanyInvites } from '../../lib/pending-company-invites';
  import type { ProvisioningState } from '../../lib/onboarding-company-route';
  import {
    companyNameFromEmail,
    companyNamePrefillStatus,
    type CompanyNamePrefillStatus,
  } from '../../lib/company-name-prefill';

  export type CompanyStepEvent =
    | {
        action: 'company_created';
        companyUid: string;
        inviteCount: number;
        inviteFailureCount: number;
        inviteQueuedCount: number;
        namePrefill: CompanyNamePrefillStatus;
      }
    | { action: 'company_create_failed'; blocked: boolean }
    | { action: 'existing_used'; companyUid: string }
    | { action: 'create_another' }
    | { action: 'company_create_plan_limit' }
    | { action: 'provisioning_wait'; companyUid: string; retry: boolean }
    | { action: 'provisioning_ready'; companyUid: string; attemptCount: number; retry: boolean }
    | { action: 'provisioning_failed'; companyUid: string; step: string; retry: boolean }
    | { action: 'invite_joined'; inviteCount: number }
    | { action: 'invite_join_failed' }
    | { action: 'invite_other_email' }
    | { action: 'switch_account' }
    | { action: 'plan_chosen'; companyUid: string; plan: FirstRunPlan }
    | { action: 'checkout_opened'; companyUid: string }
    | { action: 'checkout_failed'; companyUid: string }
    | { action: 'checkout_returned'; companyUid: string };

  export type CompanyStepResult =
    | { outcome: 'created'; companyUid: string; plan: FirstRunPlan; paid: boolean }
    | { outcome: 'joined'; slugs: string[]; companyUid: string | null }
    | { outcome: 'used_existing'; companyUid: string; slug: string | null }
    | { outcome: 'skipped' };

  interface Props {
    path: Exclude<FirstRunCompanyPath, { kind: 'skip' }>;
    invoke: InvokeFn;
    /** Sign out and go back to sign-in (invite sent to another email). */
    onswitchaccount?: () => void;
    /** Test seam: provisioning poll timing. */
    provisioningPoll?: { intervalMs?: number; timeoutMs?: number };
    openUrl: (url: string) => Promise<void>;
    listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
    onTelemetry?: (event: CompanyStepEvent) => void;
    oncomplete: (result: CompanyStepResult) => void;
    namePrefillEnabled?: boolean;
    signedInEmail?: string | null;
  }

  let {
    path,
    invoke,
    onswitchaccount,
    provisioningPoll,
    openUrl,
    listen,
    onTelemetry,
    oncomplete,
    namePrefillEnabled = false,
    signedInEmail = null,
  }: Props = $props();

  type Phase = 'other-identity' | 'existing' | 'join' | 'loading' | 'details' | 'provisioning' | 'provision-failed' | 'plan' | 'checkout';

  // svelte-ignore state_referenced_locally
  const api = createFirstRunCompanyApi(invoke, { onPlanLimit: (refusal) => (planLimit = refusal) });
  const idempotencyKey = `first-run-company-${crypto.randomUUID()}`;

  // svelte-ignore state_referenced_locally
  let phase = $state<Phase>(
    path.kind === 'join'
      ? 'join'
      : path.kind === 'existing'
        ? 'existing'
        : path.kind === 'other-identity'
          ? 'other-identity'
          : path.kind === 'resume'
            ? path.state === 'failed'
              ? 'provision-failed'
              : 'provisioning'
            : 'loading',
  );
  // svelte-ignore state_referenced_locally
  const resumed = path.kind === 'resume';
  // svelte-ignore state_referenced_locally
  let inviteOtherEmail = $state(path.kind === 'join' && path.decision === 'invite_other_email');
  // svelte-ignore state_referenced_locally
  let provisioningFailedStep = $state<string | null>(path.kind === 'resume' ? path.step : null);
  let provisioningRetrying = $state(false);
  /** Invites typed on the form; sent only once the company is ready. */
  let heldInvites: Array<{ email: string; role: string }> = [];
  let destroyed = false;
  /** Create refused for the free plan's limit: show the upgrade prompt inline, not an error. */
  let planLimit = $state<PlanLimitRefusal | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);

  let form = $state<CompanyDraftForm | null>(null);
  let values = $state<Record<string, string>>({});
  let prefilledCompanyName = $state<string | null>(null);
  let slugEdited = false;
  let slugFieldId = $state<string | null>(null);
  let slugState = $state<SlugState>(SLUG_IDLE);
  let slugWatcher: SlugWatcher | null = null;
  let inviteText = $state('');

  // svelte-ignore state_referenced_locally
  let companyUid = $state<string | null>(path.kind === 'resume' ? path.company.companyUid : null);
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

  function browserStorage(): Storage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  }

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
    prefilledCompanyName = null;
    if (namePrefillEnabled && path.kind === 'create') {
      prefilledCompanyName = companyNameFromEmail(signedInEmail);
    }
    values = Object.fromEntries(
      draft.form.fields.map((field) => [
        field.id,
        field.id === draft.form.nameFieldId
          ? prefilledCompanyName ?? field.value ?? ''
          : field.value ?? '',
      ]),
    );
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
    if (prefilledCompanyName && form.nameFieldId) {
      // Use the same edit path as typing so the derived slug and availability
      // check are populated before the create button is evaluated.
      setValue(form.nameFieldId, prefilledCompanyName);
    }
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
    planLimit = null;
    const result = await submitCreateCompany(
      api,
      form,
      Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])),
      // Invites wait until the company is ready (below); never sent mid-provisioning.
      [],
      {
        idempotencyKey: `${idempotencyKey}-submit`,
        // The create flow provisions the vault itself (activate-cloud); show it.
        onPhase: (next) => {
          if (next === 'provisioning') phase = 'provisioning';
        },
      },
    );
    busy = false;
    if (!result.ok) {
      if (planLimit) {
        onTelemetry?.({ action: 'company_create_plan_limit' });
        return;
      }
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
    heldInvites = invites.valid.map((email) => ({ email, role: 'member' }));
    if (result.company.cloudError) {
      // Created, but the vault setup did not finish: offer the retry, never a second create.
      provisioningFailedStep = 'activate-cloud';
      onTelemetry?.({ action: 'provisioning_failed', companyUid, step: 'activate-cloud', retry: false });
      phase = 'provision-failed';
      return;
    }
    await awaitProvisioning(false);
  }

  /**
   * "Setting up your company…": poll until hq-pro says the vault is ready. A
   * retry asks hq-pro to provision again (idempotent for the same company);
   * it never creates a second company.
   */
  async function awaitProvisioning(retry: boolean): Promise<void> {
    if (!companyUid) return;
    const uid = companyUid;
    phase = 'provisioning';
    error = null;
    provisioningFailedStep = null;
    provisioningRetrying = retry;
    onTelemetry?.({ action: 'provisioning_wait', companyUid: uid, retry });
    let state: ProvisioningState = { status: 'pending' };
    if (retry) state = await requestCompanyProvisioning(invoke, uid);
    let attempts = 0;
    if (state.status === 'pending') {
      state = await waitForProvisioning({
        invoke,
        companyUid: uid,
        intervalMs: provisioningPoll?.intervalMs,
        timeoutMs: provisioningPoll?.timeoutMs,
        cancelled: () => destroyed,
        onPoll: (_state, attempt) => (attempts = attempt),
      });
    }
    if (destroyed) return;
    if (state.status !== 'ready') {
      const step = state.status === 'failed' ? state.step : 'timeout';
      provisioningFailedStep = step;
      onTelemetry?.({ action: 'provisioning_failed', companyUid: uid, step, retry });
      phase = 'provision-failed';
      return;
    }
    onTelemetry?.({ action: 'provisioning_ready', companyUid: uid, attemptCount: attempts, retry });
    if (resumed) {
      // Invites queued by an earlier run go out now that the company is ready.
      void flushPendingCompanyInvites(browserStorage(), api).catch((err) =>
        console.warn('onboarding: sending queued invites failed', err),
      );
    } else {
      await sendHeldInvites(uid);
    }
    phase = 'plan';
  }

  async function sendHeldInvites(uid: string): Promise<void> {
    const queued = heldInvites;
    heldInvites = [];
    const failedEmails: string[] = [];
    let sent = 0;
    if (queued.length > 0) {
      if (!queuePendingCompanyInvites(browserStorage(), uid, queued)) {
        failedEmails.push(...queued.map((invite) => invite.email));
      } else {
        try {
          const report = await flushPendingCompanyInvites(browserStorage(), api);
          sent = report.sent.filter((entry) => entry.companyUid === uid).reduce((sum, entry) => sum + entry.count, 0);
          failedEmails.push(...report.failed.filter((entry) => entry.companyUid === uid).map((entry) => entry.email));
        } catch (err) {
          console.warn('onboarding: sending invites failed', err);
          failedEmails.push(...queued.map((invite) => invite.email));
        }
      }
    }
    const stillQueued = Math.max(0, queued.length - sent - failedEmails.length);
    onTelemetry?.({
      action: 'company_created',
      companyUid: uid,
      inviteCount: queued.length,
      inviteFailureCount: failedEmails.length,
      inviteQueuedCount: stillQueued,
      namePrefill: companyNamePrefillStatus(
        prefilledCompanyName,
        form?.nameFieldId ? values[form.nameFieldId] ?? '' : '',
      ),
    });
    const notes: string[] = [];
    if (stillQueued > 0) {
      notes.push('HQ will send the rest of your invites shortly.');
    }
    if (failedEmails.length > 0) {
      notes.push(
        `Some invites did not go out: ${failedEmails.join(', ')}. You can invite them again from the Team tab.`,
      );
    }
    note = notes.length > 0 ? notes.join(' ') : null;
  }

  /** Leave before the company is ready: the app sends the held invites once it is. */
  function skipWhileProvisioning(): void {
    if (companyUid && heldInvites.length > 0) queuePendingCompanyInvites(browserStorage(), companyUid, heldInvites);
    heldInvites = [];
    oncomplete({ outcome: 'skipped' });
  }

  function useExisting(): void {
    if (path.kind !== 'existing') return;
    onTelemetry?.({ action: 'existing_used', companyUid: path.company.companyUid });
    oncomplete({ outcome: 'used_existing', companyUid: path.company.companyUid, slug: path.company.slug });
  }

  function createAnother(): void {
    onTelemetry?.({ action: 'create_another' });
    void loadForm();
  }

  function switchAccount(): void {
    onTelemetry?.({ action: 'switch_account' });
    onswitchaccount?.();
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
        { companySlug: slug, route: 'onboarding' },
      );
      if (!result.ok) {
        error = result.message || 'HQ could not accept the invite.';
        onTelemetry?.({ action: 'invite_join_failed' });
        return;
      }
      if (result.claimedSlugs.length === 0 && /^No email-keyed pending invite/.test(result.message ?? '')) {
        // The server holds no invite for this address: it went to another one.
        inviteOtherEmail = true;
        onTelemetry?.({ action: 'invite_other_email' });
        return;
      }
      onTelemetry?.({ action: 'invite_joined', inviteCount: result.claimedSlugs.length });
      const joinedInvite =
        path.kind === 'join'
          ? (path.invites.find((invite) => invite.slug !== null && result.claimedSlugs.includes(invite.slug)) ??
            (path.invites.length === 1 ? path.invites[0] : undefined))
          : undefined;
      oncomplete({ outcome: 'joined', slugs: result.claimedSlugs, companyUid: joinedInvite?.companyUid ?? null });
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

  let resumeStarted = false;
  $effect(() => {
    if (path.kind === 'resume' && path.state === 'pending' && !resumeStarted) {
      resumeStarted = true;
      // A company left by an older build may never have been provisioned:
      // ask again (idempotent), then wait.
      void awaitProvisioning(true);
    }
  });

  onDestroy(() => {
    destroyed = true;
    slugWatcher?.cancel();
    stopCheckoutListen?.();
  });

  /** Server labels may already include "(optional)" (e.g. "Website (optional) — …"); only append it when missing. */
  function fieldLabel(field: { label: string; required?: boolean }): string {
    if (field.required || /\(optional\)/i.test(field.label)) return field.label;
    return `${field.label} (optional)`;
  }

</script>

<div class="follow-on on" data-testid="onboarding-company">
  {#if phase === 'other-identity' && path.kind === 'other-identity'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>You may already have a company</h2>
    <p class="body" data-testid="onboarding-company-other-account">
      Your company{path.other.companyName ? ` ${path.other.companyName}` : ''} is on {path.other.maskedEmail}.{#if path.signedInEmail} You're signed in as {path.signedInEmail}.{/if} Switch account?
    </p>
    <div class="btns split">
      <button
        class="btn btn-primary"
        type="button"
        data-testid="onboarding-company-switch-account"
        onclick={switchAccount}
      >Switch account</button>
      <button
        class="btn btn-secondary"
        type="button"
        data-testid="onboarding-company-create-here"
        onclick={createAnother}
      >Create a new company here</button>
    </div>
  {:else if phase === 'existing' && path.kind === 'existing'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>You already have a company</h2>
    <p class="body">
      {path.company.name} is ready in HQ. Keep working there, or make a separate company.
    </p>
    <div class="btns split">
      <button
        class="btn btn-primary"
        type="button"
        data-testid="onboarding-company-use-existing"
        onclick={useExisting}
      >Use {path.company.name}</button>
      <button
        class="btn btn-secondary"
        type="button"
        data-testid="onboarding-company-create-another"
        onclick={createAnother}
      >Create another</button>
    </div>
  {:else if phase === 'join' && path.kind === 'join'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>You have an invite</h2>
    {#if inviteOtherEmail}
      <p class="body" data-testid="onboarding-company-invite-other-email">
        Your invite was sent to a different email.{#if path.signedInEmail} You're signed in as {path.signedInEmail}.{/if} Switch account?
      </p>
      <div class="btns split">
        <button
          class="btn btn-primary"
          type="button"
          data-testid="onboarding-company-switch-account"
          onclick={switchAccount}
        >Switch account</button>
        <button
          class="btn btn-secondary"
          type="button"
          data-testid="onboarding-company-skip"
          onclick={() => oncomplete({ outcome: 'skipped' })}
        >Skip for now</button>
      </div>
    {:else if path.decision === 'invite_expired'}
      <p class="body" data-testid="onboarding-company-invite-expired">
        Your invite to {path.invites[0]!.name} has expired. Ask {path.invites[0]!.inviter ?? 'the person who invited you'} to resend it, then come back here.
      </p>
      <div class="btns split">
        <button
          class="btn btn-secondary"
          type="button"
          data-testid="onboarding-company-skip"
          onclick={() => oncomplete({ outcome: 'skipped' })}
        >Skip for now</button>
      </div>
    {:else}
      <p class="body">
        {#if path.invites.length === 1}
          You were invited to {path.invites[0]!.name}. Join to see their files and work with the team.
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
        >{busy ? 'Joining…' : path.invites.length === 1 ? `Join ${path.invites[0]!.name}` : 'Join all'}</button>
        <button
          class="btn btn-secondary"
          type="button"
          data-testid="onboarding-company-skip"
          disabled={busy}
          onclick={() => oncomplete({ outcome: 'skipped' })}
        >Skip for now</button>
      </div>
    {/if}
  {:else if phase === 'provisioning'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>Setting up your company…</h2>
    <p class="note inline-note" role="status" aria-live="polite" data-testid="onboarding-company-provisioning">
      {provisioningRetrying ? 'Trying setup again. This can take a minute.' : 'HQ is creating your company’s storage. This can take a minute.'}
    </p>
  {:else if phase === 'provision-failed'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>Setting up your company…</h2>
    <p class="note inline-note warning" role="alert" data-testid="onboarding-company-provisioning-failed">
      Setup did not finish{provisioningFailedStep && provisioningFailedStep !== 'unknown' ? ` (step: ${provisioningFailedStep})` : ''}. Your company is saved; try setup again.
    </p>
    <div class="btns split">
      <button
        class="btn btn-primary"
        type="button"
        data-testid="onboarding-company-provisioning-retry"
        onclick={() => void awaitProvisioning(true)}
      >Try again</button>
      <button
        class="btn btn-secondary"
        type="button"
        data-testid="onboarding-company-skip"
        onclick={skipWhileProvisioning}
      >Skip for now</button>
    </div>
  {:else if phase === 'loading'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>Name your company</h2>
    <p class="note inline-note" role="status" aria-live="polite">Getting things ready…</p>
  {:else if phase === 'details'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>Name your company</h2>
    <p class="body">Your company is where your team shares files, bots and work in HQ.</p>
    {#if error}<p class="note inline-note warning" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
    {#if planLimit}
      <p class="note inline-note" role="status" data-testid="onboarding-company-plan-limit">
        {planLimit.message}
        {#if planLimit.upgradeUrl}
          <PlanUpgradeAction
            upgradeUrl={planLimit.upgradeUrl}
            onUpgrade={(url) => openUrl(url)}
            testId="onboarding-company-plan-upgrade"
          />
        {/if}
      </p>
    {/if}
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
            {fieldLabel(field)}
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
