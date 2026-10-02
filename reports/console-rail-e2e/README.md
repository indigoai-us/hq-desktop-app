# Console rail end-to-end and accessibility pass (US-039)

Run on feat/console-rail, 2026-10-02, Apple M5 Max. The screenshots in this
folder come from the desktop preview harness (`apps/sync`, mocked Tauri,
indigo persona) at 1440x900, dark appearance. Each one was compared against
the pre-rendered storyboard frames in
`companies/indigo/projects/hq-desktop-console-rail/design/mockups/console-rail/`.

## How to run the checks

- Desktop path and keyboard checks: `pnpm --dir apps/sync exec playwright test e2e/browser/console-rail.spec.ts --project=chromium` (7 tests).
- Web host sign-in, rail, and Atlas landing: `pnpm --dir apps/work exec playwright test e2e/console-rail.test.ts --project=smoke` (2 tests).

The web host cannot show the project board, task pane, or Files tab. Those
need a company folder on the Mac, so they are covered by the desktop harness.

## Fixed in this story

| Problem | Fix |
|---|---|
| Four US-002 contract tests were still `it.todo` | Rail order, six-tile cap, the bell in the titlebar, and the avatar menu at the rail bottom now assert. |
| The company Projects row showed "Built in US-023" | The row now mounts the project board for that company. |
| Team > Add agent did nothing | It opens the six-step New agent sheet in the same company. |
| A partial company summary threw in the sidepane | Missing counts read as zero. |
| Local bot loaders threw on a null payload at start | They treat null as an empty list. |
| Account menu and More companies did not take focus | They focus the first item on open and return focus to the rail button on close. |
| Hidden legacy profile panels could take Tab focus | They are `inert` and `aria-hidden`. |
| Project section buttons did not say which one was open | The open section has `aria-current="page"`. |
| The deploy sheet button was just "Back" | It reads "Back to deploy". |
| Three shell tests still asserted placeholders | They assert the Outpost, Brain, and account hosts that replaced them. |

## Remaining gaps

| Screen | Gap compared with the storyboard | Owner or next step |
|---|---|---|
| All | The titlebar has a sidebar toggle and a Projects board icon that the storyboard does not show. | Owner decision: keep or remove. |
| All | The rail has no dividers between groups. The company tile shows initials, not a logomark circle. The You avatar has no live dot in the harness. | Polish lane (`shell/AppRail.svelte`). |
| 01 Home | The Companies and Pinned blocks are still in the Messages sidebar. The storyboard moves companies to the rail only. | Polish lane (`chat/ChatSidebar.svelte`). |
| 02 Atlas | The map shows skeleton circles with the harness graph, and the sidepane rows have no icons. | Polish lane (`shell/CompanySidepane.svelte`). |
| 03 Projects | The board repeats the company switcher under the sidepane header. Green marks Complete and progress bars, not just live work. | Polish lane (`projects/`, `board/`). |
| 04 Task pane | No "Now" live row. The pane starts below the filters instead of at full height. | Polish lane. |
| 05 Project Files | Tabs sit under a hero header instead of in the toolbar. The preview pane is blank until a file is picked. | Polish lane. |
| 06 Team | No avatars, live dots, seat chip, Joined column, or row menu. | Polish lane (`company/TeamPage.svelte`). |
| 07 New agent | The sheet opens as a modal over Messages instead of inline content, and the header shows twice. The + menu still opens the three-step wizard, because the cloud agent and bot-progress flows (8 tests) depend on it. | Owner decision: retire the wizard once the stepper covers cloud agents. |
| 08 Meetings | It is the full-width legacy page with Back, not the rail sidepane layout. | Follow-up story (Meetings sidepane host). |
| 09 More companies | No Recent section and no live counts. | Polish lane. |
| 10 Library | The sidepane is about 240 px, not 260. The tree is a flat list, and the preview actions overflow on the right. | Polish lane (`library/`). |
| 11 Account menu | No live chip with the avatar and no row icons. | Polish lane. |
| 12 Settings, 14 Telemetry | Two sidepanes stack: the Messages sidebar plus the page's own nav. | Shell fix in `DesktopApp.svelte`. It is held because another lane is editing that file. |
| 13 Vault | A flat folder list with no preview pane. | Polish lane. |
| Dead code | `company/CompanyPage.svelte` (the old Overview) is still on disk. Its three test files cover invite plan limits, the personal cloud board, and Office reachability, and the sync e2e harness still reads it. Deleting it means deleting passing tests. | Owner decision: port those tests to the Atlas and settings pages, then delete. |
| Dead code | The clipped legacy profile panels from US-019 remain, now inert. Avatar editing and Start bot tests still drive them. | Port those actions into the new profile panes, then delete. |

## Keyboard and screen reader

- Every rail button and company sidepane row has an accessible name and a visible focus ring under keyboard focus. The e2e test checks every visible control.
- Cmd+1 to Cmd+9 select rail items. The shell uses Ctrl on non-Mac user agents.
- Escape closes the account menu and More companies, and focus returns to the rail button. In the New agent sheet, the first Escape goes back one step and the second closes it.
- No rail animation runs under reduced motion.

## Pre-existing failures (not from this story)

- In `apps/work`, 7 smoke tests in `app-shell`, `auth`, `smoke`, `v2-display-guard`, and `phone-layout` expect the old loading skeleton and the "No conversations" state. Main replaced those with the first-run welcome channel on 2026-09-29 (e9f7cb22), before this branch. Main's web build also fails in this checkout (the known mqtt "https" resolve error), so these tests cannot run there.
- In `pnpm test:scripts`, `scripts/pre-push-tag-cooldown.test.ts` and `scripts/release-workflow.test.ts` fail the same way on main.
- The UI package has no ESLint config, so `pnpm lint` does nothing there. Decision: no config added in this story. svelte-check in `pnpm typecheck` is the gate.

## Performance

I ran `pnpm perf:rail -- --reps 3` after these commits. It matches the US-040 gate in `reports/perf/gate-2026-10-02.json`.

- Shell ready median: 141.8 ms.
- First contentful paint: 134.0 ms.
- Company switch p95: 36.3 ms.
- Sidepane switch p95: 41.2 ms.
- Conversation switch p95: 27.0 ms.
- Messages scroll: 0.53% dropped frames, worst frame 16.7 ms.
- Idle busy: 0 ms.
- Initial JS: 2,719,068 bytes against a limit of 2,736,155.
- Atlas and Telemetry are not in the initial JS (34.8 KB and 37.4 KB).

The command palette passes under the first-painted-frame definition. The gate run is `reports/perf/gate-2026-10-02-final.json` (p95 0.0 ms, budget 20 ms).
