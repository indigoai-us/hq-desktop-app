# Console-rail design audit: defect catalog

Standard: `docs/design-standard-console-rail.md` (extracted from the Messages UI; company rules win where Messages deviates).
Harness: `pnpm --dir apps/sync dev:preview`, `?view=shell&persona=indigo|multi-company|empty-inbox`, Chromium 1280x800. Screenshots: `reports/design-audit/{company,personal,overlays}/`.

## Totals

| Area | Ugly | Inconsistent | Minor |
|---|---|---|---|
| Company pane | 11 | 15 | 5 |
| Personal pages + Meetings | 6 | 10 | 5 |
| Shell chrome, overlays, sheets, light mode | 5 | 15 | 7 |
| **Total (79)** | **22** | **40** | **17** |

## Cross-cutting defects (fix once, in the foundation lane)

1. Page titles render at 15/16/17/20/22/24px, weight 600-700. Standard: 20px / 500 for the one page title, 13px for everything else.
2. Tracked mono caps (10-11px, uppercase, 0.8-1px tracking, weight 600) used for section labels, column headers, popover headers, title-bar date, "PINNED", "ACCESS REQUEST". Standard: 13px sans, weight 500, `--t3`, no tracking.
3. Buttons, tabs and row names render at the browser default 13.333px because `font: inherit` is missing (Vault, Integrations, Secrets, Deployments, all personal pages).
4. Weights 600/700 everywhere. Cap at 500.
5. Status pills are bordered and coloured, 21-25px tall. Standard: 6px dot + 13px text.
6. Full-width or full-row-height bordered action buttons. Standard: 26-30px text buttons, 0 10-12px padding.
7. Row heights 36-75px with mixed one-to-three-line rows. Standard: 31px list rows, 28px child rows.
8. Detail panes do not follow the Messages profile pane rhythm (12px 14px header + hairline, 13px title, 24px close, 24px 20px body).
9. Sheets (New secret, Share, Connect app, Deploy access) open as a floating bottom-right card overlapping the detail pane.
10. Light mode is forced back to dark on boot by `packages/ui/src/settings/settings-theme-seam.ts`.
11. Emoji as UI icons in the sidebar filter popover; 2px left accent bar on connection-request previews.

## Top 10 ugliest screens

1. Personal Connections list + detail (`personal/connections-*.png`): double 17px/600 title, coloured bordered pills, ~112px bordered Disconnect buttons, 50-62px rows, mono caps headers, 15px/700 detail title.
2. Company Secrets (`company/secrets-*.png`): four stacked full-width buttons, 700 mono heading, New secret card overlaps detail with no visible Save.
3. Personal Telemetry (`personal/telemetry-*.png`): six 24px/600 mono stat numbers, mono caps labels, 11px mono mixed with 14px sans, 8px avatars.
4. Project task pane (`company/task-pane*.png`): ~24px/600 title, red P1 pill, bold mono ID, full-width To do/Done tabs.
5. Company Team (`company/team-*.png`): mono caps headers, 12px text, ~45px rows, member click opens nothing.
6. Project detail rail + KPIs (`company/project-*.png`): 19-22px/600 numbers, green underline accent, 75px three-line rows.
7. Personal Deployments (`personal/deployments-*.png`): mono caps headers, mono counts/times, 57-71px rows, 16px/600 title.
8. Library file preview (`personal/library-*detail*.png`): 24px/600 title, 15px body, duplicated action row clipped at right edge.
9. Company Vault / Deployments (`company/vault-*.png`, `company/deployments-*.png`): 15px tree labels, 700 headings, full-width solid "Grant access".
10. Sidebar + Create menu + Filter popover (`overlays/sidebar-*.png`, `overlays/create-*.png`, `overlays/filter-*.png`): empty list with "Connection requests" floating mid-panel, create menu drawn over the rail, emoji icons, mono caps headers.

## Broken clicks (all areas)

- Bots > bot > Open session: "This destination is no longer available."
- Bots > bot > Settings: blank canvas.
- Team > Add agent: routes to Messages #general; new-bot 3-step sheet never opens.
- Team member row click: opens nothing. "Invite a teammate": no sheet.
- Vault > Upload: no visible effect.
- Project detail Activity tab: Overview content stays.
- Atlas: CORS-blocked in preview, six empty circles (harness fixture gap, not necessarily a product bug).
- Meetings "Later today" row click: nothing.
- Connections "When bots act" > Never: no visible change.
- Personal pages: row click does not change the detail pane.
- Launch tooltip stays over the open Launch menu; Create menu anchored over the rail.
- Sidebar shows no conversation rows for persona=indigo.
- Personal pages ignore persona, so empty states could not be captured; no harness flag exists for shell skeleton/error states.


---

## Design audit: company pane (console rail)

Method: Playwright at 1280x800 against `localhost:1422/?view=shell&persona=…`, script `apps/sync/cr-audit-company.mjs`. Font sizes, weights, families, transforms, and button heights were measured with getComputedStyle. Screenshots are in `reports/design-audit/company/`.

Standard: 20px page title and 13px for all other text. Weight max 500. Mono only for code and paths. No tracked caps headers. Compact buttons (Messages header controls are 26–28px with 12px text). No accent bars. Colour only for semantic state.

Note: the Messages reference does not fully meet this standard either. It uses 12px row titles, 15px body text, a 15px/600 channel title, 14px/600 author names, and 10px mono caps for "TODAY" and "READ". Tokens: `--type-metadata: 13px`, `--type-secondary: 14px`, `--type-body: 15px`, `--type-section: 17px`, `--type-detail: 24px` (`packages/ui/src/home/tokens.css`). The ramp has no 20px step. The fixes below assume `--type-metadata` (13px) for canvas text and a single 20px page-title value.

## Shared (affects every company screen)

| area | page | state | violations | severity | files |
|---|---|---|---|---|---|
| Sidepane | all | default | Row labels are 14px/400, should be 13px. Section labels "PEOPLE / BRAIN / FILES AND CONNECT" are 10px/600 mono uppercase with 1px tracking; they should be 13px/500 sentence case. Counts are 11px mono, should be 13px tabular in sans. Company name is 14px/600, should be 13px/500. "Company settings" footer is 14px. | inconsistent | packages/ui/src/shell/CompanySidepane.svelte, packages/ui/src/shell/SidepaneList.svelte |
| Page headers | all | default | Four different title treatments: Team/Bots 15px/600 in a 48px bar; Atlas, Activity, Goals, Brain and FilesConnect 17px/600; Projects 20px/600 with -0.2px tracking; project detail 22px/600. Should be one 20px/500 header in one bar height and position. FilesConnect headers sit 20px lower than Team/Bots. | ugly | TeamPage.svelte, BotsPage.svelte, atlas/AtlasView.svelte, activity/ActivityView.svelte, goals/GoalsView.svelte, company/brain/BrainPage.svelte, company/files-connect/FilesConnectPage.svelte, projects/CompanyProjectsPage.svelte, projects/ProjectDetailView.svelte |
| Buttons | FilesConnect (Vault, Integrations, Secrets, Deployments) | default | Buttons and tabs render at 13.333px, the UA default, because `font: inherit` is missing. Row names are also 13.333px. Should be 13px. | inconsistent | company/files-connect/FilesConnectPage.svelte |

## Per screen

| area | page | state | violations | severity | files |
|---|---|---|---|---|---|
| Atlas | Atlas | default (indigo, acme) | "COMPANY" and "WORKING NOW" are 10px mono caps with 0.8px tracking. Chips are 11px. Title is 17px/600 and the H2 "Indigo" is 17px/600. The play glyph "▶" is 10px text and should be an icon. "Now" is 11px mono. The canvas shows 6 empty grey circles with 0 objects and no empty-state message. | ugly | atlas/AtlasView.svelte |
| Projects | Board | default | Card names are 14px/600, should be 13px/500. Counts are 11–12px. Avatars are 9px/600. "Board/List" toggle is 22h at 12px. Each card has a "Link goal" nudge button (24h), repeated 7 times. | inconsistent | projects/CompanyProjectsPage.svelte, projects/BoardCard.svelte, projects/StoryKanban.svelte |
| Projects | List | default | Column headers are 13px uppercase with 0.78px tracking ("PROJECT / GOAL / PROVENANCE"), which are tracked caps headers. Group count is also uppercase. "Link" buttons are 18h. | inconsistent | projects/ProjectListView.svelte, projects/ProjectRow.svelte |
| Projects | Board | empty (multi-company, Acme) | Empty column subtitles are 12px. The 86h "Create project" tile is OK. | minor | projects/CompanyProjectsPage.svelte |
| Projects | Peek | project card clicked | The card opens a peek with "Open project" and "Close" rather than navigating. Step rows are 29h. | minor | projects/ProjectsHome.svelte |
| Project | Overview/Tasks | open project | Title is 22px/600. KPI values are 19px/600 and the slash is 19px. KPI labels are 12px/500. Breadcrumb is 12px. The KPI strip has a green underline accent bar under "Stories". "Done 1" is green, which is acceptable as semantic. | ugly | projects/ProjectDetailView.svelte |
| Project | Task rail | open project | "4 TASKS", "NOT STARTED" and "IN PROGRESS" are uppercase headers. Task IDs "003" are mono bold. Rows are 75h and three lines tall; Messages rows are 31h. "Close" is a bordered button. | ugly | projects/ProjectDetailView.svelte |
| Project | Task pane | story open | Title is about 24px/600 and should be 20px. "US-002" is mono bold. The P1 pill is red, which is colour for priority rather than state. "To do / Done" is a full-width underline tab pair. Field values are about 15px. Rhythm does not match AgentDetailPanel. | ugly | home/StoryPanel.svelte, projects/StoryDetailPanel.svelte |
| Project | Files | tab | H2 "Files" is 17px/600. Root path is 11px mono, which is acceptable as a path but should be 13px. Text buttons are 12px. | inconsistent | projects/ProjectFilesBody.svelte, projects/ProjectFilesHost.svelte |
| Project | Activity | tab | Clicking the tab leaves the KPI and Overview content in place (see Broken clicks). | inconsistent | projects/ProjectDetailView.svelte |
| Activity | Activity | default | H1 is 17px/600. Values are 13px/500. Tabs are 25h. | minor | activity/ActivityView.svelte |
| Goals | Goals | default | Objective titles are 15px/500. Percentages and counts are 11–13px mono ("81%", "310 / 500"). The "KR" tag is 10px mono. Bullet "●" glyphs are rendered as mono text. KR titles are 14px. | inconsistent | goals/GoalsView.svelte, projects/CompanyGoalsPage.svelte |
| Team | Team | default | H1 is 15px/600. Table headers "MEMBER / ROLE / WORKING ON / JOINED" are 10px mono caps with 0.8px tracking. Section heads "HUMANS · 2" and "PENDING INVITES" use the same treatment. Tabs, chips, buttons and the "Working on" text are all 12px. Rows are about 45h; Messages rows are 31h. The "Joined" column shows an em dash for every row. | ugly | company/TeamPage.svelte |
| Team | Profile pane | row clicked | No profile pane opens (see Broken clicks). | ugly | company/TeamPage.svelte |
| Bots | Bots | list + detail | H1 is 15px/600. Tabs and chips are 12px, and the chip reads "1 bots". The list row is 43h with a "⌁" glyph avatar. The detail pane H2 is 15px/600 and labels are 12px/500 bold `<b>`. "SCHEDULED JOBS 0" is mono caps. There are five action buttons and "Message" is solid white. The detail pane does not match AgentDetailPanel. | inconsistent | company/BotsPage.svelte |
| Brain | Knowledge, Policies, Skills, Workers | default | H1 is 17px/600 and item H2 is 14px/600. "Skill" and "company" kind labels are 13px mono; they are metadata and should not be mono. Policy section heads "HARD / SOFT" are 10px mono caps. Item rows are 58–79h. | inconsistent | company/brain/BrainPage.svelte |
| Brain | Workers | New worker | The form opens inline in the detail pane. A second "Close" button is stacked with the first. Its H2 is 14px/600. | minor | company/brain/BrainPage.svelte |
| Vault | Vault | default | Tree labels are 15px/400 and should be 13px. Root path is 12px mono. The detail H2 "indigo" is 15px/700, above the 500 maximum. "Grant access" is a full-width solid white button. Access rows have "write" pills. The layout has three columns with no title row on the middle column. | ugly | company/files-connect/FilesConnectPage.svelte, files/CompanyFileTree.svelte |
| Vault | Upload | sheet | Clicking Upload produced no sheet and no visible change (see Broken clicks). | — | company/files-connect/FilesConnectPage.svelte |
| Vault | Share | sheet | Opens a floating card in the bottom-right with full-width buttons rather than a sheet. Styles match Deploy access. | inconsistent | company/files-connect/FilesConnectPage.svelte |
| Integrations | Integrations | default | Integration marks "SL/LN/GM" are 10px. Names are 13.333px. Detail H2 is 15px/700. "Manage" is a full-width button. | inconsistent | company/files-connect/FilesConnectPage.svelte |
| Integrations | Connect app | sheet | Rendered as the floating bottom-right card, not a sheet. "Open in browser" and "Close" are full-width buttons. | inconsistent | company/files-connect/FilesConnectPage.svelte |
| Secrets | Secrets | default | Secret names are 13.333px mono, which is acceptable as identifiers but should be 13px. Detail H2 is 15px/700 mono. "Rotate / Share / Bind / Bind to outpost" are four stacked full-width 28h bordered buttons. Selection uses a lighter row background (OK). Rows pack 6 columns of metadata with no headers. | ugly | company/files-connect/FilesConnectPage.svelte, company/SecretsPanel.svelte |
| Secrets | New secret | sheet | Opens as a floating card over the detail pane in the bottom-right and overlaps the pane. The single field has a full-width "Close" button and no Save action is visible. | ugly | company/files-connect/FilesConnectPage.svelte |
| Deployments | Deployments | default + Access | Detail H2 is 15px/700. URL is 13px mono (OK). "Open / Redeploy / Access" are full-width stacked buttons. The "Deploy access" card shows read/write as pill-shaped inputs inside the same floating card pattern. | ugly | company/files-connect/FilesConnectPage.svelte, company/DeploymentsPanel.svelte |
| Settings | Company settings | General | "PLAN" is 11px mono caps with 0.88px tracking. H2 is 17px/600. Field labels are 14px. The switch label is 13.333px. Nav rows are 29h (OK). | inconsistent | company/CompanySettingsPage.svelte |
| Projects | New project | sheet | Title is about 15px/600 and the meta "indigo · board" is 12px. Form labels are left-aligned in two columns. The Location radio cards hold a mono path, which is acceptable. "Create project" is disabled grey and looks identical to Cancel. The page behind is scrolled, so the Projects header is clipped at the top. | inconsistent | projects/NewProjectSheet.svelte |
| More companies | Popover | multi-company | "PINNED · 2 OF 6" and "ALL · 2" are 10px mono caps. Marks are 8px/600. The "unpin" button is 11px and 15h. | inconsistent | shell/ (company switcher popover; see CompanySidepane / DesktopApp) |
| Empty states | empty-inbox | — | The empty-inbox persona has no company in the rail ("Acme" only for multi-company, nothing for empty-inbox), so there is no company pane to audit. | minor | shell/DesktopApp.svelte |

## Broken clicks

1. Bots, then a bot, then **Open session**: navigates to a blank canvas showing "This destination is no longer available." with a 13.333px "Back" button. Source: `packages/ui/src/shell/DesktopApp.svelte` fallback route.
2. Bots, then a bot, then **Settings**: the entire canvas renders blank, with no sidepane and no content (screenshot `bots-settings-click.png`). This looks like a route or render failure; no pageerror was captured.
3. Team, then **Add agent**: switches to Home/Messages with `#general` open. The new-bot 3-step sheet does not open, so the 3-step flow could not be audited from the company pane.
4. Team, then a member row (Maya Chen, or a tbody row): nothing opens. There is no profile pane (MemberProfilePanel) from Team.
5. Sidepane **Invite a teammate**: lands on the Team page and no invite sheet opens. This is the same result as clicking Team.
6. Vault, then **Upload**: no visible sheet or picker.
7. Project detail **Activity** tab: content stays on the Overview KPIs and task rail.
8. Atlas: fetches `https://hq.computer/api/companies/cmp_indigo/atlas` and is blocked by CORS in preview. It falls back to "offline copy" with 0 objects. This is expected in preview but leaves Atlas visually empty.

---

## Design audit: Meetings + personal pages

Viewport 1280x800, persona indigo (empty-inbox and personal-only were also checked). Screenshots are in `reports/design-audit/personal/`. Script: `apps/sync/cr-audit-personal.mjs`.

Target values, taken from Messages: title 20px; all other canvas text 13px (`--type-metadata`); weight 500 or lower; rows `--v4-row-h` 28px; controls 28px icon-btn (`v4-icon-btn`); mono only for code and paths.

Caveat: Messages itself uses 10px tracked mono caps for day dividers and "PINNED", and 15px/600 for names. The reference does not fully meet this standard either.

| area | page | state | violations (should / measured) | severity | files |
|---|---|---|---|---|---|
| Meetings | Upcoming (rail) | default | Hero title "Weekly creative review at 11:00" 20px/600 is a second 20px title under a 14px/600 page title, so the hierarchy is inverted. Weight should be 500, measured 600. Mono 10px/ls1px uppercase "NEXT", "LATER TODAY", "TODAY · OCT 2" should be 13px sans. List time 11px mono and canvas time 12px mono should be 13px. List row titles are 14px, should be 13px. The "Later today" row is 32px, list rows are about 30px, should be 28px. The day header overlaps the Meetings tooltip. | inconsistent | packages/ui/src/meetings/MeetingsStatesBody.svelte, MeetingsPage.svelte |
| Meetings | Toolbar | calendar chip + paste | Calendar chip, paste and New meeting are 26px with a 1px border, should be 28px `v4-icon-btn`. The chip text "· 1 account" is 12px, should be 13px. The paste popover label "MEETING LINK" is tracked mono caps. "Join now" is shown as a disabled grey block next to an enabled Cancel. | minor | packages/ui/src/meetings/MeetingsToolbarControls.svelte, PasteLinkBox.svelte |
| Meetings | ?view=meetings (legacy window) | default | Bold sans uppercase headers "TODAY" and "SUN, OCT 4". Rows are 2-line, 46px. "Unassigned" selects are 28px and bordered. Uses a 12-hour clock where the rail page uses 24-hour. Has a different visual language from the rail page. | inconsistent | apps/sync/src/components/MeetingsWindow.svelte, packages/ui/src/meetings/PasteLinkBox.svelte |
| Meetings | empty | empty-inbox / personal-only | Same fixture as indigo, so no empty state is reachable from the persona switch and it could not be audited. | minor | packages/ui/src/meetings/MeetingsStatesBody.svelte |
| Library | My files | default | Page title "My files" is 13px/**700 MONO**, should be 20px/500 sans. Tree rows (`frow`) are 30-31px with hairlines, should be 28px with no row rules. Sidebar counts are 12px, should be 13px. | ugly | packages/ui/src/library/PersonalLibraryPage.svelte |
| Library | File detail pane | selected file | Preview H1 is 24px/600, should be 20px/500. Body is 15px and table cells 14px, should be 13px. Header is 13px/700. Actions are duplicated: Open/Copy path/Share, then "Open in Claude Code"/"Copy path"/another button, and the second row is clipped off the right edge. The pane does not follow the MemberProfilePanel rhythm. | ugly | packages/ui/src/files/FilePreviewPane.svelte, packages/ui/src/library/PersonalLibraryPage.svelte |
| Deployments | All | default | Title is 16px/600, should be 20px/500. Column headers APP/SCOPE/STATUS/ACCESS/30D/VISIT are tracked mono caps. The 30D counts are 13.3px mono and "3m ago" is 12px mono, both should be 13px sans. Rows (`drow`) are 57-71px (3-line), should be 28px single line. Body uses UA 13.33px instead of 13px. Scope uses the "IN"/"CE" text-avatar prefix. The "You" filter item is covered by the rail tooltip. | ugly | packages/ui/src/library/PersonalDeploymentsPage.svelte |
| Deployments | Detail pane | selected | "DEPLOYMENT" eyebrow is tracked mono caps. Title is 13px/700, should be 500. The URL is mono (acceptable as a path). Visit/Redeploy are 25px bordered, should be 28px. | inconsistent | packages/ui/src/library/PersonalDeploymentsPage.svelte |
| Telemetry | Overview | default | Title "My Telemetry" is 17px/600, should be 20px/500. Six stat numbers are **24px/600 MONO** with -0.24px tracking, should be 13px sans (or 20px at most). Chart and section labels ("TOKENS PER DAY…", SESSIONS, TOP SKILLS, BOTS ACTING…) are tracked mono caps. Table headers are 11px mono caps. Cells: when/length/tokens are 11px mono, company/project/outcome 14px, should be 13px. Rows (`srow`) are 36px, should be 28px. "2 LIVE" chip is 13px mono caps in green with a border. The 8px "IN/LR/CE" avatars are illegible. Very dense: about 5 blocks in one canvas. | ugly | packages/ui/src/telemetry/TelemetryView.svelte, packages/ui/src/shell/TelemetryRailHost.svelte |
| Telemetry | Sidebar | default | Range tabs are 25px, chips 23px bordered, Export CSV 29px; all should be 28px. "RANGE"/"SCOPE" are mono caps. | inconsistent | packages/ui/src/telemetry/TelemetryView.svelte |
| Telemetry | empty | empty-inbox / personal-only | Shows the same populated data (128, 4.2M…). No empty state. | minor | packages/ui/src/telemetry/TelemetryView.svelte |
| Secrets | List + detail | default | Title is 17px/600. Rows (`srow`) are 34-49px with mixed heights, should be 28px. Key names and ages are 13.3px mono (key names as code are acceptable; ages are not). The detail key is 15px/**700** mono. Chips "5 secrets" / "values never shown" are 25px bordered. | inconsistent | packages/ui/src/personal/PersonalRailPage.svelte |
| Connections | Connected list | default | Two "Connections" titles: sidebar 17px/600 and canvas 17px/600; the canvas title should be 20px/500 and the sidebar 13px. Status pills "Connected"/"Reconnect" are bordered, coloured, as wide as the column, and 21px tall, should be plain 13px text with colour only for the error state. The header pills "5 connected" / "1 needs attention" are 25px bordered and coloured. Disconnect buttons in every row are bordered, about 112px wide and about 28px tall, which reads as row height; should be a hover-only icon or text action. Column headers APP/STATUS/SCOPES/LAST USED are tracked mono caps. Rows (`srow`) are 50-62px, wrapping to 3 lines, should be 28px. Name and handle run together ("GitHub@coreyepstein"). The 9px "GH/GO/SL" monogram tiles are illegible. "Last used" mixes 13.3px mono with sans. | ugly | packages/ui/src/personal/PersonalRailPage.svelte |
| Connections | Detail pane | GitHub | Title is 15px/**700**, should be 13px/500 like the MemberProfilePanel name. Scopes, secret and MCP values are mono with a wide letter look. Reconnect/Disconnect are bordered 28px. The "When bots act" segmented control is 11px with bordered segments, should be 13px. Its placement is detached: right-aligned while the bot rows sit at 12px below it. The pane rhythm does not match MemberProfilePanel (no consistent label/value grid gap). | ugly | packages/ui/src/personal/PersonalRailPage.svelte, ref packages/ui/src/chat/MemberProfilePanel.svelte |
| Connections | Add connection sheet | open | Sheet docks bottom-right over the detail pane. Its two full-width buttons are stacked ("Open in browser" in white, "Close"). Title is 15px/600. The sheet has no app picker, only a browser hand-off. | inconsistent | packages/ui/src/personal/PersonalRailPage.svelte |
| Outpost | Overview | default | Closest to acceptable. Sidebar title "Outpost up" is 15px/600, and its "up" chip uses a 15px font in a 17px box. Job names are 13px/**700**, run names 12px/700, should be 500. Cadence, next-run and alerts are 12px mono, should be 13px sans. Column headers are tracked mono caps. Job rows are 2-line, about 66px. The "New job" button is a white filled pill in the filter tab row, so it is misplaced. Pause/Edit/Resume are text buttons (good). | inconsistent | packages/ui/src/outpost/OutpostPage.svelte |
| Account | Menu | open | Menu items are 14px, should be 13px. Otherwise fine. | minor | packages/ui/src/shell/ (rail account menu) |
| Account | Profile | default | Title is 15px/**700**, should be 20px/500. "IDENTITY" and "COMPANIES AND ROLES" are 10px mono caps with 1px tracking, as are the table headers. The Handle field nests an input inside an input (double border). Field rows are 40-60px with hairlines. Save is 25px. "Company settings" link is 12px underlined. | inconsistent | packages/ui/src/account/AccountPages.svelte |
| Account | Billing | default | Title is 15px/700. "Invoice history" is mono caps. Invoice dates and IDs are 12px mono, should be 13px sans. Manage payment is 25px. | inconsistent | packages/ui/src/account/AccountPages.svelte |
| Account | Settings | default | Title is 15px/700. Section labels are 10px mono caps. Shortcut keys are 11px mono (acceptable as keycaps, but should be 13px). Settings nav rows (`frow`) are 40px with 12px text, should be 28px/13px. | inconsistent | packages/ui/src/account/AccountPages.svelte |
| All personal | Global | all | `<button>` text renders at the UA 13.333px because font-size is not inherited, should be 13px. Rail tooltips overlap the sidebar content on every page. Personal pages ignore the persona, so no empty states are reachable. | minor | packages/ui/src/shell/ rail, all pages above |

No left accent bars were found on these pages; selection uses background only, as required. No emojis were found on these pages (Messages reactions only).

## Broken clicks
- Meetings: there is no "New meeting" `button.btn` in the canvas (only the toolbar icon-btn), and the list rows did not match any row or list selector.
- Meetings: clicking the "Later today" row opened nothing (0 dialogs, no detail change).
- Connections: row-level Disconnect/Reconnect are not reachable as `.srow button`; the disconnect confirmation could not be opened, so the confirm sheet was not audited.
- Connections: the "When bots act" segment (Never) click produced no visible change (text delta 0).
- Every personal page: clicking a row did not change the detail pane. The first row is pre-selected, so the detail screenshots are the same as the list screenshots.
- No page errors were logged during the run.

---

## Section: shell chrome and overlays

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

---

## Fix plan: 8 parallel lanes (disjoint files)

Every lane follows `docs/design-standard-console-rail.md`. Only lane 1 touches shared files. Lanes 2-8 may start once lane 1 lands the tokens, or in parallel using the token names from the standard.

1. **Foundation (owns all shared files).** `packages/ui/src/home/tokens.css`, `packages/ui/src/chat/chat-tokens.css`, `packages/ui/src/shell/DesktopApp.svelte`, `packages/ui/src/shell/lazy-doors.ts`, `packages/ui/src/shell/AppRail.svelte`, `packages/ui/src/settings/settings-theme-seam.ts`. Add the 20px title token, retire the 14/15/17/24 ramp for canvas use, global `button,input,select{font:inherit}`, rail tooltip layering, light-mode boot fix, harness persona/empty/skeleton flags in `apps/sync/dev-harness/`.
2. **Shell chrome and overlays.** `home/V4TitleBar.svelte`, `home/CorePopover.svelte`, `inbox/NotificationsPopover.svelte`, `shell/MoreCompaniesPopover.svelte`, `shell/AccountMenu.svelte`, `common/CommandPalette.svelte`, `chat/ChatSidebar.svelte`, `chat/CreateModal.svelte`, `chat/NewMessageSheet.svelte`, `chat/NewChannelSheet.svelte`, `chat/DmRequestsPanel.svelte`, `chat/messaging/ShareRequestCard.svelte`.
3. **Detail and profile panes.** `shell/profile-panes/BotProfilePane.svelte`, `chat/LocalBotDetailPanel.svelte`, `chat/MemberProfilePanel.svelte`, `chat/AgentDetailPanel.svelte`, `files/FilePreviewPane.svelte`, `home/StoryPanel.svelte`.
4. **Company people and overview.** `shell/CompanySidepane.svelte`, `shell/SidepaneList.svelte`, `company/TeamPage.svelte`, `company/BotsPage.svelte`, `company/CompanySettingsPage.svelte`, `company/brain/BrainPage.svelte`, `atlas/AtlasView.svelte`, `activity/ActivityView.svelte`, `goals/GoalsView.svelte`. Includes broken clicks for Bots and Team.
5. **Company data pages.** `company/SecretsPanel.svelte`, `company/DeploymentsPanel.svelte`, `company/files-connect/FilesConnectPage.svelte`, `files/CompanyFileTree.svelte`. Includes converting floating cards to sheets and the Upload click.
6. **Projects.** `projects/CompanyProjectsPage.svelte`, `projects/BoardCard.svelte`, `projects/StoryKanban.svelte`, `projects/ProjectListView.svelte`, `projects/ProjectRow.svelte`, `projects/ProjectsHome.svelte`, `projects/ProjectDetailView.svelte`, `projects/StoryDetailPanel.svelte`, `projects/ProjectFilesBody.svelte`, `projects/ProjectFilesHost.svelte`, `projects/NewProjectSheet.svelte`, `projects/CompanyGoalsPage.svelte`. Includes the Activity tab bug.
7. **Personal pages.** `personal/PersonalRailPage.svelte`, `telemetry/TelemetryView.svelte`, `shell/TelemetryRailHost.svelte`, `library/PersonalDeploymentsPage.svelte`, `library/PersonalLibraryPage.svelte`, `outpost/OutpostPage.svelte`, `account/AccountPages.svelte`. Includes row-click detail and "When bots act" control.
8. **Meetings.** `meetings/MeetingsPage.svelte`, `meetings/MeetingsStatesBody.svelte`, `meetings/MeetingsToolbarControls.svelte`, `meetings/PasteLinkBox.svelte`, `apps/sync/src/components/MeetingsWindow.svelte`.

All paths are under `packages/ui/src/` unless prefixed. Final verification must run on a local build with real data (harness fixtures alone are not sufficient).
