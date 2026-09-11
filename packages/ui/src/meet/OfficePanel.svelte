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

  interface Props {
    /** Platform backend seam. `calls`, `identity` and `capabilities` are used. */
    adapter: PlatformAdapter;
    /** Native seams from the host. Absent → the surface refuses, explicitly. */
    callsHost?: OfficeCallsHost | null;
    /** Cloud company uid. Null when this company is not cloud-backed. */
    companyUid?: string | null;
    /** Human label for the company, used in the not-connected state. */
    companyLabel?: string;
  }

  let {
    adapter,
    callsHost = null,
    companyUid = null,
    companyLabel = "This company",
  }: Props = $props();

  let selfPersonUid = $state("");
  let deviceId = $state("");
  /** Set when the host itself refused before the store could be used. */
  let hostRefusal = $state<{ code: string; message: string } | null>(null);
  let actionError = $state<string | null>(null);
  let opening = $state(false);
  let ready = $state(false);

  const store = createOfficeStore({
    calls: adapter.calls,
    get selfPersonUid() {
      return selfPersonUid;
    },
    now: () => Date.now(),
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
    actionError = null;
    if (!target) return;
    let cancelled = false;
    void (async () => {
      if (!(await prepare())) return;
      if (cancelled) return;
      await store.load(target);
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
  });

  function sessionIdOf(room: {
    roomId: string;
    callId: string;
    epoch: number;
  }): string {
    return `${companyUid}:${room.roomId}:${room.callId}:${room.epoch}`;
  }

  async function openWindow(room: {
    roomId: string;
    callId: string;
    epoch: number;
  }): Promise<void> {
    if (!callsHost || !companyUid) return;
    await callsHost.openCallWindow({
      sessionId: sessionIdOf(room),
      companyUid,
      roomId: room.roomId,
      callId: room.callId,
      epoch: room.epoch,
      self: { personUid: selfPersonUid, deviceId },
    });
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
    onstartroom={startRoom}
    onopenroom={openRoom}
    onretry={() => void store.refresh()}
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
