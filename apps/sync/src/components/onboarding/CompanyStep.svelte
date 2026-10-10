<script lang="ts">
  import RailIcon from '@hq/ui/rail-icon';
  /**
   * First-run company step. Shown after the setup explainers and before the
   * ready ("Open HQ Desktop") screen, while the install runs, to a person with
   * no active company: join a pending invite, or name a company (optional website,
   * teammates), then pick Starter or Workforce. The company handle (slug) is
   * made from the name and checked in the background; nobody types it. When
   * the person already picked a plan on the website (`priorPlan`), the plan
   * screen is skipped and that plan is used. Workforce opens the
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
    COMPANY_NAME_NEEDS_LETTERS,
    COMPANY_NAME_UNUSABLE,
    createFirstRunCompanyApi,
    deriveCompanyHandle,
    isCheckoutReturnFor,
    requestCompanyProvisioning,
    waitForProvisioning,
    parseInviteEmails,
    startWorkforceCheckout,
    type FirstRunCompanyPath,
    type FirstRunPlan,
    type InvokeFn,
    type PlanLimitRefusal,
  } from '../../lib/first-run-company';
  import { PLAN_CARDS, PLAN_PICKER_COPY, type PlanRowState } from '../../lib/plan-cards';
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
    /**
     * Left without finishing the step. `company` names a company that already
     * exists when known (made here, then skipped while it provisions): its
     * `cmp_` uid, or its handle when the server did not name the uid.
     */
    | { outcome: 'skipped'; company?: string };

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
    /**
     * The plan the person already picked on the website. When set, the plan
     * screen is skipped: Starter finishes, Workforce opens checkout.
     */
    priorPlan?: FirstRunPlan | null;
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
    priorPlan = null,
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
  let slugFieldId = $state<string | null>(null);
  /** The name cannot give a usable handle; shown under the name field. */
  let nameProblem = $state<string | null>(null);
  /** Automatic retries (server suggestion, numbered suffix) for the current name. */
  let handleRetries = 0;
  const MAX_HANDLE_RETRIES = 5;
  let slugState = $state<SlugState>(SLUG_IDLE);
  let slugWatcher: SlugWatcher | null = null;
  let inviteText = $state('');

  // svelte-ignore state_referenced_locally
  let companyUid = $state<string | null>(path.kind === 'resume' ? path.company.companyUid : null);
  let plan = $state<FirstRunPlan>('starter');
  let checkoutUrl = $state<string | null>(null);
  let stopCheckoutListen: (() => void) | null = null;

  const invites = $derived(parseInviteEmails(inviteText));
  /** The handle is derived from the name, so its field is never shown. */
  const visibleFields = $derived((form?.fields ?? []).filter((field) => field.id !== slugFieldId));
  const missing = $derived(
    (form?.fields ?? []).filter((field) => field.required && !(values[field.id] ?? '').trim()),
  );
  const canCreate = $derived(
    !busy &&
      form !== null &&
      missing.length === 0 &&
      nameProblem === null &&
      !slugBlocksSubmit(slugState) &&
      invites.invalid.length === 0,
  );

  function browserStorage(): Storage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
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
          onstate: onHandleState,
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
    if (fieldId === form?.nameFieldId) deriveHandle(value, 0);
  }

  function useHandle(handle: string): void {
    if (!slugFieldId) return;
    values = { ...values, [slugFieldId]: handle };
    slugWatcher?.input(handle);
  }

  /** Make the handle from the company name; `attempt` > 0 adds a number. */
  function deriveHandle(name: string, attempt: number): void {
    if (!slugFieldId) return;
    if (attempt === 0) handleRetries = 0;
    nameProblem = null;
    if (!name.trim()) {
      values = { ...values, [slugFieldId]: '' };
      slugWatcher?.input('');
      return;
    }
    const handle = deriveCompanyHandle(name, slugWatcher?.constraints() ?? null, attempt);
    if (!handle) {
      values = { ...values, [slugFieldId]: '' };
      slugWatcher?.cancel();
      slugState = SLUG_IDLE;
      nameProblem = attempt === 0 ? COMPANY_NAME_NEEDS_LETTERS : COMPANY_NAME_UNUSABLE;
      return;
    }
    useHandle(handle);
  }

  /**
   * A taken handle moves on by itself: the server's suggestion first, else the
   * next numbered handle. Nothing about the handle is shown unless no handle
   * works, and then the message is about the name.
   */
  function onHandleState(next: SlugState): void {
    slugState = next;
    if (next.status !== 'taken' && next.status !== 'invalid') return;
    const name = form?.nameFieldId ? (values[form.nameFieldId] ?? '') : '';
    if (handleRetries >= MAX_HANDLE_RETRIES) {
      nameProblem = COMPANY_NAME_UNUSABLE;
      return;
    }
    handleRetries += 1;
    if (next.status === 'taken' && next.suggestion && next.suggestion !== next.value) {
      useHandle(next.suggestion);
      return;
    }
    deriveHandle(name, handleRetries);
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
      // the uid, so hand over to #setup where the plan card lives. The handle
      // it was made with still names it for later steps.
      error = null;
      const handle = slugFieldId ? values[slugFieldId]?.trim() : '';
      oncomplete(handle ? { outcome: 'skipped', company: handle } : { outcome: 'skipped' });
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
    if (priorPlan) {
      // Already picked on the website: use it, never ask twice.
      await confirmPlan(priorPlan);
      return;
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
    oncomplete(companyUid ? { outcome: 'skipped', company: companyUid } : { outcome: 'skipped' });
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

  /** A plan card's CTA (or a plan already picked on the website). */
  /** Spoken meaning of a row's mark. */
  function markLabel(state: PlanRowState): string {
    return state === 'on' ? 'included' : state === 'off' ? 'not included' : 'included with limits';
  }

  async function confirmPlan(choice: FirstRunPlan): Promise<void> {
    if (!companyUid || busy) return;
    plan = choice;
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
      // A skipped plan screen comes back so Starter is still one click away.
      phase = 'plan';
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

{#snippet mark(state: PlanRowState)}
  {#if state === 'on'}
    <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
  {:else if state === 'off'}
    <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
  {:else}
    <svg viewBox="0 0 16 16" width="12" height="12"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M5.5 7V5.2a2.5 2.5 0 015 0V7" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
  {/if}
{/snippet}

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
      ><RailIcon name="logout" />Switch account</button>
      <button
        class="btn btn-secondary"
        type="button"
        data-testid="onboarding-company-create-here"
        onclick={createAnother}
      ><RailIcon name="plus" />Create a new company here</button>
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
      ><RailIcon name="check-circle" />Use {path.company.name}</button>
      <button
        class="btn btn-secondary"
        type="button"
        data-testid="onboarding-company-create-another"
        onclick={createAnother}
      ><RailIcon name="plus" />Create another</button>
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
        ><RailIcon name="logout" />Switch account</button>
        <button
          class="btn btn-secondary"
          type="button"
          data-testid="onboarding-company-skip"
          onclick={() => oncomplete({ outcome: 'skipped' })}
        ><RailIcon name="arrow-right" />Skip for now</button>
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
        ><RailIcon name="arrow-right" />Skip for now</button>
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
        ><RailIcon name="check" />{busy ? 'Joining…' : path.invites.length === 1 ? `Join ${path.invites[0]!.name}` : 'Join all'}</button>
        <button
          class="btn btn-secondary"
          type="button"
          data-testid="onboarding-company-skip"
          disabled={busy}
          onclick={() => oncomplete({ outcome: 'skipped' })}
        ><RailIcon name="arrow-right" />Skip for now</button>
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
      ><RailIcon name="refresh" />Try again</button>
      <button
        class="btn btn-secondary"
        type="button"
        data-testid="onboarding-company-skip"
        onclick={skipWhileProvisioning}
      ><RailIcon name="arrow-right" />Skip for now</button>
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
        {#each visibleFields as field (field.id)}
          {@const isName = field.id === form.nameFieldId}
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
            aria-invalid={isName && nameProblem !== null}
            aria-describedby={isName && nameProblem ? 'onboarding-company-name-problem' : undefined}
          />
          {#if isName && nameProblem}
            <p
              class="note inline-note warning"
              id="onboarding-company-name-problem"
              role="alert"
              data-testid="onboarding-company-name-problem"
            >{nameProblem}</p>
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
        <div class="btns company-actions" data-testid="onboarding-company-actions">
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
          ><RailIcon name="arrow-right" />Skip for now</button>
        </div>
      </form>
    {:else}
      <div class="btns split">
        <button class="btn btn-primary" type="button" data-testid="onboarding-company-retry" onclick={() => void loadForm()}><RailIcon name="refresh" />Try again</button>
        <button
          class="btn btn-secondary"
          type="button"
          data-testid="onboarding-company-skip"
          onclick={() => oncomplete({ outcome: 'skipped' })}
        ><RailIcon name="arrow-right" />Skip for now</button>
      </div>
    {/if}
  {:else if phase === 'plan'}
    <h2 class="h" id="onboarding-title-company" tabindex="-1" data-scene-heading>{PLAN_PICKER_COPY.heading}</h2>
    <p class="body">{PLAN_PICKER_COPY.subtitle}</p>
    {#if note}<p class="note inline-note" role="status">{note}</p>{/if}
    {#if error}<p class="note inline-note warning" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
    <div class="plan-cards" data-testid="onboarding-plan-options">
      {#each PLAN_CARDS as card (card.plan)}
        <section
          class="plan-card"
          class:featured={card.featured}
          data-testid={`onboarding-plan-card-${card.plan}`}
          aria-labelledby={`onboarding-plan-name-${card.plan}`}
        >
          <div class="plan-head">
            <h3 class="plan-name" id={`onboarding-plan-name-${card.plan}`}>{card.name}</h3>
            {#if card.badge}<span class="plan-badge" data-testid="onboarding-plan-badge">{card.badge}</span>{/if}
          </div>
          <p class="plan-price"><span class="plan-amount">{card.price}</span> <span class="plan-suffix">{card.suffix}</span></p>
          <p class="plan-blurb">{card.blurb}</p>
          <ul class="plan-rows">
            {#each card.rows as row (row.label)}
              <li class="plan-row" data-state={row.state}>
                <span class="plan-mark" aria-hidden="true">{@render mark(row.state)}</span>
                <span class="plan-row-text">
                  <span class="sr-only">{row.label}, {markLabel(row.state)}: </span><span class="plan-value">{row.value}</span>{#if row.detail}<span class="plan-row-detail">{` · ${row.detail}`}</span>{/if}
                </span>
              </li>
            {/each}
          </ul>
          <div class="plan-spacer" aria-hidden="true"></div>
          <button
            class="btn plan-cta"
            class:btn-primary={card.featured}
            class:btn-secondary={!card.featured}
            type="button"
            data-testid={`onboarding-plan-choose-${card.plan}`}
            disabled={busy}
            aria-busy={busy && plan === card.plan}
            onclick={() => void confirmPlan(card.plan)}
          >{busy && plan === card.plan && card.plan === 'workforce' ? PLAN_PICKER_COPY.checkoutBusy : card.cta}</button>
          <p class="plan-cta-note">{card.ctaNote}</p>
        </section>
      {/each}
    </div>
    <p class="plan-custom">
      {PLAN_PICKER_COPY.customSetupLead}
      <button class="link" type="button" data-testid="onboarding-plan-book-call" onclick={() => void openUrl(PLAN_PICKER_COPY.customSetupUrl)}>{PLAN_PICKER_COPY.customSetupCta}</button>
    </p>
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
      <button class="btn btn-primary" type="button" data-testid="onboarding-checkout-done" onclick={() => finish(false)}><RailIcon name="check-circle" />I finished checkout</button>
      <button
        class="btn btn-secondary"
        type="button"
        data-testid="onboarding-checkout-starter"
        onclick={() => {
          plan = 'starter';
          finish(false);
        }}
      ><RailIcon name="arrow-right" />Start on Starter for now</button>
    </div>
  {/if}
</div>

<style>
  /*
   * One centered column, the same width as the other onboarding forms
   * (welcome.css .invite-form, 360px): the company form and its buttons sit
   * on the heading's center line.
   */
  .company-form {
    box-sizing: border-box;
    width: min(360px, 100%);
    margin-left: auto;
    margin-right: auto;
  }
  .company-actions {
    justify-content: center;
  }
  /*
   * The line under the heading and any status line stay inside that same
   * column, so nothing on the screen is wider than the form (the welcome
   * panel itself is 560px wide). The plan cards are the one exception.
   */
  .follow-on > .body,
  .follow-on > .note {
    box-sizing: border-box;
    max-width: 360px;
    margin: 14px auto 0;
  }

  /*
   * "Choose how your HQ runs.": the website's two company cards side by side,
   * stacked when the window is too narrow for both. The pair is wider than
   * the 560px welcome panel, so it is centred on the panel's own centre line
   * (left 50%, back by half its width) rather than left-aligned in it.
   */
  .plan-cards {
    box-sizing: border-box;
    width: min(640px, 92vw);
    margin: 20px 0 0 50%;
    transform: translateX(-50%);
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(272px, 1fr));
    gap: 12px;
    text-align: left;
  }
  .plan-card {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 14px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.08);
    --plan-accent: #fff;
  }
  /* Workforce: the website's peach fill and orange accent. */
  .plan-card.featured {
    background: rgba(255, 204, 178, 0.15);
    border-color: rgba(255, 204, 178, 0.28);
    --plan-accent: #f96;
  }
  .plan-head {
    min-height: 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .plan-name {
    margin: 0;
    color: var(--plan-accent);
    font-size: 11px;
    line-height: 16px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .plan-badge {
    padding: 1px 7px;
    border-radius: 999px;
    background: #f96;
    color: #000;
    font-size: 10px;
    line-height: 16px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .plan-price {
    margin: 8px 0 0;
    line-height: 28px;
  }
  .plan-amount {
    color: #fff;
    font-size: 28px;
    letter-spacing: -0.04em;
  }
  .plan-suffix {
    color: rgba(255, 255, 255, 0.55);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .plan-blurb {
    margin: 6px 0 0;
    color: rgba(255, 255, 255, 0.6);
    font-size: 12px;
    line-height: 16px;
  }
  .plan-rows {
    list-style: none;
    margin: 10px 0 0;
    padding: 8px 0 0;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    display: grid;
    gap: 5px;
  }
  .plan-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 12px;
    line-height: 16px;
  }
  /* The mark sits on the first line of a wrapped value. */
  .plan-mark {
    display: flex;
    align-items: center;
    height: 16px;
    flex: none;
    color: rgba(255, 255, 255, 0.5);
  }
  .plan-row[data-state='on'] .plan-mark {
    color: var(--plan-accent);
  }
  .plan-value {
    color: rgba(255, 255, 255, 0.5);
  }
  .plan-row[data-state='on'] .plan-value {
    color: #fff;
  }
  .plan-row-detail {
    color: rgba(255, 255, 255, 0.4);
  }
  /* Takes up the height difference so both CTAs share a baseline. */
  .plan-spacer {
    flex: 1 1 auto;
    min-height: 12px;
  }
  .plan-cta {
    width: 100%;
    justify-content: center;
  }
  .plan-cta-note {
    margin: 6px 0 0;
    text-align: center;
    color: rgba(255, 255, 255, 0.45);
    font-size: 10px;
    line-height: 12px;
  }
  .plan-custom {
    margin: 14px 0 0;
    color: rgba(255, 255, 255, 0.55);
    font-size: 12px;
    line-height: 16px;
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
