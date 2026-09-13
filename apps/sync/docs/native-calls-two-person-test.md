# Native calls: two-person test

How to put two people in an HQ call on the `codex/hq-meet-desktop-integration`
branch, and what to look at while you are in there.

## Why it takes two people, not two machines

`OfficeHours.svelte` filters the roster with
`person.personUid !== selfPersonUid`. Your own person is removed from the list
of people you can knock on — your own row renders "open your door" controls
instead. Two laptops signed in as the same account are the same `prs_` person,
so neither sees the other and there is nobody to call.

The `deviceId` carried in the session identity models *your* presence across
devices. It is not a second participant.

So the test needs two distinct people who are both members of Indigo.

## What is already in place

Nothing below needs doing again.

- Backend is on production. hq-pro PR #3414 merged; `/v1/meet-native/*` is live.
- The `meetings.native` registry flag is on for Indigo company-wide, so any
  Indigo member is eligible. No per-person enablement.
- TURN is live: `turn.getindigo.ai` → `54.227.203.201`, coturn REST.
- The branch is pushed: `codex/hq-meet-desktop-integration`.

## macOS only

Windows is not covered by this branch. US-012 (Windows signing) is unstarted,
and nothing in the call path has been exercised on Windows. Both participants
need a Mac.

## Setup, per person

```bash
git fetch origin
git checkout codex/hq-meet-desktop-integration
pnpm install --frozen-lockfile
pnpm --filter hq-sync sidecar:install
```

### Build a real .app — do NOT use `tauri dev`

This is the step most likely to waste an hour if skipped.

`tauri dev` produces a bare binary that `codesign` reports as ad-hoc and
linker-signed with no `CFBundleIdentifier`. macOS TCC records camera grants
against a stable code identity, so it refuses the camera outright — in about
ten milliseconds, with no prompt — and HQ never appears in the Camera list in
System Settings. The microphone can still appear to work, because the grant is
attributed to whatever launched the dev server. That mismatch makes the failure
look like a camera bug rather than a packaging one.

Build and sign a real bundle instead:

```bash
pnpm --dir apps/sync tauri build --debug --bundles app
codesign --force --deep --sign - apps/sync/src-tauri/target/debug/bundle/macos/HQ.app
open apps/sync/src-tauri/target/debug/bundle/macos/HQ.app
```

The re-sign matters. Tauri leaves the bundle linker-signed with no designated
requirement, which TCC treats much like the bare binary. After re-signing,
`codesign -dv` should report `Identifier=ai.indigo.hq-sync-menubar`.

The grant is tied to that binary's hash, so a rebuild will prompt again. That
is expected for a local unsigned build and does not affect the shipping app.

The first build takes roughly fifteen minutes.

## Running the test

1. Both people sign in normally. No special stage, no test accounts.
2. Both open **Indigo** in the sidebar. Office is a *company* tab, so it does
   not appear on a `#` project channel. The tab row should read Chat, Team,
   Atlas, Settings, Office.
3. Person A opens their door, or starts a room.
4. Person B finds A in the roster and knocks. Knocks are directional: you knock
   to ENTER the other person's room, and the capability is minted for the
   person knocking.
5. A admits B. Both should land in the call window.
6. Grant camera and microphone when macOS asks. If either was refused earlier,
   the permission card offers System Settings, and the window picks up the
   change on focus without another click.

## What to actually check

- Video and audio both directions.
- Mute really stops sending, rather than only changing the icon. It is enforced
  in the single `PeerTransport.attachLocalTracks` funnel.
- Switching microphone or camera mid-call republishes without a rejoin.
- Host moderation: ask-to-mute, force-mute, remove, end room. Moderation rides
  a dedicated `hq-meet-control` data channel, not the signaling channel.
- Leave closes the window. So does the red close button, at any point,
  including mid-connect.
- Force a TURN relay by putting one side on a different network (a phone
  hotspot is enough) and confirm the call still connects.

## Known gaps, so they are not reported as surprises

- Knock wakes poll every 10 seconds, because the Rust MQTT receiver ignores the
  `meet_knock` topic.
- There is no Knock action in Messages yet.
- Evidence preflight does not bind the receipt's `apiBase` to the host actually
  being called.
