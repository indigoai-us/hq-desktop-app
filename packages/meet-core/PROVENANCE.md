# `@hq/meet-core` provenance

This package is an adaptation, not a copy. Nothing is imported from the source
repository at build time; the behaviour below was read, understood and rewritten
against HQ-authorized signaling and explicit session lifetime ownership.

|             |                                                                    |
| ----------- | ------------------------------------------------------------------ |
| Source repo | `indigoai-us/hq-meet` (private prototype)                           |
| Pinned at   | `eaaf1c5abe3d6c502a06c96e92640bb867fb327b`                          |
| Adapted on  | 2026-09-11 for US-015 (`hq-meet-desktop-integration`)               |
| Local path  | `/Users/stefanjohnson/hq/repos/private/hq-meet` @ `eaaf1c5`         |

The prototype commit is pinned deliberately. If a later HQ Meet commit changes
this behaviour, that is a separate, reviewed port - not an implicit upgrade.

## What was ported

All of it from `src/lib/p2p/stream.ts` (757 lines), into
`src/transport.ts`:

| Prototype                                                       | Here                                                |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `createPeerConnection` / `handleDescription` perfect negotiation | `PeerTransport.create` / `handleDescription`        |
| `polite = selfPeerId < remotePeerId`                             | `isPolite()` over `personUid deviceId peerKey`      |
| `makingOffer` / `ignoreOffer` collision guards, polite rollback  | same fields on `PeerTransport`                      |
| `pendingCandidates` buffer flushed after `setRemoteDescription`  | `pendingCandidates` / `flushCandidates`             |
| `scheduleIceRestart` capped exponential backoff + jitter         | `scheduleIceRestart`, `TRANSPORT_TUNING`            |
| `MAX_ICE_RESTARTS = 5`, base 1s, cap 15s, 500ms jitter           | `TRANSPORT_TUNING` (identical values)               |
| `DISCONNECT_GRACE_MS = 5s` self-heal window                      | `armGrace`                                          |
| `armEstablishWatchdog` for silent/stranded connections           | `armEstablishWatchdog`                              |
| Renegotiate-from-scratch when `signalingState !== "stable"`      | same branch inside `scheduleIceRestart`             |
| "Fresh offer for a dead connection, recreating"                  | same branch inside `handleDescription`              |
| Ghost-tile teardown (`disconnectPeer`, `isCurrent` staleness)    | roster-driven teardown in `CallSession.onRoster`    |
| `replaceLocalTracks` / `addLocalTracks` sender reuse             | `PeerTransport.attachLocalTracks`                   |

From `apps/sync/e2e/meet/native-probe.js` and `webdriver-driver.ts` the *ideas*
of the bounded trickle-ICE exchange were reused, not the code: candidates are
queued until the remote description is set, and the per-connection candidate
budget is 256 (`TRANSPORT_TUNING.candidateBudget`).

## What authority was deliberately removed

1. **Publishing implies membership.** `src/lib/room/manager.ts` re-admitted any
   peer that published a room message (lines ~247 `joinRoom` and ~583
   `handlePeerDiscovered` on an unknown sender). That rule is **not** ported.
   Membership here comes only from the admitted roster the `SignalingPort`
   delivers (`CallSession.onRoster`); `CallSession.onSignal` drops anything from
   an identity that is not on it, before any `RTCPeerConnection` is created, and
   counts it as `unadmittedPeer`.
2. **Global room directory / anonymous rooms.** The prototype kept module-level
   `rooms`, `peerConnections`, `pendingCandidates` and `currentRoomId` maps
   shared by the whole process, so any code could join any room by id. Here all
   of that state is instance state on one `CallSession` bound to one
   `(companyUid, roomId, callId, epoch)` and one `(personUid, deviceId,
   peerKey)`. There is no ambient room registry and no cross-company path.
3. **libp2p / GossipSub transport.** `src/lib/p2p/node.ts`, `discovery.ts` and
   `relay-config.ts` are not ported. Signaling is HQ's signed, durable
   `hq-meet/1` control plane (`src/hq-signaling.ts` over
   `CallsApi.sendSignal` / `signalingControl`), and every envelope is signed by
   the host through the `EnvelopeSigner` port - the device private key never
   enters this package.
4. **SFU bookkeeping.** `src/lib/p2p/sfu.ts` (participant promotion, forwarding
   tables, host-as-SFU accounting) is not ported. This engine is mesh-only.
5. **File transfer.** `src/lib/p2p/file-transfer.ts` is not ported; files belong
   to the HQ file paths, not to a data channel that bypasses admission.
6. **Console logging of peer ids and negotiation content.** The prototype logged
   truncated peer ids and negotiation steps. Here there is no logging at all;
   diagnostics are content-free integer counters on the snapshot.

## What was NOT ported (and where it goes instead)

- **Adaptive quality tiering** - `src/lib/p2p/quality.ts` and
  `src/lib/p2p/media.ts`. `quality.ts` is not cleanly separable at this commit:
  it reads `getPeerBandwidthStats()` from `src/lib/p2p/bandwidth.ts`, which in
  turn depends on the prototype's global connection map and on `getStats()`
  shapes we do not model in `PeerConnectionLike`. Porting it would drag the
  global state back in. **Left for US-021**, which should add a `StatsPort`
  alongside `PeerConnectionFactory` rather than reaching into the transport.
- **`getUserMedia` / device selection** - lives in the call window (US-017).
  This package receives tracks through `MediaPort`.
- **Any UI, tile layout or DOM work** - the window (US-016) owns it. There is no
  DOM, `window` or Tauri reference in this package.

## US-020 additions: mute semantics, moderation transport, speaking heuristic

**Mute stops sending.** `CallSession.setLocalTrackEnabled(kind, false)` records
the kind in a muted set consulted by `PeerTransport.attachLocalTracks()` on
EVERY attach. A muted kind is filtered out of the tracks that may be attached
*and* cleared off any sender still carrying it with `replaceTrack(null)`.
`track.enabled = false` alone was deliberately rejected: it keeps the sender and
keeps transmitting silence/black frames, and a later republish or a fresh
`RTCPeerConnection` after a reconnect restores the track with no memory of the
intent. Because every republish path (device change, `replaceLocalTrack`,
renegotiation, ICE restart, the post-recreate `connect()`) funnels through
`attachLocalTracks`, there is no window in which a muted kind is attached and
then removed. Stopping the track outright is the CONTROLLER's job in the call
window (US-017 `MediaController.disable*` does stop it, which also drops the
OS capture indicator); the engine guard is the belt to that braces, and is what
survives a track the host keeps alive for a local preview.

**Moderation rides a data channel, not signalling.** The hq-pro signal contract
pins `type` to `z.enum(["offer", "answer", "ice"])`
(`src/meetings/native/contract.ts` @ `signal`), so a moderation payload cannot
be delivered over `signaling/send` without mislabelling it as SDP or ICE. There
is no file channel in this package to reuse (file transfer was deliberately not
ported, above). Moderation therefore travels on a dedicated `hq-meet-control`
`RTCDataChannel` opened by `PeerTransport` on the polite side only (same
symmetric rule negotiation uses, so the two peers never race two channels). It
inherits the admission gate for free: an unadmitted peer holds no transport and
therefore no channel, and the channel dies with the peer.

**Host mute is a REQUEST.** The backend has no server-side media authority in
this contract - `revoke` removes a participant and `end` ends the room, and
nothing can reach another device's microphone. So `mute-request` is advisory
and `mute-force` is honoured by the RECIPIENT's client only when its own roster
view says the sender is a host or cohost, by muting locally (stop sending), with
a visible notice and a control to unmute itself. There is NO unmute action at
any authority level: `parseModeration` refuses every message that is not one of
the two mute actions, so no remote encoding exists that could enable a
microphone, and `isRemoteEnableAttempt` counts the attempt content-free
(`moderationUnmuteIgnored`) rather than dropping it silently. The engine never
mutes on its own either - it emits a `moderation` event and the host decides.

**Speaking is a heuristic, never diarization.** `SpeakingPort` produces
normalised audio levels per key-free peer label (WebAudio analyser in the call
window, a fake in tests); `createSpeakingTracker` applies a threshold with
hysteresis and a release hold. Nothing here proves a person spoke, and every
label rendered from it says "may be speaking".
