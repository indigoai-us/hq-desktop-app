<script lang="ts">
  import RailIcon from '@hq/ui/rail-icon';
  /**
   * First-run company step. Shown after the setup explainers and before the
   * ready screen, while the install runs, to a person with
   * no active company: join a pending invite, or name a company (optional
   * website), pick Starter or Workforce, invite the team, and land on a
   * "<company> is ready." moment before the ready screen. Invites are their own
   * screen, sent only once the company is ready, with every address's outcome
   * on show. The company handle (slug) is
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
  import {
    PLAN_CARDS,
    PLAN_PICKER_COPY,
    loadStarterAllowances,
    planCardsFor,
    type PlanRowState,
  } from '../../lib/plan-cards';
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
    | { action: 'checkout_returned'; companyUid: string }
    | {
        action: 'invites_sent';
        companyUid: string;
        inviteCount: number;
        inviteFailureCount: number;
        inviteQueuedCount: number;
      }
    | { action: 'invites_skipped'; companyUid: string };

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
    /**
     * Told on every screen change whether Back may leave the step (its first
     * question, before anything has been made).
     */
    onbackchange?: (canGoBack: boolean) => void;
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
    onbackchange,
  }: Props = $props();

  type Phase =
    | 'other-identity'
    | 'existing'
    | 'join'
    | 'loading'
    | 'details'
    | 'provisioning'
    | 'provision-failed'
    | 'plan'
    | 'checkout'
    | 'invite'
    | 'done';

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

  // svelte-ignore state_referenced_locally
  let companyUid = $state<string | null>(path.kind === 'resume' ? path.company.companyUid : null);
  let plan = $state<FirstRunPlan>('starter');
  /** The plan the company ended up on, and whether checkout was finished. */
  let paid = $state(false);
  let checkoutUrl = $state<string | null>(null);
  let stopCheckoutListen: (() => void) | null = null;

  /** One invite on the invite screen and what happened to it. */
  type InviteStatus = 'new' | 'sending' | 'sent' | 'queued' | 'failed';
  interface InviteRow {
    email: string;
    status: InviteStatus;
  }
  let inviteRows = $state<InviteRow[]>([]);
  let inviteDraft = $state('');
  let inviteDraftProblem = $state<string | null>(null);
  let inviteSending = $state(false);
  const unsentInvites = $derived(inviteRows.filter((row) => row.status === 'new' || row.status === 'failed'));
  const deliveredInvites = $derived(
    inviteRows.filter((row) => row.status === 'sent' || row.status === 'queued').length,
  );

  // svelte-ignore state_referenced_locally
  const resumedName = path.kind === 'resume' ? (path.company.name ?? null) : null;
  /** The company's name, for the screens after it is made. */
  const companyName = $derived(
    (form?.nameFieldId ? (values[form.nameFieldId] ?? '').trim() : '') || resumedName || 'Your company',
  );
  const companyInitial = $derived(Array.from(companyName.trim())[0]?.toUpperCase() ?? 'H');

  /** A plan was picked on this screen (not on the website, not paid for): Back can return to it. */
  const planPickedHere = $derived(!priorPlan && !paid);
  /**
   * Back is offered where going back undoes nothing that was made: the first
   * question (Back leaves the step), the invite screen (back to the plans,
   * when the plan was picked here) and the company's ready moment (back to
   * the invites). The plan screen has none: the company already exists, and
   * going back to "Name your company" would make a second one.
   */
  const canGoBack = $derived(
    !busy &&
      !inviteSending &&
      (phase === 'details' ||
        phase === 'loading' ||
        phase === 'join' ||
        phase === 'existing' ||
        phase === 'other-identity' ||
        (phase === 'invite' && planPickedHere) ||
        phase === 'done'),
  );

  /**
   * The wizard's Back, inside the step. Returns true when the step moved back
   * a screen itself; false means Back leaves the step.
   */
  export function back(): boolean {
    if (!canGoBack) return false;
    if (phase === 'done') {
      phase = 'invite';
      return true;
    }
    if (phase === 'invite') {
      error = null;
      phase = 'plan';
      return true;
    }
    return false;
  }
  $effect(() => {
    onbackchange?.(canGoBack);
  });

  /**
   * Leaving a screen: like the story screens, the old one fades up and out
   * while the next one comes in. The outgoing screen is a static, inert copy
   * (no ids or test ids) faded with the Web Animations API, so the live
   * markup swaps at once; without that API, or under Reduce Motion, it is a
   * plain cut.
   */
  let rootEl: HTMLElement | null = null;
  /** How long the leaving screen takes to fade out. */
  const LEAVE_MS = 500;
  /**
   * Added to the entrance delays after a screen change: the first part of the
   * new screen starts rising (at 0.3s + this) only once the old one is gone.
   */
  const LEAVE_WAIT_MS = 300;
  /** When the copy of the last screen to leave is gone (performance.now()). */
  let leavingUntil = 0;
  /**
   * Hold the new screen's entrance until every leaving copy is gone: its first
   * part rises at 0.3s + the wait, with 100ms of clear air.
   */
  function holdEntrance(root: HTMLElement): void {
    const remaining = leavingUntil - performance.now();
    const wait = Math.max(0, Math.min(LEAVE_WAIT_MS, Math.ceil(remaining) + 100 - 300));
    root.style.setProperty('--cs-wait', `${wait}ms`);
  }
  /** How opaque an element really is on screen, ancestors included. */
  function shownOpacity(el: HTMLElement): number {
    let opacity = 1;
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity;
  }
  // svelte-ignore state_referenced_locally
  let lastPhase: Phase = phase;
  $effect.pre(() => {
    const next = phase;
    if (next === lastPhase) return;
    lastPhase = next;
    // The panel re-centres for the new screen's height at once (no glide).
    rootEl?.dispatchEvent(new CustomEvent('hq-panel-snap', { bubbles: true }));
    const old = rootEl?.querySelector<HTMLElement>(':scope > .cs-pane');
    if (!rootEl || !old || reducedMotion || typeof old.animate !== 'function') return;
    // A screen nobody saw gets no leaving copy: one replaced before its parts
    // rose in (setting up, when the company is ready at once), or one swapped
    // while the whole step is still fading in (loading, on arrival).
    const parts = [...old.children] as HTMLElement[];
    const seen = parts.some((part) => Number(getComputedStyle(part).opacity) > 0.05);
    if (!seen || shownOpacity(rootEl) < 0.5) {
      holdEntrance(rootEl);
      return;
    }
    const from = old.getBoundingClientRect();
    // Pinned to the window (the scene has no transform), so the panel moving
    // under it for the next screen does not drag the leaving copy along.
    const host = rootEl.closest<HTMLElement>('.scene') ?? document.body;
    const pane = old.cloneNode(true) as HTMLElement;
    for (const el of pane.querySelectorAll('[id], [data-testid]')) {
      el.removeAttribute('id');
      el.removeAttribute('data-testid');
    }
    // The copy's animations are off, so it keeps each part exactly where its
    // entrance had got to: a part still rising leaves from there, not from
    // fully shown.
    const live = old.querySelectorAll<HTMLElement>('*');
    const copies = pane.querySelectorAll<HTMLElement>('*');
    live.forEach((el, i) => {
      const style = getComputedStyle(el);
      if (style.animationName === 'none') return;
      copies[i]?.style.setProperty('opacity', style.opacity);
      copies[i]?.style.setProperty('transform', style.transform);
    });
    // Wrapped in a bare copy of this component's root so its styles (scoped
    // to `.cs`) still apply outside it.
    const ghost = rootEl.cloneNode(false) as HTMLElement;
    ghost.removeAttribute('data-testid');
    ghost.removeAttribute('data-phase');
    ghost.classList.add('cs-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      margin: '0',
      zIndex: '4',
      pointerEvents: 'none',
    });
    ghost.appendChild(pane);
    host.appendChild(ghost);
    // The new screen holds its entrance until the old one has gone, so the
    // two never show text at the same time.
    leavingUntil = performance.now() + LEAVE_MS;
    holdEntrance(rootEl);
    // The story screens' cross-fade: eased in and out.
    const fade = ghost.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(-12px)' },
      ],
      { duration: LEAVE_MS, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' },
    );
    fade.finished.then(
      () => ghost.remove(),
      () => ghost.remove(),
    );
  });

  const reducedMotion =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

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
      !slugBlocksSubmit(slugState),
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
      // Invites have their own screen once the company is ready.
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
      // the uid, so hand over to HQ Desktop's setup channel, where the plan
      // card lives. The handle
      // it was made with still names it for later steps.
      error = null;
      const handle = slugFieldId ? values[slugFieldId]?.trim() : '';
      oncomplete(handle ? { outcome: 'skipped', company: handle } : { outcome: 'skipped' });
      return;
    }
    slugWatcher?.cancel();
    companyUid = result.company.companyUid;
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
      onTelemetry?.({
        action: 'company_created',
        companyUid: uid,
        inviteCount: 0,
        inviteFailureCount: 0,
        inviteQueuedCount: 0,
        namePrefill: companyNamePrefillStatus(
          prefilledCompanyName,
          form?.nameFieldId ? values[form.nameFieldId] ?? '' : '',
        ),
      });
    }
    if (priorPlan) {
      // Already picked on the website: use it, never ask twice.
      await confirmPlan(priorPlan);
      return;
    }
    phase = 'plan';
  }

  /** Leave before the company is ready; it carries on being set up without this screen. */
  function skipWhileProvisioning(): void {
    oncomplete(companyUid ? { outcome: 'skipped', company: companyUid } : { outcome: 'skipped' });
  }

  // ─── Invite your team ────────────────────────────────────────────────────

  function goToInvite(): void {
    busy = false;
    error = null;
    phase = 'invite';
  }

  /** Turn what is typed into invite rows; anything that is not an address stays typed. */
  function commitInviteDraft(): void {
    const parsed = parseInviteEmails(inviteDraft);
    const known = new Set(inviteRows.map((row) => row.email.toLowerCase()));
    const added = parsed.valid.filter((email) => !known.has(email.toLowerCase()));
    if (added.length > 0) inviteRows = [...inviteRows, ...added.map((email) => ({ email, status: 'new' as const }))];
    inviteDraft = parsed.invalid.join(' ');
    inviteDraftProblem =
      parsed.invalid.length === 0
        ? null
        : parsed.invalid.length === 1
          ? `“${parsed.invalid[0]}” is not an email address.`
          : 'Some of these are not email addresses.';
  }

  function onInviteKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ',' || event.key === ' ' || event.key === 'Tab') {
      if (!inviteDraft.trim()) {
        if (event.key === 'Enter') {
          event.preventDefault();
          void inviteForward();
        }
        return;
      }
      event.preventDefault();
      commitInviteDraft();
      return;
    }
    if (event.key === 'Backspace' && inviteDraft === '') {
      const last = inviteRows[inviteRows.length - 1];
      if (last && last.status === 'new') inviteRows = inviteRows.slice(0, -1);
    }
  }

  function removeInvite(email: string): void {
    inviteRows = inviteRows.filter((row) => row.email !== email);
  }

  /** The invite screen's primary button: send what is new, else carry on. */
  async function inviteForward(): Promise<void> {
    if (inviteDraft.trim()) commitInviteDraft();
    if (inviteDraftProblem) return;
    if (unsentInvites.length > 0) {
      await sendInvites();
      return;
    }
    if (deliveredInvites > 0) phase = 'done';
  }

  async function sendInvites(): Promise<void> {
    if (!companyUid || inviteSending) return;
    const uid = companyUid;
    const batch = unsentInvites.map((row) => row.email);
    if (batch.length === 0) return;
    inviteSending = true;
    setInviteStatus(batch, 'sending');
    const failed = new Set<string>();
    let waiting = false;
    if (!queuePendingCompanyInvites(browserStorage(), uid, batch.map((email) => ({ email, role: 'member' })))) {
      batch.forEach((email) => failed.add(email.toLowerCase()));
    } else {
      try {
        const report = await flushPendingCompanyInvites(browserStorage(), api);
        for (const entry of report.failed) {
          if (entry.companyUid === uid) failed.add(entry.email.toLowerCase());
        }
        waiting = report.waiting.includes(uid);
      } catch (err) {
        console.warn('onboarding: sending invites failed', err);
        // Still queued: the app sends them once it can.
        waiting = true;
      }
    }
    if (destroyed) return;
    let sent = 0;
    let queued = 0;
    inviteRows = inviteRows.map((row) => {
      if (!batch.includes(row.email)) return row;
      if (failed.has(row.email.toLowerCase())) return { ...row, status: 'failed' };
      if (waiting) {
        queued += 1;
        return { ...row, status: 'queued' };
      }
      sent += 1;
      return { ...row, status: 'sent' };
    });
    inviteSending = false;
    onTelemetry?.({
      action: 'invites_sent',
      companyUid: uid,
      inviteCount: batch.length,
      inviteFailureCount: failed.size,
      inviteQueuedCount: queued,
    });
    // Everything went out: on to the company's moment, after a beat to see it.
    if (failed.size === 0 && sent + queued === batch.length) {
      window.setTimeout(() => {
        if (!destroyed && phase === 'invite' && unsentInvites.length === 0) phase = 'done';
      }, reducedMotion ? 0 : 900);
    }
  }

  function setInviteStatus(emails: readonly string[], status: InviteStatus): void {
    inviteRows = inviteRows.map((row) => (emails.includes(row.email) ? { ...row, status } : row));
  }

  function skipInvites(): void {
    if (companyUid) onTelemetry?.({ action: 'invites_skipped', companyUid });
    phase = 'done';
  }

  /** "<company> is ready.": the end of the step. */
  function finishCompany(): void {
    if (!companyUid) return;
    oncomplete({ outcome: 'created', companyUid, plan: paid ? 'workforce' : plan, paid });
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
      goToInvite();
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

  /** Back from checkout (finished, or Starter for now): on to the invites. */
  function finish(checkoutDone: boolean): void {
    stopCheckoutListen?.();
    stopCheckoutListen = null;
    if (!companyUid) return;
    paid = checkoutDone;
    goToInvite();
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

  /**
   * Plan cards. Starter's ceilings come from hq-pro's GET /v1/pricing once the
   * picker opens; until then (or if the read fails) the built-in fallback.
   */
  let planCards = $state(PLAN_CARDS);
  let pricingRequested = false;
  $effect(() => {
    if (phase !== 'plan' || pricingRequested) return;
    pricingRequested = true;
    void loadStarterAllowances(invoke).then((starter) => {
      if (starter) planCards = planCardsFor(starter);
    });
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

  /**
   * The field's label, short. Server labels can carry a run-on explanation
   * after a dash ("Website (optional) — so HQ can…"); only the name is shown,
   * and "(optional)" is added when the field is not required.
   */
  function fieldLabel(field: { label: string; required?: boolean }): string {
    const name = field.label.split(/\s+[—–-]\s+/u)[0]!.replace(/\s*\(optional\)\s*/iu, '').trim();
    return field.required ? name : `${name} (optional)`;
  }

  function fieldPlaceholder(field: { id: string }): string {
    if (field.id === form?.nameFieldId) return 'Acme Inc.';
    if (field.id === 'website') return 'acme.com';
    return '';
  }

  /** What the provisioning failure means, without its internal step name. */
  const provisionFailureText = $derived(
    provisioningFailedStep === 'timeout'
      ? `${companyName} is saved, but setting it up is taking longer than usual.`
      : `${companyName} is saved, but setting it up did not finish.`,
  );

</script>

{#snippet mark(state: PlanRowState)}
  <!-- Phosphor regular Check / X / LockSimple (MIT, Copyright (c) 2023 Phosphor Icons). -->
  {#if state === 'on'}
    <svg viewBox="0 0 256 256" width="12" height="12"><path fill="currentColor" d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" /></svg>
  {:else if state === 'off'}
    <svg viewBox="0 0 256 256" width="12" height="12"><path fill="currentColor" d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z" /></svg>
  {:else}
    <svg viewBox="0 0 256 256" width="12" height="12"><path fill="currentColor" d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z" /></svg>
  {/if}
{/snippet}

{#snippet heading(text: string)}
  <h2 class="h cs-title" id="onboarding-title-company" tabindex="-1" data-scene-heading>{text}</h2>
{/snippet}

{#snippet skipButton(onclick: () => void, disabled = false)}
  <button class="btn btn-ghost cs-skip" type="button" data-testid="onboarding-company-skip" {disabled} {onclick}>Skip for now</button>
{/snippet}

<div class="follow-on on cs" data-testid="onboarding-company" data-phase={phase} bind:this={rootEl}>
  {#key phase}
    <!-- Each screen comes in like the story screens: title, the line under
         it, the content, then its buttons last (CSS; a plain cut under Reduce Motion). -->
    <div class="cs-pane">
      {#if phase === 'other-identity' && path.kind === 'other-identity'}
        {@render heading('You may already have a company')}
        <p class="body cs-body" data-testid="onboarding-company-other-account">
          Your company{path.other.companyName ? ` ${path.other.companyName}` : ''} is on {path.other.maskedEmail}.{#if path.signedInEmail} You're signed in as {path.signedInEmail}.{/if} Switch account?
        </p>
        <div class="cs-actions">
          <button class="btn btn-primary" type="button" data-testid="onboarding-company-switch-account" onclick={switchAccount}>Switch account</button>
          <button class="btn btn-secondary" type="button" data-testid="onboarding-company-create-here" onclick={createAnother}>Create a new company here</button>
        </div>
      {:else if phase === 'existing' && path.kind === 'existing'}
        {@render heading('You already have a company')}
        <p class="body cs-body">{path.company.name} is ready in HQ. Keep working there, or make a separate company.</p>
        <div class="cs-actions">
          <button class="btn btn-primary" type="button" data-testid="onboarding-company-use-existing" onclick={useExisting}>Use {path.company.name}</button>
          <button class="btn btn-secondary" type="button" data-testid="onboarding-company-create-another" onclick={createAnother}>Create another</button>
        </div>
      {:else if phase === 'join' && path.kind === 'join'}
        {@render heading('You have an invite')}
        {#if inviteOtherEmail}
          <p class="body cs-body" data-testid="onboarding-company-invite-other-email">
            Your invite was sent to a different email.{#if path.signedInEmail} You're signed in as {path.signedInEmail}.{/if} Switch account?
          </p>
          <div class="cs-actions">
            <button class="btn btn-primary" type="button" data-testid="onboarding-company-switch-account" onclick={switchAccount}>Switch account</button>
            {@render skipButton(() => oncomplete({ outcome: 'skipped' }))}
          </div>
        {:else if path.decision === 'invite_expired'}
          <p class="body cs-body" data-testid="onboarding-company-invite-expired">
            Your invite to {path.invites[0]!.name} has expired. Ask {path.invites[0]!.inviter ?? 'the person who invited you'} to resend it, then come back here.
          </p>
          <div class="cs-actions">
            {@render skipButton(() => oncomplete({ outcome: 'skipped' }))}
          </div>
        {:else}
          <p class="body cs-body">
            {#if path.invites.length === 1}
              You were invited to {path.invites[0]!.name}. Join to see their files and work with the team.
            {:else}
              You were invited to {path.invites.length} companies. Join them to see their files and work with each team.
            {/if}
          </p>
          {#if error}<p class="cs-alert" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
          <div class="cs-actions">
            <button
              class="btn btn-primary"
              type="button"
              data-testid="onboarding-company-join"
              disabled={busy}
              aria-busy={busy}
              onclick={() => void joinInvite(path.invites.length === 1 ? path.invites[0]!.slug : null)}
            >{busy ? 'Joining…' : path.invites.length === 1 ? `Join ${path.invites[0]!.name}` : 'Join all'}</button>
            {@render skipButton(() => oncomplete({ outcome: 'skipped' }), busy)}
          </div>
        {/if}
      {:else if phase === 'provisioning'}
        <div class="cs-mark working" aria-hidden="true"><span>{companyInitial}</span></div>
        {@render heading(`Setting up ${companyName}`)}
        <p class="body cs-body" role="status" aria-live="polite" data-testid="onboarding-company-provisioning">
          {provisioningRetrying
            ? 'Trying again. This can take a minute.'
            : 'Making a private home for your team’s files. This can take a minute.'}
        </p>
        <div class="cs-progress" aria-hidden="true"><span></span></div>
      {:else if phase === 'provision-failed'}
        {@render heading('Setup didn’t finish')}
        <p class="body cs-body" role="alert" data-testid="onboarding-company-provisioning-failed">
          {provisionFailureText} Try again, or skip and finish it later in HQ Desktop.
        </p>
        <div class="cs-actions">
          <button class="btn btn-primary" type="button" data-testid="onboarding-company-provisioning-retry" onclick={() => void awaitProvisioning(true)}><RailIcon name="refresh" />Try again</button>
          {@render skipButton(skipWhileProvisioning)}
        </div>
      {:else if phase === 'loading'}
        {@render heading('Name your company')}
        <p class="body cs-body" role="status" aria-live="polite">Getting things ready…</p>
      {:else if phase === 'details'}
        {@render heading('Name your company')}
        <p class="body cs-body">Your company is where your team shares files, bots and work in HQ.</p>
        {#if error}<p class="cs-alert" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
        {#if planLimit}
          <p class="cs-alert" role="status" data-testid="onboarding-company-plan-limit">
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
            class="invite-form cs-form"
            novalidate
            onsubmit={(event) => {
              event.preventDefault();
              void createCompany();
            }}
          >
            {#each visibleFields as field (field.id)}
              {@const isName = field.id === form.nameFieldId}
              <div class="cs-field">
                <label for={`onboarding-company-${field.id}`}>{fieldLabel(field)}</label>
                <input
                  id={`onboarding-company-${field.id}`}
                  data-testid={`onboarding-company-field-${field.id}`}
                  type={field.id === 'website' ? 'url' : 'text'}
                  placeholder={fieldPlaceholder(field)}
                  value={values[field.id] ?? ''}
                  oninput={(event) => setValue(field.id, event.currentTarget.value)}
                  aria-required={field.required}
                  disabled={busy}
                  aria-invalid={isName && nameProblem !== null}
                  aria-describedby={isName && nameProblem ? 'onboarding-company-name-problem' : undefined}
                />
                {#if isName && nameProblem}
                  <p class="cs-hint warning" id="onboarding-company-name-problem" role="alert" data-testid="onboarding-company-name-problem">{nameProblem}</p>
                {:else if field.error}
                  <p class="cs-hint warning">{field.error}</p>
                {/if}
              </div>
            {/each}
            <div class="cs-actions" data-testid="onboarding-company-actions">
              <button
                class="btn btn-primary"
                type="submit"
                data-testid="onboarding-company-create"
                disabled={!canCreate}
                aria-busy={busy}
              >{busy ? 'Creating…' : 'Create company'}</button>
              {@render skipButton(() => oncomplete({ outcome: 'skipped' }), busy)}
            </div>
          </form>
        {:else}
          <div class="cs-actions">
            <button class="btn btn-primary" type="button" data-testid="onboarding-company-retry" onclick={() => void loadForm()}><RailIcon name="refresh" />Try again</button>
            {@render skipButton(() => oncomplete({ outcome: 'skipped' }))}
          </div>
        {/if}
      {:else if phase === 'plan'}
        {@render heading(PLAN_PICKER_COPY.heading)}
        <p class="body cs-body">{PLAN_PICKER_COPY.subtitle}</p>
        {#if note}<p class="cs-alert" role="status">{note}</p>{/if}
        {#if error}<p class="cs-alert" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
        <div class="plan-cards" data-testid="onboarding-plan-options">
          {#each planCards as card (card.plan)}
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
        {@render heading('Finish checkout in your browser')}
        <p class="body cs-body">
          Checkout is open in your browser. When you finish, HQ comes back here and turns on Workforce for {companyName}.
        </p>
        {#if error}<p class="cs-alert" role="alert" data-testid="onboarding-company-error">{error}</p>{/if}
        <div class="cs-actions">
          <button class="btn btn-primary" type="button" data-testid="onboarding-checkout-done" onclick={() => finish(false)}><RailIcon name="check-circle" />I finished checkout</button>
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
        {#if checkoutUrl}
          <p class="cs-fine">
            <button class="link" type="button" data-testid="onboarding-checkout-reopen" onclick={() => checkoutUrl && void openUrl(checkoutUrl)}>Open checkout again</button>
          </p>
        {/if}
      {:else if phase === 'invite'}
        {@render heading('Invite your team')}
        <p class="body cs-body">HQ is better together. Everyone you invite gets an email to join {companyName}.</p>
        <form
          class="invite-form cs-form"
          novalidate
          onsubmit={(event) => {
            event.preventDefault();
            void inviteForward();
          }}
        >
          <div class="cs-field">
            <label for="onboarding-company-invite-input">Email addresses</label>
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div
              class="field cs-chips"
              class:has-problem={inviteDraftProblem !== null}
              onclick={(event) => (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}
            >
              {#each inviteRows as row (row.email)}
                <span class="cs-chip" data-status={row.status} data-testid="onboarding-company-invite-row">
                  <span class="cs-chip-email">{row.email}</span>
                  {#if row.status === 'sending'}
                    <span class="cs-spin" aria-label="Sending"></span>
                  {:else if row.status === 'sent' || row.status === 'queued'}
                    <span class="cs-chip-ok" aria-label={row.status === 'sent' ? 'Invite sent' : 'Invite will send shortly'}>{@render mark('on')}</span>
                  {:else}
                    <button class="cs-chip-x" type="button" aria-label={`Remove ${row.email}`} onclick={() => removeInvite(row.email)}>{@render mark('off')}</button>
                  {/if}
                </span>
              {/each}
              <input
                id="onboarding-company-invite-input"
                data-testid="onboarding-company-invite-input"
                type="email"
                autocomplete="off"
                placeholder={inviteRows.length === 0 ? 'name@company.com' : ''}
                bind:value={inviteDraft}
                oninput={() => (inviteDraftProblem = null)}
                onkeydown={onInviteKey}
                onblur={() => inviteDraft.trim() && commitInviteDraft()}
                onpaste={() => window.setTimeout(commitInviteDraft, 0)}
                disabled={inviteSending}
                aria-invalid={inviteDraftProblem !== null}
                aria-describedby="onboarding-company-invite-hint"
              />
            </div>
            <p class="cs-hint" class:warning={inviteDraftProblem !== null || unsentInvites.some((row) => row.status === 'failed')} id="onboarding-company-invite-hint" role="status" aria-live="polite">
              {#if inviteDraftProblem}
                {inviteDraftProblem}
              {:else if inviteRows.some((row) => row.status === 'failed')}
                {inviteRows.filter((row) => row.status === 'failed').length === 1 ? 'One invite didn’t go out.' : 'Some invites didn’t go out.'} Send again, or invite them later from the Team tab.
              {:else if inviteRows.some((row) => row.status === 'queued')}
                Invites are on their way. HQ sends them as soon as {companyName} is ready.
              {:else if deliveredInvites > 0 && unsentInvites.length === 0}
                {deliveredInvites === 1 ? 'Invite sent.' : `${deliveredInvites} invites sent.`}
              {:else}
                Press Enter after each address, or paste a list.
              {/if}
            </p>
          </div>
          <div class="cs-actions">
            {#if unsentInvites.length > 0 || inviteDraft.trim() || deliveredInvites === 0}
              <button
                class="btn btn-primary"
                type="submit"
                data-testid="onboarding-company-invite-send"
                disabled={inviteSending || (unsentInvites.length === 0 && !inviteDraft.trim())}
                aria-busy={inviteSending}
              >{inviteSending
                  ? 'Sending…'
                  : unsentInvites.some((row) => row.status === 'failed') && !unsentInvites.some((row) => row.status === 'new')
                    ? 'Send again'
                    : unsentInvites.length > 1
                      ? `Send ${unsentInvites.length} invites`
                      : 'Send invite'}</button>
              <button class="btn btn-ghost cs-skip" type="button" data-testid="onboarding-company-invite-skip" disabled={inviteSending} onclick={skipInvites}>{deliveredInvites > 0 ? 'Continue' : 'Skip for now'}</button>
            {:else}
              <button class="btn btn-primary" type="submit" data-testid="onboarding-company-invite-continue">Continue</button>
            {/if}
          </div>
        </form>
      {:else if phase === 'done'}
        <div class="cs-mark done" aria-hidden="true">
          <span>{companyInitial}</span>
          <i class="cs-mark-check"><svg viewBox="0 0 256 256" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z" /></svg></i>
        </div>
        <h2 class="h cs-title" id="onboarding-title-company" tabindex="-1" data-scene-heading data-testid="onboarding-company-ready">{companyName} is ready.</h2>
        <p class="body cs-body">Your team has a home in HQ. Files, bots and work you add there are shared with everyone in it.</p>
        <ul class="cs-summary">
          <li><span class="cs-summary-mark">{@render mark('on')}</span>{paid ? 'Workforce plan' : plan === 'workforce' ? 'Workforce after checkout' : 'Starter plan, free'}</li>
          <li>
            <span class="cs-summary-mark" class:muted={deliveredInvites === 0}>{#if deliveredInvites > 0}{@render mark('on')}{:else}<RailIcon name="user-plus" size={12} />{/if}</span>
            {deliveredInvites === 0
              ? 'Invite people any time from the Team tab'
              : deliveredInvites === 1
                ? '1 teammate invited'
                : `${deliveredInvites} teammates invited`}
          </li>
        </ul>
        <div class="cs-actions">
          <button class="btn btn-primary" type="button" data-testid="onboarding-company-ready-continue" onclick={finishCompany}>Continue</button>
        </div>
      {/if}
    </div>
  {/key}
</div>

<style>
  /*
   * The company step speaks the welcome flow's language: one centred column,
   * the 56px Fraunces title, the 15px line under it, and its buttons centred
   * right below the content. Forms sit in a 400px column under the title;
   * the plan cards use the wider panel (welcome.css `.s-company`).
   */
  .cs {
    position: relative;
    text-align: center;
  }
  /*
   * The story screens' entrance (welcome.css .h / .body, then the forward
   * button once the screen has played): each part rises in turn.
   */
  .cs-pane > * {
    animation: cs-rise 0.9s cubic-bezier(0.23, 1, 0.32, 1) calc(var(--cs-wait, 0s) + 0.3s) both;
  }
  .cs-pane > .cs-title {
    animation-delay: calc(var(--cs-wait, 0s) + 0.42s);
  }
  .cs-pane > .cs-body {
    animation-delay: calc(var(--cs-wait, 0s) + 0.56s);
  }
  .cs-pane > .cs-form,
  .cs-pane > .plan-cards,
  .cs-pane > .cs-progress,
  .cs-pane > .cs-summary,
  .cs-pane > .cs-alert {
    animation-delay: calc(var(--cs-wait, 0s) + 0.7s);
  }
  .cs-pane > .plan-custom,
  .cs-pane > .cs-fine {
    animation-delay: calc(var(--cs-wait, 0s) + 0.84s);
  }
  /* The leaving copy holds still while it fades. */
  :global(.cs-ghost),
  :global(.cs-ghost *) {
    animation: none !important;
  }
  @keyframes cs-rise {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  .cs .cs-title {
    font-size: clamp(40px, 5.4vw, 56px);
    text-wrap: balance;
  }
  /* Wide enough that a one-sentence line stays on one line; longer copy wraps balanced. */
  .cs .cs-body {
    box-sizing: border-box;
    max-width: 600px;
    margin: 14px auto 0;
    text-wrap: balance;
  }
  .cs-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 44px;
    /* Buttons arrive last, once the screen has played (the story screens' revealNav). */
    animation: cs-rise 0.7s cubic-bezier(0.23, 1, 0.32, 1) calc(var(--cs-wait, 0s) + 1.1s) both;
  }
  /*
   * The story screens' rhythm (engines.ts): title -> line under it 14px,
   * line -> content 36px, content -> button 44px (NAVGAP). The form's own
   * 16px row gap is part of the 44.
   */
  .cs-form .cs-actions {
    margin-top: 28px;
  }
  /* A quiet "Skip for now" sits under the main button, on the same centre line. */
  .cs-actions:has(:global(.cs-skip)) {
    flex-direction: column;
    gap: 6px;
  }
  .cs-form {
    box-sizing: border-box;
    width: min(400px, 100%);
    gap: 16px;
    margin: 36px auto 0;
  }
  .cs-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
  }
  .cs-hint {
    margin: 2px 0 0;
    color: rgba(255, 255, 255, 0.55);
    font-size: 12px;
    line-height: 16px;
    text-align: left;
  }
  .cs-hint.warning {
    color: #ffc6a8;
  }
  /* A short line under the copy for errors and limits: quiet, centred, never a red dump. */
  .cs-alert {
    box-sizing: border-box;
    max-width: 520px;
    margin: 16px auto 0;
    padding: 10px 14px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    font-size: 13px;
    line-height: 18px;
  }
  .cs-fine {
    margin: 14px 0 0;
    font-size: 12px;
    line-height: 16px;
    color: rgba(255, 255, 255, 0.55);
  }

  /* ---- the company's mark: a tile with its initial ---------------------- */
  .cs-mark {
    position: relative;
    width: 64px;
    height: 64px;
    margin: 0 auto 28px;
    border-radius: 18px;
    display: grid;
    place-items: center;
    background: linear-gradient(160deg, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0.06));
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.14),
      0 18px 50px -18px rgba(255, 255, 255, 0.35);
  }
  .cs-mark span {
    font-family: var(--w-font-display);
    font-weight: 300;
    font-variation-settings: 'wght' 300, 'SOFT' 0, 'WONK' 1;
    font-size: 34px;
    line-height: 1;
    color: #fff;
  }
  /* Rises in with the rest of the screen first, then breathes. */
  .cs-mark.working {
    animation:
      cs-rise 0.9s cubic-bezier(0.23, 1, 0.32, 1) calc(var(--cs-wait, 0s) + 0.3s) both,
      cs-breathe 2.4s ease-in-out calc(var(--cs-wait, 0s) + 1.2s) infinite;
  }
  .cs-mark.done {
    animation: cs-land 0.9s cubic-bezier(0.23, 1, 0.32, 1) var(--cs-wait, 0s) both;
  }
  .cs-mark-check {
    position: absolute;
    right: -6px;
    bottom: -6px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: #fff;
    color: #000;
    box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.35);
    animation: cs-pop 0.5s calc(var(--cs-wait, 0s) + 0.45s) cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  @keyframes cs-breathe {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.85;
    }
    50% {
      transform: scale(1.04);
      opacity: 1;
    }
  }
  @keyframes cs-land {
    from {
      transform: scale(0.82);
      opacity: 0;
    }
    to {
      transform: none;
      opacity: 1;
    }
  }
  @keyframes cs-pop {
    from {
      transform: scale(0);
    }
    to {
      transform: none;
    }
  }

  /* ---- setting up: a thin indeterminate bar ----------------------------- */
  .cs-progress {
    position: relative;
    width: 160px;
    height: 2px;
    margin: 36px auto 0;
    border-radius: 2px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.12);
  }
  .cs-progress span {
    position: absolute;
    inset: 0 auto 0 0;
    width: 40%;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.8);
    animation: cs-slide 1.6s ease-in-out infinite;
  }
  @keyframes cs-slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }

  /* ---- invite your team: addresses become chips ------------------------- */
  .cs-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 4px 6px;
    cursor: text;
  }
  /* Focus (welcome.css .field:focus-within) beats hover; a problem beats both. */
  :global(.hq-welcome) .cs-chips.has-problem,
  :global(.hq-welcome) .cs-chips.has-problem:hover,
  :global(.hq-welcome) .cs-chips.has-problem:focus-within {
    border-color: rgba(255, 198, 168, 0.6);
  }
  .cs-chips input {
    flex: 1 1 140px;
    min-width: 120px;
    min-height: 30px;
    height: 30px;
    padding: 4px 6px;
    border: none !important;
    background: transparent !important;
  }
  .cs-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 3px 5px 3px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
    font-size: 13px;
    line-height: 18px;
    animation: cs-land 0.25s ease-out both;
  }
  .cs-chip-email {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cs-chip[data-status='sent'],
  .cs-chip[data-status='queued'] {
    background: rgba(255, 255, 255, 0.22);
  }
  .cs-chip[data-status='failed'] {
    background: rgba(255, 153, 102, 0.2);
    box-shadow: inset 0 0 0 1px rgba(255, 153, 102, 0.45);
  }
  .cs-chip-x,
  .cs-chip-ok,
  .cs-spin {
    flex: none;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
  }
  .cs-chip-x {
    border: 0;
    padding: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
  }
  .cs-chip-x:hover {
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
  }
  .cs-chip-ok {
    background: #fff;
    color: #000;
    animation: cs-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .cs-spin {
    box-sizing: border-box;
    width: 12px;
    height: 12px;
    margin: 3px;
    border: 1.5px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff;
    animation: cs-turn 0.8s linear infinite;
  }
  @keyframes cs-turn {
    to {
      transform: rotate(360deg);
    }
  }

  /* ---- "<company> is ready." -------------------------------------------- */
  .cs-summary {
    list-style: none;
    display: inline-flex;
    flex-direction: column;
    gap: 8px;
    margin: 36px auto 0;
    padding: 0;
    text-align: left;
    color: rgba(255, 255, 255, 0.82);
    font-size: 14px;
    line-height: 20px;
  }
  .cs-summary li {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .cs-summary-mark {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgba(255, 255, 255, 0.16);
    color: #fff;
  }
  .cs-summary-mark.muted {
    background: transparent;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.24);
    color: rgba(255, 255, 255, 0.6);
  }

  /*
   * "Choose how your HQ runs.": the website's two company cards side by side
   * inside the company panel (wide enough for both), stacked when the window
   * is too narrow. Nothing hangs outside the panel.
   */
  .plan-cards {
    box-sizing: border-box;
    width: 100%;
    margin: 36px 0 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    text-align: left;
  }
  @media (max-width: 720px) {
    .plan-cards {
      grid-template-columns: minmax(0, 1fr);
      max-width: 400px;
      margin-left: auto;
      margin-right: auto;
    }
  }
  .plan-card {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 24px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.08);
    transition: background-color 0.2s;
    --plan-accent: #fff;
  }
  .plan-card:hover {
    background: rgba(255, 255, 255, 0.11);
  }
  /* Workforce: the website's peach fill and orange accent. */
  .plan-card.featured {
    background: rgba(255, 204, 178, 0.14);
    --plan-accent: #f96;
  }
  .plan-card.featured:hover {
    background: rgba(255, 204, 178, 0.18);
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
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  /* The website's "Most popular" orange (indigo-marketing ChoosePlan
     TAG_FEATURED): #f96 at 60%, so full white text reads on it. */
  .plan-badge {
    padding: 3px 10px;
    border-radius: 999px;
    background: rgba(255, 153, 102, 0.6);
    color: #fff;
    font-size: 9px;
    line-height: 14px;
    font-weight: 400;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  .plan-price {
    margin: 10px 0 0;
    line-height: 32px;
  }
  .plan-amount {
    color: #fff;
    font-family: var(--w-font-display);
    font-weight: 300;
    font-size: 32px;
    letter-spacing: -0.03em;
  }
  .plan-suffix {
    color: rgba(255, 255, 255, 0.55);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .plan-blurb {
    margin: 6px 0 0;
    color: rgba(255, 255, 255, 0.62);
    font-size: 13px;
    line-height: 18px;
  }
  .plan-rows {
    list-style: none;
    margin: 14px 0 0;
    padding: 12px 0 0;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    display: grid;
    gap: 8px;
  }
  .plan-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 12px;
    line-height: 17px;
  }
  /* The mark sits on the first line of a wrapped value. */
  .plan-mark {
    display: flex;
    align-items: center;
    height: 17px;
    flex: none;
    color: rgba(255, 255, 255, 0.5);
  }
  .plan-row[data-state='on'] .plan-mark {
    color: var(--plan-accent);
  }
  .plan-value {
    color: rgba(255, 255, 255, 0.6);
  }
  .plan-row[data-state='on'] .plan-value {
    color: #fff;
  }
  .plan-row-detail {
    color: rgba(255, 255, 255, 0.5);
  }
  /* Takes up the height difference so both CTAs share a baseline. */
  .plan-spacer {
    flex: 1 1 auto;
    min-height: 16px;
  }
  .plan-cta {
    width: 100%;
  }
  .plan-cta-note {
    margin: 8px 0 0;
    text-align: center;
    color: rgba(255, 255, 255, 0.55);
    font-size: 11px;
    line-height: 14px;
  }
  .plan-custom {
    margin: 32px 0 0;
    color: rgba(255, 255, 255, 0.55);
    font-size: 13px;
    line-height: 18px;
  }
  /* Short windows (800x600): tighten the vertical spacing in and around the
     plan cards so the plan screen fits, centred, under the progress strip.
     Type and content are unchanged. */
  @media (max-height: 640px) {
    .plan-cards {
      margin-top: 20px;
    }
    .plan-card {
      padding-top: 16px;
      padding-bottom: 16px;
    }
    .plan-rows {
      margin-top: 10px;
      padding-top: 8px;
      gap: 6px;
    }
    .plan-spacer {
      min-height: 8px;
    }
    .plan-custom {
      margin-top: 14px;
    }
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: rgba(255, 255, 255, 0.85);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .link:hover {
    color: #fff;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  @media (prefers-reduced-motion: reduce) {
    .cs-pane > *,
    .cs-actions,
    .cs-mark.working,
    .cs-progress span,
    .cs-spin {
      animation-duration: 0s;
      animation-iteration-count: 1;
    }
  }
</style>
