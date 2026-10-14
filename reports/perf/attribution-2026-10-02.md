# Initial JS attribution: feat/console-rail vs main (2026-10-02)

Method: the perf harness build (same Vite config as scripts/perf/harness-build.mjs) run with an extra Rollup plugin that walks static chunk imports from the entry and sums each module's rendered length inside the initial chunks. Rendered length is post-tree-shake, pre-minify, so per-module numbers are larger than their minified share; the totals are real minified bytes. "main" is the main checkout at the merge base f8ea7d03. The branch build includes other lanes' uncommitted work in the worktree at the time of measurement.

| Build | Initial JS (minified bytes) |
|---|---|
| main @ f8ea7d03 | 2,581,092 |
| feat/console-rail before this pass | 2,732,863 |
| feat/console-rail after this pass | 2,680,699 |

## Top 25 modules added or grown on the branch (rendered bytes)

| # | Module | Added bytes | New or grew | After this pass |
|---|---|---|---|---|
| 1 | `packages/ui/src/shell/DesktopApp.svelte` | 25,650 | grew | initial |
| 2 | `packages/ui/src/company/TeamPage.svelte` | 17,306 | new | initial |
| 3 | `packages/ui/src/company/BotsPage.svelte` | 13,984 | new | initial |
| 4 | `packages/ui/src/shell/profile-panes/BotProfilePane.svelte` | 13,196 | new | lazy |
| 5 | `packages/ui/src/shell/AppRail.svelte` | 12,240 | new | initial |
| 6 | `packages/ui/src/shell/profile-panes/BotSessionPane.svelte` | 10,819 | new | lazy |
| 7 | `packages/ui/src/projects/NewProjectSheet.svelte` | 10,097 | new | initial |
| 8 | `packages/ui/src/shell/profile-panes/EditBotSheet.svelte` | 9,994 | new | lazy |
| 9 | `packages/ui/src/shell/MoreCompaniesPopover.svelte` | 9,225 | new | lazy |
| 10 | `packages/ui/src/shell/profile-panes/UserProfilePane.svelte` | 8,522 | new | lazy |
| 11 | `packages/ui/src/agents/agent-stepper-model.ts` | 8,415 | new | lazy |
| 12 | `packages/ui/src/chat/ChatSidebar.svelte` | 8,051 | grew | initial |
| 13 | `packages/ui/src/chat/messaging/ShareRequestCard.svelte` | 8,046 | new | initial |
| 14 | `packages/ui/src/chat/NewChannelSheet.svelte` | 7,853 | new | lazy |
| 15 | `packages/ui/src/inbox/NotificationsPopover.svelte` | 7,797 | new | lazy |
| 16 | `packages/ui/src/chat/NewMessageSheet.svelte` | 7,533 | new | lazy |
| 17 | `packages/ui/src/company/team-telemetry.ts` | 7,475 | new | initial |
| 18 | `packages/ui/src/shell/CompanySidepane.svelte` | 6,159 | new | initial |
| 19 | `packages/ui/src/shell/AtlasLandingHost.svelte` | 5,992 | new | initial |
| 20 | `packages/ui/src/chat/PeoplePicker.svelte` | 5,541 | new | lazy |
| 21 | `packages/ui/src/shell/AccountMenu.svelte` | 5,392 | new | initial |
| 22 | `packages/ui/src/shell/SidepaneList.svelte` | 4,873 | new | initial |
| 23 | `packages/ui/src/shell/Sidepane.svelte` | 4,832 | new | initial |
| 24 | `packages/ui/src/projects/CompanyProjectsPage.svelte` | 4,349 | grew | initial |
| 25 | `packages/ui/src/shell/app-rail.ts` | 4,309 | new | initial |
