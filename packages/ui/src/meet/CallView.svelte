<script lang="ts">
  /**
   * The in-call gallery (US-020).
   *
   * Renders 1..8 tiles — the self tile first, then admitted peers in join
   * order — with a connection chip, mute/camera indicators and a heuristic
   * speaking ring per tile, over the shared `MediaControls` bar.
   *
   * Platform-pure: no Tauri, no capture, no network. Media elements are handed
   * in by the host through `attach`, so this component never touches a
   * `MediaStream` and never learns a track id.
   *
   * Accessibility rules this file holds to:
   *  - every state is TEXT as well as shape; nothing is carried by colour alone
   *  - the speaking ring is labelled "may be speaking" (a level heuristic, not
   *    diarization), and is never claimed as confirmed
   *  - roster and connection changes announce through one polite live region
   *  - the whole surface is native buttons and selects, so it is keyboard
   *    operable with no key handlers of our own
   *  - the ring animation is dropped under `prefers-reduced-motion`
   */
  import MediaControls from "./MediaControls.svelte";
  import {
    deriveCallView,
    type CallRole,
    type CallSnapshotView,
    type CallTile,
    type CallViewLayout,
    type MediaDevicesPort,
    type SelfMediaView,
    type TileConnection,
  } from "./call-view-model.js";

  interface Props {
    snapshot: CallSnapshotView;
    self: SelfMediaView;
    role?: CallRole;
    hostPersonUid?: string | null;
    cohosts?: readonly string[];
    speaking?: readonly string[];
    joinOrder?: readonly string[];
    displayName?: (personUid: string) => string;
    devices?: MediaDevicesPort | null;
    selectedMicrophoneId?: string | null;
    selectedCameraId?: string | null;
    busy?: boolean;
    controlsDisabled?: boolean;
    /**
     * A notice shown above the controls — a host mute that was honoured, a
     * capture denial and its OS recovery path, an undeliverable request.
     */
    notice?: string | null;
    /** Host hook to attach the media element for a tile. Returns a teardown. */
    attach?: (
      element: HTMLVideoElement,
      tile: CallTile,
    ) => (() => void) | void;
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
    ondismissnotice?: () => void;
  }

  let {
    snapshot,
    self,
    role = "participant",
    hostPersonUid = null,
    cohosts = [],
    speaking = [],
    joinOrder = [],
    displayName,
    devices = null,
    selectedMicrophoneId = null,
    selectedCameraId = null,
    busy = false,
    controlsDisabled = false,
    notice = null,
    attach,
    ontogglemicrophone,
    ontogglecamera,
    onselectdevice,
    onleave,
    onendroom,
    onremovepeer,
    onmuterequest,
    onmuteforce,
    ondismissnotice,
  }: Props = $props();

  const layout = $derived<CallViewLayout>(
    deriveCallView({
      snapshot,
      self,
      hostPersonUid,
      cohosts,
      speaking,
      joinOrder,
      ...(displayName ? { displayName } : {}),
    }),
  );

  const CONNECTION_LABEL: Record<TileConnection, string> = {
    connecting: "Connecting",
    connected: "Connected",
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
    removed: "Removed",
  };

  const ROLE_LABEL: Record<CallRole, string> = {
    host: "Host",
    cohost: "Cohost",
    participant: "Participant",
  };

  /** One polite announcement for the whole roster/connection picture. */
  const announcement = $derived.by(() => {
    const people = layout.tiles.length;
    const trouble = layout.tiles.filter(
      (tile) =>
        tile.connection === "reconnecting" ||
        tile.connection === "disconnected" ||
        tile.connection === "removed",
    );
    const base = `${people} ${people === 1 ? "person" : "people"} in the call.`;
    if (trouble.length === 0) return base;
    return `${base} ${trouble
      .map((tile) => `${tile.label}: ${CONNECTION_LABEL[tile.connection]}.`)
      .join(" ")}`;
  });

  function media(element: HTMLVideoElement, tile: CallTile) {
    const teardown = attach?.(element, tile);
    return {
      destroy() {
        teardown?.();
      },
    };
  }
</script>

<section class="call" data-testid="call-view">
  <p class="sr-only" aria-live="polite" data-testid="call-announcement">
    {announcement}
  </p>

  <div
    class="gallery"
    data-testid="call-gallery"
    data-columns={layout.columns}
    style="--call-columns: {layout.columns}"
  >
    {#each layout.tiles as tile (tile.id)}
      <article
        class="tile"
        class:speaking={tile.maybeSpeaking}
        class:self={tile.self}
        class:removed={tile.connection === "removed"}
        data-testid="call-tile"
        data-tile-id={tile.id}
        data-connection={tile.connection}
        aria-label="{tile.label}, {ROLE_LABEL[tile.role]}, {CONNECTION_LABEL[
          tile.connection
        ]}"
      >
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          class="video"
          class:hidden={tile.cameraOff}
          data-testid="call-tile-video"
          autoplay
          playsinline
          muted={tile.self}
          use:media={tile}
        ></video>
        {#if tile.cameraOff}
          <p class="placeholder" data-testid="call-tile-placeholder">
            Camera off
          </p>
        {/if}
        <footer class="meta">
          <span class="name" data-testid="call-tile-name">{tile.label}</span>
          {#if tile.role !== "participant"}
            <span class="chip" data-testid="call-tile-role"
              >{ROLE_LABEL[tile.role]}</span
            >
          {/if}
          <span class="chip" data-testid="call-tile-connection"
            >{CONNECTION_LABEL[tile.connection]}</span
          >
          {#if tile.micMuted}
            <span class="chip" data-testid="call-tile-muted">Muted</span>
          {/if}
          {#if tile.maybeSpeaking}
            <!--
              The heuristic, said out loud. It is an audio-LEVEL guess, so the
              text and the aria-label both hedge; nothing here is diarization.
            -->
            <span
              class="chip"
              data-testid="call-tile-speaking"
              aria-label="{tile.label} may be speaking">May be speaking</span
            >
          {/if}
        </footer>
        {#if tile.recovery}
          <p class="recovery" data-testid="call-tile-recovery">
            {tile.recovery}
          </p>
        {/if}
      </article>
    {/each}
  </div>

  {#if layout.overflow > 0}
    <!--
      Content-free: a COUNT, never names. Nothing about a participant we do not
      render may leak through the layout.
    -->
    <p class="overflow" data-testid="call-overflow">
      {layout.overflow} more admitted {layout.overflow === 1
        ? "participant is"
        : "participants are"} not shown.
    </p>
  {/if}

  {#if notice}
    <div class="notice" role="status" data-testid="call-notice">
      <span>{notice}</span>
      {#if ondismissnotice}
        <button
          type="button"
          data-testid="call-notice-dismiss"
          onclick={() => ondismissnotice?.()}>Dismiss</button
        >
      {/if}
    </div>
  {/if}

  <MediaControls
    {role}
    micMuted={self.micMuted}
    cameraOff={self.cameraOff}
    peers={layout.tiles}
    {devices}
    {selectedMicrophoneId}
    {selectedCameraId}
    {busy}
    disabled={controlsDisabled}
    {ontogglemicrophone}
    {ontogglecamera}
    {onselectdevice}
    {onleave}
    {onendroom}
    {onremovepeer}
    {onmuterequest}
    {onmuteforce}
  />
</section>

<style>
  .call {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-family: var(--font-sans);
    color: var(--v4-text-1);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  .gallery {
    flex: 1 1 auto;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(var(--call-columns, 1), minmax(0, 1fr));
    gap: var(--v4-space-2, 8px);
    padding: var(--v4-space-3, 12px);
    overflow: auto;
  }
  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 120px;
    border: 2px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-panel, 10px);
    background: var(--v4-surface-2, rgba(0, 0, 0, 0.06));
    overflow: hidden;
  }
  /*
    The speaking ring is DECORATION on top of the "May be speaking" chip: the
    chip is the accessible carrier, so a user who cannot see the ring loses
    nothing.
  */
  .tile.speaking {
    border-color: var(--v4-accent, currentColor);
  }
  @media (prefers-reduced-motion: no-preference) {
    .tile.speaking {
      transition: border-color 120ms ease-in-out;
    }
  }
  .tile.removed {
    opacity: 0.6;
  }
  .video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: #000;
  }
  .video.hidden {
    display: none;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    margin: 0;
    display: grid;
    place-items: center;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 14px);
  }
  .meta {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--v4-space-1, 4px);
    padding: var(--v4-space-2, 8px);
    background: var(--v4-surface-1, rgba(255, 255, 255, 0.85));
    font-size: var(--type-caption, 12px);
  }
  .name {
    font-weight: 600;
  }
  .chip {
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-button, 6px);
    padding: 1px 6px;
  }
  .recovery {
    position: relative;
    margin: 0;
    padding: var(--v4-space-1, 4px) var(--v4-space-2, 8px);
    background: var(--v4-surface-1, rgba(255, 255, 255, 0.85));
    color: var(--v4-text-3);
    font-size: var(--type-caption, 12px);
  }
  .overflow {
    margin: 0;
    padding: 0 var(--v4-space-4, 16px) var(--v4-space-2, 8px);
    color: var(--v4-text-3);
    font-size: var(--type-caption, 12px);
  }
  .notice {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2, 8px);
    padding: var(--v4-space-2, 8px) var(--v4-space-4, 16px);
    border-top: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    font-size: var(--type-secondary, 14px);
  }
  .notice span {
    flex: 1 1 auto;
  }
  .notice button {
    border: 1px solid var(--v4-border, rgba(0, 0, 0, 0.12));
    border-radius: var(--v4-radius-button, 6px);
    padding: 4px 10px;
    background: var(--v4-surface-1, transparent);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
</style>
