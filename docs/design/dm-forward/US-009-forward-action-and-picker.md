# US-009 design: Forward action and destination picker (desktop)

Story: hq-dm-forward US-009. Branch `feat/dm-forward`. Builds on US-008 (forwarded message rendering, commits ddcb12ad5 / cec719232 / c6185c7f0).

## Server contract this design relies on

Verified against hq-pro-core worktree `hq-dm-forward-core` (`src/vault-service/lib/message-forward.ts`, `forward-company.ts`, `forward-send.ts`) and handoffs US-003/004/005-backend.json.

- Send routes, unchanged: `POST /v1/notify/dm` (body `{ toPersonUid, body, ... }`; `toPersonUid` takes a person `prs_*` or bot `agt_*` principal uid) and `POST /v1/notify/channels/{id}/messages` (channels and group DMs; a group DM is a channel).
- Forward fields on either route: `forwardOf: { conversationId, eventId }`, `body` (the note, may be empty when forwardOf is present), optional `fileAccess: "grant" | "omit"`, optional `acknowledgeCrossCompany: true`.
- `forwardOf.conversationId`: the peer principal uid for a 1:1 DM; the channel id for a channel or group DM (message-forward.ts:92-107).
- Success response adds `forwardedFrom`, `forwardNote`, `omittedAttachments` (number), and when non-empty `omittedAttachmentFiles`, `notShareable`, `grantedAttachments`.
- Error codes (all carry `code` + `error`): INVALID_FORWARD_OF 400, FORWARD_SOURCE_NOT_FOUND 404, INVALID_FILE_ACCESS 400, FORWARD_FILES_NOT_ALLOWED 400, FORWARD_BODY_TOO_LARGE / FORWARD_DETAILS_TOO_LARGE / FORWARD_PROMPT_TOO_LARGE 400, FORWARD_NOT_SCHEDULABLE 400, FORWARD_NOT_CONNECTED 400, CROSS_COMPANY_FORBIDDEN 403, CROSS_COMPANY_ACK_REQUIRED 409 (`sourceCompany {uid,name}`, `destinationCompany {uid,name}|null`), FORWARD_FILE_ACCESS_REQUIRED 409 (`files[]`, `notShareable[]`), FORWARD_FILE_SHARE_FORBIDDEN 403, FORWARD_FILE_GRANT_FAILED 502 (`file {id,name}`).

## Decision 1: transport goes through the existing `hq_pro_fetch` seam, no new Rust command

The existing `send_dm` and `send_channel_message` Tauri commands take only `(to, body)` and flatten errors to a string, so they cannot carry `forwardOf` or return a code. The platform adapter already exposes an authenticated JSON fetch (`packages/platform/src/tauri/sync-adapter.ts`, `hq_pro_fetch` → `apps/sync/src-tauri/src/commands/hq_pro.rs:107`) that returns `{ status, body }`. Add one adapter method there:

```ts
// packages/ui/src/chat/chat-api.ts (interface) + sync-adapter.ts (impl)
forwardMessage(args: ForwardRequest): Promise<ForwardResult>;

type ForwardDestination =
  | { kind: "dm"; principalUid: string; companyUid: string; name: string }
  | { kind: "channel"; channelId: string; companyUid: string; name: string }; // channel or group DM

interface ForwardRequest {
  destination: ForwardDestination;
  forwardOf: { conversationId: string; eventId: string };
  note: string;                        // trimmed; sent as `body`
  fileAccess?: "grant" | "omit";
  acknowledgeCrossCompany?: boolean;
}

type ForwardResult =
  | { ok: true; omittedAttachments: number; eventId?: string }
  | { ok: false; code: ForwardErrorCode | "NETWORK" | "UNKNOWN"; status: number | null;
      sourceCompany?: { uid: string; name: string }; destinationCompany?: { uid: string; name: string } | null;
      files?: { id?: string; name?: string }[]; notShareable?: { id?: string; name?: string }[] };
```

Route: `dm` → `POST /v1/notify/dm` with `{ toPersonUid, body, forwardOf, ... }`; `channel` → `POST /v1/notify/channels/{encodeURIComponent(channelId)}/messages`. Parse the error body once in a pure `parseForwardResponse(status, text)` in `packages/ui/src/chat/messaging/forward-model.ts`; coerce every array field there (`files`, `notShareable`, `omittedAttachmentFiles`) with `Array.isArray(x) ? x : []` (indigo-coerce-api-array-fields-at-parse-boundary). No Rust change is needed for US-009; the read-side pass-through was done in US-008. If the implementer finds hq_pro_fetch unusable for these paths, the fallback is a `forward_message` Tauri command beside `send_dm` that returns `{status, body}`; then add a cargo test and run both crates.

## Decision 2: the Forward button lives in the existing action row

`packages/ui/src/chat/messaging/ChannelConversation.svelte` ~line 2216-2242 holds Reply (`message-reply-quick`) and Copy (`message-copy`). Add after Copy:

```svelte
{#if onforward && !isPendingOrFailed(msg)}
  <button type="button" class="dm-quick-react-btn dm-quick-forward"
    data-testid="message-forward" aria-label="Forward message" title="Forward"
    onclick={() => onforward(msg)}>Forward</button>
{/if}
```

New optional prop `onforward?: (msg: ChannelMessageModel) => void`. Shown on 1:1 DMs, group DMs, and channels because all three hosts render ChannelConversation; each host passes `onforward` plus the source `conversationId` (peer uid for 1:1, channel id otherwise). Not offered on optimistic/unsent rows (no server eventId). Same class as Reply/Copy, so no new styling and no left accent bar. ReplyPanel is out of scope for AC0 (the AC names the per-message row with Reply and Copy).

## Decision 3: picker component and data

New `packages/ui/src/chat/messaging/ForwardPicker.svelte`, rendered by the host (DesktopApp / ConversationView) as a modal outside the message column, like the attachment modal.

Props: `source: ForwardSource` (`{ conversationId, eventId, companyUid, senderName, body, artifactKind?, artifactTitle? }`), `candidates: ForwardCandidate[]`, `adminCompanies: { uid, name }[]`, `onsend(req) => Promise<ForwardResult>`, `onclose()`, `ondone(destinationName)`.

Candidate list (AC1, AC6, AC7): built synchronously by a pure `buildForwardCandidates(sidebarConversations, contacts, companyUid)` in forward-model.ts from data already in memory: the sidebar's DM, group DM, bot, and channel rows plus the contacts roster used for @mention (`mentionCandidates`). No fetch on open. Filter to `companyUid === selected company`. Dedupe by principal/channel id. Exclude the source conversation itself is NOT required; allow it. Never call a directory or search endpoint, so nothing outside sidebar + contacts can appear. Search: case-insensitive substring on name, client-side.

Selection (AC2): single `selectedId` state; radio semantics (`role="listbox"`, options `role="option" aria-selected`). Note: one `<textarea data-testid="forward-note">`, optional.

Preview (AC3) `data-testid="forward-preview"`: sender name (`source.senderName`), first lines of body via `artifactPreviewLines` style truncation (3 lines), and when the source has details or prompt, `artifactKindLabel(kind)` + `artifactTitle(text, kind)` from `artifact-model.ts`. If the source is itself a forward, still show its sender name (the server re-forwards the original).

Cross-company (AC4): `adminCompanies` = companies from the existing `companies` list (ChatSidebar uses `company.role`) where role is `owner` or `admin`. Show a company `<select data-testid="forward-company">` only when `adminCompanies.length > 1` AND the source company is in that set. Default value is the source company. Others never see it. Selecting another company re-filters candidates to that company's sidebar rows. First send to another company omits `acknowledgeCrossCompany`; a 409 CROSS_COMPANY_ACK_REQUIRED shows a plain confirm ("This sends the message from {source} to {destination}. Files are not carried across companies.") with Send anyway / Cancel; Send anyway resends with `acknowledgeCrossCompany: true`. Do not pre-set the ack: the server is the authority.

Send (AC5): Send button disabled until a destination is selected and while sending. On `ok`: call `onclose()` then `ondone(name)`; host shows its existing toast/confirmation "Forwarded to {name}." plus ", {n} file(s) not included." when `omittedAttachments > 0`. On FORWARD_FILE_ACCESS_REQUIRED: show "Some files in this message are not shared with {name}." with Share files (`fileAccess: "grant"`) / Send without files (`"omit"`).

Keyboard (AC6): focus the search field on open; Escape anywhere in the dialog calls `onclose()`; Enter in search or list sends when a destination is selected (Enter inside the note textarea with Shift inserts a newline; plain Enter sends when selected); arrow keys move selection in the list.

## Error copy (indigo-ui-never-raw-errors-always-heal-path)

`forwardErrorMessage(code, ctx)` in forward-model.ts maps every code to a sentence + next action; never render `error` text or JSON:

| Code | Copy |
|---|---|
| FORWARD_SOURCE_NOT_FOUND | That message is no longer available. Close this and refresh the conversation. |
| INVALID_FORWARD_OF, INVALID_FILE_ACCESS, UNKNOWN | Something went wrong forwarding. Try again. |
| FORWARD_BODY/DETAILS/PROMPT_TOO_LARGE | This message is too long to forward. Copy the part you need and send it instead. |
| FORWARD_NOT_CONNECTED | You're not connected with {name} yet. Send them a message first. |
| FORWARD_NOT_SCHEDULABLE | Scheduled messages can't be forwarded. Pick another message. |
| CROSS_COMPANY_FORBIDDEN | You need to be an owner or admin in both companies to forward there. Pick someone in {source}. |
| FORWARD_FILES_NOT_ALLOWED | Files can't be sent to another company. Remove them and try again. |
| FORWARD_FILE_SHARE_FORBIDDEN | You can't share these files with {name}. Send without files instead. |
| FORWARD_FILE_GRANT_FAILED | Couldn't share {file}. Try again, or send without files. |
| NETWORK | Couldn't reach HQ. Check your connection and try again. |

## Files the frontend phase should touch

- `packages/ui/src/chat/messaging/forward-model.ts` (new): candidates, preview, response parse, error copy.
- `packages/ui/src/chat/messaging/ForwardPicker.svelte` (new).
- `packages/ui/src/chat/messaging/ChannelConversation.svelte`: `onforward` prop + button.
- `packages/ui/src/chat/chat-api.ts` and `packages/platform/src/tauri/sync-adapter.ts`: `forwardMessage`.
- Host wiring where ChannelConversation is mounted for DMs, group DMs, channels (grep `<ChannelConversation` in packages/ui/src/shell and chat).

## Tests to write (each must fail when its rule is removed)

- `ChannelConversation.forward.test.ts`: `message-forward` present in DM, group DM, channel hosts; absent without `onforward`; click passes the message.
- `forward-model.test.ts`: candidates only from given sidebar/contacts and only the chosen company; search filter; parse coerces non-array fields; every code maps to non-raw copy.
- `ForwardPicker.test.ts`: opens with no fetch (onsend mock not called, no network); single select; note sent as body; preview shows sender, first lines, artifact title; company control shown only for >1 admin company; Escape closes; Enter sends only when selected; success closes and calls ondone with name; 409 ack resend sets `acknowledgeCrossCompany: true`.
- `sync-adapter` test: dm vs channel route and payload shape.

## AC mapping

0 → Decision 2. 1 → Decision 3 candidates + search. 2 → single select + note. 3 → preview. 4 → company control rule. 5 → Send + ondone. 6 → synchronous candidates + keyboard. 7 → candidate source restricted to sidebar + contacts.

## Revision: picker layout (owner review, 2026-10-07)

Corey reviewed the first picker in the beta app and asked for it to match HQ messaging. The redesign changes the dialog, not the wire contract.

- Quoted card: the sender's avatar (`IdentityMark`, photo from `avatarByUid`, generated mark for bots, monogram otherwise), name, short time (`forwardTimeLabel`), and origin ("in #welcome", "in Ana, Bo", or "Direct message", from `forwardOriginLabel`). Soft fill, no border, no accent bar.
- One "To" field. The company scope is a chip at the left of the search (`data-testid="forward-company"`, a button that opens a small menu) instead of a separate select. Chosen recipients render as chips in the same field; Backspace on an empty search removes the last one.
- Results are grouped by `groupForwardCandidates`: Recent (top five by sidebar `lastActivityAt`), then Channels, People, Bots. Rows carry an avatar, presence dot (`presenceStatus`), name, a subtitle (email or company when known), a type tag, and a check mark when picked. Hover or arrow keys move the highlight; `aria-activedescendant` tracks it.
- Multi-select: `selectedIds` holds many destinations. Sending runs them in order through the same `onsend`; a prompt (cross-company ack, file access) or an error stops the run at that destination, delivered ones leave the selection, and confirming or retrying resends only what is outstanding. `ondone` receives the delivered names joined by ", ".
- Keys: Enter in the search adds the highlighted row; Enter elsewhere or ⌘/Ctrl+Enter sends; Shift+Enter in the note inserts a newline; Escape closes the scope menu first, then the dialog.
- Footer: a quiet key hint on the left, Cancel and a filled primary Forward ("Forward to N" for several) on the right, 13 px UI type with 11 px secondary and 10 px uppercase section labels.

Avatar note: the shared Avatar component is landing separately (hq-desktop-app PR 1444 on release/console-rail-beta). The picker uses the existing `IdentityMark` on main; swap to the shared component once it is on main.
