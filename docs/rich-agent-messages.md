# Rich structured agent messages (stats, tables, charts) + GenUI design

Fleet-agent replies in HQ DMs and channels default to **terse plain text**
(Style D — answer first, ~2 lines). But a genuinely data-heavy answer reads far
better as structure. Because HQ owns the desktop chat surface, an agent can emit
that structure as **data** and a **trusted client component** renders it — the
agent never authors markup or script.

This document is the contract + the security design the owner must sign off on
before any arbitrary-markup GenUI is enabled.

## What renders today (before this change)

Message bodies already render through a hand-written, CSP-safe Markdown renderer
(`packages/ui/src/common/markdown.ts` + `messageMarkdown.ts`): headings,
**bold**/_italic_, links (validated `http(s)`/`mailto` only), inline + fenced
code, task lists, blockquotes, and **GFM tables**. Raw source HTML is never
passed through; inline images degrade to alt text; `javascript:`/`data:` hrefs
are rejected. So **bullets and tables written as Markdown already work** in the
desktop chat — GOAL A's Markdown piece was essentially free.

What did *not* exist: a way for an agent to emit **stat tiles, data tables, and
charts as structured data** that a trusted component renders (rather than as
Markdown text the model has to hand-format).

### The `systemEvent` v1 envelope (separate contract)

`hq-block` fences are agent-authored content. Server-authored channel events
use the `systemEvent` v1 envelope, parsed in
`packages/ui/src/chat/messaging/channelMessageModels.ts`. `KnownSystemEventType`
is: `run_started`, `run_progress`, `run_complete`, `pr_opened`, `deploy`,
`file_added`, `work_session`, `work_session_blocked`,
`work_session_task_status`, `work_session_finished`, `member_added`,
`lifecycle_card`. Unknown types are dropped, not rendered.

`lifecycle_card` (0.10.194) carries a `kind` from `LIFECYCLE_CARD_KINDS`
(`create_company`, `activate_cloud`, `upgrade_plan`, `create_agent`, `status`,
`companies_summary`, `tab_row`) and renders through
`messaging/LifecycleCard.svelte`; an unknown envelope version parses to `null`
rather than rendering. Actions are submitted by
`card-action.ts::submitLifecycleCardAction` → the desktop `run_card_action`
command. Non-card system events render as a one-line
`messaging/SystemEventLine.svelte`. Cards are server-stamped only — the
client never mints a `lifecycle_card` through `POST /messages`.

## GOAL A — the structured-content contract (shipped, safe)

### Wire shape

Rich content is **additive** to a message. Every rich message MUST still carry a
human-readable `body` — the **plain-text fallback**. Old clients, notifications,
and non-desktop surfaces ignore the structured field and show `body`.

Two ways to carry the structured content, both parsed into the same model by
`packages/ui/src/chat/messaging/richMessageContent.ts`:

1. **Explicit wire field** `ConversationMessageWire.richContent` — a versioned
   envelope the server passes through unchanged (see the hq-pro PR). Preferred
   when the server supports it.
2. **`hq-block` fenced block inside `body`** — an agent emits prose PLUS a
   fenced block; the client lifts it out and shows the surrounding prose as the
   fallback. **Works with zero server changes** (body already passes through),
   which is why it is the mechanism an on-box agent can reliably produce today.

Envelope:

```json
{
  "v": 1,
  "blocks": [
    { "kind": "stat", "items": [
      { "label": "MRR", "value": "$42.1k", "delta": "+12% MoM", "trend": "up" }
    ]},
    { "kind": "table",
      "columns": ["Repo", "Open PRs", "Deploys (7d)"],
      "rows": [["hq-pro", "12", "3"], ["hq-desktop-app", "7", "5"]],
      "align": ["left", "right", "right"] },
    { "kind": "chart", "chartType": "line",
      "series": [{ "name": "Signups", "data": [12, 19, 14, 23, 28] }],
      "categories": ["Mon", "Tue", "Wed", "Thu", "Fri"] },
    { "kind": "markdown", "text": "Prose that interleaves between blocks." }
  ]
}
```

Block types: `stat` (label/value/delta/trend tiles), `table` (columns + rows +
per-column align), `chart` (`line`|`bar`, one or more numeric series, optional
categories), and `markdown` (routed through the same CSP-safe renderer).

### How an agent emits a block (`hq-block` fence)

The agent writes its normal terse answer, then appends a fenced block:

    Weekly read: signups up, one flow needs attention.

    ```hq-block
    {"v":1,"blocks":[{"kind":"stat","items":[{"label":"Signups","value":"1,204","delta":"+8%","trend":"up"}]}]}
    ```

The desktop lifts the fence into a rendered stat tile and shows the prose line as
the bubble text. On any client without support, the whole thing degrades to
Markdown (the JSON shows inside a code block — ugly but safe).

> Note on the on-box watcher: `inbox-watcher-cli.ts`'s `clean_reply` de-fences a
> reply **only when a fence wraps the entire message**. So the agent must emit
> **prose + a fenced block**, never a bare whole-message fence (which would be
> de-fenced to literal JSON text). This is captured in the agent reply-style
> guidance (hq-pro `channel-writing-formats.ts`).

### Security model (why this is safe to ship)

- Blocks carry **data, never markup**. `stat`/`table`/`chart` values are plain
  strings and numbers.
- The Svelte renderer (`RichMessageContent.svelte`) binds every value through
  **text interpolation (auto-escaped)** or **numeric SVG attributes**. There is
  **no `{@html}` path** for agent-supplied stat/table/chart data. A payload like
  `<img src=x onerror=alert(1)>` renders as the literal text `<img …>`; no
  element is created. (Covered by tests.)
- The parser sanitizes and **caps** everything (max blocks/rows/series/points,
  string length, control-char stripping) so an oversized/hostile payload cannot
  freeze the render loop.
- The one `markdown` block is routed through the existing CSP-safe
  `renderMarkdown`, i.e. the exact trust level every message body already has.
- Charts are drawn with **inline SVG we author** — no external chart library.

### Design system

Rendered in the desktop-alt system: 13px body, hairline borders (`--line`),
muted uppercase labels (`--t2`/`--t3`), a single violet accent (`--vio-ink`),
tabular-nums for figures. Inherits light + dark from the `.chat-shell` token
ramp. Normal text messages are unchanged.

## GOAL B — GenUI (DESIGN ONLY, behind a disabled flag)

The owner wants agents to be able to send richer **generative UI** — beyond the
fixed stat/table/chart/markdown vocabulary. Because an agent's output is only
**semi-trusted** (its text can be steered by inputs it reads), arbitrary
agent-authored HTML/JS is a real security surface and is **NOT shipped here**.

### Status in this PR

- A `genui` block **kind is reserved** in the schema, and the parser **drops it**
  whenever `GENUI_ENABLED` is `false` (its value in this PR). A test asserts the
  flag is off and that a `genui` payload never renders any markup.
- Nothing agent-authored is rendered as markup anywhere.

### Proposed sandbox (needs owner security sign-off before enabling)

Two candidate designs, in order of preference:

1. **Constrained component schema (recommended).** Extend the *data-not-markup*
   model with more allow-listed, trusted-rendered components (e.g. `progress`,
   `timeline`, `keyValue`, `badge`, `callout`). The agent still emits only data;
   HQ owns every pixel. No sandbox needed because no agent markup ever executes.
   Lowest risk; highest control; least expressive.

2. **Sandboxed iframe for true arbitrary markup.** If free-form agent HTML is
   genuinely required, render it inside a `sandbox` iframe with **no**
   `allow-scripts` `allow-same-origin` combination, a strict `Content-Security-
   Policy` (`default-src 'none'`; no network, no inline event handlers), a fixed
   height, no access to the host DOM, tokens, or Tauri IPC, and a size/DOM-node
   budget. This still exposes phishing/clickjacking/visual-spoofing surfaces and
   must be gated per-company and per-agent-trust-tier.

### The exact decision the owner must make

> **Do we keep GenUI to an allow-listed, data-only component schema (option 1,
> no agent markup ever executes), or do we accept a sandboxed-iframe surface
> (option 2) that can render arbitrary agent-authored HTML under a strict CSP —
> and if so, under what per-company / per-agent-trust gating?**

`GENUI_ENABLED` stays `false` until that decision is signed off.

## Files

- `packages/ui/src/chat/messaging/richMessageContent.ts` — contract, parser,
  sanitizers, `hq-block` fence extraction, `GENUI_ENABLED` flag.
- `packages/ui/src/chat/messaging/RichMessageContent.svelte` — trusted renderer.
- `packages/ui/src/chat/chat-api.ts` — `richContent` wire field.
- Wired into `ChannelConversation.svelte` and `ReplyPanel.svelte`.
- Tests: `richMessageContent.test.ts` (parse/validate/sanitize/fallback/flag),
  `RichMessageContent.svelte.test.ts` (each block renders; no markup injection).
