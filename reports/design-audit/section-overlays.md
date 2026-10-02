# Section: shell chrome and overlays

Harness: http://localhost:1422/?view=shell&persona=indigo, 1280x800, Playwright (`apps/sync/cr-audit-overlays.mjs`, `cr-audit-light.mjs`, `cr-audit-create.mjs`, `cr-light2.mjs`). Screenshots: `reports/design-audit/overlays/`. Raw measurements: `overlays/results.json`, `results-light.json`.
Standard: text 13px (20px page title only), weight <= 500, mono only for code/paths, no tracked caps, compact uniform rows, no UI emoji, no accent bars, semantic-only colour. Tokens: `packages/ui/src/home/tokens.css` (`--hq-*`), `packages/ui/src/chat/messaging/messaging-tokens.css`.

| Area | Page | State | Violations (measured) | Severity | Component file(s) |
|---|---|---|---|---|---|
| Title bar | all | default | date `FRIDAY · OCT 2` 10px mono, tracked 0.8px caps; "HQ" weight 600; Launch/Core pills 12px; Core dot 7px | inconsistent | packages/ui/src/home/V4TitleBar.svelte |
| Title bar | all | Launch menu open | header `LAUNCH` 10px mono tracked 1px caps; path 10px mono; CC/CX/GB marks 10px mono weight 600; item labels 14px; subtitles 12px; trigger tooltip renders on top of the open menu and hides the path | ugly | packages/ui/src/home/V4TitleBar.svelte |
| Title bar | all | Notifications popover | title + empty-state weight 600; empty title 14px; tabs 12px; body 12px; "Notification settings" 11px | inconsistent | packages/ui/src/inbox/NotificationsPopover.svelte |
| Title bar | all | Core popover | status 11px; row labels 12px; pills `NO DRIFT`/`UP TO DATE`/`1 PACK INSTALLED` 10px mono tracked 0.4px caps; "Check" 11px; dot 9px; version mono is fine | inconsistent | packages/ui/src/home/CorePopover.svelte |
| Rail | all | default | company tile `IN` 12px w600; avatar `AL` 10px w600 | minor | packages/ui/src/shell/AppRail.svelte |
| Rail | all | More companies popover | section labels `PINNED · 1 OF 6`, `ALL · 1` 10px mono tracked caps; tile marks 8px w600 | inconsistent | packages/ui/src/shell/MoreCompaniesPopover.svelte |
| Rail | all | Account menu | menu items 14px (should be 13); email 12px; `COMPANIES` 10px mono tracked 1px caps w600; name w600 | inconsistent | packages/ui/src/shell/AccountMenu.svelte |
| Sidebar | Messages | default | `PINNED` label 10px mono tracked 1px caps w600 with leading glyph; "All" scope w600; rows uneven heights 22/26/28/29/31px; conversation list area empty, "Connection requests" row floats mid-panel (y=386) leaving a ~280px void above it | ugly | packages/ui/src/chat/ChatSidebar.svelte |
| Sidebar | Messages | scope menu (All) | "New company" 12px | minor | packages/ui/src/chat/ChatSidebar.svelte |
| Sidebar | Messages | + Create menu | popover anchored at x=8 and draws over the icon rail; "Create" header and items on different indents; items 12px; shortcuts 10px mono inline after label instead of right-aligned; footer "Scope follows the selected row · All" crowds the edge | ugly | packages/ui/src/chat/ChatSidebar.svelte |
| Sidebar | Messages | search / switcher | `#` glyph 14px; company 12px; avatars 8px w600 | inconsistent | packages/ui/src/chat/ChatSidebar.svelte |
| Sidebar | Messages | filter popover | `SORT BY`/`SHOW` 10px mono tracked 1px caps w600; emoji icons in chrome (🕐 Recent, 💬 DMs & groups, 🗄 Show archived) mixed with text glyphs (⌂ ≣ # ◎ ✓); icon spans 11-12px | ugly | packages/ui/src/chat/ChatSidebar.svelte |
| Sidebar | Messages | connection requests open | message previews use 2px left border bar (rgba(255,255,255,.11)) | inconsistent | packages/ui/src/chat/DmRequestsPanel.svelte |
| Command palette | all | Cmd+K | section titles `PEOPLE AND BOTS`/`CHANNELS`/`COMMANDS` 11px caps w600; row titles w600; rows 54px (not compact) | inconsistent | packages/ui/src/common/CommandPalette.svelte |
| Sheet | Messages | New message | title 15px w600; close ✕ 14px; labels 12px; section labels `PEOPLE`/`AGENTS` 11px tracked 0.44px caps; avatars 8px | inconsistent | packages/ui/src/chat/NewMessageSheet.svelte |
| Sheet | Messages | New channel | title 15px w600; labels/hints 12px; close ✕ 13.33px (UA default, unstyled); path mono 12px | inconsistent | packages/ui/src/chat/NewChannelSheet.svelte |
| Modal | Messages | New agent (Create) | title 14px w600; back/close glyphs 18px; step numbers 10px mono; step label w600; card title w600; "Ctrl+Enter TO CREATE" tracked mono caps; preview pill mono; 880px wide modal | inconsistent | packages/ui/src/chat/CreateModal.svelte |
| Card | Messages | Access request | `ACCESS REQUEST` + `READ` 10px mono tracked 1px/0.8px caps; "Approve read" uses tinted fill (colour not tied to state) | inconsistent | packages/ui/src/chat/messaging/ShareRequestCard.svelte |
| Messages | Messages | day divider | `TODAY` mono tracked 0.8px caps | minor | packages/ui/src/chat/messaging/ (day divider) |
| Pane | Messages | bot profile (click "setup") | `UID`, `NOW`, `RUNTIME`, `COMPANIES`, `BOT · 30D USAGE` mono tracked caps; name ~17px w600; value text 14px; "Message" primary is solid white button in dark mode; action buttons wrap to 2 rows | ugly | packages/ui/src/shell/profile-panes/BotProfilePane.svelte, packages/ui/src/chat/LocalBotDetailPanel.svelte |
| Header | Messages | default | "Edit profile" text link underlined, different from other header controls | minor | packages/ui/src/shell/DesktopApp.svelte |
| Personas | Messages | empty-inbox / personal-only / multi-company | same title bar/sidebar violations; personal-only adds 16px `·` glyph | minor | ChatSidebar.svelte, V4TitleBar.svelte |
| Light | Messages | forced light | readable; no white-on-light text; tracked caps persist | minor | tokens.css |
| Light | Meetings | forced light | `TODAY · OCT 2`/`TOMORROW`/`NEXT` mono tracked caps w600; times mono; "Prepare brief" white text on dark button (ok contrast) | inconsistent | packages/ui/src/meetings/* |
| Light | Library | forced light | weight 700 on "My files"/file titles; `COMPANIES`/`LOCAL` tracked caps; "My files" in mono; blockquote 3px left bar | inconsistent | packages/ui/src/files/* |
| Light | Secrets | forced light | column headers `NAME`/`SCOPE`/... mono tracked caps; `GITHUB_TOKEN` w700; title "Secrets" repeated in subnav and header; solid black primary buttons with hardcoded white text | inconsistent | packages/ui/src/secrets/* |
| Light | Home | forced light | same as Messages (Home = Messages view) | minor | - |
| Loading/error | - | - | no shell fixture flag for skeleton/error found (`dev-harness` has `view`, `theme`, `persona`, `tour`, `kind`, `step`, `beat`, `mode`; GlobalErrorPreview exists only as separate view) | n/a | apps/sync/dev-harness/Harness.svelte |

## Broken clicks / behaviour
- `?theme=light` (and `prefers-color-scheme: light`) is ignored by the shell: harness sets `data-force-theme`, then the app resets `<html data-force-theme="dark">` on boot (likely the persisted appearance via `packages/ui/src/settings/settings-theme-seam.ts`). Light was audited only by forcing the attribute with a MutationObserver.
- Launch button tooltip stays visible over the open Launch menu.
- + Create menu opens over the app rail rather than under the + button.
- Sidebar in persona=indigo shows no conversation rows in the main list; only "Connection requests" mid-panel and Pinned at bottom (check against the conversation-rail paint-cache-first rule).
- No page errors captured on any state. All aria-labelled controls tested (Back/Forward not exercised beyond render) opened their surfaces; New message / New channel / New agent menu items work when targeted as `role=menuitem`.

Counts: ugly 5, inconsistent 15, minor 7.
