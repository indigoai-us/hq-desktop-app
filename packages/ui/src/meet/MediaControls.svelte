<script lang="ts">
  /**
   * The in-call control bar (US-020).
   *
   * Platform-pure: no Tauri, no `navigator`, no capture. Every device list
   * arrives through an injected `MediaDevicesPort` and every action is a
   * callback the host wires to the US-017 media controller and the calls API.
   *
   * Moderation is only rendered for a host or cohost, and the destructive ones
   * (end the room, remove someone) go through an explicit confirm rather than a
   * single click. There is no "unmute them" control, at any authority level —
   * see `meet-core/moderation.ts`.
   */
  import {
    canModerate,
    resolveDevice,
    type CallRole,
    type CallTile,
    type MediaDeviceOption,
    type MediaDevicesPort,
  } from "./call-view-model.js";

  interface Props {
    role: CallRole;
    micMuted: boolean;
    cameraOff: boolean;
    /** Peers that can be moderated (never self). */
    peers?: readonly CallTile[];
    /** Injected device enumeration. Omit to hide the pickers. */
    devices?: MediaDevicesPort | null;
    /** Remembered device ids, pre-selecting the pickers. */
    selectedMicrophoneId?: string | null;
    selectedCameraId?: string | null;
    /** True while a control is in flight; every button goes inert. */
    busy?: boolean;
    /** Disabled until the window proved whose account it is. */
    disabled?: boolean;
    ontogglemicrophone?: (next: boolean) => void | Promise<void>;
    ontogglecamera?: (next: boolean) => void | Promise<void>;
    onselectdevice?: (
      kind: "microphone" | "camera",
      deviceId: string,
    ) => void | Promise<void>;
    onleave?: () => void | Promise<void>;
    onendroom?: () => void | Promise<void>;
    onremovepeer?: (tile: CallTile) => void | Promise<void>;
    onmuterequest?: (tile: CallTile) => void | Promise<void>;
    onmuteforce?: (tile: CallTile) => void | Promise<void>;
  }

  let {
    role,
    micMuted,
    cameraOff,
    peers = [],
    devices = null,
    selectedMicrophoneId = null,
    selectedCameraId = null,
    busy = false,
    disabled = false,
    ontogglemicrophone,
    ontogglecamera,
    onselectdevice,
    onleave,
    onendroom,
    onremovepeer,
    onmuterequest,
    onmuteforce,
  }: Props = $props();

  let available = $state<readonly MediaDeviceOption[]>([]);
  let selectedPeerId = $state<string>("");
  /** Which destructive action is awaiting confirmation. */
  let confirming = $state<"end" | "remove" | null>(null);
  /** The control that opened the confirm, so focus can go back where it was. */
  let confirmTrigger: HTMLButtonElement | null = null;
  let cancelButton = $state<HTMLButtonElement | null>(null);

  const moderator = $derived(canModerate(role));
  const microphones = $derived(
    available.filter((device) => device.kind === "audioinput"),
  );
  const cameras = $derived(
    available.filter((device) => device.kind === "videoinput"),
  );
  const micChoice = $derived(resolveDevice(selectedMicrophoneId, microphones));
  const cameraChoice = $derived(resolveDevice(selectedCameraId, cameras));
  const moderatable = $derived(peers.filter((tile) => !tile.self));
  const selectedPeer = $derived(
    moderatable.find((tile) => tile.id === selectedPeerId) ?? null,
  );
  const inert = $derived(busy || disabled);

  /**
   * Enumeration is a READ, never a capture: it lists devices, it does not open
   * them. It re-runs on devicechange so a plugged-in headset appears without a
   * rejoin, and the listener is released with the component.
   */
  $effect(() => {
    const port = devices;
    if (!port) {
      available = [];
      return;
    }
    let live = true;
    const load = () => {
      void port
        .list()
        .then((list) => {
          if (live) available = list;
        })
        .catch(() => {
          // A refused enumeration leaves the pickers empty and the toggles
          // working: device choice is a convenience, not a gate on the call.
          if (live) available = [];
        });
    };
    load();
    const off = port.onChange?.(load);
    return () => {
      live = false;
      off?.();
    };
  });

  /**
   * Open a confirm, remembering the button that opened it. Focus goes to
   * Cancel (the safe choice), and comes back to this button on close, so a
   * keyboard user is never dropped at the top of the document.
   */
  function openConfirm(action: "end" | "remove", event: Event): void {
    confirmTrigger = event.currentTarget as HTMLButtonElement;
    confirming = action;
  }

  function closeConfirm(): void {
    if (confirming === null) return;
    confirming = null;
    const trigger = confirmTrigger;
    confirmTrigger = null;
    trigger?.focus();
  }

  $effect(() => {
    if (confirming !== null) cancelButton?.focus();
  });

  /**
   * The person being removed left, or was removed by another host, while the
   * confirm was open. Accepting now would act on nobody (or worse, on whoever
   * the select slid to), so the confirm closes itself.
   */
  $effect(() => {
    if (confirming === "remove" && !selectedPeer) closeConfirm();
  });

  function pick(kind: "microphone" | "camera", event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (!value) return;
    void onselectdevice?.(kind, value);
  }
</script>

<!--
  Escape cancels the confirm wherever focus is. The confirm is deliberately not
  modal (see `aria-modal="false"` below), so this is a convenience, not the only
  way out — Cancel is focused the moment it opens.
-->
<svelte:window
  onkeydown={(event: KeyboardEvent) => {
    if (event.key === "Escape" && confirming !== null) {
      event.preventDefault();
      closeConfirm();
    }
  }}
/>

<div class="bar" data-testid="media-controls">
  <div class="group">
    <button
      type="button"
      class="control"
      data-testid="control-microphone"
      aria-pressed={micMuted}
      disabled={inert}
      onclick={() => ontogglemicrophone?.(micMuted)}
    >
      {micMuted ? "Unmute" : "Mute"}
    </button>
    {#if devices && microphones.length > 0}
      <label class="picker">
        <span class="picker-label">Microphone</span>
        <select
          data-testid="device-microphone"
          disabled={inert}
          value={micChoice ?? ""}
          onchange={(event) => pick("microphone", event)}
        >
          {#each microphones as device (device.deviceId)}
            <option value={device.deviceId}>{device.label}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>

  <div class="group">
    <button
      type="button"
      class="control"
      data-testid="control-camera"
      aria-pressed={cameraOff}
      disabled={inert}
      onclick={() => ontogglecamera?.(cameraOff)}
    >
      {cameraOff ? "Start video" : "Stop video"}
    </button>
    {#if devices && cameras.length > 0}
      <label class="picker">
        <span class="picker-label">Camera</span>
        <select
          data-testid="device-camera"
          disabled={inert}
          value={cameraChoice ?? ""}
          onchange={(event) => pick("camera", event)}
        >
          {#each cameras as device (device.deviceId)}
            <option value={device.deviceId}>{device.label}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>

  {#if moderator}
    <div class="group moderation" data-testid="host-controls">
      <label class="picker">
        <span class="picker-label">Participant</span>
        <select
          data-testid="moderation-target"
          disabled={inert || moderatable.length === 0}
          value={selectedPeerId}
          onchange={(event) => {
            selectedPeerId = (event.currentTarget as HTMLSelectElement).value;
          }}
        >
          <option value="">Choose someone</option>
          {#each moderatable as tile (tile.id)}
            <option value={tile.id}>{tile.label}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        class="control"
        data-testid="moderation-mute-request"
        disabled={inert || !selectedPeer}
        onclick={() => selectedPeer && onmuterequest?.(selectedPeer)}
      >
        Ask to mute
      </button>
      <button
        type="button"
        class="control"
        data-testid="moderation-mute-force"
        disabled={inert || !selectedPeer}
        onclick={() => selectedPeer && onmuteforce?.(selectedPeer)}
      >
        Mute now
      </button>
      <button
        type="button"
        class="control danger"
        data-testid="moderation-remove"
        disabled={inert || !selectedPeer}
        onclick={(event) => openConfirm("remove", event)}
      >
        Remove
      </button>
      <button
        type="button"
        class="control danger"
        data-testid="moderation-end"
        disabled={inert}
        onclick={(event) => openConfirm("end", event)}
      >
        End room
      </button>
    </div>
  {/if}

  <button
    type="button"
    class="leave"
    data-testid="control-leave"
    disabled={busy}
    onclick={() => onleave?.()}
  >
    Leave
  </button>
</div>

{#if confirming !== null}
  <!--
    An explicit confirm for the two irreversible actions. Both say exactly what
    happens and to whom; "End room" is called out as affecting everyone, which
    is the distinction between leaving and ending.
  -->
  <!--
    `aria-modal="false"` is the truth, not a shortcut: this is an inline strip
    under the bar, the rest of the call stays operable behind it, and nothing
    is made inert. Claiming modality we do not enforce would tell a screen
    reader the rest of the page is unavailable when it is not.
  -->
  <div
    class="confirm"
    role="alertdialog"
    aria-modal="false"
    aria-label={confirming === "end" ? "End the room" : "Remove a participant"}
    data-testid="moderation-confirm"
  >
    <p class="confirm-text" data-testid="moderation-confirm-text">
      {#if confirming === "end"}
        End the room for everyone? Every participant is disconnected and the
        call is closed.
      {:else}
        Remove {selectedPeer?.label ?? "this participant"} from the call? They
        lose access immediately and are not muted — they are removed.
      {/if}
    </p>
    <button
      type="button"
      class="control"
      data-testid="moderation-confirm-cancel"
      bind:this={cancelButton}
      onclick={closeConfirm}
    >
      Cancel
    </button>
    <button
      type="button"
      class="control danger"
      data-testid="moderation-confirm-accept"
      disabled={confirming === "remove" && !selectedPeer}
      onclick={() => {
        const action = confirming;
        const peer = selectedPeer;
        closeConfirm();
        if (action === "end") void onendroom?.();
        else if (peer) void onremovepeer?.(peer);
      }}
    >
      {confirming === "end" ? "End room" : "Remove"}
    </button>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--v4-space-3, 12px);
    padding: var(--v4-space-3, 12px) var(--v4-space-4, 16px);
    border-top: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    font-family: var(--font-sans);
    font-size: var(--type-secondary, 14px);
    color: var(--v4-text-1);
  }
  .group {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2, 8px);
  }
  .moderation {
    flex-wrap: wrap;
  }
  .picker {
    display: flex;
    align-items: center;
    gap: var(--v4-space-1, 4px);
  }
  .picker-label {
    color: var(--v4-text-3);
    font-size: var(--type-caption, 12px);
  }
  select {
    max-width: 180px;
    padding: 4px 6px;
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-button, 6px);
    background: var(--v4-surface-1, transparent);
    color: inherit;
    font: inherit;
  }
  .control {
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-button, 6px);
    padding: 5px 12px;
    background: var(--v4-surface-1, transparent);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  /* State is carried by the text AND the outline, never by colour alone. */
  .control[aria-pressed="true"] {
    outline: 2px solid var(--v4-accent, currentColor);
    outline-offset: -2px;
  }
  .control.danger {
    border-color: var(--v4-danger, #c0362c);
  }
  .control:disabled,
  .leave:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .leave {
    margin-inline-start: auto;
    border: 1px solid var(--v4-danger, #c0362c);
    border-radius: var(--v4-radius-button, 6px);
    padding: 5px 14px;
    background: var(--v4-danger, #c0362c);
    color: #fff;
    font: inherit;
    cursor: pointer;
  }
  .confirm {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2, 8px);
    padding: var(--v4-space-3, 12px) var(--v4-space-4, 16px);
    border-top: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    font-family: var(--font-sans);
    font-size: var(--type-secondary, 14px);
  }
  .confirm-text {
    flex: 1 1 auto;
    margin: 0;
  }
</style>
