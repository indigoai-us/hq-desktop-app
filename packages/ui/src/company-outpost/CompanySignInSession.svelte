<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import CompanySignInCard from "./CompanySignInCard.svelte";
  import {
    SIGNIN_COPY,
    signInPollDelayMs,
    suppressUnchangedLink,
    type CompanySignInRole,
    type CompanySignInView,
    type SignInFailure,
    type SignInFinishing,
  } from "./company-signin-model.js";
  import { createCompanySignInClient, type CompanySignInPost } from "./company-signin-client.js";

  interface Props {
    role: CompanySignInRole;
    companyUid: string;
    outpostId?: string;
    post: CompanySignInPost;
  }

  // CompanySignInPanel keys this component on companyUid:outpostId:role, so
  // the props are fixed for its whole life. The client is built once from them.
  let props: Props = $props();
  const role = untrack(() => props.role);
  const client = untrack(() =>
    createCompanySignInClient({
      companyUid: props.companyUid,
      ...(props.outpostId ? { outpostId: props.outpostId } : {}),
      role: props.role,
      post: (body) => props.post(body),
    }),
  );
  const canManage = role === "owner" || role === "admin";

  const FINISHING_MS = 120_000;

  let view = $state<CompanySignInView | null>(null);
  let failure = $state<SignInFailure | null>(null);
  let codeError = $state<string | null>(null);
  let busy = $state<"submit" | "refresh" | "regenerate" | null>(null);
  let notice = $state<string | null>(null);
  let finishing = $state<SignInFinishing>(null);
  let tick = $state(Date.now());

  /** The link a regenerate replaced. A read that still returns it is hidden. */
  let suppressedUrl: string | null = null;
  /** The link the accepted code belonged to. */
  let codeUrl: string | null = null;
  let finishingUntil: number | null = null;
  /** One call at a time: every action and every poll tick go through this. */
  let inFlight = false;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waitingForVisible = false;

  function hidden(): boolean {
    return typeof document !== "undefined" && document.hidden === true;
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    clearTimer();
    if (destroyed || !canManage) return;
    const delay = signInPollDelayMs(view, finishing === "active", { now: Date.now(), failure });
    if (delay === null) return;
    timer = setTimeout(() => { void pollTick(); }, delay);
  }

  async function pollTick() {
    timer = null;
    if (destroyed) return;
    if (hidden()) {
      waitingForVisible = true;
      return;
    }
    if (inFlight) {
      schedule();
      return;
    }
    await run(null, readOnce);
  }

  function onVisibility() {
    if (destroyed || hidden() || !waitingForVisible) return;
    waitingForVisible = false;
    void pollTick();
  }

  /** Run one action under the single in-flight guard, then re-arm the poll. */
  async function run(label: "submit" | "refresh" | "regenerate" | null, action: () => Promise<void>): Promise<boolean> {
    if (inFlight || destroyed) return false;
    inFlight = true;
    busy = label;
    clearTimer();
    try {
      await action();
    } finally {
      inFlight = false;
      if (!destroyed) {
        busy = null;
        tick = Date.now();
        schedule();
      }
    }
    return true;
  }

  function applyView(next: CompanySignInView) {
    const shown = suppressUnchangedLink(suppressedUrl, next);
    view = shown;
    failure = null;
    if (shown.signedIn) {
      finishing = null;
      finishingUntil = null;
      suppressedUrl = null;
      codeUrl = null;
      notice = null;
      return;
    }
    if (shown.loginUrl && shown.loginUrl !== suppressedUrl) suppressedUrl = null;
    if (finishing !== null && shown.loginUrl && shown.loginUrl !== codeUrl) {
      // The box posted a different link, so the accepted code is no longer in play.
      finishing = null;
      finishingUntil = null;
      codeUrl = null;
      notice = null;
      return;
    }
    if (finishing === "active" && finishingUntil !== null && Date.now() > finishingUntil) {
      finishing = "stalled";
      finishingUntil = null;
      notice = SIGNIN_COPY.stillFinishing;
    }
  }

  /** One status read. Callers hold the in-flight guard. */
  async function readOnce() {
    const result = await client.read();
    if (destroyed) return;
    if (result.ok) applyView(result.view);
    else failure = result.reason;
  }

  function refresh() {
    if (!canManage) return;
    void run("refresh", readOnce);
  }

  function regenerate() {
    if (!canManage) return;
    void run("regenerate", async () => {
      // Hide the old link before the request goes out, so no read that lands
      // meanwhile can show it again.
      suppressedUrl = view?.loginUrl ?? suppressedUrl;
      if (view) view = suppressUnchangedLink(suppressedUrl, view);
      const result = await client.regenerate();
      if (destroyed) return;
      if (!result.ok) {
        if (result.reason === "not_ready") {
          suppressedUrl = null;
          view = { signedIn: false, state: "awaiting_box" };
          codeError = null;
          failure = null;
          notice = null;
          return;
        }
        if (result.reason === "link_changed") {
          suppressedUrl = null;
          notice = SIGNIN_COPY.linkChanged;
          await readOnce();
          return;
        }
        // The server removes the link before it mints one, so a failed
        // regenerate never leaves the old link valid to show again.
        suppressedUrl = null;
        failure = result.reason;
        return;
      }
      finishing = null;
      finishingUntil = null;
      codeUrl = null;
      view = { signedIn: false, state: "awaiting_sign_in" };
      codeError = null;
      failure = null;
      notice = null;
      await readOnce();
    });
  }

  function submit(code: string) {
    if (!canManage) return;
    void run("submit", async () => {
      const sentFor = view?.loginUrl ?? null;
      const result = await client.submitCode(code);
      if (destroyed) return;
      if (result.ok) {
        codeError = null;
        notice = SIGNIN_COPY.finishing;
        finishing = "active";
        finishingUntil = Date.now() + FINISHING_MS;
        codeUrl = sentFor;
        await readOnce();
        return;
      }
      if (result.reason === "not_available") {
        notice = null;
        failure = "not_available";
      } else if (result.reason === "not_admin") codeError = SIGNIN_COPY.notAdmin;
      else if (result.reason === "unreachable") codeError = SIGNIN_COPY.unreachable;
      else if (result.reason === "link_changed") {
        notice = SIGNIN_COPY.linkChanged;
        await readOnce();
      } else {
        notice = null;
        codeError = SIGNIN_COPY.rejected;
      }
    });
  }

  onMount(() => {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    if (!canManage) {
      // Members never call the route.
      view = { signedIn: false, state: "unknown" };
      return;
    }
    void run(null, readOnce);
  });

  onDestroy(() => {
    destroyed = true;
    clearTimer();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  });
</script>

<CompanySignInCard
  {role}
  {view}
  {failure}
  {codeError}
  {busy}
  now={tick}
  {notice}
  {finishing}
  onRefresh={refresh}
  onRegenerate={regenerate}
  onSubmitCode={submit}
/>
