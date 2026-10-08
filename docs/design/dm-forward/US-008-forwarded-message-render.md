# US-008: Rendering forwarded messages (architect design)

Status: design for implementation. Branch `feat/dm-forward`. Server contract source:
hq-pro-core `feat/dm-forward` (US-003, US-004, US-005 handoffs; references.md AC5/AC6).

## Server fields this story reads

All are optional and absent-safe. Rows without them render exactly as before.

| Field | Shape | Source |
|---|---|---|
| `forwardedFrom` | `{ senderUid: string; senderName: string; sourceKind: "dm" \| "group" \| "channel"; originalCreatedAt: string }` | Stored row, every AC6 read shape |
| `forwardNote` | `string`, absent when empty | US-003 handoff: the forwarder's own text |
| `omittedAttachments` | `number` | US-005 handoff: send response. Treat as optional on read rows too; show nothing when absent or 0 |

On a forwarded row, `body`, `details`, `prompt`, `richContent` and `attachments` are the
copied source content. `forwardNote` is the sender's own note. Do not read any other
`forward*` field; none is defined.

## Parse boundary (one place)

Add to `packages/ui/src/chat/messaging/channelMessageModels.ts`:

```ts
export interface ForwardedFromModel {
  senderUid: string;
  senderName: string;
  sourceKind: "dm" | "group" | "channel";
  originalCreatedAt: string;
}
/** null unless raw.forwardedFrom is an object with a non-empty senderName. */
export function parseForwardedFrom(raw: unknown): ForwardedFromModel | null;
/** Non-negative integer, else 0. */
export function parseOmittedAttachments(raw: unknown): number;
export function omittedAttachmentsLabel(n: number): string | null; // "1 file not included" / "3 files not included"; null for 0
```

Wire types: add `forwardedFrom?: unknown; forwardNote?: string | null; omittedAttachments?: number | null`
to `ConversationMessageWire` (chat-api.ts), `ChannelMessage` (channels.ts), and the thread
message type ReplyPanel uses. In `live-messages.ts` row mapping (~line 379), pass the three
fields through (`forwardedFrom: row.forwardedFrom`, `forwardNote: asString(row.forwardNote) || null`,
`omittedAttachments: row.omittedAttachments`). Attachments keep going through the existing
`parseWireAttachments` / `parseMessageAttachments` array coercion.

Rust check required by the implementer: confirm the Tauri commands that feed the channel,
DM and thread views return `serde_json::Value` (pass-through) and not a typed struct. If any
path is a typed struct, the fields are dropped silently (policy
indigo-desktop-serde-wire-passthrough-contract-test). Rust edits are out of scope for this
run; report a blocker if a typed struct is found.

## Component

New `packages/ui/src/chat/messaging/ForwardedBlock.svelte`. Props:

```ts
{ forwardedFrom: ForwardedFromModel; omittedAttachments: number; children: Snippet }
```

Renders:

1. Header line, fixed text: `Forwarded from {senderName}` (text interpolation, never `{@html}`).
   Muted tone with existing tokens (`--text-secondary`/muted size used by the author row).
   Original time optional as a `title` attribute from `originalCreatedAt`.
2. `children` — the forwarded body, artifact cards, attachments, rendered by the caller with the
   existing pieces (body markup, `RichMessageContent`, `ArtifactCard` for details and prompt,
   `MessageAttachments`).
3. When `omittedAttachmentsLabel(n)` is non-null, a plain-text line `{n} file(s) not included`.

Styling: no `border-left`, no accent bar, no card container. Separation by spacing and an
existing subtle background or full border token only. Add a test that asserts the block's
computed/inline class set has no left-border rule (grep the component style for `border-left`).

## Message row composition

In each of the three render sites — `ChannelConversation.svelte` (~2022-2081, the `dm-bubble`,
used by both the 1:1 DM view and the channel view) and `ReplyPanel.svelte` root (~989-1025)
and reply (~1149-1170) rows:

```
const fwd = parseForwardedFrom(msg.forwardedFrom)
if fwd:
  if msg.forwardNote?.trim(): render note with the same body pipeline (sender's own text)
  <ForwardedBlock forwardedFrom={fwd} omittedAttachments={parseOmittedAttachments(msg.omittedAttachments)}>
     existing body + rich + ArtifactCard(details) + ArtifactCard(prompt) + MessageAttachments
  </ForwardedBlock>
else:
  existing markup unchanged
```

To avoid three copies, extract the existing inner content (body, rich, two ArtifactCards,
MessageAttachments) into a snippet per file and call it from both branches. The non-forwarded
branch must produce identical DOM.

The header comes only from `parseForwardedFrom`. Body text that begins with "Forwarded from"
goes down the normal path and renders as text.

`messageHasVisibleContent` should count `forwardNote` so a forward with only attachments is
still shown.

ArtifactCard is called with the row's own `eventId`, so the side pane opens with the full
forwarded text through the existing `onopenartifact` path. No artifact-model.ts change is needed.

## Tests (packages/ui, vitest)

New `src/chat/messaging/ForwardedBlock.test.ts` and `channelMessageModels.forward.test.ts`:

- AC0: header text in ChannelConversation (DM and channel) and ReplyPanel with a forwardedFrom row.
- AC1: body "Forwarded from Mallory" with no forwardedFrom renders no header element
  (query by a `data-testid="forwarded-header"`); malformed forwardedFrom (string, missing senderName) → null.
- AC2: note renders before the block; without note, only the block.
- AC3: details/prompt render ArtifactCard inside the block; clicking calls onopenartifact with full text.
- AC4: attachments render through MessageAttachments inside the block.
- AC5: omittedAttachments 1 → "1 file not included", 3 → "3 files not included", 0/absent/"x" → nothing.
- AC6: ForwardedBlock style has no border-left; only var(--…) colors.
- AC7: existing ChannelConversation.*.test.ts suites pass unchanged, plus one test that a row
  without forwardedFrom has no forwarded block.

Each test must fail when its rule is removed (QA check).
