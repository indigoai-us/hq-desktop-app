<script lang="ts">
  /**
   * MeetingPermissionsWindow — secondary window for the meeting-detect
   * permission surface. **Windows-adapted.**
   *
   * On macOS this is a wizard that walks the user through granting five TCC
   * permissions (accessibility, screen-capture, microphone, system-audio,
   * full-disk-access) with deep-linked System Settings panes. Windows has no
   * equivalent per-app permission system for these capabilities — the Recall
   * Desktop SDK captures with the user's ambient rights — so there is nothing to
   * grant. This view renders a purely informational "all set" state: it fetches
   * `meetings_permissions_state` (which always reports granted / not-required on
   * Windows) and confirms each capability is available, with no prompts or CTAs.
   *
   * Like `MeetingsWindow.svelte`, the view self-fetches on mount + window focus
   * (no main-window event handshake). All CSS is scoped to
   * `[data-window="meeting-permissions"]` (see `main.ts`, which tags the
   * document element) so secondary-window styles never bleed into the popover or
   * sibling windows.
   */
  import { invoke } from '@tauri-apps/api/core';
  import { onMount, onDestroy } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';

  type PermStatus = 'granted' | 'denied' | 'prompt' | 'unknown';

  interface MeetingPermissionsState {
    accessibility: PermStatus;
    screenCapture: PermStatus;
    microphone: PermStatus;
    systemAudio: PermStatus;
    fullDiskAccess: PermStatus;
    allRequiredGranted: boolean;
  }

  // The capabilities the meeting pipeline uses. On Windows each is available
  // without a consent gate; we still list them so the user understands what the
  // SDK touches when it records a meeting.
  const CAPABILITIES = [
    {
      key: 'microphone' as const,
      title: 'Microphone',
      reason: 'Captures the meeting audio when you record.',
    },
    {
      key: 'screenCapture' as const,
      title: 'Screen & system audio',
      reason: 'Reads the meeting window and the other participants’ audio.',
    },
    {
      key: 'accessibility' as const,
      title: 'Foreground app detection',
      reason: 'Sees which app is in front so it can detect when you join a meeting.',
    },
  ] as const;

  let snapshot = $state<MeetingPermissionsState | null>(null);
  let loadError = $state<string | null>(null);

  const allGranted = $derived(snapshot?.allRequiredGranted ?? false);

  function statusOf(key: (typeof CAPABILITIES)[number]['key']): PermStatus {
    if (!snapshot) return 'unknown';
    return snapshot[key];
  }

  async function refresh(): Promise<void> {
    try {
      snapshot = await invoke<MeetingPermissionsState>('meetings_permissions_state');
      loadError = null;
    } catch (err) {
      console.error('meetings_permissions_state failed:', err);
      loadError = String(err);
    }
  }

  let unlistenFocus: (() => void) | null = null;

  onMount(async () => {
    await refresh();
    // Re-read on focus so the state is fresh if the user tabs away and back —
    // parity with the macOS wizard's System-Settings round-trip refresh.
    unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void refresh();
    });
  });

  onDestroy(() => {
    unlistenFocus?.();
  });

  async function close(): Promise<void> {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.error('close failed:', err);
    }
  }
</script>

<main class="perms">
  <header class="perms-header">
    <h1>Meeting permissions</h1>
    <p class="subtitle">
      What HQ Sync uses to detect and record your meetings.
    </p>
  </header>

  {#if loadError}
    <div class="banner banner-error" role="alert">
      Couldn’t read permission status. {loadError}
      <button class="link" onclick={() => void refresh()}>Retry</button>
    </div>
  {:else}
    <div class="banner banner-ok" class:pending={!allGranted}>
      {#if allGranted}
        <span class="banner-icon" aria-hidden="true">✓</span>
        <div>
          <strong>You’re all set.</strong>
          <span class="banner-sub"
            >Windows doesn’t require any per-app permission for these — nothing to
            grant.</span
          >
        </div>
      {:else}
        <span class="banner-icon" aria-hidden="true">…</span>
        <div>
          <strong>Checking…</strong>
          <span class="banner-sub">Reading capability status.</span>
        </div>
      {/if}
    </div>
  {/if}

  <ul class="perm-list">
    {#each CAPABILITIES as cap (cap.key)}
      {@const status = statusOf(cap.key)}
      <li class="perm-row">
        <div class="perm-info">
          <span class="perm-title">{cap.title}</span>
          <span class="perm-reason">{cap.reason}</span>
        </div>
        <span class="pill" class:pill-ok={status === 'granted'}>
          {status === 'granted' ? 'Available' : 'Checking'}
        </span>
      </li>
    {/each}
  </ul>

  <footer class="perms-footer">
    <p class="note">
      On macOS these require granting Accessibility, Screen Recording, and
      Microphone access in System Settings. On Windows the recorder runs with
      your existing rights, so there’s nothing to approve.
    </p>
    <button class="primary" onclick={() => void close()}>Done</button>
  </footer>
</main>

<style>
  /* Scope EVERYTHING to this window label so secondary-window styles can't bleed
     into the popover / sibling windows. `main.ts` sets
     document.documentElement.dataset.window = <label>, so the `:global(...)`
     body/background reset below is keyed to `[data-window="meeting-permissions"]`
     — the same pattern the other secondary windows use (c4909a9). */
  :global(html[data-window='meeting-permissions']),
  :global(body[data-window='meeting-permissions']) {
    margin: 0;
    background: transparent;
    color: #f4f4f5;
    font-family:
      -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial,
      sans-serif;
  }

  .perms {
    box-sizing: border-box;
    min-height: 100vh;
    padding: 1.5rem 1.75rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    /* Solid-background fallback for when Mica/Acrylic vibrancy is unavailable
       (Win 10 without Acrylic, Server SKUs, theme tools). When vibrancy is
       applied this sits on top of the system blur. */
    background: rgba(24, 24, 27, 0.72);
  }

  .perms-header h1 {
    margin: 0 0 0.25rem;
    font-size: 1.125rem;
    font-weight: 650;
  }
  .subtitle {
    margin: 0;
    font-size: 0.8125rem;
    color: rgba(244, 244, 245, 0.65);
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0.875rem;
    border-radius: 12px;
    background: rgba(126, 226, 168, 0.14);
    border: 1px solid rgba(126, 226, 168, 0.3);
  }
  .banner.pending {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.12);
  }
  .banner-error {
    background: rgba(255, 130, 130, 0.14);
    border-color: rgba(255, 130, 130, 0.32);
  }
  .banner-icon {
    font-size: 1.1rem;
    width: 1.5rem;
    text-align: center;
    flex-shrink: 0;
  }
  .banner strong {
    display: block;
    font-size: 0.875rem;
  }
  .banner-sub {
    display: block;
    font-size: 0.75rem;
    color: rgba(244, 244, 245, 0.7);
  }

  .perm-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    overflow: auto;
  }
  .perm-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 0.875rem;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
  }
  .perm-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .perm-title {
    font-size: 0.875rem;
    font-weight: 550;
  }
  .perm-reason {
    font-size: 0.75rem;
    color: rgba(244, 244, 245, 0.6);
  }

  .pill {
    flex-shrink: 0;
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    color: rgba(244, 244, 245, 0.75);
  }
  .pill-ok {
    background: rgba(126, 226, 168, 0.22);
    color: #aef2c8;
  }

  .perms-footer {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .note {
    margin: 0;
    font-size: 0.6875rem;
    line-height: 1.4;
    color: rgba(244, 244, 245, 0.5);
  }
  .primary {
    align-self: flex-end;
    padding: 0.45rem 1.1rem;
    border: none;
    border-radius: 8px;
    background: #6366f1;
    color: #fff;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
  }
  .primary:hover {
    background: #585bef;
  }
  .link {
    background: none;
    border: none;
    color: #c7d2fe;
    cursor: pointer;
    text-decoration: underline;
    font-size: inherit;
    padding: 0;
  }
</style>
