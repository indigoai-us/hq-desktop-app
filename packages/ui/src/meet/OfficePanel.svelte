<script lang="ts">
  /**
   * Shell host for the shared Office view (US-018) — the ONE implementation.
   *
   * This component owns the sequencing the pure `OfficeHours` view must not
   * know about: the capability gate, the build-time service-evidence
   * preflight, identity resolution, the room-open seam, and the presence
   * *hint*. It owns no native import: `adapter` and `callsHost` are handed in
   * by whichever host mounted the shell, so the same file serves the Sync
   * desktop shell and any future host without a second copy.
   *
   * Company isolation: the store is bound to this company's explicit
   * `companyUid` SYNCHRONOUSLY at the top of every switch — before the async
   * preparation runs — so the previous company's roster never lingers under
   * the new company's heading. The store's generation counter then discards a
   * late answer for the company we just left.
   *
   * Presence is a HINT, never authority. A presence change only asks the store
   * to re-read the authorized office payload; it never sets anyone's
   * reachability, willingness or occupancy, and it never admits anybody.
   */
  import type { PlatformAdapter } from "@hq/platform";
  import { presenceSnapshot } from "../chat/presence-store.svelte.js";
  import OfficeHours from "./OfficeHours.svelte";
  import {
    createOfficeStore,
    type OfficePerson,
  } from "./office-store.svelte.js";
  import type { OfficeCallsHost } from "./office-host.js";
  import { cannedReply, type Knock } from "./knocks.js";
  import {
    createKnockStore,
    type KnockRoomBinding,
  } from "./knocks.svelte.js";

  interface Props {
    /** Platform backend seam. `calls`, `identity` and `capabilities` are used. */
    adapter: PlatformAdapter;
    /** Native seams from the host. Absent → the surface refuses, explicitly. */
    callsHost?: OfficeCallsHost | null;
    /** Cloud company uid. Null when this company is not cloud-backed. */
    companyUid?: string | null;
    /** Human label for the company, used in the not-connected state. */
    companyLabel?: string;
    /** Optional display names, keyed by person uid. */
    displayName?: (personUid: string) => string;
    /**
     * How often to re-read `GET /knocks` while this view is mounted.
     *
     * Knock wakes are published by the backend on `hq/{personUid}/notifications`
     * (`meet_knock`), but the desktop host subscribes only to the `dm` and
     * `client-health` leaves of that tree and discards MQTT payloads outright,
     * so there is no JS-visible knock wake to listen for yet. Until that Rust
     * receiver exists, this modest poll — plus a refresh on window focus and on
     * every presence hint — is what keeps windows and devices in agreement.
     * Wakes would only be hints anyway: `GET /knocks` stays the authority.
     */
    knockPollMs?: number;
  }

  let {
    adapter,
    callsHost = null,
    companyUid = null,
    companyLabel = "This company",
    displayName = (personUid: string) => personUid,
    knockPollMs = 10_000,
  }: Props = $props();

  let selfPersonUid = $state("");
  let deviceId = $state("");
  /** Set when the host itself refused before the store could be used. */
  let hostRefusal = $state<{ code: string; message: string } | null>(null);
  let actionError = $state<string | null>(null);
  let opening = $state(false);
  let ready = $state(false);

  /**
   * The room this device knocks WITH.
   *
   * Per the backend (see the direction note at the top of `knocks.ts`), the
   * KNOCKER binds a room they can already reach and the target's acceptance
   * issues the admission capability back to the knocker. So knocking on a
   * person means: open (or reuse) my own company-visible room, then ask them
   * to come to it. Reused across knocks in a session so three knocks do not
   * leave three abandoned rooms behind.
   */
  let ownRoom = $state<KnockRoomBinding | null>(null);
  /** Sent knocks whose acceptance has already opened a window for us. */
  let openedForKnock = new Set<string>();

  const store = createOfficeStore({
    calls: adapter.calls,
    get selfPersonUid() {
      return selfPersonUid;
    },
    now: () => Date.now(),
  });

  const knocks = createKnockStore({
    calls: adapter.calls,
    now: () => Date.now(),
    resolveRoom: () => ensureOwnRoom(),
    onKnockArrived: (knock) => notifyKnock(knock),
  });

  /**
   * Unlock the adapter with the host's build-time US-011 receipt, then resolve
   * identity. Both must succeed before any office request goes out — the
   * adapter refuses everything with CALLS_PREFLIGHT_REQUIRED until preflight
   * passes, and an office loaded as nobody is worse than no office.
   */
  async function prepare(): Promise<boolean> {
    if (ready) return true;
    if (adapter.capabilities?.nativeCalls !== true) {
      hostRefusal = {
        code: "CALLS_UNSUPPORTED_HOST",
        message:
          "Native calls are not available here. Open HQ in the desktop app to use office hours.",
      };
      return false;
    }
    if (!callsHost) {
      hostRefusal = {
        code: "CALLS_HOST_MISSING",
        message: "This build did not supply calling support.",
      };
      return false;
    }
    const preflight = await adapter.calls.preflight(
      callsHost.serviceEvidence,
      callsHost.evidenceMaxAgeMs === undefined
        ? undefined
        : { maxAgeMs: callsHost.evidenceMaxAgeMs },
    );
    if (!preflight.ok) {
      hostRefusal = {
        code: preflight.code ?? "CALLS_PREFLIGHT_REQUIRED",
        message: "Calling is not verified on this device yet.",
      };
      return false;
    }
    const who = await adapter.identity.whoami();
    if (!who.ok || !who.value.personUid) {
      hostRefusal = {
        code: "IDENTITY_UNAVAILABLE",
        message: "Your HQ identity could not be resolved. Sign in again.",
      };
      return false;
    }
    selfPersonUid = who.value.personUid;
    deviceId = (await callsHost.resolveDeviceId?.().catch(() => "")) ?? "";
    hostRefusal = null;
    ready = true;
    return true;
  }

  /**
   * Company binding. Re-runs on every company change. The synchronous
   * `store.reset` is the whole point: it lands in the SAME tick as the switch,
   * so nothing from the previous company survives the await below.
   */
  $effect(() => {
    const target = companyUid;
    store.reset(target);
    // Same tick as the office reset: a knock from the company we just left
    // must never render under the new company's heading.
    knocks.bind(target);
    ownRoom = null;
    openedForKnock = new Set();
    actionError = null;
    if (!target) return;
    let cancelled = false;
    void (async () => {
      if (!(await prepare())) return;
      if (cancelled) return;
      await store.load(target);
      if (cancelled) return;
      await knocks.refresh();
    })();
    return () => {
      cancelled = true;
    };
  });

  /**
   * Presence hint. A mesh presence change for THIS company asks for a refresh
   * of the authorized payload; it is never folded into the view itself.
   */
  let lastHint = 0;
  $effect(() => {
    const target = companyUid;
    // Reading the snapshot is what subscribes this effect to presence.
    const snapshot = presenceSnapshot().get(target ?? "");
    void snapshot;
    if (!target || !ready || store.state.status !== "ready") return;
    const now = Date.now();
    if (now - lastHint < 5_000) return;
    lastHint = now;
    void store.refresh();
    void knocks.refresh();
  });

  /**
   * Knock reconciliation. Authoritative state is `GET /knocks`, so every route
   * that could have missed something ends in the same refresh: a modest poll,
   * regaining window focus (the other window may have answered), and — via the
   * effect above — a presence hint. Duplicate wakes converge because the store
   * merges by knockId.
   */
  $effect(() => {
    const target = companyUid;
    if (!target || knockPollMs <= 0) return;
    const handle = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void knocks.refresh();
    }, knockPollMs);
    const onFocus = () => void knocks.refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(handle);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  });

  /** Mirror the office's own willingness into the knock store's DND flag. */
  $effect(() => {
    knocks.setDnd(store.visibleSelf()?.willingness === "dnd");
  });

  /**
   * Our OWN knock was accepted → the capability we were issued is what admits
   * us to our own room. Opening happens once per knockId; the guard survives a
   * duplicate refresh, and the call window still applies US-017's explicit
   * join controls before anything is captured.
   */
  $effect(() => {
    for (const knock of knocks.visibleSent()) {
      if (knock.state !== "accepted") continue;
      const capability = knock.admissionCapability;
      if (!capability || openedForKnock.has(knock.knockId)) continue;
      openedForKnock.add(knock.knockId);
      void openWindow(knock, {
        knockId: knock.knockId,
        capabilityId: capability.grantId,
      });
    }
  });

  /**
   * A knock banner is a nudge, never a ring: no sound, no window steal. On do
   * not disturb nothing is shown at all — but the knock itself stays in the
   * store, so the server's record and the in-app card are untouched.
   */
  function notifyKnock(knock: Knock): void {
    if (knocks.state.dnd) return;
    if (adapter.capabilities?.osNotifications !== true) return;
    const note = knock.note ? ` — “${knock.note}”` : "";
    void adapter.appShell
      .showOsNotification({
        title: `${displayName(knock.from)} knocked`,
        body: `They would like a quick word${note}`,
        route: "office",
      })
      .catch(() => undefined);
  }

  function sessionIdOf(room: {
    roomId: string;
    callId: string;
    epoch: number;
  }): string {
    return `${companyUid}:${room.roomId}:${room.callId}:${room.epoch}`;
  }

  async function openWindow(
    room: { roomId: string; callId: string; epoch: number },
    knock?: { knockId: string; capabilityId: string },
  ): Promise<void> {
    if (!callsHost || !companyUid) return;
    await callsHost.openCallWindow({
      sessionId: sessionIdOf(room),
      companyUid,
      roomId: room.roomId,
      callId: room.callId,
      epoch: room.epoch,
      self: { personUid: selfPersonUid, deviceId },
      // Only the knocker is ever issued a capability; the accepting side joins
      // on its own membership and must NOT be handed one it does not hold.
      ...(knock ? { knock } : {}),
    });
  }

  /**
   * Open (or reuse) the room this device knocks with. Returns null when the
   * room could not be opened — the store then refuses the send locally rather
   * than sending a knock bound to nothing.
   */
  async function ensureOwnRoom(): Promise<KnockRoomBinding | null> {
    if (!companyUid) return null;
    if (ownRoom) return ownRoom;
    const binding = await createOwnRoom();
    ownRoom = binding;
    return binding;
  }

  async function createOwnRoom(): Promise<KnockRoomBinding | null> {
    if (!companyUid) return null;
    const created = await adapter.calls.createRoom({
      companyUid,
      // Company-visible on purpose: a PRIVATE room only accepts a knock aimed
      // at somebody already inside it, which nobody is on a fresh room.
      visibility: "company",
    });
    if (!created.ok) return null;
    const payload = asRecord(created.value);
    const room = asRecord(payload.room);
    const call = asRecord(payload.call);
    const roomId = typeof room.roomId === "string" ? room.roomId : "";
    const callId = typeof call.callId === "string" ? call.callId : "";
    const epoch = typeof call.epoch === "number" ? call.epoch : 0;
    if (!roomId || !callId) return null;
    return { roomId, callId, epoch };
  }

  function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  async function startRoom(): Promise<void> {
    if (opening || !companyUid) return;
    opening = true;
    actionError = null;
    try {
      const created = await adapter.calls.createRoom({
        companyUid,
        visibility: "company",
      });
      if (!created.ok) {
        actionError = "The room could not be started. Try again.";
        return;
      }
      const body = asRecord(created.value);
      const room = asRecord(body.room);
      const call = asRecord(body.call);
      const roomId = typeof room.roomId === "string" ? room.roomId : "";
      const callId = typeof call.callId === "string" ? call.callId : "";
      const epoch = typeof call.epoch === "number" ? call.epoch : 0;
      if (!roomId || !callId) {
        actionError = "The room could not be started. Try again.";
        return;
      }
      await openWindow({ roomId, callId, epoch });
    } catch {
      actionError = "The call window could not be opened.";
    } finally {
      opening = false;
    }
  }

  async function knockPerson(
    person: OfficePerson,
    note: string,
  ): Promise<void> {
    actionError = null;
    const outcome = await knocks.send(person.personUid, note);
    // A stale binding is worth exactly one retry with a fresh room: the room we
    // reused may have sealed or moved epoch since we opened it.
    if (
      !outcome.ok &&
      (outcome.error?.code === "STALE_EPOCH" ||
        outcome.error?.code === "CALL_SEALED")
    ) {
      ownRoom = null;
      await knocks.send(person.personUid, note);
    }
  }

  /**
   * Open the door. Acceptance is the server's decision — capacity, membership
   * and epoch are all re-checked there — so a refusal is surfaced and we do NOT
   * enter the room. On success we join the KNOCKER's room on our own
   * membership, with no capability, and with nothing captured until the call
   * window's explicit join controls say so.
   */
  async function acceptKnock(knock: Knock): Promise<void> {
    actionError = null;
    const accepted = await knocks.accept(knock.knockId);
    if (!accepted || accepted.state !== "accepted") {
      actionError =
        knocks.state.error?.message ??
        "That door could not be opened. Ask them to knock again.";
      return;
    }
    try {
      await openWindow(accepted);
    } catch {
      actionError = "The call window could not be opened.";
    }
  }

  /**
   * Reply with words instead of a room: send the DM, then decline so the
   * knocker is not left waiting on a door that is not going to open.
   */
  async function replyToKnock(knock: Knock, text: string): Promise<void> {
    actionError = null;
    try {
      const sent = await adapter.messaging.sendDm(knock.from, text);
      if (!sent.ok) actionError = "The reply could not be sent.";
    } catch {
      actionError = "The reply could not be sent.";
    }
    await knocks.decline(knock.knockId);
  }

  async function openRoom(person: OfficePerson): Promise<void> {
    const room = person.room;
    if (!room || opening) return;
    opening = true;
    actionError = null;
    try {
      await openWindow(room);
    } catch {
      actionError = "The call window could not be opened.";
    } finally {
      opening = false;
    }
  }
</script>

{#if !companyUid}
  <div class="office-host-notice" data-testid="office-not-connected">
    <strong>{companyLabel} is not connected to HQ cloud</strong>
    <span>Connect this company to use office hours.</span>
  </div>
{:else if hostRefusal}
  <div
    class="office-host-notice"
    data-testid="office-host-refusal"
    data-refusal={hostRefusal.code}
  >
    <strong>Office hours are unavailable</strong>
    <span>{hostRefusal.message}</span>
  </div>
{:else}
  {#if actionError}
    <p class="office-host-error" role="alert" data-testid="office-action-error">
      {actionError}
    </p>
  {/if}
  <OfficeHours
    {store}
    {selfPersonUid}
    {displayName}
    {knocks}
    onstartroom={startRoom}
    onopenroom={openRoom}
    onknock={knockPerson}
    onacceptknock={acceptKnock}
    onreplyknock={replyToKnock}
    ondeferknock={(knock) => void knocks.defer(knock.knockId)}
    ondismissknock={(knock) => void knocks.decline(knock.knockId)}
    oncancelknock={(knock) => void knocks.cancel(knock.knockId)}
    replySuggestion={(knock) => cannedReply(knock, displayName)}
    onretry={() => {
      void store.refresh();
      void knocks.refresh();
    }}
  />
{/if}

<style>
  .office-host-notice {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2, 8px);
    margin: var(--v4-space-4, 16px);
    padding: var(--v4-space-4, 16px);
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-panel, 10px);
    font-family: var(--font-sans);
  }

  .office-host-notice span {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 14px);
  }

  .office-host-error {
    margin: var(--v4-space-4, 16px) var(--v4-space-4, 16px) 0;
    font-size: var(--type-secondary, 14px);
  }
</style>
