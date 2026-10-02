# Design standard: console rail (derived from Messages)

> **Conflict rule.** Where this standard and the shipped Messages (Home) view disagree, the shipped Messages view wins. Subpages should look like Messages, not like a cleaner theory of Messages; measure the real components in `packages/ui/src/chat/` when in doubt.
>
> **Tokens.** Use `--type-title` (20px), `--type-title-weight` (500), `--type-title-line` (1.25) for the one page or task title, and `--type-ui` (13px), `--type-ui-line` (1.45), `--type-ui-weight` (400), `--type-ui-strong` (500) for everything else (`packages/ui/src/home/tokens.css`). The old `--type-metadata/secondary/body/section/detail` names are aliases onto these and should not be used in new code. Native `button, input, select, textarea` inherit the shell font.
>
> **Harness states.** The dev harness shell view takes `?state=empty|loading|error` (plus `?loadingMs=N`) alongside `?persona=` and `?theme=light|dark` to reach empty, skeleton and error paint (`apps/sync/dev-harness/state-flags.ts`).


Source of truth is the shipped Messages UI plus the pre-branch Settings page (`origin/main`, ef822f96).
Paths below are relative to `packages/ui/src/`. "SP" = `git show origin/main:packages/ui/src/settings/SettingsPage.svelte`.
Binding company rules override Messages where they conflict; deviations are marked **DEV**.

## 1. Fonts

| Token | Value | Source |
|---|---|---|
| `--font-ui` | "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif | chat/chat-tokens.css:39 |
| `--font-mono` | "Geist Mono", ui-monospace, Menlo, monospace | chat/chat-tokens.css:40 |
| Shell default | `font: 400 13px/1.45 var(--font-ui)`, antialiased/grayscale | chat/chat-tokens.css:8-9,42; messaging/ChannelConversation.svelte:2386 |
| Settings root | `font-family: var(--font-sans)` (= `--font-ui`) | SP:2898; messaging/messaging-tokens.css:46 |

Mono is used in Messages only for: keyboard chord hints (`.chat-scope-shortcut` 10px, ChatSidebar.svelte:4527), code blocks (12px/18px, ChannelConversation.svelte:2791-2793,2846), slash glyph in composer (2318), timestamps on hover (10px, 2748-2749), date separator (10px, 3072-3073), and sidebar section labels (10px uppercase, ChatSidebar.svelte:4612-4615). Rule for new surfaces: mono only for code, IDs/paths/hashes, and keyboard chords. Timestamps and section labels use sans (**DEV**: Messages section labels and date separator).

## 2. Type scale

Company rule: canvas uses 20px (page/task title) and 13px (everything else). Max weight 500.

| Role | Standard | Messages today | Source |
|---|---|---|---|
| Page / task title | 20px / 500 / 1.25 / 0 | Settings h2 = 13px/500/1.25 | SP:2984-2986 |
| Section label | 13px / 500 / `--t2`, sentence case, no tracking | 10px mono 600 uppercase +0.1em (**DEV**) | ChatSidebar.svelte:4612-4617 |
| Row title | 13px / 400 (500 when unread/emphasized) / 17px | 13px/400/17px | ChatSidebar.svelte:4938-4940 |
| Row meta | 13px / 400 / `--t3`, tabular-nums | 12px child rows, 10px times (**DEV**) | ChatSidebar.svelte:4809; ChannelConversation.svelte:2677 |
| Body | 13px / 400 / 1.45 | Message body 15px/1.7 (`--msg-body-font`) (**DEV**, timeline-only exception) | messaging/message-row.css:18-20 |
| Caption | 13px / 400 / `--t3` | 11-12px (`--text-micro` 11, `--text-sm` 12) (**DEV**) | messaging/messaging-tokens.css:36-39 |
| Author name | 13px / 500 | 14px / 600 (**DEV**) | ChannelConversation.svelte:2713-2716 |
| Profile name | 20px / 500 | 18px / 700 (**DEV**) | chat/MemberProfilePanel.svelte:212-213 |
| Agent detail name | 20px / 500 | 16px / 650 (**DEV**) | chat/AgentDetailPanel.svelte:751-752 |
| Sheet title | 13px / 500 | 15px / 600 (**DEV**) | chat/NewChannelSheet.svelte:196-197 |

Reference token sets that must NOT be used on the canvas (inflated): `--type-metadata 13 / --type-secondary 14 / --type-body 15 / --type-section 17 / --type-detail 24` (home/tokens.css:31-35; chat/tokens.css:23-27). `--text-lg: 15px` (messaging-tokens.css:39) likewise.

Weights shipped: Geist 400/500/600 (comment at ChannelConversation.svelte:2714). Messages uses 600 in ~20 places and 650/700 in panels; all are **DEV** against the 500 cap. Settings on main already obeys it (500 only: SP:2952,2960,2985,3079,3267).

## 3. Color tokens (chat-tokens.css, dark / light)

| Token | Dark | Light | Use | Source |
|---|---|---|---|---|
| `--t1` | rgba(255,255,255,.95) | rgba(0,0,0,.88) | primary text | :25 / :57 |
| `--t2` | rgba(255,255,255,.56) | rgba(0,0,0,.55) | secondary, idle rows, labels | :26 / :58 |
| `--t3` | rgba(255,255,255,.32) | rgba(0,0,0,.34) | tertiary, meta, placeholders | :27 / :59 |
| `--line` | rgba(255,255,255,.07) | rgba(0,0,0,.08) | hairline divider, pane edge | :23 / :55 |
| `--line2` | rgba(255,255,255,.11) | rgba(0,0,0,.12) | control/field border | :24 / :56 |
| `--panel-border` | rgba(255,255,255,.10) | rgba(0,0,0,.07) | popover/sheet border | :18 / :50 |
| `--hover` | rgba(255,255,255,.05) | rgba(0,0,0,.045) | row/control hover | :37 / :69 |
| `--sel` | rgba(255,255,255,.08) | rgba(0,0,0,.07) | selected row (bg only) | :38 / :70 |
| `--btn-bg` | rgba(255,255,255,.07) | rgba(0,0,0,.045) | field/secondary button fill | :15 / :47 |
| `--raised` | rgba(255,255,255,.05) | rgba(0,0,0,.035) | code block, grouped card | :14 / :46 |
| Semantic only | `--ok` #34c759, `--warn`, `--red` #f0616d | | state dots/text | :31-34; messaging-tokens.css:58 |

Accent: monochrome. **DEV**: `--accent: var(--vio-ink)` (messaging-tokens.css:48) and `--ice-ink` for links/thread replies (ChannelConversation.svelte:3107; ChatSidebar.svelte:4630). Do not carry violet/ice into the console rail; primary button = `--t1` fill on `--panel-bg` ink (NewChannelSheet.svelte:237).

## 4. Controls

| Control | Height | Padding | Radius | Border / fill | States | Source |
|---|---|---|---|---|---|---|
| Icon button | 24px (svg 14px, stroke 1.3) | 0 | 6px | none, transparent | hover `--hover`, `--t1` | ChatSidebar.svelte:4379-4380,4558,2812 |
| Icon button large | 28px | 0 | 8px | none | hover `--hover` | ChatSidebar.svelte:4536-4540 |
| Compact button | 26px | 0 10px | `--v4-radius-button` 6px | 1px `--v4-control-border` | | SP:3375-3382; home/tokens.css:51 |
| Row button | 30px | 0 12px | 6px | 1px control border | | SP:3341-3348 |
| Sheet button | auto (~28px) | 6px 10px | 6px | 1px `--panel-border`; primary = `--t1` fill | | NewChannelSheet.svelte:236-237 |
| Full-width panel action | 32px | | 8px | transparent border, 13px | | MemberProfilePanel.svelte:283-296 |
| Input / select | 28-30px | 0 8px | 6px (`--v4-radius-field`) | 1px `--line2`/`--panel-border` | | NewChannelSheet.svelte:208-210; SP:3194-3200 |
| Segmented control | track pad 2px, gap 2px | tab 4px 8px | track 6px / tab 4px | track 1px `--panel-border` on `--hover` | selected = bg `--hover`/active-row, `--t1` | NewChannelSheet.svelte:216-218 |
| Pill / chip | ~20px | 3px 7px | `--v4-radius-pill` 980px | none, text 13px | | SP:3329-3333; home/tokens.css:55 |
| Jump pill (floating) | | | 999px | `--panel-bg` + `--panel-shadow` | hover `--hover` | ChannelConversation.svelte:2570-2577 |
| Quick-react btn | 28px | 0 4px | 6px | none | | ChannelConversation.svelte:3204-3212 |

Status: a 6px dot (SP:3250-3251) plus 13px `--t2` text. No filled/bordered status pills.

## 5. Rows, panes, headers

| Element | Value | Source |
|---|---|---|
| Sidebar width | `--sidebar-width` 260px, pad 12px 14px, border-right 1px `--line` | ChatSidebar.svelte:4331-4352 |
| Sidebar row | 31px (7px + 17px + 7px), pad 7px 8px, radius 8px | ChatSidebar.svelte:4929-4940 |
| Sidebar child row | min 28px, pad 4px 8px, radius 4px, 16px icon column, gap 8px | ChatSidebar.svelte:4795-4810 |
| Section label pad | 12px 8px 4px | ChatSidebar.svelte:4610 |
| Header control row | 28px | ChatSidebar.svelte:4359 |
| Scope menu | 252px wide, 32px rows | ChatSidebar.svelte:4461,4479 |
| Settings index (nav) | 210px, pad 16px 20px; row pad 7px 10px, radius 8px, 13px | SP:2919-2937 |
| Settings row (card) | min 48px, pad 14px 16px, gap 12px, radius 10px, `--raised` | SP:3037-3046 |
| Message row | pad-y 3px, group gap 12px, avatar 32px col | messaging/message-row.css:26-27; ChannelConversation.svelte:2618 |
| Thread / reply pane | 36px avatar column | messaging/ReplyPanel.svelte:1551 |
| Detail/profile pane | header pad 12px 14px + border-bottom `--line`, title 13px; body pad 24px 20px; close 24px/6px | MemberProfilePanel.svelte:191-238 |
| Side panel (legacy conv) | 340px | ConversationView.svelte:693 |
| Sheet | header 52px, pad 0 10px 0 20px; form row pad 10px 20px, 120px label col; footer pad 12px 20px; radius 8px | NewChannelSheet.svelte:192-234 |
| Date separator | hairlines, margin 12px 8px, gap 12px | ChannelConversation.svelte:3061-3073 |

Selection: background `--sel` only, `box-shadow: none` (ChatSidebar.svelte:4955-4958, 4827-4830). Code blocks set `border-left: 0` (ChannelConversation.svelte:2787).

## 6. Empty state and skeleton

| Element | Value | Source |
|---|---|---|
| Empty | centered, pad 48px 16px, 13px `--t3`, no illustration | ChannelConversation.svelte:2542-2548 |
| Sidebar skeleton row | 36px, gap 10px; icon 20px r5; line 10px r4, fill `--line` | ChatSidebar.svelte:4567-4569 |
| Thread skeleton | avatar 32px circle; bars r6, `--t1` at 6% | ChannelConversation.svelte:2510-2521 |

## 7. Icons

SVG stroke only, 14px in 24px buttons, stroke-width 1.3 (ChatSidebar.svelte:2812,4558); 16px row icon column (4797). No emoji glyphs in chrome (emoji in user message content/reactions is fine).

## Do / Don't

| Do | Don't |
|---|---|
| Use 20px/500 for the page or task title, 13px for everything else | Use `--type-section` 17, `--type-detail` 24, `--text-lg` 15, or 16/18px panel names (inflated scale vs Messages; huge page titles) |
| Cap weight at 500; express hierarchy with `--t1/--t2/--t3`, spacing, `--line` hairlines | Use 600/650/700 (Messages author 600, profile 700, agent 650 are deviations, not precedent) |
| Section labels: 13px sans, `--t2`, sentence case | Tracked mono-caps headers (10px, 0.06-0.1em, uppercase) for columns or sections |
| Sans for all UI text; mono only for code, IDs/paths, keyboard chords | Mix mono timestamps/statuses into sans rows |
| Status as 6px dot + 13px `--t2` text; color only for semantic ok/warn/error | Heavy filled or bordered status pills; violet/ice accents for non-semantic emphasis |
| Buttons 26-30px, radius 6px, transparent or `--btn-bg`, 1px `--line2` only on secondary actions | Bordered full-height buttons, stacked bordered button groups |
| Fixed row heights: 31px nav rows, 28px child rows, 48px settings rows; line-height in px | Rows whose height depends on content or mixed font sizes (uneven row heights) |
| Selected row = `--sel` background, `--t1` text | Left accent bars, inset box-shadow markers, colored borders |
| Detail panes: 12px 14px header with `--line` bottom, 13px title, 24px close, 20px side padding | Bespoke pane chrome; detail panes must match Messages thread/profile pane rhythm |
| SVG stroke icons, 14px in 24px hit targets, stroke 1.3 | Emoji or filled glyph icons in chrome |
| Empty state: one 13px `--t3` line, centered | Illustrations, large headings, or CTA stacks in empty states |
