<script lang="ts">
  /**
   * The call window's shell (US-016/017/020).
   *
   * It owns the window chrome, the identity/permission notices and the media
   * ROUTING; the gallery and the control bar are the SHARED design-system
   * components (`meet.CallView` / `meet.MediaControls`), so the call looks and
   * behaves like the rest of HQ and stays testable without a webview.
   *
   * There is exactly ONE control surface: `MediaControls`, inside the gallery.
   * The footer below it is the transcription consent + status strip and holds
   * no microphone, camera or leave control — two places to mute is two places
   * to disagree about whether you are muted.
   *
   * The microphone and camera buttons are still the ONLY path to
   * `getUserMedia`: mounting, receiving a knock, restoring a remembered
   * preference or picking a device in a picker never reaches capture.
   */
  import { onMount, untrack } from 'svelte';

  import { CallView, MediaPermissionCard, type CallTile } from '@hq/ui';

  import { SELF_TILE, applyStream, setTileTracks } from './media-sinks';
  import { callView } from './view.svelte';
  import { formatConversationTime } from './conversation';
  let transcriptOpen = $state(false);
  let sessionDialog: HTMLDialogElement;
  let sessionDialogOpen = $state(false);
  let destination = $state<'personal'|'company'>('personal');
  let sessionBusy = $state(false);
  let sessionError = $state('');
  const transcriptionSession = $derived(callView.transcript.session);
  const sessionRunning = $derived(!!transcriptionSession && transcriptionSession.state !== 'ended');
  const sessionOwner = $derived(!!transcriptionSession && transcriptionSession.ownerPersonUid === (callView.state.roster?.self.personUid ?? callView.handle?.target?.self.personUid));
  const ownerName = $derived(sessionOwner ? 'you' : callView.names[transcriptionSession?.ownerPersonUid ?? ''] || 'the session starter');
  $effect(() => {
    if(sessionDialogOpen)sessionDialog?.showModal();
    else sessionDialog?.close();
  });
  function openSessionDialog(){destination='personal';sessionError='';sessionDialogOpen=true;}
  async function startTranscription(){
    if(sessionBusy||!callView.startTranscriptionSession)return;
    sessionBusy=true;sessionError='';
    try{await callView.startTranscriptionSession(destination);sessionDialogOpen=false;transcriptOpen=true;}
    catch(error){sessionError=error instanceof Error?error.message:'Could not start the session. Please try again.';}
    finally{sessionBusy=false;}
  }
  async function controlSession(action:'pause'|'resume'|'end'){
    if(sessionBusy)return;sessionBusy=true;sessionError='';
    try{await (action==='pause'?callView.pauseTranscriptionSession:action==='resume'?callView.resumeTranscriptionSession:callView.endTranscriptionSession)?.();}
    catch(error){sessionError=error instanceof Error?error.message:'Could not update the session. Please try again.';}
    finally{sessionBusy=false;}
  }


  /**
   * Closes the call window once the leave has been asked for.
   *
   * Leaving a call and closing its window are one user action, not two: the
   * window has no content after the session ends, and `MediaControls` goes
   * inert the moment `leaving` latches, so a window left open here offers no
   * control that still works — including Leave itself.
   */
  let {
    onclose,
    onopensettings,
    onrequestpermission,
    onreadpermissions,
  }: {
    onclose?: () => void;
    /**
     * Opens the OS pane where this device is granted. macOS never re-prompts
     * for a permission the user already refused, so a denied camera has
     * exactly one way back and the banner must offer it — telling someone
     * where the setting lives, with no way to get there, is not recovery.
     */
    onopensettings?: (device: 'microphone' | 'camera') => void;
    /**
     * Asks macOS for access, which shows the native dialog AND is the only
     * thing that puts HQ in the System Settings list for that device. Returns
     * the status read back afterwards.
     */
    onrequestpermission?: (
      device: 'microphone' | 'camera',
    ) => Promise<MediaPermissions> | MediaPermissions;
    /** Reads the native permission status without prompting. */
    onreadpermissions?: () => Promise<MediaPermissions> | MediaPermissions;
  } = $props();

  type MediaPermission = 'prompt' | 'denied' | 'granted' | 'unknown';
  type MediaPermissions = { microphone: MediaPermission; camera: MediaPermission };

  /**
   * Native TCC status, distinct from the capture result. `getUserMedia`
   * failing tells us capture did not happen; only this tells us WHY, and
   * therefore whether the way forward is a prompt or System Settings.
   */
  let permissions = $state<MediaPermissions | null>(null);
  let permissionBusy = $state(false);
  let permissionWatching = $state(false);
  /** Set when the user waves the card away; cleared by the next denial. */
  let permissionDismissed = $state(false);

  async function readPermissions(): Promise<MediaPermissions | null> {
    if (!onreadpermissions) return null;
    try {
      const next = await onreadpermissions();
      permissions = next;
      return next;
    } catch {
      // A host that cannot answer must not replace the call with a wall.
      return null;
    }
  }

  async function requestPermission(device: 'microphone' | 'camera') {
    if (!onrequestpermission || permissionBusy) return;
    permissionBusy = true;
    try {
      permissions = await onrequestpermission(device);
    } catch {
      // Fall through to a re-read; the card stays on whatever is true.
    } finally {
      permissionBusy = false;
    }
    // The native dialog is asynchronous — the value above is usually still
    // `prompt`. Watch until it settles rather than asking the user to retry.
    void watchForGrant(device);
  }

  function openSettings(device: 'microphone' | 'camera') {
    onopensettings?.(device);
    // Returning from System Settings should just work, so poll from here too.
    void watchForGrant(device);
  }

  /**
   * Poll until the OS verdict changes, then start the device.
   *
   * Bounded so a user who wanders off does not leave a timer running for the
   * life of the call, and re-armed by `focus` because coming back to the
   * window is the strongest signal that something changed.
   */
  async function watchForGrant(device: 'microphone' | 'camera') {
    if (permissionWatching) return;
    permissionWatching = true;
    try {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const next = await readPermissions();
        const verdict = next?.[device];
        if (verdict === 'granted') {
          permissionDismissed = false;
          await retryDevice(device);
          return;
        }
      }
    } finally {
      permissionWatching = false;
    }
  }

  /**
   * Read the OS verdict once on mount, and again whenever the window regains
   * focus. Returning from System Settings is the moment the answer changes,
   * and `focus` is the only signal the webview gets for it.
   */
  onMount(() => {
    void readPermissions();
    const onFocus = () => {
      void readPermissions();
    };
    globalThis.addEventListener?.('focus', onFocus);
    return () => globalThis.removeEventListener?.('focus', onFocus);
  });

  let leaving = $state(false);
  let busy = $state<'microphone' | 'camera' | 'transcription' | null>(null);

  const view = $derived(callView.state);
  const remoteTracks = $derived(callView.remoteTracks);
  const mic = $derived(view.media.microphone);
  const cam = $derived(view.media.camera);
  /**
   * Controls stay inert until this window proved whose account it is.
   *
   * `connecting` is reached BEFORE the identity gate answers, so status alone
   * would hand the microphone to a window that has not yet resolved a
   * canonical `prs_…`. `identityResolved` is the proof; authority being paused
   * (the host cannot refresh credentials) also holds them shut, because a
   * capture started there could not be authorized.
   */
  const controlsEnabled = $derived(
    view.identityResolved &&
      !view.authorityPaused &&
      (view.status === 'joined' || view.status === 'connecting'),
  );
  const denial = $derived(
    mic.recovery && (mic.status === 'denied' || mic.status === 'error')
      ? {
          kind: 'Microphone',
          recovery: mic.recovery,
          device: 'microphone' as const,
          deviceStatus: mic.status,
        }
      : cam.recovery && (cam.status === 'denied' || cam.status === 'error')
        ? {
            kind: 'Camera',
            recovery: cam.recovery,
            device: 'camera' as const,
            deviceStatus: cam.status,
          }
        : null,
  );
  /**
   * The permission surface takes over the stage only for a real permission
   * problem. A device that is missing or busy keeps the call visible and uses
   * the inline notice — replacing a live call with a full-bleed card over a
   * unplugged webcam would be the cure being worse than the disease.
   */
  const permissionBlock = $derived.by(() => {
    if (!denial || permissionDismissed) return null;
    const verdict = permissions?.[denial.device] ?? null;
    if (verdict === 'denied' || verdict === 'prompt') {
      return { device: denial.device, status: verdict };
    }
    // No native reading (non-macOS, or the host does not expose it): fall back
    // to the capture result, which at least distinguishes denied from broken.
    if (!permissions && denial.deviceStatus === 'denied') {
      return { device: denial.device, status: 'denied' as const };
    }
    return null;
  });

  const transcriptionLabel = $derived(callView.transcript.detail);

  const statusLabel = $derived(
    view.status === 'connecting'
      ? 'Connecting…'
      : view.status === 'identity'
        ? 'Confirm your account to join this call.'
        : view.status === 'waiting'
          ? 'Waiting for the call…'
          : view.status === 'joined'
            ? `In call · ${view.peerCount} connected`
            : view.status === 'left'
              ? 'Left the call'
              : `Call error${view.code ? ` · ${view.code}` : ''}`,
  );

  /**
   * The gallery needs SOME snapshot before the first roster lands, or the
   * window renders nothing while connecting. This one has exactly one member —
   * us — and no peers, which is the truth at that moment.
   */
  const roster = $derived(
    view.roster ?? {
      self: { personUid: 'self', deviceId: 'self' },
      admitted: [],
      peers: [],
      rosterRevision: 0,
      trafficStopped: false,
    },
  );
  const selfMedia = $derived({
    micMuted: !mic.active,
    cameraOff: !cam.active,
    speaking: view.speaking.includes('self'),
    connection:
      view.status === 'joined'
        ? ('connected' as const)
        : view.status === 'left' || view.status === 'error'
          ? ('disconnected' as const)
          : ('connecting' as const),
  });

  async function leave() {
    if (leaving) return;
    leaving = true;
    try {
      await callView.handle?.leave('leave-button');
    } catch {
      // The window closes either way. A leave that throws must not strand it.
    }
    onclose?.();
  }

  /** The explicit join control. Nothing else in this window may capture. */
  async function toggleDevice(kind: 'microphone' | 'camera', on: boolean) {
    if (busy) return;
    busy = kind;
    try {
      await callView.handle?.setDevice(kind, on);
    } finally {
      busy = null;
    }
  }

  async function retryDevice(kind: 'microphone' | 'camera') {
    if (busy) return;
    busy = kind;
    try {
      await callView.handle?.setDevice(kind, true);
    } finally {
      busy = null;
    }
  }

  async function retryIdentity() {
    await callView.handle?.retryIdentity();
  }

  /**
   * The REAL media sink. `CallView` hands us one `<video>` per tile and this is
   * where it is pointed at that tile's stream — there is no hidden element
   * anywhere else holding the media.
   *
   * Elements are kept in a registry (not just wired once) because tracks arrive
   * LATE: a peer whose camera comes on mid-call, or whose first track lands
   * after their roster entry did, must light up the tile that is already on
   * screen. The `$effect` below re-applies on every change to the stream map.
   */
  const sinks = new Map<HTMLMediaElement, string>();

  function attach(element: HTMLVideoElement, tile: CallTile): () => void {
    element.dataset.tileId = tile.id;
    if (tile.self) element.classList.add('local-preview');
    sinks.set(element, tile.id);
    applyStream(element, tile.id);
    return () => {
      sinks.delete(element);
      // Teardown releases the media: an element that keeps a srcObject after
      // its tile is gone is a peer still being rendered off-screen.
      element.srcObject = null;
      delete element.dataset.tileId;
    };
  }

  $effect(() => {
    // Read the map so this re-runs whenever a track lands or is dropped.
    void callView.streams;
    for (const [element, tileId] of sinks) applyStream(element, tileId);
  });

  /**
   * Our own tile shows the media CONTROLLER's local tracks, never a peer
   * connection's. It re-runs when a device goes live or off, so stopping the
   * camera empties the preview instead of freezing the last frame.
   */
  $effect(() => {
    void mic.active;
    void cam.active;
    const tracks = (callView.handle?.media?.tracks() ?? []) as MediaStreamTrack[];
    // `untrack`: publishing a stream WRITES the same map this effect would
    // otherwise read through, and an effect that reads and writes one piece of
    // state never settles.
    untrack(() => setTileTracks(SELF_TILE, tracks));
  });
</script>

{#snippet extraControls()}
<button class="transcription-toggle" type="button" data-testid="toggle-transcription" aria-label="Live transcript" title="Open live transcript" aria-pressed={transcriptOpen} onclick={() => { if(!transcriptionSession)openSessionDialog();else transcriptOpen = !transcriptOpen; }}>
<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h6M7 17h8"/></svg>
</button>
<span class="sr-status" data-testid="transcription-state">{transcriptionLabel}</span>
<p class="sr-status" data-testid="call-status" aria-live="polite">{statusLabel}</p>
<span class="sr-status" data-testid="remote-track-count">{remoteTracks.length}</span>
{/snippet}

<div class="call">
  <div class="window-drag" data-tauri-drag-region></div>
  {#if view.status === 'identity' && view.recoverable}
    <div class="notice" data-testid="call-identity-error" role="alert">
      <span>Confirm your account to join this call.</span>
      <button type="button" data-testid="call-identity-retry" onclick={retryIdentity}>Retry</button>
    </div>
  {/if}

  {#if view.authorityPaused}
    <div class="notice" data-testid="call-authority-paused" role="status">
      <span>Reconnecting to your account. The call continues; new actions are paused.</span>
    </div>
  {/if}

  {#if denial && !permissionBlock}
    <div class="notice" data-testid="call-permission-denied" role="alert">
      <span data-testid="call-permission-recovery">{denial.kind}: {denial.recovery}</span>
      {#if onopensettings}
        <button
          type="button"
          data-testid="call-permission-open-settings"
          onclick={() => onopensettings?.(denial.device)}>Open System Settings</button
        >
      {/if}
      <button
        type="button"
        data-testid="call-permission-retry"
        disabled={busy !== null}
        onclick={() => retryDevice(denial.device)}>Retry</button
      >
    </div>
  {/if}

  <div class="conversation-status" role="status"><span class:running={transcriptionSession?.state === 'active'}></span>{sessionRunning ? (transcriptionSession?.state === 'paused' ? 'Off the record' : 'Session live') : 'In your office'}{#if sessionRunning}<span class="transcript-indicator">{transcriptionSession?.scope === 'personal' ? 'Personal' : 'Company'} · {formatConversationTime(callView.transcript.elapsedMs)}</span>{/if}</div>
  <main class="stage">
    {#if permissionBlock}
      <MediaPermissionCard
        device={permissionBlock.device}
        status={permissionBlock.status}
        busy={permissionBusy}
        watching={permissionWatching}
        onrequest={(device) => void requestPermission(device)}
        onopensettings={(device) => openSettings(device)}
        onretry={(device) => void retryDevice(device)}
        ondismiss={() => (permissionDismissed = true)}
      />
    {:else}
    <CallView
      {extraControls}
      snapshot={roster}
      displayName={(uid)=>callView.names?.[uid] || (uid===roster.self.personUid ? "You" : "Participant")}
      self={selfMedia}
      role={view.role}
      hostPersonUid={view.hostPersonUid}
      cohosts={view.cohosts}
      speaking={view.speaking}
      devices={callView.handle?.mediaDevices ?? null}
      selectedMicrophoneId={view.devices.microphoneId}
      selectedCameraId={view.devices.cameraId}
      busy={busy !== null || leaving}
      controlsDisabled={!controlsEnabled}
      notice={view.notice}
      {attach}
      ontogglemicrophone={(next: boolean) => toggleDevice('microphone', next)}
      ontogglecamera={(next: boolean) => toggleDevice('camera', next)}
      onselectdevice={(kind: 'microphone' | 'camera', deviceId: string) => {
        void callView.handle?.selectDevice(kind, deviceId);
      }}
      onleave={leave}
      onendroom={() => {
        void callView.handle?.endRoom();
      }}
      onremovepeer={(tile: CallTile) => {
        void callView.handle?.removePeer(tile.personUid);
      }}
      onmuterequest={(tile: CallTile) => {
        callView.handle?.moderateMute(tile.id, false);
      }}
      onmuteforce={(tile: CallTile) => {
        callView.handle?.moderateMute(tile.id, true);
      }}
      ondismissnotice={() => callView.handle?.dismissNotice()}
    />
    {/if}
  {#if transcriptOpen}
    <aside class="transcript-panel" aria-label="Live transcript" data-testid="live-transcript-panel">
      <div class="transcript-heading"><div><span class="eyebrow">{transcriptionSession?.scope === 'personal' ? 'PERSONAL VAULT · LOCAL' : transcriptionSession ? 'COMPANY VAULT' : 'HQ MEET'}</span><h2>{transcriptionSession?.scope === 'personal' ? 'Personal notes' : 'Transcript'}</h2></div><button class="close-transcript" aria-label="Close transcript" onclick={() => transcriptOpen=false}>×</button></div>
      {#if sessionRunning}
        <div class="session-strip" class:off-record={transcriptionSession?.state === 'paused'}>
          <div class="session-strip-label"><span class="session-dot"></span><strong>{transcriptionSession?.state === 'paused' ? 'Off the record' : 'Session live'}</strong><time>{formatConversationTime(callView.transcript.elapsedMs)}</time></div>
          {#if sessionOwner}
            <div class="session-actions"><button disabled={sessionBusy} onclick={() => controlSession(transcriptionSession?.state === 'paused' ? 'resume':'pause')}>{#if transcriptionSession?.state === 'paused'}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6Z"/></svg>Resume{:else}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4v12M13 4v12"/></svg>Pause{/if}</button><button class="end-session" disabled={sessionBusy} onclick={() => controlSession('end')}><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="2"/></svg>End session</button></div>
          {:else}<small>Started by {ownerName} · only they can pause or end</small>{/if}
        </div>
      {:else}
        {#if transcriptionSession}<p class="session-ended">Session ended. Your transcript is below.</p>{/if}
        <button class="session-start" onclick={openSessionDialog}><span aria-hidden="true">＋</span> Start a transcription session</button>
      {/if}
      {#if callView.transcript.sessionNotice}<p class="session-ended">{callView.transcript.sessionNotice}</p>{/if}
      {#if sessionError && !sessionDialogOpen}<p class="session-error" role="alert">{sessionError}</p>{/if}
      <p class="transcript-status" role="status">{transcriptionLabel}</p>
      <div class="transcript-lines" role="log" aria-label="Conversation transcript" aria-live="polite">
      {#each callView.transcript.rows as row (`${row.personUid}/${row.deviceId}/${row.streamId}/${row.segmentId}`)}
        <article class="transcript-line"><div><strong>{callView.names[row.personUid] || (row.personUid===roster.self.personUid ? 'You' : 'Participant')}</strong><time>{formatConversationTime(row.startMs)}</time></div><p>{row.text}</p></article>
      {:else}
        <div class="transcript-empty"><span aria-hidden="true">≋</span><h3>{callView.transcript.mode === "personal" ? "Think out loud." : "A conversation, in words."}</h3><p>{callView.transcript.mode === "personal" ? "Unmute and speak. Your thoughts will appear here, phrase by phrase." : "Words appear here while the session is live. Pausing keeps the conversation off the record."}</p><p>Your microphone stays under your control.</p></div>
      {/each}
      </div>
      {#if callView.transcript.gaps > 0}<p class="transcript-gap">{callView.transcript.gaps} recognition gap(s) · some speech may be missing</p>{/if}
      <footer class="transcript-footer">
        {#if callView.transcript.mode === 'personal'}
          <span role="status" class:save-error={callView.personalSave.status === 'error'}>{callView.personalSave.detail}</span><br/>Private notes · never shared with room visitors.
          {#if callView.personalSave.status === 'error'}<button class="show-transcript" onclick={() => { void callView.retryPersonalSave?.(); }}>Retry save</button>{/if}
          {#if callView.personalSave.sourcePath}<button class="show-transcript" onclick={() => { void callView.showPersonalTranscript?.(); }}>Show in personal vault ↗</button>{/if}
        {:else}
          <span role="status" class:save-error={callView.transcriptSave.status === 'error'}>{callView.transcriptSave.detail}</span>
          <br/>Only session participants can access the saved transcript.
          {#if callView.transcriptSave.sourcePath}<button class="show-transcript" onclick={() => { void callView.showSavedTranscript?.(); }}>Show in vault ↗</button>{/if}
        {/if}
      </footer>
    </aside>
  {/if}
  </main>
  <dialog class="session-dialog" bind:this={sessionDialog} oncancel={() => sessionDialogOpen=false} onclick={event=>{if(event.target===sessionDialog && !sessionBusy)sessionDialogOpen=false;}} onclose={() => sessionDialogOpen=false}>
    <form onsubmit={event=>{event.preventDefault();void startTranscription();}}>
      <div class="session-modal-top"><span class="eyebrow">HQ MEET / TRANSCRIPTION</span><button type="button" class="close-transcript" aria-label="Close session setup" disabled={sessionBusy} onclick={()=>sessionDialogOpen=false}>×</button></div>
      <div class="session-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 10v4M9 6v12M13 3v18M17 7v10M21 10v4"/></svg></div>
      <h2>Start transcription.</h2><p class="session-intro">Choose where this session will be saved.</p>
      <fieldset disabled={sessionBusy}><legend>Where should this session live?</legend>
        <label class="destination" class:selected={destination==='personal'}><input type="radio" name="vault-destination" value="personal" bind:group={destination}/><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg><span><strong>Personal notes <em>Only you</em></strong><small>Your microphone. Your personal vault.<br/>Saved only on this device.</small></span></label>
        <label class="destination" class:selected={destination==='company'}><input type="radio" name="vault-destination" value="company" bind:group={destination}/><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21V6l9-3 9 3v15M8 10h1m6 0h1M8 14h1m6 0h1M10 21v-4h4v4"/></svg><span><strong>Company transcript <em>The room</em></strong><small>Everyone here, including people who join later.<br/>Saved to this company’s vault.</small></span></label>
      </fieldset>
      <p class="session-explainer">{destination==='personal' ? 'Capture your own thoughts, alone or with others.' : 'Starts transcription across the room. Muted microphones stay muted.'} You control pause, resume, and end.</p>
      {#if sessionError}<p class="session-error" role="alert">{sessionError}</p>{/if}
      <div class="session-modal-actions"><button type="button" disabled={sessionBusy} onclick={()=>sessionDialogOpen=false}>Cancel</button><button class="primary" type="submit" disabled={sessionBusy || !callView.startTranscriptionSession}>{sessionBusy?'Starting…':'Start session'}<span aria-hidden="true">↗</span></button></div>
    </form>
  </dialog>
</div>

<style>
  :global(html:has(#call)),:global(body:has(#call)){margin:0;background:#121513;color:#edf2ed;color-scheme:dark;height:100%;overflow:hidden}
  .call{--v4-text-1:#edf2ed;--v4-text-2:#b4c1b8;--v4-text-3:#8f9e94;--v4-ground:#121513;--v4-raised:#1d2420;--v4-inset:#ffffff07;--v4-popover-strong:#303c34;--v4-hairline:#ffffff18;--v4-border:#ffffff18;--v4-surface-1:#202822;--v4-surface-2:#1c241f;--font-sans:system-ui;box-sizing:border-box;padding:6px 12px 12px;}

  .call {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #101010;
    color: rgba(255, 255, 255, 0.92);
  }
  .titlebar {
    height: 38px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    user-select: none;
  }
  .title {
    font-size: 12px;
    letter-spacing: 0.06em;
    opacity: 0.7;
  }
  .stage {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .stage :global(.call) {
    flex: 1 1 auto;
    min-width: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    flex: none;
  }
  .status {
    margin: 0;
    font-size: 13px;
    flex: 1 1 auto;
  }
  .tracks {
    font-size: 11px;
    opacity: 0.5;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    flex: none;
    font-size: 12px;
    background: rgba(192, 54, 44, 0.18);
  }
  .notice span {
    flex: 1 1 auto;
  }
  .notice button,
  .control {
    border: 0;
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 12px;
    background: rgba(255, 255, 255, 0.14);
    color: inherit;
    cursor: pointer;
  }
  .control[aria-pressed='true'] {
    background: rgba(255, 255, 255, 0.34);
  }
  .control:disabled,
  .notice button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .transcription {
    font-size: 11px;
    opacity: 0.6;
  }
.titlebar{height:34px;justify-content:flex-start;padding:0 14px}.title{font-size:12px;letter-spacing:.02em}.call{padding:0;background:#101412}.bar{padding:7px 18px;gap:10px;border-top:1px solid #ffffff0b;min-height:34px;box-sizing:border-box}.bar .control{font-size:11px;padding:4px 8px}.status{font-size:11px;color:#93a79a}.tracks{display:none}.transcription-toggle{pointer-events:auto;width:42px;height:42px;display:grid;place-items:center;border:1px solid #ffffff20;border-radius:12px;background:#202822d9;color:#edf2ed;cursor:pointer}.transcription-toggle[aria-pressed="true"]{background:#365c48}.transcription-toggle:disabled{opacity:.4}.transcription-toggle svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6}.sr-status{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.window-drag{position:absolute;top:0;left:0;right:60px;height:30px;z-index:10}
.conversation-status{position:absolute;top:12px;left:100px;z-index:12;display:flex;align-items:center;gap:8px;font-size:11px;color:#c5d1c9;pointer-events:none}.conversation-status>span:first-child{width:6px;height:6px;border-radius:50%;background:#819087}.conversation-status>span.running:first-child{background:#7bd7a4}.transcript-indicator{color:#92a69a;margin-left:10px}.transcript-panel{box-sizing:border-box;flex:0 0 330px;min-width:0;display:flex;flex-direction:column;background:#141c18;border-left:1px solid #ffffff12;padding:44px 20px 16px}.transcript-heading{display:flex;align-items:center;justify-content:space-between}.eyebrow{font-size:9px;letter-spacing:.13em;color:#8ca193}.transcript-heading h2{font-size:20px;margin:5px 0 10px;letter-spacing:-.03em}.close-transcript{border:0;background:transparent;color:#b6c6bb;font-size:24px;cursor:pointer}.transcript-status{font-size:11px;line-height:1.5;color:#a7c3b1;padding:10px 0;border-bottom:1px solid #ffffff12;margin:0}.transcript-lines{flex:1;min-height:0;overflow:auto;padding:12px 0}.transcript-line{margin:0 0 20px}.transcript-line>div{display:flex;align-items:center;gap:12px}.transcript-line strong{font-size:11px;color:#b9d3c3}.transcript-line time{font-size:10px;color:#789383}.transcript-line p{font-size:13px;line-height:1.65;color:#e0e9e3;margin:6px 0}.transcript-empty{margin:50px 0;text-align:center;color:#9aad9f;font-size:12px;line-height:1.7}.transcript-empty>span{font-size:40px;color:#83af95}.transcript-empty h3{font-weight:500;color:#dae8df;font-size:15px}.show-transcript{display:block;background:transparent;border:0;padding:6px 0 0;color:#a8dcc0;font:inherit;cursor:pointer}.save-error{color:#e3bf86}.transcript-footer{font-size:10px;line-height:1.6;color:#8fa395;border-top:1px solid #ffffff12;padding-top:12px}.transcript-gap{font-size:11px;color:#e3bf86}@media(max-width:720px){.transcript-panel{position:absolute;right:0;top:0;bottom:0;width:min(330px,85vw);z-index:25;box-shadow:-15px 0 50px #0006}}

.session-strip{border:1px solid #91d7ad26;background:#6eba8b09;border-radius:12px;padding:12px;margin:8px 0 2px}.session-strip-label{display:flex;align-items:center;gap:8px;font-size:11px}.session-strip-label strong{font-weight:500;color:#c3e8d0}.session-strip-label time{margin-left:auto;color:#8da99a;font-variant-numeric:tabular-nums}.session-dot{width:6px;height:6px;border-radius:50%;background:#8ddfb0;box-shadow:0 0 10px #8ddfb033}.off-record{background:#dcb77d08;border-color:#dcb77d25}.off-record .session-dot{background:#dcb77d;box-shadow:none}.off-record strong{color:#ddc5a0}.session-strip small{display:block;margin-top:10px;font-size:10px;line-height:1.5;color:#91a698}.session-actions{display:flex;gap:8px;margin-top:12px}.session-actions button,.session-start{font:inherit;font-size:11px;border:1px solid #ffffff16;border-radius:8px;background:#ffffff08;color:#dce9e1;cursor:pointer;padding:8px 10px;display:flex;align-items:center;justify-content:center;gap:6px}.session-actions button{flex:1}.session-actions .end-session{color:#b8c4bd;background:transparent}.session-actions svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}.session-actions button:hover,.session-start:hover{background:#ffffff10}.session-actions button:disabled{opacity:.45;cursor:wait}.session-start{margin:10px 0;background:#91d7ad14;color:#c1e8d1;padding:11px}.session-start span{font-size:16px}.session-ended{font-size:11px;line-height:1.6;color:#a6b9ac}.session-error{color:#e9bdab;font-size:12px;line-height:1.5}.session-dialog{padding:0;border:1px solid #bdd9c42b;border-radius:22px;background:linear-gradient(145deg,#24352b,#141e19 65%);color:#e8f0eb;width:min(440px,calc(100vw - 40px));max-height:calc(100vh - 48px);box-shadow:0 30px 100px #0008;font-family:inherit;overflow:auto}.session-dialog::backdrop{background:#07110b99;backdrop-filter:blur(9px)}.session-dialog form{padding:22px 26px}.session-modal-top{display:flex;align-items:center;justify-content:space-between}.session-modal-top .eyebrow{color:#9db7a6;font-size:9px;letter-spacing:.16em}.session-modal-top .close-transcript{line-height:1;font-size:22px}.session-mark{width:40px;height:40px;display:grid;place-items:center;margin:12px 0 14px;background:#a0e8b910;border:1px solid #a0e8b923;border-radius:14px;color:#a7dfbc}.session-mark svg{width:25px;height:25px;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;fill:none}.session-dialog h2{font-size:26px;letter-spacing:-.04em;font-weight:550;margin:0 0 8px}.session-intro{font-size:13px;line-height:1.6;color:#a7bcae;margin:0 0 18px}.session-dialog fieldset{margin:0;padding:0;border:0;display:flex;flex-direction:column;gap:10px}.session-dialog legend{font-size:11px;color:#c1d0c6;margin-bottom:12px}.destination{position:relative;display:flex;align-items:flex-start;gap:13px;border:1px solid #d1e6d418;border-radius:12px;background:#ffffff03;padding:15px;cursor:pointer;transition:background .15s,border-color .15s}.destination.selected{border-color:#9ddeb36b;background:#8bd5a30a}.destination:hover{background:#ffffff07}.destination>svg{width:22px;height:22px;stroke:#9eb5a6;stroke-width:1.4;fill:none;flex:none;margin-top:1px}.destination input{position:absolute;right:14px;top:17px;accent-color:#abd9b9;width:13px;height:13px;margin:0}.destination strong{display:block;font-size:12px;font-weight:550;line-height:20px;padding-right:12px}.destination em{font-size:9px;font-style:normal;font-weight:400;color:#9fbcaa;margin-left:7px}.destination small{display:block;font-size:11px;line-height:1.65;color:#94a99b;margin-top:5px}.session-explainer{font-size:11px;line-height:1.7;color:#8da595;margin:14px 0 18px}.session-modal-actions{display:flex;justify-content:flex-end;gap:10px;padding-top:14px;border-top:1px solid #ffffff0d}.session-modal-actions button{font:inherit;font-size:12px;border:0;border-radius:9px;padding:11px 16px;background:transparent;color:#a7bcaf;cursor:pointer}.session-modal-actions .primary{background:#c5e6cf;color:#152c1d;font-weight:600;display:flex;align-items:center;gap:24px}.session-modal-actions .primary:hover{background:#d5efdd}.session-modal-actions button:disabled{opacity:.45;cursor:wait}.session-dialog :focus-visible,.session-actions :focus-visible,.session-start:focus-visible{outline:2px solid #b1e6c2;outline-offset:3px}
.notice{margin:36px 12px 4px;border-radius:10px;line-height:1.5}.notice + .notice{margin-top:4px}
</style>
