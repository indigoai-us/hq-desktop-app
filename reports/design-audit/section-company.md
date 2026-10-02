# Design audit: company pane (console rail)

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
