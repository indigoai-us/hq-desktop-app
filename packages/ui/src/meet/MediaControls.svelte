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
    extraControls?: import("svelte").Snippet;
    role: CallRole;
    /** Gallery supplies per-tile moderation instead of the standalone selector. */
    participantActionsInTiles?: boolean;
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
    extraControls,
    role,
    participantActionsInTiles = false,
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

  let deviceSettings:HTMLDetailsElement;
  let roomSettings:HTMLDetailsElement;
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
  onpointerdown={(event) => { if (roomSettings?.open && !roomSettings.contains(event.target as Node)) roomSettings.open = false; }}
  onkeydown={(event: KeyboardEvent) => {
    if(event.key === "Escape" && confirming === null){for(const panel of [deviceSettings,roomSettings]){if(panel?.open){panel.open=false;panel.querySelector('summary')?.focus();}}}
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
      aria-label={micMuted ? "Unmute" : "Mute"}
      title={micMuted ? "Unmute" : "Mute"}
      aria-pressed={micMuted}
      disabled={inert}
      onclick={() => ontogglemicrophone?.(micMuted)}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>{#if micMuted}<path d="M3 3l18 18"/>{/if}</svg>
      <span>{micMuted ? "Unmute" : "Mute"}</span>
    </button>

  </div>

  <div class="group">
    <button
      type="button"
      class="control"
      data-testid="control-camera"
      aria-label={cameraOff ? "Start video" : "Stop video"}
      title={cameraOff ? "Start video" : "Stop video"}
      aria-pressed={cameraOff}
      disabled={inert}
      onclick={() => ontogglecamera?.(cameraOff)}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-4v12l-6-4"/>{#if cameraOff}<path d="M2 2l20 20"/>{/if}</svg>
      <span>{cameraOff ? "Start video" : "Stop video"}</span>
    </button>

  </div>

  {@render extraControls?.()}
  <details bind:this={roomSettings} class="settings room-settings"><summary aria-label="More call options" title="More call options">•••</summary>
  <div class="overflow-panel">
  {#if devices}
    <details bind:this={deviceSettings} class="settings" data-testid="call-device-settings">
      <summary aria-label="Audio and video settings" title="Audio and video settings"><span aria-hidden="true">⚙</span><span>Settings</span></summary>
      <div class="settings-panel"><strong>Audio & video</strong><p>Choose your devices. Your microphone and camera stay under your control.</p>
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
    {/if}    {#if devices && cameras.length > 0}
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
      {#if !microphones.length && !cameras.length}<p>No devices available.</p>{/if}
      </div>
    </details>
  {/if}

  {#if moderator}

    <div class="group moderation settings-panel" data-testid="host-controls">
      {#if !participantActionsInTiles}
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
      {/if}
      <button
        type="button"
        class="control danger"
        data-testid="moderation-end"
        disabled={inert}
        onclick={(event) => openConfirm("end", event)}
      >
        End for everyone
      </button>
    </div>
  {/if}
  </div></details>

  <button
    type="button"
    class="leave"
    aria-label="Leave call" title="Leave call"
    data-testid="control-leave"
    disabled={busy}
    onclick={() => onleave?.()}
  >
    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 15v-4c5-5 13-5 18 0v4h-5v-4M8 11v4H3"/></svg>
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

  .bar{margin:0 20px 16px;padding:16px;border:1px solid var(--v4-hairline,#ffffff18);border-radius:12px;background:var(--v4-raised,#1b211d);gap:12px;justify-content:center}.control,.leave{padding:11px 15px;border-radius:8px;font-size:12px}.control,select{border-color:var(--v4-hairline,#ffffff20);background:var(--v4-inset,#ffffff05)}.picker-label{font-size:11px}select{max-width:150px;font-size:12px;padding:8px}.control[aria-pressed="true"]{outline-width:1px;outline-color:var(--v4-text-3,#abc4b3)}

  .bar{position:relative;margin:0;padding:10px 18px;min-height:56px;box-sizing:border-box;gap:10px;flex-wrap:nowrap;border:0;border-top:1px solid #ffffff12;border-radius:0;background:#151917;justify-content:center;flex-shrink:0}.group{gap:0}.control{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 12px;font-size:12px}.control svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.leave{height:36px;padding:0 18px;font-size:12px;margin-left:auto}.settings{position:relative}.settings summary{list-style:none;display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-radius:8px;cursor:pointer;font-size:12px;color:#bac8bf}.settings summary::-webkit-details-marker{display:none}.settings summary:hover,.settings[open] summary{background:#ffffff0b}.settings summary:focus-visible{outline:2px solid #b2d8c4;outline-offset:2px}.settings-panel{position:absolute;bottom:48px;left:0;z-index:20;width:270px;padding:18px;box-sizing:border-box;background:#202822;border:1px solid #ffffff20;border-radius:12px;box-shadow:0 16px 40px #0008;display:flex;flex-direction:column;align-items:stretch;gap:14px}.settings-panel strong{font-size:14px}.settings-panel p{font-size:12px;line-height:1.5;color:#a5b5aa;margin:0}.settings-panel .picker{display:grid;gap:7px}.settings-panel select{max-width:none;width:100%}.room-settings .settings-panel{width:200px}.confirm{position:absolute;bottom:84px;left:24px;right:24px;background:#202822;border:1px solid #ffffff28;border-radius:12px;box-shadow:0 10px 40px #0007;z-index:30}.confirm .control{flex-shrink:0}.bar>.group:first-child{margin-left:auto}.control[aria-pressed="true"]{outline:none;background:#ffffff0b;color:#e5eee8}@media(max-width:650px){.bar{gap:4px;padding:8px}.control{padding:0 8px}.settings summary{padding:0 8px}.settings summary span:last-child{display:none}.settings-panel{left:auto;right:0}.confirm{left:10px;right:10px;flex-wrap:wrap}}

.bar{position:absolute;bottom:0;left:0;right:0;z-index:15;padding:32px 20px 20px;border:0;background:linear-gradient(transparent, #080d0bd9);justify-content:flex-start;pointer-events:none;gap:10px}.bar>*{pointer-events:auto}.bar>.group:first-child{margin-left:0}.group>.control,.leave{width:42px;height:42px;padding:0;display:grid;place-items:center;border-radius:12px}.group>.control>span{display:none}.leave svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linejoin:round}.settings summary{height:42px;min-width:42px;justify-content:center;background:#202822d9;border:1px solid #ffffff20;border-radius:12px}.overflow-panel{position:absolute;bottom:54px;left:0;width:270px;max-width:calc(100vw - 150px);padding:12px;background:#202822;border:1px solid #ffffff20;border-radius:12px;box-shadow:0 14px 40px #0008}.overflow-panel .settings-panel{position:static;width:auto;padding:10px 0;box-shadow:none;border:0}.overflow-panel .settings summary{justify-content:flex-start;padding:0 10px}.overflow-panel .moderation{margin:0;display:flex;flex-direction:column;align-items:stretch}.confirm{z-index:30}

.overflow-panel{width:232px;padding:6px;background:#1d2421f5;backdrop-filter:blur(24px)}.overflow-panel .settings summary,.overflow-panel .moderation>.control{box-sizing:border-box;width:100%;min-height:36px;height:auto;padding:9px 12px;display:flex;align-items:center;justify-content:flex-start;gap:9px;border:0;border-radius:7px;background:transparent;white-space:nowrap;font-size:12px;font-weight:500;text-align:left}.overflow-panel .settings summary:hover,.overflow-panel .moderation>.control:hover{background:#ffffff0b}.overflow-panel .moderation{width:auto;padding:5px 0 0;margin-top:5px;border-top:1px solid #ffffff10;gap:2px}.overflow-panel .moderation>.danger{color:#ff928a}.overflow-panel .settings-panel{padding:10px}.overflow-panel .picker{display:flex;flex-direction:column;align-items:stretch;gap:5px;margin:8px 0}.overflow-panel select{max-width:100%;width:100%}.overflow-panel p{font-size:11px;line-height:1.5;color:#a9b8af}
</style>
