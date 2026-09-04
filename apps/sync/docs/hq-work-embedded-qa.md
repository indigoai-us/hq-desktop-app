# HQ Work embedded UI — feature-parity QA (US-105)

Mapping checklist for `@hq/ui` DesktopApp inside Sync's desktop-alt window,
against `createSyncPlatformAdapter` and the Sync/hq-pro backend.

**This file is fixture QA.** Proof is
[`hq-work-sync-handoff-US-105.test.ts`](../__tests__/stories/hq-work-sync-handoff-US-105.test.ts)
plus the adapter/shell/Rust source it contracts. A live Mac run is
[US-107](./hq-work-embedded-rollout.md) — do not mark live Results from a
coding session.

Flag **defaults off** (`hqWorkHandoff` / `hq_work_handoff`). Do not flip the
compiled default here. Tray popover, widget, and the sync engine stay in
Sync.

Silent degradations are fails. `unavailable("not-yet-mapped")` is only
acceptable when DesktopApp does not call that surface for a dogfooded
capability.

## Attachment upload path (vault presign + CORS-safe PUT)

Vault S3 buckets have **no CORS**. A webview `fetch` PUT/GET fails with
"Failed to fetch" / "Load failed".

Embedded path (same contract as WebPlatformAdapter presign + HQ Work desktop
native hop):

1. DesktopApp `uploadChatAttachments` (composer send, image paste/drop,
   ReplyPanel attach).
2. `adapter.files.presignVaultPut(company, key, contentType)` →
   `hq_pro_fetch` `POST /v1/files/presign`
   `{ company, op: "put", key, contentType }` (same body as
   `WebPlatformAdapter`).
3. Presign result `{ results: [{ url, headers }] }` — `headers` must include
   `content-type` (and any `x-amz-*` the signer returned).
4. WorkShell's `createTauriAttachmentHandlers` →
   `invoke("vault_s3_put", { url, headers, body })`.
   Rust allowlists HTTPS S3 hosts and forwards only `content-type`,
   `if-match` / `if-none-match`, and `x-amz-*`. No Cognito bearer, no
   `build_client()` HQ headers (those break SigV4). 180s timeout.
5. `sendChannelMessage` / `sendDm` / `sendReply` with the returned
   `ChatAttachmentWire[]` (hq-pro message POST, same paths as web).
6. Preview: `presignVaultGet` then `getVaultObject` → `vault_s3_get`.

`createSyncPlatformAdapter` is `kind: "desktop"`, so DesktopApp uses
`putAttachmentObject` rather than the web `/api/chat-attachment-upload`
proxy. `HqWorkWorkShell` must pass both hops.

## Parity checklist

| Capability | Surface (DesktopApp → adapter / command) | Result | Proof |
| --- | --- | --- | --- |
| Reactions | `fetchReactions` / `toggleReaction` → `fetch_reactions` / `toggle_reaction` | Pass | US-105 `reactions map onto existing Sync commands`; US-102 wrap/toggle tests |
| Reply threads | `fetchReplyThread` / `sendReply` → `fetch_thread` / `send_thread_reply`; attachments → `hq_pro_fetch` via `buildSendReplyRequest` | Pass | US-105 `reply threads` + `sendReply with attachments` |
| Image paste/drop | `ChannelConversation` / `ReplyPanel` `onpaste`/`ondrop` → `uploadFilesForSelectedRow` → vault hop | Pass | US-105 paste/drop source-contract + attachment hop wiring |
| Attachments (presign PUT + CORS-safe PUT) | `presignVaultPut` + WorkShell `createTauriAttachmentHandlers`/`vault_s3_put`; send extras on channel/DM/reply | Pass | US-105 attachment hop + presign PUT contract; `vault_s3.rs` cargo tests |
| Attachment preview GET | `presignVaultGet` + `getVaultObject`/`vault_s3_get` | Pass | US-105 `getAttachmentObject={getVaultObject}` + `vault_s3_get` registration |
| Channel creation | sidebar `createChannel` → `create_channel` / `create_group_dm` | Pass | US-105 `createChannel through the sidebar host` |
| History | `fetchChannel` / `fetchDmThread` (`fetch_channel` / `fetch_dm_thread`; `since` → hq-pro GET) | Pass | US-105 `history fetchChannel / fetchDmThread` |
| Settings (⌘,) | DesktopApp `keydown` meta/ctrl + `,` → `openSettings`; `applyDesktopAltRoute('settings')` → `OPEN_SETTINGS_EVENT` | Pass | US-105 `⌘, opens settings`; US-103 embedded settings |
| Light mode | Appearance pills include Light (`settings-theme-light`); `applyColorTheme("light")` sets `data-force-theme` | Pass | US-105 `light mode pill is present and applies` |

### Not dogfood / leave unavailable

| Surface | Why | Result |
| --- | --- | --- |
| `workMesh.readLocalSnapshot` | HQ Work *host* `App.svelte` reads the on-disk mesh overlay. Embedded Sync uses `createHqWorkSidebarApi` over REST (`list_channels` / directory). DesktopApp does not call this. | N/A (`not-yet-mapped`) |
| `shell.pickFile` | Marketplace creator avatar (`ProfilePanel`) only. Not in the dogfood list. | N/A (`not-yet-mapped`) |

## Flag

`hqWorkHandoffEnabled(undefined \| null \| false)` is false. Do not change
that in this story.

## Related

- Adapter: [`sync-adapter.ts`](../../../packages/platform/src/tauri/sync-adapter.ts)
- Shell: [`HqWorkWorkShell.svelte`](../src/desktop-alt/HqWorkWorkShell.svelte)
- Native hop: [`vault-s3-put.ts`](../src/desktop-alt/vault-s3-put.ts),
  [`vault_s3.rs`](../src-tauri/src/commands/vault_s3.rs)
- Rollout: [hq-work-embedded-rollout.md](./hq-work-embedded-rollout.md)
- Live smoke (US-107): [hq-work-embedded-smoke.md](./hq-work-embedded-smoke.md)
