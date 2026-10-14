# US-010 design: file access confirmation, channel and cross-company notices, error recovery (desktop)

Story: hq-dm-forward US-010. Branch `feat/dm-forward`. Builds on US-009 (commits 12c016eae, 21f460859, 375677e6a), which already ships the picker (`packages/ui/src/chat/messaging/ForwardPicker.svelte`), the model (`forward-model.ts`), and the transport (`adapter.messaging.forwardMessage` through `hq_pro_fetch`). No new Rust command, no new Tauri struct, and no new screen: every change lives inside the existing picker card.

## Server contract (verified)

From handoffs US-004-backend.json and US-005-backend.json and the US-009 design:

- `FORWARD_FILE_ACCESS_REQUIRED` 409, body `files: [{id,name}]` (shareable files the recipient cannot open) and `notShareable: [{id,name}]`. Only same-company DM forwards return it. The task brief's code list omits this code; the server handoff is authoritative and the model already parses it.
- `FORWARD_FILE_GRANT_FAILED` 502, body `file: {id,name}`.
- `FORWARD_FILE_SHARE_FORBIDDEN` 403, `FORWARD_FILES_NOT_ALLOWED` 400, `INVALID_FILE_ACCESS` 400.
- `CROSS_COMPANY_ACK_REQUIRED` 409, body `sourceCompany {uid,name}`, `destinationCompany {uid,name} | null`. `CROSS_COMPANY_FORBIDDEN` 403.
- Request fields: `fileAccess: "grant" | "omit"`, `acknowledgeCrossCompany: true`.
- Channel forwards never carry files (`omittedAttachmentFiles[].reason = "channel"`). The server does not refuse them; it drops the files and reports `omittedAttachments`.

## Decision 1: the source knows its file count

Add `attachmentCount: number` and `attachmentNames: string[]` to `ForwardSource`, filled in `forwardSourceFrom` from `msg.attachments`, coerced with `Array.isArray` at that boundary (policy indigo-coerce-api-array-fields-at-parse-boundary). Names fall back to `"Untitled file"`. This drives the pre-send notices (AC2, AC3) without a server round trip.

## Decision 2: pre-send notices are derived state, not prompts

In `forward-model.ts` add:

```ts
export type ForwardNotice =
  | { kind: "channel-files"; text: string }      // AC2
  | { kind: "cross-company"; text: string; from: string; to: string }; // AC3

export function forwardNotices(args: {
  source: ForwardSource;
  destination: ForwardCandidate | null;
  sourceCompanyName: string | null;
  destinationCompanyName: string | null;
}): ForwardNotice[];
```

- `channel-files`: destination kind is `channel` or `group` and `attachmentCount > 0`. Text: `Files are not included in forwards to channels. {n} file(s) will be left out.`
- `cross-company`: destination `companyUid` is set, the source `companyUid` is set, and they differ. Text: `This sends the message from {from} to {to}. Files are not included.` When `attachmentCount` is 0 the second sentence still shows; it is cheap and keeps the wording fixed for tests.

The picker renders these in a `role="status"` block (`data-testid="forward-notice-channel"` / `forward-notice-cross-company`) above the action row, using the existing `.forward-prompt` styling. No left accent bar, existing tokens only.

## Decision 3: cross-company confirmation is one gate, client or server first

When a `cross-company` notice is active, the primary button label becomes `Confirm and forward` and an explicit confirm checkbox is not used. Pressing it is the confirmation and sends `acknowledgeCrossCompany: true`. The first press without the notice active never sets the flag. If the server still answers `CROSS_COMPANY_ACK_REQUIRED` (the client could not tell, for example a company-less source row), the existing `pending.kind = "ack"` prompt shows with the server's company names, and only its confirm button resends with the flag (current behavior, keep). The prompt text changes to `This sends the message from {source} to {destination}. Files are not included.` so both paths say the same thing. `destinationCompany: null` renders as `another company`.

Invariant to test: no request carries `acknowledgeCrossCompany` unless the user pressed a button whose label names the confirmation.

## Decision 4: file access prompt (AC0, AC1, AC4)

Replace the `files` prompt body with:

- Heading text: `This shares {n} file(s) with {name}` where n = `result.files.length`, `file` when n is 1, `files` otherwise. Exact literal: `This shares 1 file with Ana` / `This shares 2 files with Ana`.
- A list (`data-testid="forward-files-list"`) of `files[].name` (fallback `Untitled file`).
- When `notShareable` is non-empty, a second list (`data-testid="forward-files-not-included"`) headed `Not included` with those names and no action per item.
- Two buttons: `Share and send` (`forward-files-grant`, sends `fileAccess: "grant"`) and `Send without files` (`forward-files-omit`, sends `fileAccess: "omit"`). Cancel stays.

If `files` is empty and only `notShareable` is non-empty (all files blocked), show only `Send without files` plus the not-included list.

## Decision 5: errors carry a typed next action (AC5)

Change `forwardErrorMessage` to return `{ text: string; action: "retry" | "pick" | "omit" | "close" }` (rename to `forwardErrorView`; keep `forwardErrorMessage` as `forwardErrorView(...).text` for callers that only need text). Mapping:

| Code | Action |
|---|---|
| NETWORK, UNKNOWN, FORWARD_FILE_GRANT_FAILED, INVALID_FILE_ACCESS, INVALID_FORWARD_OF | retry (GRANT_FAILED text also offers send without files; render both `Try again` and `Send without files`) |
| CROSS_COMPANY_FORBIDDEN, FORWARD_NOT_CONNECTED | pick (button `Pick another destination` clears selection and focuses search) |
| FORWARD_FILES_NOT_ALLOWED, FORWARD_FILE_SHARE_FORBIDDEN | omit (button `Send without files`) |
| FORWARD_SOURCE_NOT_FOUND, FORWARD_NOT_SCHEDULABLE, *_TOO_LARGE | close (button `Close`) |

`INVALID_FORWARD_OF` and `INVALID_FILE_ACCESS` get their own plain sentences instead of the generic default. The rendered error never includes `status`, the server `error` field, or JSON; a test asserts the error node text contains no `{`, no digits-then-space status pattern like `409 `, and no code string.

## Decision 6: failure keeps state (AC6)

Already true in US-009 (`errorText` set, `onclose` only on success). Lock it with a test: after a failing send, `forward-picker` is still in the DOM, the selected option keeps `aria-selected="true"`, and `forward-note` keeps its value. Retrying via the action button reuses the same request including any `fileAccess` and ack already chosen.

## Files to change (frontend phase)

- `packages/ui/src/chat/messaging/forward-model.ts`: `ForwardSource` fields, `forwardSourceFrom`, `forwardNotices`, `forwardErrorView`, `filesPromptTitle(n, name)`.
- `packages/ui/src/chat/messaging/ForwardPicker.svelte`: notices block, button label swap, files prompt, error action buttons.
- Tests: `forward-model.test.ts` (notices, titles, error view table, coercion), `ForwardPicker.svelte.test.ts` (AC0-AC6 DOM flows with a fake `onsend` that records requests).
- No Rust change: `attachments` already reach the webview on `ThreadMessage` and `ChannelMessage`; `omittedAttachments` pass-through landed in US-008.

## Acceptance criteria mapping

0. Decision 4 heading, list and two actions.
1. Decision 4 buttons send `grant` / `omit`; test inspects recorded requests.
2. Decision 2 `channel-files` notice shown before any send.
3. Decision 2 `cross-company` notice plus Decision 3 gate.
4. Decision 4 `Not included` list with no per-item action.
5. Decision 5 table and no-raw-text test.
6. Decision 6.
