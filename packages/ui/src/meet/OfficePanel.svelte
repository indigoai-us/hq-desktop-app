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
  import { KNOCK_FRIENDLY, cannedReply, type Knock } from "./knocks.js";
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
  /** A quiet confirmation, for the answers that succeed silently otherwise. */
  let actionNote = $state<string | null>(null);
  let opening = $state(false);
  let ready = $state(false);

  /**
   * Our OWN live room, once this session has started one.
   *
   * This is not a room we knock with — see the direction note at the top of
   * `knocks.ts`: a knock names the TARGET's room. This is the door we open for
   * other people, created only by an explicit "Open my door" / "Start a room"
   * click and reused for the rest of the session.
   */
  let selfRoom = $state<KnockRoomBinding | null>(null);
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
    resolveRoom: (target) => resolveTargetRoom(target),
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
    selfRoom = null;
    openedForKnock = new Set();
    actionError = null;
    actionNote = null;
    if (!target) return;
    let cancelled = false;
    void (async () => {
      if (!(await prepare())) return;
      if (cancelled) return;
      await store.load(target);
      if (cancelled) return;
      // Seed DND from the office self row BEFORE the first knock read. The
      // mirroring effect below would land a tick too late, and a knock arriving
      // on that first read would raise an OS banner the person explicitly
      // switched off.
      knocks.setDnd(store.visibleSelf()?.willingness === "dnd");
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
    // Becoming HIDDEN is not a reason to spend a request: only the transition
    // back to visible can have missed something.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void knocks.refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(handle);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  /** Mirror the office's own willingness into the knock store's DND flag. */
  $effect(() => {
    knocks.setDnd(store.visibleSelf()?.willingness === "dnd");
  });

  /**
   * Our OWN knock was accepted → we are the one who moves.
   *
   * The knock is bound to THEIR room, and the grant the acceptance minted was
   * issued to us, for that room, for a short while only. So: open exactly once
   * per knockId, at once, and if the grant is already spent say so rather than
   * leaving a dead window behind. The call window still applies US-017's
   * explicit join controls before anything is captured.
   */
  $effect(() => {
    for (const knock of knocks.visibleSent()) {
      if (knock.state !== "accepted") continue;
      const capability = knock.admissionCapability;
      if (!capability || openedForKnock.has(knock.knockId)) continue;
      openedForKnock.add(knock.knockId);
      void enterOnKnock(knock, capability.grantId, capability.expiresAt);
    }
  });

  /**
   * Walk through the door they just opened. Refusals are stated, never
   * swallowed: a window that cannot admit us is worse than no window.
   */
  async function enterOnKnock(
    knock: Knock,
    capabilityId: string,
    expiresAt: number | null,
  ): Promise<void> {
    if (expiresAt !== null && expiresAt <= Date.now()) {
      actionError = KNOCK_FRIENDLY.GRANT_EXPIRED;
      return;
    }
    try {
      await openWindow(knock, { knockId: knock.knockId, capabilityId });
    } catch (error) {
      actionError = refusalMessage(error);
    }
  }

  /**
   * A thrown host refusal, in words. `GRANT_EXPIRED` and `CALL_SEALED` are the
   * two the knock path actually produces, and both must read as "that door is
   * gone", not as a generic failure.
   */
  function refusalMessage(error: unknown): string {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : String(error ?? "");
    for (const known of ["GRANT_EXPIRED", "CALL_SEALED", "CAPACITY_EXCEEDED"]) {
      if (code.includes(known)) return KNOCK_FRIENDLY[known];
    }
    return "The call window could not be opened.";
  }

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
      // Only the KNOCKER is ever issued a grant, and only for the target's
      // room. Every other path into a window — our own room, a walk-in to a
      // company-visible open door — travels on plain membership and must NOT
      // be handed a capability nobody minted for it.
      ...(knock ? { knock } : {}),
    });
  }

  /**
   * The TARGET's live room, from the authorized office payload.
   *
   * `discoverOffice` already carries `roomId`, `callId` and `epoch` for every
   * room the caller is permitted to see (`parseRoom` refuses a partial one), so
   * there is nothing to fetch. When the payload named no room, `getRoom` is the
   * fallback for a room we know the id of but not its live call.
   *
   * Returning null means "they have no open door": the knock store then refuses
   * the send locally, with no request spent and no room invented.
   */
  async function resolveTargetRoom(
    target: string,
  ): Promise<KnockRoomBinding | null> {
    if (!companyUid) return null;
    const person = store
      .visiblePeople()
      .find((entry) => entry.personUid === target);
    const room = person?.room;
    if (!room) return null;
    if (room.callId && Number.isFinite(room.epoch)) {
      return { roomId: room.roomId, callId: room.callId, epoch: room.epoch };
    }
    return await readRoom(room.roomId);
  }

  /** Read a room's live call binding when the office payload lacked one. */
  async function readRoom(roomId: string): Promise<KnockRoomBinding | null> {
    if (!companyUid || !roomId) return null;
    const result = await adapter.calls.getRoom(roomId, companyUid);
    if (!result.ok) return null;
    const payload = asRecord(result.value);
    const call = asRecord(payload.call);
    const callId = typeof call.callId === "string" ? call.callId : "";
    const epoch = typeof call.epoch === "number" ? call.epoch : 0;
    return callId ? { roomId, callId, epoch } : null;
  }

  /**
   * Make sure there IS a door: reuse our own live room when the office payload
   * already reports one, and otherwise create a company-visible one.
   *
   * Only ever called from an explicit click. Nothing on this surface creates a
   * room on load — an empty room is sealed by the server a minute later, and a
   * room nobody asked for is a call nobody agreed to.
   */
  async function ensureSelfRoom(): Promise<KnockRoomBinding | null> {
    if (!companyUid) return null;
    const mine = store.visibleSelf()?.room;
    if (mine) {
      selfRoom = {
        roomId: mine.roomId,
        callId: mine.callId,
        epoch: mine.epoch,
      };
      return selfRoom;
    }
    if (selfRoom) return selfRoom;
    const created = await adapter.calls.createRoom({
      companyUid,
      // Company-visible: an open door people can see is the whole point.
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
    selfRoom = { roomId, callId, epoch };
    return selfRoom;
  }

  function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  /**
   * "Start a room" / "Open my door" — the only two ways a room comes into
   * existence here, and both are a click.
   *
   * Opening a door means being behind it: the preference alone advertises a
   * room that does not exist, so this creates (or reuses) the room and walks us
   * into it. No capability: it is ours, and we are its host.
   */
  async function enterOwnRoom(): Promise<void> {
    if (opening || !companyUid) return;
    opening = true;
    actionError = null;
    try {
      const room = await ensureSelfRoom();
      if (!room) {
        actionError = "The room could not be started. Try again.";
        return;
      }
      await openWindow(room);
      // The roster is what tells everyone else the door is open.
      void store.refresh();
    } catch {
      actionError = "The call window could not be opened.";
    } finally {
      opening = false;
    }
  }

  /** Say the door is open, then actually open one. */
  async function openDoor(ttlMs: number): Promise<void> {
    await store.setWillingness("open", ttlMs);
    await enterOwnRoom();
  }

  async function knockPerson(
    person: OfficePerson,
    note: string,
  ): Promise<void> {
    actionError = null;
    // No retry with a "fresh room": there is no room of ours to refresh. A
    // STALE_EPOCH here means THEIR call moved on, and the honest answer is to
    // say so and let the next roster read supply the new binding.
    await knocks.send(person.personUid, note);
  }

  /**
   * Open the door: let them in. Acceptance is the server's decision — capacity,
   * membership and epoch are all re-checked there — so a refusal is surfaced.
   *
   * Nothing opens here. The knock named OUR room, and the grant the acceptance
   * minted was issued to THEM. If we are not currently in that room the card
   * offers "Go to your room", which is a separate, explicit click.
   */
  async function acceptKnock(knock: Knock): Promise<void> {
    actionError = null;
    const accepted = await knocks.accept(knock.knockId);
    if (!accepted || accepted.state !== "accepted") {
      actionError =
        knocks.state.actionError?.message ??
        knocks.state.error?.message ??
        "That door could not be opened. Ask them to knock again.";
    }
  }

  /**
   * Walk back into our own room after accepting. It is ours (or at least one we
   * are a member of), so no capability travels with us — the server would not
   * have issued us one anyway.
   */
  async function goToOwnRoom(knock: Knock): Promise<void> {
    if (opening) return;
    opening = true;
    actionError = null;
    try {
      await openWindow(knock);
    } catch (error) {
      actionError = refusalMessage(error);
    } finally {
      opening = false;
    }
  }

  /**
   * Reply with words instead of a room: send the DM, and only then close the
   * door. A DM that never left must NOT be followed by a decline — that would
   * leave the knocker refused and unanswered, which is the one outcome this
   * action exists to avoid.
   */
  async function replyToKnock(knock: Knock, text: string): Promise<void> {
    actionError = null;
    actionNote = null;
    let sent = false;
    try {
      const result = await adapter.messaging.sendDm(knock.from, text);
      sent = result.ok;
    } catch {
      sent = false;
    }
    if (!sent) {
      actionError =
        "The reply could not be sent, so the knock is still open. Try again, or answer it another way.";
      return;
    }
    await knocks.decline(knock.knockId);
    actionNote = "Your reply was sent and the knock was answered by message.";
  }

  /**
   * Are we already in our own room? The office payload is the authority: if it
   * says we are occupied, "Go to your room" would be a button that does nothing
   * anyone can see, so it is not offered at all.
   */
  const selfInRoom = $derived(store.visibleSelf()?.occupancy === "occupied");

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
  {#if actionNote}
    <p
      class="office-host-error"
      role="status"
      aria-live="polite"
      data-testid="office-action-note"
    >
      {actionNote}
    </p>
  {/if}
  <OfficeHours
    {store}
    {selfPersonUid}
    {displayName}
    {knocks}
    onstartroom={enterOwnRoom}
    onopendoor={openDoor}
    onopenroom={openRoom}
    onknock={knockPerson}
    onacceptknock={acceptKnock}
    ongotoknock={selfInRoom ? undefined : goToOwnRoom}
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
