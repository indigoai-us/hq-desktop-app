<script lang="ts">
  import CompanySignInCard from "./CompanySignInCard.svelte";
  import {
    SIGNIN_COPY,
    signInPollDelayMs,
    suppressUnchangedLink,
    type CompanySignInRole,
    type CompanySignInView,
    type SignInFailure,
  } from "./company-signin-model.js";
  import type { CompanySignInClient } from "./company-signin-client.js";

  interface Props {
    role: CompanySignInRole;
    companyUid: string;
    outpostId?: string;
    client?: CompanySignInClient;
    /** Fixture render. When set, the panel does not call the route on open. */
    preview?: {
      view: CompanySignInView | null;
      failure?: SignInFailure | null;
      codeError?: string | null;
      now?: number;
    };
  }

  let { role, client, preview }: Props = $props();

  let view = $state<CompanySignInView | null>(null);
  let failure = $state<SignInFailure | null>(null);
  let codeError = $state<string | null>(null);
  let busy = $state<"submit" | "refresh" | "regenerate" | null>(null);
  let suppressedUrl = $state<string | null>(null);
  let finishingUntil = $state<number | null>(null);
  let notice = $state<string | null>(null);
  let tick = $state(Date.now());
  const now = $derived(preview ? (preview.now ?? tick) : tick);
  const canManage = $derived(role === "owner" || role === "admin");
  let started = false;

  $effect.pre(() => {
    if (!preview || started) return;
    started = true;
    view = preview.view;
    failure = preview.failure ?? null;
    codeError = preview.codeError ?? null;
  });

  $effect(() => {
    if (started || preview) return;
    started = true;
    if (!canManage) {
      view = { signedIn: false, state: "unknown" };
      return;
    }
    void load(false);
  });

  $effect(() => {
    if (preview || !client || !canManage) return;
    const delay = signInPollDelayMs(view, finishingUntil !== null);
    if (delay === null) return;
    const timer = setInterval(() => { void load(false); }, delay);
    return () => clearInterval(timer);
  });

  function applyView(next: CompanySignInView) {
    const shown = suppressUnchangedLink(suppressedUrl, next);
    view = shown;
    failure = null;
    if (shown.signedIn) {
      finishingUntil = null;
      suppressedUrl = null;
      notice = null;
      return;
    }
    if (shown.loginUrl && shown.loginUrl !== suppressedUrl) suppressedUrl = null;
    if (finishingUntil !== null && Date.now() > finishingUntil) {
      finishingUntil = null;
      notice = SIGNIN_COPY.expired;
    }
  }

  async function load(manual: boolean) {
    if (!client || !canManage) return;
    tick = Date.now();
    if (manual) busy = "refresh";
    const result = await client.read();
    if (manual) busy = null;
    if (result.ok) applyView(result.view);
    else if (!view) failure = result.reason;
    else if (result.reason === "unreachable" || result.reason === "not_available") failure = result.reason;
  }

  async function regenerate() {
    if (!client || !canManage) return;
    busy = "regenerate";
    const previousUrl = view?.loginUrl ?? null;
    const result = await client.regenerate();
    if (!result.ok) {
      busy = null;
      if (result.reason === "not_ready") {
        view = { signedIn: false, state: "awaiting_box" };
        codeError = null;
        failure = null;
        notice = null;
        return;
      }
      if (result.reason === "link_changed") {
        notice = SIGNIN_COPY.linkChanged;
        await load(false);
        return;
      }
      failure = result.reason;
      return;
    }
    suppressedUrl = previousUrl;
    finishingUntil = null;
    view = { signedIn: false, state: "awaiting_sign_in" };
    codeError = null;
    failure = null;
    notice = null;
    const next = await client.read();
    busy = null;
    if (next.ok) applyView(next.view);
  }

  async function submit(code: string) {
    if (!client || !canManage) return;
    busy = "submit";
    const result = await client.submitCode(code);
    busy = null;
    if (result.ok) {
      codeError = null;
      notice = SIGNIN_COPY.finishing;
      finishingUntil = Date.now() + 120_000;
      await load(false);
      return;
    }
    if (result.reason === "not_available") {
      notice = null;
      failure = "not_available";
    } else if (result.reason === "not_admin") codeError = SIGNIN_COPY.notAdmin;
    else if (result.reason === "unreachable") codeError = SIGNIN_COPY.unreachable;
    else if (result.reason === "link_changed") {
      notice = SIGNIN_COPY.linkChanged;
      await load(false);
    } else {
      notice = null;
      codeError = SIGNIN_COPY.rejected;
    }
  }
</script>

<CompanySignInCard
  {role}
  {view}
  {failure}
  {codeError}
  {busy}
  {now}
  {notice}
  onRefresh={() => { void load(true); }}
  onRegenerate={() => { void regenerate(); }}
  onSubmitCode={(code) => { void submit(code); }}
/>
