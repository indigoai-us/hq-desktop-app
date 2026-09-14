<script lang="ts">
  /**
   * The camera / microphone permission surface for a call.
   *
   * **Why this is a card and not a warning strip.** macOS has no `+` button in
   * the Camera or Microphone panes. An app appears in either list if, and only
   * if, it has already called `AVCaptureDevice.requestAccess`. So the honest
   * first step is almost never "go to System Settings" — sending someone there
   * before the app has asked shows them a list that does not contain HQ, and
   * there is nothing they can do about it. The first step is to ASK, which is
   * what `request` does, and which puts HQ in the list as a side effect.
   *
   * The card therefore renders the state the user is actually in:
   *
   *   prompt  — never asked. One button, and macOS draws its own dialog.
   *   denied  — already refused. macOS will not ask again, so System Settings
   *             is the only way back, and HQ is now listed there.
   *   blocked — granted at the OS level but capture still failed. That is a
   *             device problem, not a permission problem, and it says so.
   *
   * Platform-pure by construction: no Tauri, no `navigator`, no timers. The
   * host passes status in and handles the three actions, so this renders in a
   * test with no webview.
   */
  import type { Snippet } from "svelte";

  export type MediaPermissionDevice = "camera" | "microphone";

  /** Mirrors the native TCC verdict. `unknown` never asserts a false state. */
  export type MediaPermissionStatus =
    | "prompt"
    | "denied"
    | "granted"
    | "unknown";

  interface Props {
    device: MediaPermissionDevice;
    status: MediaPermissionStatus;
    /** True while an action is in flight; the primary button shows progress. */
    busy?: boolean;
    /** True once the host has re-read status at least once after an action. */
    watching?: boolean;
    /** A device-level failure message, shown only when status is `granted`. */
    deviceError?: string | null;
    /** Ask macOS for access. Shows the native dialog and lists HQ in the pane. */
    onrequest?: (device: MediaPermissionDevice) => void;
    /** Open the OS pane for this device. Only meaningful once denied. */
    onopensettings?: (device: MediaPermissionDevice) => void;
    /** Try capture again without changing permission. */
    onretry?: (device: MediaPermissionDevice) => void;
    /** Leave the permission surface and go back to the call. */
    ondismiss?: () => void;
    /** Optional brand mark. Falls back to the built-in HQ glyph. */
    mark?: Snippet;
  }

  let {
    device,
    status,
    busy = false,
    watching = false,
    deviceError = null,
    onrequest,
    onopensettings,
    onretry,
    ondismiss,
    mark,
  }: Props = $props();

  const label = $derived(device === "camera" ? "camera" : "microphone");
  const Label = $derived(device === "camera" ? "Camera" : "Microphone");

  const heading = $derived(
    status === "denied"
      ? `${Label} access is turned off`
      : status === "granted"
        ? `Your ${label} didn’t start`
        : `HQ needs your ${label}`,
  );

  const body = $derived(
    status === "denied"
      ? `macOS won’t ask again once you’ve said no. Turn HQ back on in System Settings and this will pick it up on its own.`
      : status === "granted"
        ? (deviceError ??
          `HQ has permission, so this is the device itself. Check nothing else is using it, then try again.`)
        : `macOS will ask you to confirm. HQ only opens the ${label} when you press a control in a call — never on a knock, never in the background.`,
  );

  const primaryLabel = $derived(
    status === "denied"
      ? "Open System Settings"
      : status === "granted"
        ? `Try the ${label} again`
        : `Allow ${label}`,
  );

  function primary(): void {
    if (busy) return;
    if (status === "denied") onopensettings?.(device);
    else if (status === "granted") onretry?.(device);
    else onrequest?.(device);
  }
</script>

<section
  class="perm"
  data-testid="call-permission-card"
  data-device={device}
  data-status={status}
  role="group"
  aria-label={`${Label} permission`}
>
  <div class="card">
    <div class="mark" aria-hidden="true">
      {#if mark}{@render mark()}{:else}
        <span class="glyph">HQ</span>
      {/if}
      <span class="badge" data-device={device}>
        {#if device === "camera"}
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
            <path
              d="M4 6.5h9.2c1 0 1.8.8 1.8 1.8v7.4c0 1-.8 1.8-1.8 1.8H4c-1 0-1.8-.8-1.8-1.8V8.3c0-1 .8-1.8 1.8-1.8Zm13.4 4.1 3.3-2.3c.5-.4 1.1 0 1.1.6v6.2c0 .6-.6 1-1.1.6l-3.3-2.3v-2.8Z"
            />
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
            <path
              d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Zm-6 8.2a1 1 0 0 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.9V20a1 1 0 1 1-2 0v-2.9a6 6 0 0 1-5-5.9Z"
            />
          </svg>
        {/if}
      </span>
    </div>

    <h2 data-testid="call-permission-heading">{heading}</h2>
    <p data-testid="call-permission-body">{body}</p>

    {#if status === "denied"}
      <ol class="steps" data-testid="call-permission-steps">
        <li>
          <span class="step">1</span>
          <span>Find <strong>HQ</strong> in the {Label} list</span>
        </li>
        <li>
          <span class="step">2</span>
          <span>Turn the switch on</span>
        </li>
        <li>
          <span class="step">3</span>
          <span>Come back — no need to press anything else</span>
        </li>
      </ol>
    {/if}

    <div class="actions">
      <button
        type="button"
        class="primary"
        data-testid="call-permission-primary"
        disabled={busy}
        onclick={primary}
      >
        {busy ? "Working…" : primaryLabel}
      </button>
      {#if ondismiss}
        <button
          type="button"
          class="ghost"
          data-testid="call-permission-dismiss"
          onclick={() => ondismiss?.()}>Not now</button
        >
      {/if}
    </div>

    {#if watching && status === "denied"}
      <p class="watching" data-testid="call-permission-watching" role="status">
        <span class="pulse" aria-hidden="true"></span>
        Watching for the change
      </p>
    {/if}
  </div>
</section>

<style>
  .perm {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    /* Sits on the call's own dark stage; the card is the only lit surface. */
    background:
      radial-gradient(
        120% 90% at 50% 0%,
        rgba(255, 255, 255, 0.07),
        transparent 70%
      ),
      #0d0d0d;
  }

  .card {
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 14px;
    padding: 32px 28px 26px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    background: rgba(255, 255, 255, 0.045);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.06) inset,
      0 24px 60px rgba(0, 0, 0, 0.55);
  }

  .mark {
    position: relative;
    width: 62px;
    height: 62px;
    display: grid;
    place-items: center;
    border-radius: 15px;
    background: linear-gradient(
      160deg,
      rgba(255, 255, 255, 0.16),
      rgba(255, 255, 255, 0.05)
    );
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  .glyph {
    font-size: 20px;
    font-weight: 620;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.94);
  }
  .badge {
    position: absolute;
    right: -7px;
    bottom: -7px;
    width: 25px;
    height: 25px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: #0d0d0d;
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 0 0 3px #101010;
  }

  h2 {
    margin: 2px 0 0;
    font-size: 17px;
    font-weight: 600;
    line-height: 1.3;
    color: rgba(255, 255, 255, 0.96);
  }
  p {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.62);
    max-width: 34ch;
  }

  .steps {
    list-style: none;
    margin: 2px 0 0;
    padding: 14px 16px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.28);
    border: 1px solid rgba(255, 255, 255, 0.06);
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
    text-align: left;
    color: rgba(255, 255, 255, 0.74);
  }
  .steps strong {
    color: rgba(255, 255, 255, 0.95);
    font-weight: 600;
  }
  .step {
    flex: none;
    width: 19px;
    height: 19px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.85);
    background: rgba(255, 255, 255, 0.11);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  button {
    border: 0;
    border-radius: 8px;
    padding: 9px 18px;
    font: inherit;
    font-size: 13px;
    font-weight: 550;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .primary {
    color: #0d0d0d;
    background: rgba(255, 255, 255, 0.93);
  }
  .primary:not(:disabled):hover {
    background: #fff;
  }
  .ghost {
    color: rgba(255, 255, 255, 0.66);
    background: transparent;
  }
  .ghost:hover {
    color: rgba(255, 255, 255, 0.9);
    background: rgba(255, 255, 255, 0.07);
  }
  button:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.55);
    outline-offset: 2px;
  }

  .watching {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 2px 0 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }
  .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.75);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.25;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
      opacity: 0.7;
    }
  }
</style>
