# Changelog

What changed in the HQ desktop app, newest first.

Write your entry under `## [Unreleased]` in the same pull request as the
change, in plain language, describing what changes for the people who use it.
The release moves it under the version it ships in.

## [Unreleased]

This beta brings the new HQ interface. A rail on the left holds your companies, and each company opens into its own set of panes: Atlas, Projects, Goals, Activity, Team, Bots, Files and Settings. Home, Messages, Meetings and your personal pages sit at the top of the rail, so everything is in one window.
- Projects hides complete projects by default on the Board and in the List. A "Show N complete" button where the Complete column was brings them back, and Hide puts them away again; the choice is saved on this computer. Picking Complete in the state filter always shows them. The Projects title now sits on the same line as Activity, Team and Meetings instead of tight under the top bar.
- Project cards show more at a glance: the repos the project touches and its branch as small chips, a state dot in the column's color, "7 of 15 stories" next to the progress bar, the owner and other people on it, and when it was last updated. The description is one line. Active cards never show a raw id such as "prs_01KQ…"; they show the person's name, or "1 live session" when the name is not known.
- Knowledge, Policies, Skills and Workers now share one layout. The list on the left is as narrow as the sidebar and the document fills the rest of the window. Drag the line between them to resize the list; each page remembers its width on this computer. In a narrow window you see the list first, then the document with a Back button. Documents show a header with the title, path, Open and Copy path, and the frontmatter as small labels, then the formatted text instead of the raw file. Policy rows show hard or soft, where the policy applies (core, company or personal) and when it triggers. Skill rows show Scaffold and Blocked labels, runs once known, and the owning company. Worker rows show status, type, team, number of skills and model. Knowledge tree files show their titles, with a file count on each folder. Tags show as labels with small icons.
- The Atlas Today panel now groups what changed under its project, knowledge folder or repo. Each group shows its kind icon and name, and projects with a PRD show a story count such as "7 of 15 stories", a thin progress bar and the same state dot as the Projects board. Each file gets its own icon (PRD, brainstorm, policy, doc, meeting note, source file) and a readable title such as "Opportunity sizing", with its folder underneath, so a file called "references" now shows which project it belongs to. A group shows three files and its own "N more"; more groups open a few at a time.
- The Not on the map group on the Atlas map now draws everyone as the same small circle with one thin outline, including bots and the "+N" count. Only people and bots working right now get a thin green ring. The title reads "Not on the map" with a quiet count, and you can tab to each picture to see its name and whether it is a person or a bot.
- Selecting a row in Deployments, including clicking its name, no longer opens the site in your browser. The row is selected and its side panel updates. The site opens only from the Visit button in the side panel. The panel's page preview was being loaded in a way the app treated as a link click.
- Every page title now uses the same 20px title size; Marketplace, Settings and Notifications were smaller and heavier. The Meetings list title is now "Meetings" in the same size.
- Hovering a project on the Atlas map now always shows its name, even on a narrow map where the section names around it leave no free space. A section name the hovered name has to cover steps aside until you move the pointer away. Before, hovering a small, quiet project could show the names of its repos but not its own.
- Meetings opens with your list right away, using the last list it saved, and then updates it in the background. Before, the list could take about six seconds to appear. While Meetings is still loading for the first time, it no longer says "Nothing scheduled", "Nothing live" or "No calendar". The loading text is now just "Loading".
- Creating a local bot now uses the same screens as creating a cloud bot: one question at a time over the sunrise office. You enter a name, choose blank or a template, then pick the coding tool and sign in to it on the same screen. Title, avatar, who the bot is for and its permissions are under More options on the name screen, and the next screens show the bot's picture, name and coding tool under the title.
- There is now one way to create a bot. New bot from the "+" window and from Settings → Bots opens the same Cloud or Local question and the same step screens as everywhere else. A cloud bot for a company without its own cloud screen picks the company (when there is more than one), then its name, brain and size. The old wide New bot window with the preview card is gone; the bot's title and what a template brings now show on the step screens. The screens fit small windows and scroll when needed.
- Meetings shows all of today's meetings in one Today section, earlier ones first and in a quieter color. Tomorrow stays hidden until today's last meeting has ended, or when today has no meetings. A meeting's recap now shows its headings, numbered topics and Next Steps list instead of one long paragraph. Details counts the Next Steps as actions and is hidden when there is nothing to count. "No link" no longer appears next to the meeting time.
- Page titles now start on the same left edge as the items in the page's side list. On Marketplace and Settings the title used to sit about 76 pixels to the right of Browse, Installed and Submit. The Deployments title moved over 4 pixels to match the other pages.
- The Projects board's Active column now fills with work that is really happening. A project is Active when someone or a lane worked on it in the last 30 minutes, or its stories changed in the last day. Each Active card says why in one quiet line, such as "active · Corey, 4 min ago", "active · lane desktop-dev" or "stories updated 3h ago". Started projects with no recent activity stay in In progress.
- The Atlas inspector's Changed today and Related lists now show each item as a card: a small type icon instead of the grey type word, the name, a quiet line with how long ago it changed, and for projects with stories a thin progress bar with a count such as "12 / 20 stories". Projects without stories show no bar.
- Every button in the app now has the same height and padding as the Launch and Core buttons in the top bar. The white primary buttons, such as Open console, are no longer taller than the rest.
- The "Host unreachable" notice on the Outpost page now has even padding around its text and its Retry now button.
- The secret detail panel is cleaner: a quiet label above the name, the path on its own line, one row of buttons that never wraps (extra buttons move into a More menu when space runs out), facts in a two-column list where empty values are left out instead of showing a dash, and a Who can read section that lists each reader. The personal connection and app panels use the same layout.
- In Messages, when the list is set to All, company channels now sort into the same date sections as direct messages (Today, Yesterday, and so on), placed by their most recent message. The company groups from the last beta are gone. Each channel shows a small company name after its title, and channels with no messages yet sit in a section at the bottom. Pinned stays first, and muted and unread channels keep their state.
- Activity > Tokens now colors models by provider: warm shades for Anthropic models (Opus, Sonnet, Fable, Haiku), blue for OpenAI (GPT and Codex models together), indigo for Grok, and gray for anything unknown. Each name has a small provider logo in front of it. The daily chart, its legend, the Models table and the model mix under the totals use the same names, colors and order, so OpenAI models no longer show as "Codex" in green in one place and "OpenAI GPT" in blue in another. The totals read as one row of large numbers.
- Sessions on this Mac now shows each session's project, title and length. A session that was never named shows the first line its author wrote, skipping text that HQ, Claude Code or Codex add before it. Background sessions are marked "Agent" (for example the checkpoint helper) or "Lane" (work another session handed off), and "Hide agent sessions" leaves only your own. Sessions without a company say "No company", and the time no longer gets cut off.
- The robot "Show bot messages" button is gone from the Messages toolbar. The list now always works the default way, with bot-only messages kept out of previews, even for anyone who had turned the button on before.
- Hovering an object on the Atlas map now shows more: who is on it now with their pictures, a story progress bar, the repos it links to and counts of linked knowledge and policies, the folder for a file, and recent times such as "Touched 2 h ago". Each row appears only when there is data for it.
- People and bots on the Atlas map, in the Not on the map group, in Working now and in the hover card now show their profile picture or bot picture, the same one Messages uses. Anyone without a picture, or whose picture does not load, keeps their initials or the bot mark.
- Buttons in the separate windows (onboarding, sign-in, the quick window and the call window) now show a small icon before their label, like the rest of the app.
- With nothing selected, the Atlas inspector now opens with a Today at <company> section listing what changed on the map today, projects first, each one clickable to fly to it on the map, with Show more for long days. Working now follows it as before. On a quiet day it says so in one line.
- Pressing play under the Atlas map now plays the last 30 days forward in about 25 seconds. Items appear as of each day, the day shows in large quiet type on the map, and a short line names that day's biggest changes. Playback stops at today, and when you scrub or use the arrow keys.
- The Atlas map has more depth: a faint vignette and fine grain under the map, and a softer, wider glow behind items that are active. None of it moves, and labels stay as readable as before.
- Atlas now shows where work is happening. A project gives one soft pulse when a refresh shows it changed or when someone live on it moves off a task or finishes, and a project someone is working on right now draws faint drifting lines to the items it touched in the last two days. Nothing moves on a quiet map, and nothing moves when motion is reduced.
- Clicking a project on the Atlas map now glides to it and gathers its repos, knowledge and policies in a ring around it, with everything else pushed further back. Escape, a click on empty map, or another selection sends them back home. Picking a project from Find or from Related does the same.
- Project dots on the Atlas map now grow with recent activity (the project's own last change and the linked items changed in the last 14 days), and projects with stories carry a thin ring that fills clockwise as stories are done.
- Atlas now shows everyone who is working. People and bots whose session names a repo, folder or worker on the map are placed there, and anyone the map cannot place is listed in a small Not on the map group in the corner of the map, with a note saying why when you hover them.

### Rail and navigation

- The left rail shows your pinned companies with their favicons, or their initials when a company has no website. More companies lists the rest, and you can pin and reorder them.
- Clicking a company opens its panes beside the rail. Switching companies keeps you on the same kind of page where it exists.
- Opening a company lands on Atlas, a map of the company's folders, projects and people.
- The command palette (Cmd+K) searches pages, companies, projects and people. Cmd+N opens the create menu, Cmd+Shift+K starts a new message and Cmd+Shift+A opens Atlas.
- Notices such as update ready, sync progress and copy confirmations appear as small toasts in one corner instead of banners across the window.
- Toasts use the same neutral grey as other overlays.
- Windows, sheets and menus use one neutral grey across the app.
- Toasts never cover an open window or sheet.
- Marketplace has its own icon in the main rail. The page is named Marketplace (it was Library) and no longer lists Skills and Workers. The Launch and Core menus open above it.
- People are shown by name with their email, never by an internal id. Filters and pickers use one dropdown style.
- Large numbers are abbreviated, so a count rolls over to the next unit (for example 96.6B instead of 96572.1M).
- Company names show the company favicon beside them across the app, including the New bot company chips, project header, More companies, command palette, Connections, settings, bot membership lists, Meetings, Telemetry and Atlas. The company list reloads when you switch companies, so an icon added later replaces the initials.
- Clickable icons and small controls on the new pages have a 28 px click area, so they are easier to hit. Their drawn size is unchanged.
- Toast buttons show a focus ring when you reach them with the keyboard. The sync toast names the company by its display name.

### Home and Messages

- Home shows a welcome checklist for new accounts and your recent messages, meetings and work.
- Messages keeps channels, direct messages and bot conversations in one list, with threads in a side panel.
- Pending company invites appear in the notifications bell, where you can accept them.

### Projects and goals

- Projects has a board and a list view. Opening a task shows it in a side pane with its status, owner and files.
- Each project has a Files tab, and you can create a new file from it.
- Goals lists the company's goals with their progress and linked projects. Click a goal to see its details and linked projects, and add or remove projects.
- The Projects board shows as soon as the projects load; goal details fill in after.

### Company pages

- Activity and the Atlas people list load again for every company and range. Both had stopped reading the server's current data and showed an error instead.
- When Activity can't load, it says why: you're offline, your sign-in expired, or HQ had a problem. Try again is always there, and Sign in again appears when your sign-in expired.
- Team lists people and bots with their roles, join dates, groups and access in one place, and you can invite people from the same page. A team you have already loaded stays on screen while it refreshes.
- The company panel has Groups and Grants under People, and a Settings group with General, Brand and Billing. The separate Company settings page is gone.
- Activity shows the team's real activity, with a detail pane for each member.
- Bots shows the company's bots. New bot starts on the company you opened it from. When a filter matches no bots, the page says so.
- New cloud bots sign in with your model subscription. The API key option is no longer offered.
- Behind `agents.desktop-agent-creation` (Indigo only): New bot is one three-step flow (what kind, where it runs, its details). Choosing Cloud creates the bot directly, without Slack, and opens its DM. New cloud bots start on Claude, with Codex and Grok offered. Cloud stays visible when it can't be used and says why (admin role, plan, or no company). Settings › Bots › New bot closes Settings and opens the same flow. The flag is checked for the company you pick, and the cloud create code loads only when the flow opens, so startup is not slower.
- Escape closes New bot when it opened on the bot step.
- New bot now asks "Cloud or Local?" first, on the full-window New bot screen, from every place New bot opens (the + menu, Team, Settings › Bots and the command palette). Cloud goes on to the cloud bot steps; Local opens the local bot steps on the same full-window screen, with Local already picked. An option that cannot be used is shown greyed out with one line saying why. Back on the first step returns to the question. Opening a bot that is still starting goes straight to its waiting screen.
- Files and Knowledge show the company vault with a preview pane. Knowledge's Browse tree is a real folder tree.
- Vault uses the same folder tree, viewer and access panel as Files. Files and Vault show who can access the selected file or folder.
- Relative links in any Markdown preview open the linked file.
- Policies, Workers and Skills each have their own page. Workers shows each worker's details, skills and a file browser. Skills shows the team's usage beside your own.
- Integrations is view only. Open console opens the company's integration setup in the web console, and connection types have plain labels.
- Secrets lists secret names without ever showing their values.
- When a search on Secrets or Integrations matches nothing, the page says so and the side panel clears instead of showing the last item.
- Outpost is a status view of your Outpost, with Open console to manage it in the web console. If the read fails it shows Couldn't read your Outpost with Try again.
- Deployments lists the company's deployed apps with their links and access.
- Access on a company deployment now opens. If it can't load, it says so in plain words.
- When company Projects, Goals, Team, Bots, Files, Knowledge, Policies, Skills, Workers, Secrets or Deployments, Personal Deployments, or the Choose folder sheet can't be read, the page says so in plain words with Try again, instead of showing the empty-page line or raw error text.
- When the Library can't be read, it shows one Try again, which reloads both the folder tree and the vault home.
- Goals no longer lists projects that are not linked to a goal. The Projects filter has a No goal option to find them.
- The New objective window, its project picker and its inputs fit inside the app window without scrolling sideways.
- Pages with nothing in them yet use plain empty copy.
- Library and Settings text uses the app's standard sizes and weights.
- While a page loads, it shows a loading animation with short rotating messages. A slow page keeps waiting and is never reported as failed. The grey placeholder rows are gone.
- When a page can't be read, it no longer also says the page is empty or shows zero counts. This covers Team, Goals, Bots, Projects, Knowledge, Policies, Skills, Workers, Secrets, Deployments, Connections and the company map.
- Company Vault says you don't have access when the server refuses access, instead of showing an error.
- Atlas tints each section without an outline, never covers a section's name, and uses readable 13 px labels that do not overlap or run into the legend. Projects are small dots. The most recent and largest items are labeled first; the rest show on hover and when you zoom in. A panel lists the company's people and agents with their recent activity.
- Company Integrations reliably lists the apps the company has actually connected, with loading, failed and empty states.
- Telemetry shows one sentence when there is no activity, and is hidden for people who do not have the feature. Indigo members keep the Telemetry entry on Home and in every company.
- My Telemetry is one page: totals, tokens per day, usage by exact model, skills, and the sessions recorded on this Mac.
- Deployments and Secrets filter from the page header. Personal Connections and Secrets no longer have a side list.
- Personal Secrets load even when you open them before any company.
- Marketplace no longer shows zero counts when it can't be read.
- New bot shows the platform's own create shortcut (Cmd+Return on macOS).

### Meetings

- Meetings shows your calendar, live meetings and recaps in one page. When the desktop detects a meeting it shows recording controls on the Meetings page, and the meeting-detected banner opens Meetings.
- Notes, recaps and decisions load for all your meetings, and recaps and decisions are shown as formatted text. Opening a company meeting no longer times out, and if part of a recap fails the transcript still shows.
- The "Some past meetings could not load" line appears only when something really fails.
- The New meeting window is replaced by Invite notetaker. You can invite the notetaker from an upcoming meeting, or by pasting a meeting link.
- Meetings lists only your own meetings: ones your notetaker recorded, ones on your calendar, and ones recorded on this device. Company role does not add other people's meetings. Past meetings are grouped under day headers.
- Meetings stored as a single document now show their notes, transcript and attendees.
- Meeting notes and transcripts stored as documents now load: the app downloads them itself. If a meeting's notes can't load, it shows "Couldn't load the notes." with Try again, instead of saying there are no notes.
- Load more shows meeting notes past the first 24.
- When your calendar can't be read, Meetings says so with Try again instead of asking you to connect your calendar.
- Behind the `desktop.meetings-personal-transcripts` flag (off by default): Past meetings can list meeting transcripts and notes saved privately on this computer, including older ones, and your own desktop recordings. Transcripts from another account signed in on the same computer stay hidden.

### New companies and setup

- New company opens a sheet beside the rail and sets up the company's cloud storage before it finishes.

### Settings and account

- Settings opens from your account at the bottom of the rail. Profile, Billing and Public profile live in the one Settings list. Pronouns are removed from the profile. Light appearance is supported across the new pages.
- The signed-out page uses plain copy that names the app HQ. Its quit button reads Quit HQ.
- The signed-out page has one heading, Sign in to HQ, with the reason as a short line under it.
- Restart to update works while sync is running. Only a meeting recording, a transcript that is still saving, or an HQ Core update holds a restart you asked for, and Settings › Updates and the update notice say which one. While an upload is holding the update, Restart is unavailable in both places.
- Office Hours and the Settings profile show a plain message with Try again when they can't load or save.
- Removing a bot in Settings > Bots now opens a branded confirmation dialog that shows progress or a retryable error in place. A bot on its own cloud machine keeps the dialog open for one more confirmation before the machine is deleted.

### Other changes

- Desktop sign-in now records each stage from choosing a provider through the browser callback and token exchange. When it fails, HQ records only the failing stage and a safe error category.
- The welcome sign-in window moves on when you are already signed in, keeps you informed while browser sign-in is in progress, and offers Try again if it does not finish.
- Sign-in tracking from a first sign-in is no longer lost. Progress and failure records sent before you are signed in are kept on this Mac (at most 20, for 3 days) and sent once you sign in.
- Daily-use and first-launch records are sent reliably and carry the app version.
- Startup diagnostics tell more kinds of rejected saved sign-ins apart.
- HQ recovers when its record of running commands was damaged by an earlier error.
- Setup failure events now fill a missing stage from the bounded component and keep error categories on the closed list.
- CI launches of the desktop app no longer add first-run rows to the install funnel.
- Desktop Core baseline refresh now retries GitHub timeouts before reporting a pending baseline. Persistent timeouts are still reported.
- When company-name suggestions are turned on, new-company setup can fill in the name from a business email domain. You can still edit it.
- Error messages across the app use plain words instead of technical error text, including sending messages, uploads, channel actions, Settings, sign-in, setup and the marketplace. The technical details go to the app log.
- Opening a company retries the company lookup once before giving up.
- HQ CLI updates wait for running HQ CLI commands to finish before replacing the CLI.
- Setup recovers when its install bookkeeping was left locked by an earlier error, so it can still cancel an install and record its failure.
- CLI update failure reports record which CLI version was running. Onboarding step telemetry can be joined to the install attempt (behind a flag).
- Sync keeps a company's cloud link when the company is missing from your membership list or its lookup comes back missing. Only a confirmed deletion removes the link.
- A rejected saved sign-in at startup is treated as signed out, so HQ asks you to sign in again.
- After a Windows Core update, HQ puts its managed CLI ahead of stale CLI paths in the HQ Claude settings file so the updated version is selected.
- Shelltest builds report to a separate Sentry environment. Release telemetry is unchanged.
- More internal tests now check what the desktop UI does instead of searching its source text. Nothing changes in the app.

### Known gaps for the beta

- Telemetry and Outpost editing are available to Indigo team members only for now. Others see Coming soon.
- The Grok mark in the launch menu is a placeholder.
- Performance has not yet been measured on a quiet machine, so the new interface may feel slower than it will at release.
- Atlas is slow to draw the first map for large companies. A faster map needs a server change that is not in this beta.
- Deployments cannot redeploy from the desktop yet, and the Your bots filter is empty.
- Workforce shows the seat limit as unavailable until the plan limits are connected.
- Custom keyboard shortcuts in the Edit shortcuts sheet are not saved yet.
- Atlas now shows everyone who is working. People and bots whose session names a repo, folder or worker on the map are placed there, and anyone the map cannot place is listed in a small Not on the map group in the corner of the map, with a note saying why when you hover them.
- Company logos in the left rail now fill their whole circle instead of sitting small inside a grey one. Companies without a logo still show their initials.

- Connection cards in a cloud bot's direct message can now come from the bot itself. A bot on the new runtime sends each card with the state it looked up (whether the app is connected, whether the bot can use it, who connected it, and whether the bot is in Slack), in the message's structured content instead of inside its text. The app draws those cards straight from what the bot sent, without reading the company's connection list: "Nova can use it." when the bot can use the app (for a bot named Nova), "Let Nova use it?" with the button when you connected it, "A teammate connected this. Ask them to share it with Nova." when someone else did, Connect when you can add apps, and "Ask a company admin" when you cannot. When you press one of these cards, the app first checks the live state and then acts on that, and it checks again when a note that a connection changed reaches the bot. Slack is still the first card and a row still shows three cards at most. Messages from older bots, and cards without state, work as before. The app now also keeps a direct message's structured content when it loads the conversation; it used to drop it.

- Connection cards and the first hello in a cloud bot's direct message now read the company's connected apps with the server's faster summary list. For a company with about 135 connections that read took 7 to 9 seconds and should now take under a second. The cards and the hello show the same thing as before. An older server that does not know the summary list answers with the full one, as before.
- A row of connection cards in a cloud bot's direct message now appears as one: the app waits until it knows every card in the row (the company's connections and each app the bot named), then shows them together, Slack first. If that takes longer than two seconds, it shows the cards it knows and the others join at the end of the row.
- Connected connection cards no longer have a green border. They keep the same edge as the other cards; the green "Connected" mark stays.
- In a cloud bot's direct message, the bot's own Slack card is now the first card of every row of connection cards. The app adds it when the bot's message names other apps but not Slack, moves it to the front when the bot named it later in the row, and keeps it, as "Nova is in Slack." (for a bot named Nova), once the bot is in Slack. A row still shows three cards at most, Slack counting as one.
- The file sync status of a cloud bot moved into the header of its direct message. The full-width "Syncing your company's files" strip and its progress bar under the header are gone. In their place a small sync icon and one short grey line sit to the right of "Direct message", next to the bot's name, for example "Syncing your company's files, 10 files so far", or with a percent when there is a real one. Nothing in it moves. In a narrow window the line is cut with "..." before anything else in the header gives way, and hovering it shows the full text. It goes away when the files are up to date, as the strip did.
- Files opens a vault with its last known counts while the current index refreshes. The app now prewarms authorized vault indexes after the shell is ready and saves the paths, file metadata, and note links locally for the signed-in account, so the next launch can start with an incremental refresh instead of reading every note again.
- Deployments now has an All companies filter that lists only scopes with apps, and every column can be sorted forward, reverse, then back to the default order.
- Buttons: the remaining action buttons now have icons, including Archive, Reject, Choose, Knock and Manage, and labels such as Back to queue and Create channel use real plus and arrow icons instead of typed symbols.
- Brand: the Logo file-name box is gone. It did not change anything.
- Company switcher: companies that are only on this Mac and not synced yet now appear in the list, marked "Local, not synced".
- Atlas: the Find on the map box shows a Show more row when more than eight things match, instead of hiding the rest.
- Connections: Connected sources in the Google detail panel now show each product's own icon (Gmail, Drive, Calendar and others) in a compact two-column list.
- Buttons across the app now show a small icon before their label, including New project, Choose folder, Submit for review and Refresh.
- Packs: the Uninstall button is no longer red, and every button on the page has an icon.
- Deployments: the detail panel shows a small preview of a live deployment. Click it to open the page.
- Deployments opens with the most recently deployed apps first. Click any column header, including the new Deployed header next to App, to sort by it; click again to reverse. Your choice is remembered on this computer.
- Deployments: selecting a live public app shows a picture of the page itself at the top of the detail panel. On a Mac the app opens the page in a hidden window, takes the picture, saves it on this computer, and takes a new one after a redeploy or when you click Refresh preview. Apps behind a password or sign-in, and Windows for now, show the page's share image (og:image) instead when it has one. Click the picture to open the page.
- Deployments: when one company fails to load, the notice now sits in a banner with a Retry button.
- Settings: the "Open this company on sign-in for members" switch is gone from General. It did not change anything.
- Billing: the page shows the seat and hosted agent counts without the long list of names under them.
- Atlas: the map names only recently touched projects until you point at something. Hovering or selecting a project names the repos, knowledge and policies it uses. Other sections show names when hovered, or once you zoom in.
- Atlas: rows under People & agents and Working now have inner padding and a small gap between them, so the hover and selected background no longer runs flush against the text.
- Atlas: the company sidebar no longer lists who is live or idle. People and bots are shown on the Atlas page itself.
- Atlas: Open files now opens a file, not a folder tree. A folder opens on its main file in Files (its README, or the PRD, SKILL or worker file when there is no README). A project with no such file still opens its Files tab.
- Atlas: a Find box in the toolbar jumps to any item by name (press / to focus it). Clicking a person in Working now or an item under Related moves the map to it. Clicking a section title zooms into that section. Frame all, the zoom buttons and these jumps now glide instead of snapping, and stop as soon as you pan or zoom.
- Atlas: items active now are brighter. The pan and zoom tip goes away after you first move the map. The timeline is taller and names its busiest day. Bots have a small square mark in People & agents. The projects in progress count is hidden when it is zero.
- Atlas polish: faded items are easier to see, and an item's name is as quiet as its dot. Section titles show how many items they hold. Hovering an item no longer blacks out the rest of the map, and the hovered dot gets a ring. Markers for people and bots with a session in progress have a slow pulse; ones who are only online are grey. Items matching the people filter show at full strength. Working now rows say what each person or bot is on. The People & agents rows stay on one line and carry a thin bar for their share of tokens. The hover card shows the section color.
- Atlas has a clearer visual order. Section titles are small, uppercase and muted. Item names come in three strengths: the item you are on and its relations, recently touched items, then everything else. Items that are not active now fade by age, with the oldest the faintest.
- Atlas Working now lists only people and bots with a session in progress, people first. Everyone else who is online is counted in one line you can open. A person or bot is never shown as an id: the name comes from the company activity data, or reads "Unnamed bot" or "Unnamed member".
- Atlas sections now pack close around the largest one instead of sitting on a wide ring, and the shaded circles behind them are gone; the color of the dots and the section name group each section. Very large folders no longer draw as oversized circles. Items active at the selected time have a soft glow. Long names on the map are shortened to 28 characters, with the full name in the hover card. Section names stay on screen while their section is. The map re-frames itself when the rest of the company finishes loading, unless you have already moved it.
- Atlas: the People & agents list loads again. It showed "Activity could not be read" because the app expected an older layout of the activity data.
- Atlas: Working now fills in when you open a company. Before, it stayed on "Nobody is working in this company right now" until the next live update arrived.
- Atlas is easier to read. Names on the map no longer have an outline, the shaded areas behind each section are much fainter, and sections sit close together instead of spread around a wide ring. Names no longer run across another item's dot.
- Atlas shows who is working where at a readable size at every zoom: people and bots appear as markers beside the item they are working on. Hovering an item or a marker opens a card with who is there, what they are doing, story progress, related items and dates.
- Atlas reads project links for up to 30 seconds before drawing the map without them (was 8), and names up to 16 items when zoomed out (was 8).

## [0.10.395] — 2026-10-05

- Desktop push-events flag resolution uses a valid configured company UID and falls back for stale or legacy IDs.
- With liveness telemetry enabled, the desktop app can report how it launched, whether start-at-login is registered, and why it exited. It does not change launch, autostart, window, or quit behavior.

- Desktop Core now retries a baseline write once if its directory disappears during the final file rename.
- First-launch records can include the installer's download visitor key when the `desktop.first-launch-download-join-v1` flag is on.
- The git mirror removes an index lock left by its own timed-out Git write once the killed writer releases it.

- Package-use lease timeout reports now include a bounded purpose for the oldest active HQ CLI holder.

## [0.10.394] — 2026-10-05

- Connection cards and the first hello in a cloud bot's direct message now read the company's connected apps with the server's faster summary list. For a company with about 135 connections that read took 7 to 9 seconds and should now take under a second. The cards and the hello show the same thing as before. An older server that does not know the summary list answers with the full one, as before.
- Desktop launch telemetry now records the effective start-at-login preference by platform.
- Desktop onboarding records provider sign-in starts and browser callbacks on the install session.

## [0.10.393] — 2026-10-05

- Rsync failure reports now include fixed categories for the exit status and sync phase.
- A row of connection cards in a cloud bot's direct message now appears as one: the app waits until it knows every card in the row (the company's connections and each app the bot named), then shows them together, Slack first. If that takes longer than two seconds, it shows the cards it knows and the others join at the end of the row.
- Connected connection cards no longer have a green border. They keep the same edge as the other cards; the green "Connected" mark stays.
- In a cloud bot's direct message, the bot's own Slack card is now the first card of every row of connection cards. The app adds it when the bot's message names other apps but not Slack, moves it to the front when the bot named it later in the row, and keeps it, as "Nova is in Slack." (for a bot named Nova), once the bot is in Slack. A row still shows three cards at most, Slack counting as one.

## [0.10.392] — 2026-10-05

- The macOS Rust CI job now also runs for PRs that change the shared packages or the work app, because the sync app bundle it builds includes them.
- Setup no longer says "Claude Code is installed. Sign in to finish." on a Mac that has only the Claude desktop app. Setup needs Claude Code itself, so it now shows "Install Claude", which installs Claude Code and opens its sign-in in one step. Codex works the same way with the ChatGPT app. HQ now also finds the Codex that comes inside current versions of the ChatGPT app, so people with the ChatGPT app can sign in to Codex without installing it separately. If a sign-in check still fails, the message names Claude Code or Codex and says to make sure it is installed. The coding-tool step on the welcome channel now only installs and signs in to Claude Code or Codex: the "Set up with Claude" and "Set up with ChatGPT" buttons and the "Already use Claude Code or Codex?" card are gone from it. The setup assistant offers to continue in Claude or Codex itself, and the Launch menu in the top right still opens your HQ folder in either one.
- When the Claude app or the Codex app is installed on your Mac and you have used it a lot lately, your setup bot's welcome asks whether you want to continue setup there, with two buttons under it: "Continue in Claude" (or "Continue in Codex") opens your HQ folder in that app with a plain request to set up HQ already typed in, and "Keep going here" carries on with setup in the conversation as before. The button opens the desktop app, never a terminal. Needs the hq-cli release that sends the offer.
- Opening your HQ folder in the Codex app works again with the current ChatGPT app, which moved its built-in Codex command inside the app.
- Connection cards under a cloud bot's message now appear with the message. They used to appear several seconds later, because the app only asked the server what was connected after the message was already on screen. It now asks when you open the bot's direct message, and a bot you just created reuses what the app already read while setting it up. If that check fails, the app tries again by itself instead of waiting for you to leave the conversation and come back. A card for an app the app still has to look up no longer holds back the other cards in its row: they show at once and that card joins the row a moment later, after the ones already there.
- In a cloud bot's direct message, a Slack card is always about the bot's own Slack. When a bot offered Slack by naming slack.com, the card showed a teammate's company Slack connection as "Connected" even though the bot had never been connected. It now shows the Connect Slack card, which opens the Connect Slack window, and reads "in Slack" only when the bot itself is in Slack. A person who is not allowed to set the bot up sees "Ask a company admin to connect Nova to Slack." (for a bot named Nova). The cards the app chooses no longer show a second Slack card for your own Slack connection. A new bot is told whether it is in Slack yet, and the company's Slack connection is no longer in the list of apps it is given.
- Connection cards in a cloud bot's direct message no longer say "Connected" twice. Under the green Connected mark, an app a teammate connected now reads "A teammate connected this. Ask them to share it with Nova." (for a bot named Nova), your own app reads "Let Nova use it?", and an app the bot can already use reads "Nova can use it." The sentence on a card can take two rows, so the instruction is no longer cut off after the first few words. Every card in a row keeps the same height.
- The messages the app sends a cloud bot (the first request after it is created, and the notes that say an app or Slack was connected) now only state facts and say what to do next. They no longer list things the bot must not do. A company whose only connection is Slack sends the bot no apps list.

## [0.10.391] — 2026-10-04

- Desktop update checks now record bounded check, download, and install outcomes that can be joined to first launch.

- Desktop mirror Git commands no longer pause while holding the Git index lock, so later mirror passes are not held behind a stopped Git process.
- First-launch join-key rollout assignments now use the public flag resolver.
- CLI update failure reports now identify known Node crash signatures with fixed, path-free categories.
- Channel and direct-message conversations now retain a message's intended audience. Human-only views hide messages explicitly sent to agents while keeping untagged messages visible.

- Rust cache warmers now skip setup and compile work when the exact cache key already exists; cache misses still populate the keys used by release and Windows checks.
- Core update failure prompts now say how much free space the safety snapshot needs and ask the user to retry after freeing it.
- The required macOS Rust CI job now skips PR changes outside its app, Rust, and CI inputs while still running for every main push.

## [0.10.390] — 2026-10-04

- Bot conversations with messages, unread activity, or an activity dot now show in the desktop sidebar on every copy of the app, including after local storage is reset.

- HQ CLI update timeout reports now include bounded counts and version and age buckets for live package-use holders.

- Desktop onboarding records the selected company after someone creates one, joins an invite, or chooses an existing company.

- HQ CLI updates that time out while a command is using the package now retry up to three times, ten minutes apart, before returning to the regular six-hour check.


## [0.10.389] — 2026-10-04

- When the auto-sync watcher stops because another sync runner already owns the HQ root (exit 20), the report now says so instead of "exited unexpectedly", even when the runner printed nothing. It names the owning runner's owner, pid, process and start time when the runner reports them, and reads `unknown` for any it does not.

- Setup telemetry now records a bounded reason when the invite step is hidden after company creation.
- New bot: for companies that have the new bot screen turned on, choosing New bot from the + menu now opens a full-window screen for creating a cloud bot. You pick the company, give the bot a name, choose its brain and machine size, and wait on a "Waking up" screen until the bot can chat. Cancel works at every step and removes a bot that was already being made. "Create a local bot instead" is on the same screen. If your plan cannot host another bot, the screen says so and links to the upgrade options. Companies without it keep the New bot steps in the + menu, which work as before.
- A cloud bot made on the new screen opens in a direct message with you instead of its own channel. A direct message with any bot now reads as one conversation: the bot's answers show in line instead of under "1 reply", and the setup request the app sends to the bot for you is not shown.
- A cloud bot's direct message shows connection cards under its messages for Slack and the other apps your company uses. Connect Slack opens in a window over the chat. Writing "Connect more tools" brings the cards back. Suggested replies appear under the bot's newest message.
- While a cloud bot's copy of your company files is syncing, a slim strip under the header of its direct message shows how far along it is, and goes away once the files are up to date.
- While a bot works on an answer in its direct message, the "working" row shows what the bot is doing, and it goes away when the answer arrives.
- App logos on connection cards are the app's own brand mark, shipped inside HQ. An app HQ has no mark for shows a plain app icon. No logo is loaded from another site.

## [0.10.388] — 2026-10-04

- Free companies in their first week can see a once-daily sync reminder in the existing Core status popover.
- First-launch telemetry can record whether sign-in was reached or which setup, update, or app-exit path diverted it; the measurement is off by default.
- Updater restarts now carry a short-lived, version-checked marker through the GUI restart fallback when start-at-login is disabled.
- Add an Add member action to project boards for active company members.
- Sync retries once when the cloud service returns a gateway timeout from a Lambda invoke, and keeps error bodies available for diagnosis.

- Held sign-in receipts now read the sign-in token from the same home directory they were held in, so a session in another home directory can no longer send or drop them.
- First-launch sync start failures are now captured in Sentry with bounded categories and no error details.
- Desktop setup failure records now show whether a dependency timeout retry ran and how it ended, using a bounded dependency label.

- An updater restart with a previously completed install and temporarily unresolved local tools now resumes setup repair instead of reopening first-run onboarding.

## [0.10.387] — 2026-10-04

- Checking whether a desktop command is still registered, cancelled, or finished, and registering or removing one, still works after an internal error interrupts that bookkeeping. (This fix was listed under 0.10.386 by mistake; it ships in this release.)
- First-run setup: "Name your company" now comes right after the setup explainers, before the "Open HQ Desktop" screen, while the install keeps running. It no longer asks for a company handle: HQ makes it from the company name and, if it is taken, picks a free one by itself; a name it cannot use gets a plain message under the name field. The company and plan screens stay centred in the welcome window: the form, the line under the heading, the plan cards and the buttons share one column under the heading, the screen re-centres when the form or plan cards replace "Getting things ready…", and the window no longer scrolls off-centre when a field gets focus. The plan screen now matches the website's plan cards: "Choose how your HQ runs.", Starter and Workforce side by side with the website's prices, rows and buttons ("Get started free" finishes setup, "Get started" opens checkout), and a "Book a call" link for a custom setup. It is skipped when hq-pro reports a plan already picked on the website; hq-pro does not send that yet, so the screen still shows until it does.
- A sign-in step saved for your next session, and other app settings, are no longer lost when the app saves two settings at the same moment. Changes to the settings file are now made one at a time.
- Unexpected watcher-exit reports now include the runner phase and elapsed-time bucket as searchable Sentry tags.
- Held sign-in receipts keep the home directory captured before token resolution, preventing a profile switch from redirecting the pending event.
- Desktop setup invite telemetry now includes the company for each step outcome and the number of invitations sent. It does not include invitee details.
- Background first-launch and sign-in telemetry flushes stay bound to the home
  directory that scheduled them, so delayed sends cannot consume another
  install's held rows.
- Startup diagnostics now classify reason-suffixed refresh-rejection markers as desktop-origin markers.
- Sign-in telemetry from a first sign-in is no longer dropped. Progress and failure rows sent before the app has a session are kept on this Mac (closed labels only, at most 20 rows, for 3 days) and sent once the user signs in, each with a stable key so a resend is stored once.
- The welcome sign-in window now advances when you are already signed in, keeps
  you informed while browser sign-in is in progress, and gives you a clear Try
  again path if it does not finish.
- Desktop funnel telemetry fixes: the daily-active row is stamped with the time it was sent (it was stamped midnight, so daytime reports showed none) and is re-sent every 6 hours; a new install's first app-opened row is held until sign-in instead of being dropped; account-linked rows now carry the company hash after the first sync or first company push; and every desktop funnel row carries the app version.

## [0.10.386] — 2026-10-03

- "Restart to update" now works while a sync is running. Only a meeting recording, a transcript that is still saving, or an HQ Core update holds a restart you asked for, and the update card says which one. (This fix was listed under 0.10.379 by mistake; it ships in this release.)
- Internal tests: two more desktop UI tests (message link color, touch quick-react) now render the conversation and reply panel and read the applied styles instead of searching their source text. Nothing changes in the app.
- When company-name suggestions are enabled, new-company setup can prefill the name from a business email domain. The name remains editable.
- Desktop setup still cancels an install and still records its failure after an internal error interrupts that bookkeeping.
- On first launch, onboarding step telemetry can share the persisted install attempt id with the anonymous launch receipt when its hq-flags gate is enabled.
- Workspace refresh no longer clears a company cloud link when an entity lookup is missing; only a confirmed deletion removes it.
- Internal tests: four more desktop UI tests (desktop sidebar layout, files sidebar contrast, @here mention, emoji shortcodes) now render the components instead of searching their source text. Nothing changes in the app.
- Internal tests: four more desktop UI tests (conversation rail ready signal, mute bell, notification focus ring, quick-react toolbar) now render the components instead of searching their source text. Nothing changes in the app.
- Keep a company's cloud binding in `companies/manifest.yaml` when it is absent
  from the signed-in person's membership list. The app now waits for an
  authoritative deletion signal before unlinking a workspace.

- Company names now show the company favicon beside them across the app: the New bot company chips, project header, More companies, command palette, Connections, settings, bot membership lists, Meetings, Telemetry, and Atlas. Companies without a website show their initials instead of a grey dot.
- Company favicons now show in the left rail for companies that have a website set. The app was dropping the icon the server sends, so every company showed initials. The company list also reloads when you switch companies, so an icon added later replaces the initials.
- New cloud bots created from the desktop New bot flow sign in with your model subscription. The API key option is no longer offered there.
- Behind `agents.desktop-agent-creation` (Indigo only): New bot in Messages is one three-step flow (what kind, where it runs, its details). Choosing Cloud creates the bot directly, without Slack, and opens its DM. New cloud bots start on Claude, with Codex and Grok offered. Cloud stays visible when it can't be used and says why (admin role, plan, or no company). Settings › Bots › New bot closes Settings and opens the same flow. The flag is checked for the company you pick, and the cloud create code loads only when the flow opens, so startup is not slower.
- Internal tests: four more desktop UI tests (task strip, task chip, page header, agents settings) now render the components instead of searching their source text. Nothing changes in the app.
- Internal: CLI update failure reports now record which CLI version was running when the update failed, as a SemVer value or the word unknown, with no file path.
- Release builds: the macOS release check now confirms its test sign-in is still valid before it opens the app. An expired test sign-in failed v0.10.383 with a message that looked like the app was stuck loading; it now says the test sign-in expired and how to renew it.
- Add bounded marker and refresh rejection attribution to unexpected startup diagnostics.
- Startup diagnostics now distinguish a rejected saved session from an empty credential store.
- Desktop CLI updates now wait for running CLI commands to finish before replacing shared package files.
- Shelltest builds now report to a separate Sentry environment; release telemetry remains in production.
- Past meetings can list local personal notes and your own desktop recordings, behind the desktop.meetings-personal-transcripts flag (off by default).
- Desktop sign-in now records each stage from choosing a provider through the browser callback and token exchange. When it fails, HQ records only the failing stage and a safe error category, so the download-to-sign-in drop can be measured without collecting sign-in details.
- Desktop onboarding retries a failed company lookup once and records when the lookup stays unavailable, without creating a company from incomplete data.
- The Meet native Windows test build now pins its signing and Rust toolchain actions to exact versions. Nothing changes in the app.
- Setup failure events now fill a missing stage from the bounded component and keep error categories on the closed list.
- CI launches of the desktop app no longer add first-run rows to the install funnel, including through the CDP mirror.
- Past meetings can show meeting transcripts you saved privately on this computer, including older ones, when the personal transcripts feature is turned on for your account. Transcripts from another account signed in on the same computer stay hidden.
- Internal tests: four desktop tests that only searched the source text for strings now check what the code does. Nothing changes in the app.
- Desktop Core baseline refresh now retries GitHub timeouts before reporting a pending baseline; persistent timeouts remain reported.

- After a Windows Core update, HQ puts its managed CLI ahead of stale CLI paths in the HQ Claude settings file so the updated version is selected.

## [0.10.385] — 2026-10-03
- The vyg CDP mirror now also records app opens (every launch), one daily-active row per day, account linking after sign-in (sha256 hashes of the person and company ids only), Claude/Codex/Grok session launches, sync start and end, teammate invites, joining a company from an invite, and the plan picked during setup. The same rows go to HQ's operational telemetry. The `desktop.cdp-mirror` flag is now re-checked every 6 hours, so turning it on or off no longer needs a relaunch.
- Referral links now carry through desktop sign-in regardless of the signup experiment. HQ retries referral confirmation after connection failures or a restart and keeps each referral tied to the account that signed in.
- Release builds: a daily check now fails, and opens an issue, once the release test sign-in is 25 days old, five days before it expires, so it is renewed before a release depends on it. The renewal steps no longer need AWS keys or a shared GitHub token.
- The updater now refuses a beta or alpha build unless you chose that release channel in Settings. People on the stable channel stay on stable releases even if a test build is ever published by mistake.

## [0.10.384] — 2026-10-03

- Release builds: the macOS release check now confirms its test sign-in is still valid before it opens the app. An expired test sign-in failed v0.10.383 with a message that looked like the app was stuck loading; it now says the test sign-in expired and how to renew it.
- Desktop onboarding step telemetry now includes the install-attempt identifier so sign-in progress can be joined to that installation’s first launch.

- If the desktop cannot read the HQ daemon flag at startup, it uses the last successfully read value and retries with bounded backoff. After a failed startup read, a later successful on value can recover from the Legacy host to daemon sync without relaunching the app. Turning the flag off while the daemon is running sync takes effect on the next launch. Sign-in also triggers a retry.
- Cognito refresh failures now log the status and sanitized provider error details. HTTP 401, invalid_grant, and Cognito NotAuthorizedException responses require sign-in; invalid_client keeps the session and parks retries for 15 minutes. Other failures retry with bounded backoff. The shared token lock uses the CLI-compatible PID-file protocol.
- When a plan limit pauses new files for a company, the app now adds a notification to the notifications panel instead of a banner across the top of the window. Before, someone in many paused companies got one banner per company stacked over the window. Each company gets one notification per pause, a refresh or a reopened window does not repeat it, opening it goes to that company's upgrade page, and the system banner follows your notification settings and is sent once per sync pass however many companies were paused. The main window also stays solid at full opacity, so other apps no longer show through behind it.
- The main window no longer shows a stack of "New files are paused" notices, one per company, with other apps showing through behind them. A paused company now gets one small notice inside its own pane, personal pages show none, and Dismiss hides it for the rest of the session. The window stays solid at full opacity.
- Setup now checks what you already have before it asks you to name a company. A paid company, or one you joined, is selected and the company step is skipped. A company you own shows "Use <name>" with "Create another" beside it. A pending invite shows "Join <company>" and never the create form; an invite sent to a different email offers to switch account, and an expired one says to ask the inviter to resend it. If your website sign-up made a company under another account, setup says which (masked email) and offers to switch before offering create.
- A new company shows "Setting up your company…" until its cloud storage is ready, and only then sends invites and offers a plan. If a setup step fails, the screen names the step and "Try again" retries setup for the same company instead of creating a second one. A company left half set up by an earlier run resumes at that state.
- Creating a company past the free plan's limit shows the upgrade prompt inline instead of an error.
- When the first sync finds a company with no storage yet, setup shows "Finishing setup…" and finishes it instead of showing the raw error; "Try again" still works.
- On first launch over an old HQ folder that is still signed in, the sign-in screen says which account is signed in and lets you continue or switch before anything is created.

## [0.10.382] — 2026-10-03

- Creating a company from the desktop app now sets up its cloud storage right away. Before, the app created the company but never provisioned its vault, so the first sync failed with "has no bucket provisioned. Run VLT-2 bucket provisioning first" and teammate invites could not go out. The New company form shows "Setting up cloud storage..." while this runs, its Try again button re-runs only the setup step, and the sync banner's Try again now repairs companies created by earlier builds.
- Core update failures now report the available snapshot disk space instead of the required snapshot size.

## [0.10.381] — 2026-10-02

- Sync works again for everyone whose app runs sync itself. Since 0.10.369 the app passed a launcher option to hq-cloud runners 6.18.25 to 6.18.37 that made every sync pass fail, so nothing synced. The app now passes it only to runners from 6.18.38, which handle it correctly.
- Inviting a teammate after setup no longer fails when that address was already invited: HQ resends the existing invitation and says so. Other invite failures now name the cause (plan limit, invalid email, no connection, server problem) instead of a generic message, and the setup telemetry records the error kind and HTTP status.
- When you name a new company during setup, HQ now waits for the company's cloud storage to be ready before sending invites. If it isn't ready yet, the invites are queued and sent the next time the app sees the company ready, and the setup screen says they are pending instead of reporting them sent.
- The "Name your company" setup form no longer shows "(optional)" twice on the Website label, and the Invite teammates box now matches the other fields.
- On first launch, HQ reads the website visitor id and download surface from the address the installer was downloaded from (macOS download metadata, Windows Zone.Identifier), so a download can be linked to its website visit before sign-in. Only those two values are kept; the address itself is never stored or logged, and an id already linked through sign-in is never replaced.

## [0.10.380] — 2026-10-02

- Keep desktop recording recovery entries after local SDK errors until hq-pro reconciliation reaches a terminal status.
- Sync reports when another HQ process holds the operation lock, bounds the wait to ten minutes, retries lock timeouts with backoff, and restarts watchers that have not started a pass after thirty minutes.

## [0.10.379] — 2026-10-02

- Closing the main window no longer logs an error.

- Settings › Updates now shows what is holding a requested restart (a recording, a transcript that is still saving, or an HQ Core update) under the Desktop app row, and the update notice says the same instead of always mentioning a recording.
- "Restart to update" works again while sync is running. Only a meeting recording, a transcript that is still saving, or an HQ Core update holds a restart you asked for, and the update card now says which one instead of always mentioning a recording.

- When hq-flags enables `desktop.setup-deps-timeout-retry-v1`, a dependency setup timeout gets one automatic retry before setup is marked passed with that step skipped.





- Internal: startup diagnostics now label observed CLI resolver candidates, managed package state, and bundled CLI source.

## [0.10.378] — 2026-10-02

- The desktop setup funnel can now be followed end to end in the vyg CDP. When you sign in through the browser, hqforwork.com tells the app which website visitor downloaded it, and the app mirrors first launch, each onboarding step shown, sign-in, company creation, first sync, and a quit before sign-in to the CDP under that visitor, with app version, OS version, chip, and install source. Off by default; turned on remotely with the `desktop.cdp-mirror` flag. No email, name, or token is ever sent.

- Desktop no longer shows your personal space in the Companies list, where clicking it looped between Setting up and Tap to retry.

- Windows-visible copy now uses PC controls, the system tray, and file manager labels where older screens assumed a Mac, menu bar, or Finder.

- Platform wording and keyboard hints now follow the visitor's or desktop's OS instead of assuming macOS.

- Fixes a race in the agent sign-in test when reading the child process ID.

- Desktop usage uploads are limited to four requests and 4 MB per sync; remaining records resume on later syncs.

- Behind `desktop.sync-on-launch-reconcile-v1`, the desktop app honors the existing Sync on launch preference with a one-shot sync when background Auto-sync is disabled.

- When an HQ CLI update fails partway through installing, the desktop app now
  puts the previous HQ CLI back instead of leaving a broken or missing `hq`
  command. Before this, a failed update could leave sync unable to run until
  the CLI was reinstalled by hand.

- Behind `desktop.first-launch-sync-v1`, a fresh install schedules its first sync after the ready handoff when Auto-sync remains enabled.

## [0.10.377] — 2026-10-02

- Automatic updates now install after the idle cap even when sync stays busy. HQ pauses new sync cycles and waits up to a minute for active transfers before installing. A meeting recording, transcript processing, or another core update can still delay installation.

- Desktop setup completion telemetry now carries the persisted install attempt ID so it can join to first launch.
- Auto-sync watcher reports now identify launcher and runner exits and owner-lease
  outcomes. When a Node report is available, they add a safe error identifier and
  the top frame's file name for HQ's own scripts only; frames from other files
  report "external", so a user's file names are never sent.

- Behind `desktop.ready-first-action-v1`, the post-setup welcome screen can offer a one-click first sync and record whether the action was shown and used.

- Reinstalling HQ setup preserves files already present in your HQ folder.

## [0.10.376] — 2026-10-02

- Core update failures now report a specific snapshot failure class, such as
  insufficient space, a protected recovery snapshot, a permission error, a
  symlink, or a copy failure.

- First-run onboarding events now use the same installation identifier as launch and sign-in receipts, so those steps can be joined without adding personal data.
- Log in with Microsoft now works for work and school Microsoft accounts, not only personal Microsoft accounts.
- Fresh desktop installs show the welcome window before startup checks finish.



- When someone takes their first action after desktop setup, HQ can now record which action they took without sending folder details.

## [0.10.375] — 2026-10-02

- Daemon sync controls explain paused, disabled, and stopped states. Resume also re-enables sync for machines migrated from the older daemon setting. Instant Sync changes reach an existing daemon and require HQ CLI 5.312.0 or later. Sync actions wait briefly for host selection at launch, then use the legacy or daemon path. Company-specific Sync Now no longer starts a sync across every company when the daemon owns sync.

- Fixes the sidebar order shipped in 0.10.373 and 0.10.374, which listed
  conversations by unread count and then by name within each day instead of
  by time. The order and the day headings now both follow the latest message
  a person typed, where the server reports it: a channel that only bots
  posted in today is listed under the day a person last typed in it. A
  channel or group conversation the server reports as having no typed
  message is placed by when it was created, so a channel made today appears
  under Today. A direct message with no typed message yet is placed by its
  latest activity for now, so a new teammate's or a bot's first direct
  message appears under Today. A conversation the server has not classified
  yet is still placed by its latest activity, bot and session activity
  included, until a one-time server fill-in has run.

- Channels and direct messages that hide bot and session activity now ask the
  server for the filtered history. When a conversation opens on a long run of
  hidden activity, the app continues loading earlier history automatically,
  up to a limit of eight requests, and then offers "Look further back",
  instead of showing an empty pane with a "load earlier" button. With an
  older server the app filters on its side, as before.

- On refresh, HQ Desktop can show the existing plan-limit notice when a free company is nearing or over a resource limit.

- Desktop now uses the current cloud company name for workspace rows and
  home-channel labels before falling back to cached names or slugs.

## [0.10.374] — 2026-10-02

- On a fresh install, HQ now shows its logo and "Starting HQ..." right away instead of a blank, frozen window while it starts up.
- Sign-in and workspace-selection receipts reach HQ again. Since late September the app could not read the `email_verified` claim on Cognito access tokens (it arrives as text, not true/false), so every receipt was held on disk instead of sent. Receipts already held on your machine are sent on the next signed-in start.
- A first-ever sign-in's receipt is no longer discarded when HQ has not created the person record yet. The app keeps it and resends it once the record exists (HQ stops accepting it after 30 days).
- First run now sets up your company. After the install finishes, someone
  with no company names one (with an optional website and teammate invites),
  then picks Starter or Workforce. Workforce opens checkout in your browser
  and HQ picks up when you come back. Someone who was invited can join that
  company instead.
- Sync health no longer counts runner diagnostics as failed syncs. The runner
  pin now starts at hq-cloud 6.18.31 and accepts later 6.18 patch releases.
- Automatic Core updates wait for sync to finish after 10 deferrals or 6 hours.
  The wait ends after 15 minutes, and a failed update backs off before retrying.
  Updates also report when Git 2.19.0 or newer is required.
- Desktop sign-in can open the website first to link the new account to the native app; if that check fails, it opens Cognito directly as before.
- Library Back now leaves internal Library tab history and returns to the prior app screen.

- Setup diagnostics now identify the resolved CLI copy and settings PATH source using path-free values.

## [0.10.373] — 2026-10-01

- Setting up a coding tool after onboarding is smoother. You can choose
  Claude Code or Codex, and one button ("Install Claude" or "Install Codex")
  installs it and opens its sign-in page, with no second Sign in click.
  HQ notices by itself when a coding tool is already signed in, or when you
  finish signing in in your browser, and shows one Continue button instead of
  "Sign in above, then Retry". It no longer says "Sign-in did not complete"
  while your browser sign-in is still open, and if a sign-in does fail you
  can try again, switch tools, or reopen the sign-in page.
- Core Drift ignores setup PATH changes and generated wrapper markers while retaining raw-hash fallback when settings JSON cannot be parsed.
- Core Drift ignores the desktop-generated `env.PATH` in `.claude/settings.json` and the company skill-wrapper marker, while continuing to report other settings edits.

- Desktop company-creation invites identify the desktop surface in the hq-pro team invite action.
- Windows setup now detects Claude Code from the current user PATH and
  Anthropic's user-local install directory, including on Retry.
- The sidebar orders DMs and channels by the latest message a person typed.

- HQ no longer restarts for an update, or at support's request, while a meeting
  is being recorded; it waits until the recording finishes.

- When HQ daemon owns sync, Sync Now, pause/resume, and company sync modes go through the daemon. Instant Sync follows its setting, and sync help points to the daemon log while preserving the old log for history.
- On macOS 26.2 and later, the installer window shows its background artwork again instead of a plain white window behind the HQ and Applications icons.

- Internal: removed two unused packages/ui helpers and made three module-only helpers private (TD-60, #1198). No user-visible change.

- Internal: unused exports in the shared UI package are now module-private. No behaviour change.

- Internal: unused exports in the work shell and installer are now module-private. No behaviour change.

- With the Personal workspace board rollout enabled, HQ Desktop shows the
  cloud-backed board alongside company workspaces.

- Core drift ignores only the setup-managed `env.PATH` value in `.claude/settings.json`; other settings changes remain visible.

- Work feed and Board reads now stop waiting after 15 seconds and keep their cached or empty states when requests fail.
- On Apple Silicon Macs, the app now replaces a managed Node.js that was installed for Intel Macs instead of reusing it, so setup and repair install the right one.
- Channel owners no longer see Leave while their channel role is unknown, and
  a stale owner-role conflict gives a clear recovery message.
- Goals with an empty company board now explain that the board has no goals yet.

- Internal: unused UI exports are now module-private. No behaviour change.

## [0.10.371] — 2026-10-01

- Desktop sync now recovers legacy watcher processes left behind by an app update when their process path and ancestry prove they belong to the desktop. Other active sync owners continue to be left alone.
- Home now lists projects from your Personal workspace, and Personal board and summary requests resolve with your Personal identity.
- Usage telemetry now backs off after unaccepted batches and does not resend rows the server explicitly skipped.

## [0.10.370] — 2026-10-01

- First-run setup now retries a just-published npm package when the registry
  briefly returns E404 or ETARGET, while keeping setup progress active.
- Startup diagnostics now distinguish unreadable saved credentials from an empty token store.

- With a compatible hq-cloud runner, auto-sync watches the desktop process directly and releases its lease when the app exits, including after a crash or force-quit.
- A stalled attachment upload or download in the Work app now ends with the usual upload or download error instead of staying open indefinitely.
- When a saved access token is rejected, HQ Desktop tries its stored refresh token before asking you to sign in. After Cognito rejects that refresh, HQ Desktop stops retrying the same token and keeps sign-in available.

## [0.10.368] — 2026-10-01

- Window opacity is reset to 100% once for existing installs, including anyone who had chosen a lower value. The theme is unchanged, and an opacity chosen after the update is kept.

## [0.10.367] — 2026-09-30

- Auto-sync identifies its watch-runner lease owner, stops a live orphan desktop runner once, and defers to hq-daemon when it owns the root. Lease-busy exits do not count as repeated runner failures.
- A watch runner that exits during orphan recovery now counts as stopped, so auto-sync can finish recovery instead of reporting a false runner failure.
- Fresh installs now open fully opaque until Window opacity is changed; saved
  opacity values remain in effect.

## [0.10.365] — 2026-09-30

- Opening the desktop window no longer freezes the whole app for seconds
  while it checks which AI tools are installed. That check (shell probes plus
  a scan of the Claude, Codex, and Grok config folders) ran on the app's main
  thread, so under disk load it stalled every window, every other request, and
  the boot watchdog, which then showed the Recovery dialog. It now runs in the
  background. The "HQ Work installed" probe moves off the main thread for the
  same reason.

- The Recovery dialog no longer stays open when the desktop window was only
  slow to load. If the window finishes loading after the dialog appeared, the
  dialog closes by itself, including when it finishes while Recovery is still
  checking for updates. When the app notices its own timers running late
  (the machine or the app was stalled), it waits an extra ten seconds before
  showing Recovery instead of alarming right away. The log now records how long
  each window took to load and when the app's background runtime stalls, so a
  slow open can be told apart from a broken one.

- On Windows, template installs now use safe file-copy and junction fallbacks when symlink creation is unavailable.

- Added desktop regression tests for adapter results and call-window URL target rejection.

- First-time setup shows when it is checking for AI tools instead of waiting silently.

## [0.10.364] — 2026-09-30

- The desktop app no longer checks which AI tools are installed every time it opens; it checks when you create a bot or run setup.

- On macOS, HQ Sync restarts after an abnormal exit and waits at least 30
  seconds between crash restarts. Existing enabled LaunchAgents are refreshed
  on app startup, and the updater handoff avoids a duplicate restart.

- Internal desktop regression tests now exercise runtime behavior instead of reading implementation source text.
- Core update failures caused by low snapshot space now report a dedicated
  diagnostic class and coarse required/available space buckets.

- Startup reporting now treats pending first-run consent and confirmed
  missing-root recovery as expected.
- Desktop setup continues to report installation failures after an internal error interrupts its diagnostic cache.

- The existing sync plan-limit notice can report gated exposure and Upgrade-click measurements.
- Successful sign-ins can wait for their local receipt queue write behind a default-off flag before returning to the setup flow.

## [0.10.363] — 2026-09-30

- Opening a conversation no longer shows an empty pane when recent activity was hidden; older messages from people load automatically.

## [0.10.362] — 2026-09-30

- Conversations now hide work-mesh activity even when it is posted under a person's name, and the sidebar orders by messages people typed.
- Channels and conversations now show only messages from people. Work-mesh activity (noted, started, and done lines), session cards, system events, and bot-only messages are hidden. A bot's reply in a conversation a person started still shows. A channel with only hidden activity shows "No messages yet".

## [0.10.361] — 2026-09-30

- When a company is over a Starter plan limit, a refused action now says why
  in plain words and offers an "Upgrade plan" link. A chat attachment that
  goes over the storage limit reads, for example, "Could not upload
  report.pdf: New files are paused while Acme is over its Starter limits.
  Storage: 10.2 GB of 10 GB used." Accepting an invite to a company that is
  at its member limit shows the same kind of sentence instead of raw server
  JSON. Plan-limit refusals are no longer reported as crashes.
- When a sync pass skips new files because a company is over its storage
  limit, HQ now says "Uploads paused" for that company instead of "All
  synced". The desktop window shows the notice even if it was opened after
  the sync ran, the Core status panel names the company with an "Upgrade
  plan" button, and the menu bar (and the Windows tray) lists "Uploads paused
  for Acme" with an "Upgrade plan for Acme…" item. The notice clears once
  uploads go through again. Upgrade links open only for hq.computer, the
  host HQ's billing uses.
  The sync engine moves to hq-cloud 6.18.17, which skips files refused by a
  plan limit instead of failing the sync.

## [0.10.360] — 2026-09-29

- Leaving a channel and removing a bot from a channel work again, and bots in the member list have a remove button.

- Files saved while a folder like `node_modules` or `build` is being created,
  or in the brief moment when HQ changes which folders it watches, now sync
  right away. Before, they waited for the next full rescan, up to six hours
  later. The sync engine moves to hq-cloud 6.18.16.

- The "Syncing initial cloud data" step of a new install now finishes in
  seconds instead of about two minutes. Once your personal vault is set up,
  the step hands the upload to HQ's background sync, which was already
  pushing the same files. The step only does this when background sync is
  running, Auto-sync and Personal sync are on, sync is not paused, and you are
  signed in. In every other case the step uploads the files itself, now eight
  at a time instead of one at a time. When the step hands off, the app checks
  that background sync actually saved your personal files and uploads them
  itself if it did not. The `desktop.install-initial-sync-handoff` flag
  controls this and is on by default; turning it off restores the previous
  one-file-at-a-time upload.

- Behind a flag (`desktop.human-only-conversations`, off by default): conversations can hide work-mesh and automated messages, and the sidebar can order by the latest message from a person.

- When creating a cloud bot, each size now shows its own monthly price ($100, $250 or $500). If your company pays a different amount, that amount appears underneath.

## [0.10.359] — 2026-09-29

- First-time setup is now one five-screen welcome flow that fills the screen
  (everything below the menu bar and beside the Dock) with no window
  shadow. On macOS the background is your own desktop wallpaper, blurred
  and dimmed; other app windows no longer show through. If the wallpaper
  cannot be read, and on Windows, the window keeps a soft blur of whatever
  is behind it. The same full-screen window is used for the sharing
  re-prompt and "Replay welcome intro". The window has the standard close
  and minimize buttons (top left on macOS). Minimize puts it in the Dock or
  taskbar. Close hides it without quitting or cancelling setup: the install
  keeps running, and clicking the menu-bar item or the Dock icon brings the
  flow back on the same screen. You sign in with Google or Microsoft, pick
  where HQ lives, and choose "Install here". If you are already signed in
  to hq.computer in your browser, the sign-in screen shows one "Continue as
  {your email}" button in place of the Google and Microsoft buttons and
  waits for you to press it. The install then runs in the background while
  two short screens explain cloud sync and the Option Shift O shortcut. A
  small card in the corner shows the real install progress, and install
  errors show there with a Retry. The last screen leads with a large white
  HQ Desktop card ("Use HQ's own app"). Under it are smaller "Claude Code"
  and "Codex" buttons that open HQ in that tool with setup ready. Each
  shows only if the tool is installed, and appears if you install it
  while the screen is open. If a tool fails to open, the screen says
  what to do next in one line. HQ Desktop and the tool
  buttons stay disabled until the install is done, and HQ Desktop says
  "Getting ready..." meanwhile. The usage-sharing question is no
  longer its own screen: the last screen has one "Share anonymous usage
  data" checkbox, checked by default, with a "What's collected" link.
  Nothing is sent until you finish from that screen, whichever option you
  use. If sending your choice fails, the screen says so and offers Retry;
  if you are offline, your choice is saved on this computer and you can
  finish now and have it sent later. The separate full-screen intro film
  is gone; "Replay welcome intro" now plays the first four screens with
  Next and Done. The flow respects Reduce Motion, works from the keyboard
  and with a screen reader, and pauses its animation when the window is
  hidden.
- After a fresh install, HQ Desktop shows an eight-step guided tour once,
  starting on the setup page. It points out the setup bot, the Files button,
  the "+" button for a new bot, the Companies section, Meetings, the web
  console, the Launch menu and the Command-K palette. Next moves on; Skip,
  Done or Esc ends the tour and leaves you on the page you were on.
  "Take the tour" in the Command-K palette plays it again.

- A local bot's model picker lists specific model versions: Claude Opus 5.5,
  Opus 5, Sonnet 5 and Haiku 4.5; GPT-6 Astra and GPT-5.5 for Codex; and
  Grok 4.7, 4.6 and 4.5. Bots that already use the older Opus, Sonnet or Haiku
  setting show it as "(latest in Claude Code)". When a specific model is
  picked, a note says to update the coding tool if the bot cannot start with
  it, and a bot whose tool does not know its model now says so in plain words.

- Personal workspaces with a cloud vault can show their board when the
  `desktop.personal-workspace-board-v1` hq-flags rollout is enabled; it stays
  off until explicitly enabled.
- In a DM with a bot, the "is thinking" / "working on it" line now
  disappears as soon as the bot's reply appears, instead of staying under
  the reply for a few more seconds. It shows again when you send another
  message or the bot reports new work.

- Setup uses HQ's managed Node.js and npm to install qmd and the HQ CLI.
- Sign-in keeps working after an internal error during an earlier sign-in attempt, instead of failing until the app restarts.

## [0.10.358] — 2026-09-29

- Startup sign-in diagnostics now distinguish an invalidated saved token from a token-store read race without sending credential data.
- Desktop sync commands now recover their valid state after a mutex is poisoned.

- Auto-sync memory-ceiling reports now include the active sync phase and its
  elapsed-time bucket, so recurring memory failures can be compared across scan,
  pull, and push work.

## [0.10.357] — 2026-09-29

- Core updates now report distinct clone failure causes and retry network or unsupported Git filtering failures once.

## [0.10.356] — 2026-09-29

- If a Core update overlaps an active HQ change, HQ defers it and retries on a later check instead of reporting an update failure.
- Pin the third-party actions used by the release monitor and UI-only publish workflow to their resolved commits.
- The optional setup-stage timeout mitigation is off until enabled in hq-flags. When enabled, dependency install, template download and extraction, and search indexing timers restart when that stage reports progress and still stop at a maximum elapsed time.

## [0.10.355] — 2026-09-29

- After an updater restart, HQ checks local tools again before reopening setup for an existing installation. If the HQ folder is missing, the folder picker opens so it can be found or installed again. An unanswered consent question still appears at startup.
- After setup, people in a single-member company can optionally invite a
  teammate. The step is off until its hq-flags rollout is enabled and can be
  skipped.

## [0.10.354] — 2026-09-29

- If HQ cannot refresh saved credentials at launch, it keeps the loading screen up and checks again every five seconds. It shows sign-in after Cognito confirms the credentials are invalid.
- Core update failures now classify active HQ changes, generic clone failures, and rsync partial transfers separately in diagnostics.
- Core update rescue error classes for deferred updates and restore symlink races now pass Sentry's diagnostic filter.
- Build workflows now pin third-party actions to fixed commits. Manual Windows checks use read-only repository access.

## [0.10.353] — 2026-09-29

- The Window opacity slider in Settings > Appearance now works. Lowering it makes the window see-through, 100% keeps it fully solid, and the setting is remembered after the app restarts. On Macs the glass effect turns off at 100%.
- With `desktop.push-events` enabled, realtime events trigger share and direct-message refreshes. If the connection drops, the app checks every five minutes, including while all windows are hidden, so tray launches retain a notification long-stop. Scheduled checks pause while push is connected. When the flag is off, the existing 60-second cadence continues.
- Core update diagnostics now group deferred baseline refreshes separately from local
  baseline read or write failures.
- History search now requires 2 to 100 characters, matching the server limit.

## [0.10.352] — 2026-09-28

- After setup passes, people can start syncing their HQ folder right away. The optional first-folder step is off until its hq-flags rollout is enabled, and can be skipped.

## [0.10.351] — 2026-09-28

- The New bot wizard and the setup assistant now offer "Set up with Claude"
  and "Set up with ChatGPT" buttons when the app finds no coding tool on this
  computer. Clicking one opens the person's assistant desktop app with a
  short install prompt already in the composer; the assistant does the
  install and tells the person to switch back to HQ. When neither assistant
  app is on the computer, HQ still runs its own one-click installer, so the
  panel never dead-ends. The main text no longer mentions `npm`, a terminal,
  or a file path. The two places share one component and one adapter so they
  cannot drift.
- The "Install Claude Code" button now says what is happening while it
  works. During the install the panel reads "Installing Claude Code on this
  PC. This usually takes about a minute. No need to click anything.", and
  as soon as the installer finishes HQ re-checks by itself. When the tool is
  found on the second look, the panel confirms "Claude Code is installed.
  Sign in to finish." and offers Sign in as the primary action. No more
  "Working…" for 30-40 seconds followed by the panel snapping back to its
  original state. The same behaviour applies to Codex.
- If the install fails, HQ shows a plain-language reason instead of raw
  installer output. Known signals (no internet, permission denied, an
  antivirus block, a missing dependency, no disk space) become one-sentence
  explanations that name the tool and the next step. Anything HQ does not
  recognise falls back to "HQ couldn't finish installing Claude Code. You
  can try again or install Claude Code yourself, then click Check again."
  The raw error still goes to the app log for support.
- The footer next to Next in the New bot wizard no longer contradicts the
  panel above. When the panel shows the install path it now reads "Finish
  setting up Claude Code above."; after installing and before signing in it
  reads "Sign in to Claude Code above." The panel and the footer read as one
  thought, never two competing sentences.
- The setup assistant's top line no longer opens with "No coding tool is
  signed in on this computer yet. Sign in to Claude Code, Codex, or Grok,
  then retry.". It now reads "HQ needs a coding tool signed in on this
  PC to finish setup. Sign in above, then Retry." Purpose first, and no
  three-tool list right after the person installed one.
- Windows template setup can reuse matching content links and use a gated copy or junction fallback for selected link errors.

## [0.10.350] — 2026-09-28

- With `desktop.setup-directory-parent-fallback` enabled, HQ uses a fresh `hq`
  subfolder when the chosen location already has files. Before setup, it checks
  the suggested `~/hq` folder too. If HQ cannot write to a location, the folder
  step explains how to choose a different one or grant access. The flag
  defaults off.

- On Windows, setup can wait for the desktop CLI updater to finish before reporting a dependency failure. The default-off hq-flags rollout also gives selected-prefix rename locks more time to clear between retries.

- Channel messages now keep mentions aligned with their person or agent IDs and within the 25-person limit.

- Sync plan-limit upgrade links now carry desktop_limit attribution into billing telemetry.

- Desktop sign-in now retries once after an expired or mismatched browser
  callback and uses another registered localhost callback port when the
  default port is occupied. If the retry fails, the provider buttons stay
  available.
- The New bot wizard no longer replaces the app with a "Something went wrong"
  screen on Windows. When the runtime CLI was not found, the "Where HQ looked"
  list could hold the same folder twice (on 64-bit Windows the Program Files
  and ProgramW6432 env vars point at the same place), and the wizard's list
  rendering crashed on the repeat. The list is now deduplicated before it is
  shown, and the folder appears once.
- Small copy fixes in the New bot wizard for Windows: the Memory choice now
  reads "This PC only" instead of "This Mac only", and the create-form
  keyboard hint reads "Ctrl+Enter TO CREATE" instead of the Mac symbol on a
  PC.
- Core updates now retry with the bundled Git when the system Git is too old for partial clone filtering.
- Removed an unused internal script left over from the old installer. No change to how the app updates.
- After desktop sign-in, the browser tab no longer leaves the one-time sign-in code in the address bar or history: the page clears it and closes itself where the browser allows.
- Behind the `desktop.hq-daemon` flag (off by default), the app runs
  `hq daemon` as its own child process in place of its background sync
  runner, sync supervisor, Work Mesh service and scheduled CLI updates. The
  daemon handles sync, Work Mesh, bots, search indexing and its own updates,
  and the app restarts it if it exits. Turning sync on or off in the app turns
  the daemon's sync unit on or off. The app still shows conflicts, plan-limit
  notices, errors and changed files from each sync pass. The flag is read at
  launch and needs an installed `hq` new enough to be hosted; otherwise the
  app keeps its own services.

## [0.10.349] — 2026-09-28

- The returning-user setup welcome uses current HQ Desktop wording, and the
  retired `g a` shortcut no longer opens a stale Atlas destination.

## [0.10.348] — 2026-09-27

- When an update restarts the app before the HQ folder is available, people
  who have completed setup stay on the normal app surface instead of seeing
  onboarding again.

- Setup and bot-picker copy now names the user's actual computer instead of
  guessing. On macOS the app says "this Mac", on Windows "this PC", and on
  Linux or before the platform probe has landed it stays "this computer" so
  a Windows user never briefly reads "Mac" and a Mac user never briefly
  reads "PC". The setup bot's hello and kickoff, its Home card and hero,
  the install error, the "Signed in on this ___" runtime hints, the New bot
  picker, the Settings AI-tools lede, and the returning-user welcome all go
  through one shared helper. The onboarding wizard also shows an honest
  expectation under "Getting your HQ ready": on Windows it explains that
  antivirus scans and background installs make setup take longer, so a
  long-running step no longer looks stuck.
- MIGRATION.md: restore the historical updater endpoint URLs with '(retired, never launched)' annotations and add a dated note that the shipped app uses GitHub Releases for updates. Wave 2a of the getindigo.ai deprecation (docs-only, no runtime change).

## [0.10.347] — 2026-09-27

- The usage data choice during setup now starts on "Share usage data", and its
  selection circles are drawn in full instead of being cut off on one side.
- The setup bot's first message now mentions that you can run it in Claude Code
  or Codex from the Launch button.
- When setup finds no coding tool installed, the Home setup card offers a
  guided path instead of the old dead-end "Open in Claude Code / Codex"
  buttons. One click installs Claude Code, a plain progress line shows what
  is happening, and after it lands HQ walks you through signing in inside
  Claude Code's own window. Your password never comes to HQ. If the install
  fails, the card says why in one sentence and offers a manual download.

## [0.10.346] — 2026-09-27

- New Files page (Cmd+5, or the file icon in the title bar). It opens full
  window like Settings, with Back to return to Messages. Browse your
  personal vault and each company vault on this Mac. Notes open in a reading
  view with their properties, clickable [[links]], an outline, and the notes
  that link back to them. Cmd+O jumps to any file. Settings folders and key
  files are never shown. Large company vaults (tens of thousands of files)
  stay fast: search, links and counts come from an index the app keeps up to
  date in the background, folders with thousands of files scroll smoothly,
  and a very large note shows its first part with a button to open the rest.
- Markdown documents of a few megabytes no longer crash the reading view.
- A company you were just added to, including one the setup bot creates for
  you, now syncs onto this Mac by itself. The "Added to … Sync to pull it"
  banner only appears when that sync fails, and its Sync now button retries.
- The setup bot now has a name, picked at random from 100 friendly ones
  (Pickles, Mochi, Waffles…), and never one a bot you can already see uses.
  It says its name in its first hello. If you started your own company, the
  card at the end of setup can also offer to put the bot in Slack; clicking it
  asks the bot to walk you through it.
- The setup bot's messages can now end with suggested replies: a few buttons
  under its newest message with the likely answers to its question, or the
  next questions to ask. Clicking one sends it as your reply. They go away
  once you reply. The last button, "Something else", puts the cursor in the
  message box so you can type your own answer.
- The setup bot now opens by asking whether you want HQ explained first or
  want to jump straight into setup, instead of starting the first step right
  away.
- Clicking a new company's channel right after the setup bot creates it no
  longer lands on the "no longer available" page. The company rail now asks
  the host to re-read its company roster as soon as a channel names a company
  the roster is missing, and the unavailable page re-opens the channel once
  the company shows up.

## [0.10.345] — 2026-09-27

- Stable releases now keep their published notes out of Unreleased. The changelog
  check also catches repeated notes before the next tag is cut.
- On Windows, the CLI updater defers a busy target when no holder is found. It retries on
  later launches and reports a persistent failure after three attempts.
- Automatic Core updates wait for startup cache preparation. If it times out, the
  update is deferred to a later automatic check. Manual updates remain unchanged.
- Setup cancellation treats SIGTERM EPERM as clean only when a full process group
  probe confirms no live members. Live groups and SIGKILL errors still surface.

## [0.10.344] — 2026-09-27

- On Windows, setup uses Winget for Git and checks qmd's launcher before marking setup complete.
- Windows setup waits for Git before installing qmd and rechecks Git after a specific WinGet failure.
- Updater restarts now find Node from the app-managed toolchain, preventing completed installations from reopening setup when Node is available.
- Updated in-app help and docs links to point to docs.hq.computer (the new docs domain). The old docs.getindigo.ai address continues to work.

## [0.10.342] — 2026-09-27

- When enabled, cancelling setup treats an installer process group with no live
  members as already cleaned up instead of reporting a cleanup error. The
  rollout flag is off by default.

## [0.10.341] — 2026-09-26

- When enabled, automatic Core updates wait for startup cache preparation before
  running the rescue. If the wait limit expires, the update moves to a later
  automatic check; manual updates keep their current behavior. The rollout flag
  defaults off.
- Windows releases no longer fail to save the prebuilt native app, because it is now compressed and trimmed to stay under GitHub's 2 GiB file limit.

## [0.10.340] — 2026-09-26
- Update holds now apply to manual installs too, and a recording that ends with an error no longer blocks updates.
- When sync moves unchanged company files into `.hq/scope-quarantine`, the Git mirror keeps them out of deletion commits. The `desktop.mirror-quarantine-move-not-deletion` flag controls this behavior and is off by default.
- Release builds no longer recompile the native app every time. The job that
  prepares the native pieces after each merge now installs its build targets
  correctly and is no longer cancelled by the next merge, so a normal release
  assembles from the prepared pieces instead of building them from scratch.
- Core tests no longer start `npx` in the background or leave npm cache files
  in temporary home folders.

## [0.10.339] — 2026-09-26

- HQ no longer restarts for an update while you are using it or while a meeting is being recorded. A card in the sidebar lets you choose when to apply pending updates.

## [0.10.337] — 2026-09-26

- When Windows blocks an HQ CLI update with EBUSY and HQ's lock check finds no
  holder, HQ keeps the current CLI available and retries on later launches. It
  reports a persistent failure after three attempts.

## [0.10.336] — 2026-09-26

- Interface fixes can now reach installed apps within a couple of minutes,
  without a new installer or a restart. The app downloads a signed interface
  update, checks it was built for this exact version of the app, and offers
  "Interface updated — reload" (or reloads on its own when nothing would be
  lost). If an update fails to start, the app goes back to the previous
  interface by itself. Off by default for now; Settings shows which interface
  version is running.
- When the app shows sign-in or onboarding to someone who already finished
  setup, its error report now records which setup checks passed or failed.
  The report contains short fixed values only, with no file paths or account
  details. This helps us find why some people are sent back to onboarding
  after an update.

## [0.10.334] — 2026-09-26

- The sync engine moves to hq-cloud 6.18.5, the same version the `hq` command
  line tool now uses, so Update / Restore and `hq rescue` keep running the same
  engine. It brings the sync fixes released since 6.16.53.

## [0.10.333] — 2026-09-26

- On Windows, setup no longer fails when an old content folder link points
  to a folder that has since been removed. Setup removes the old link and
  creates it again. If linking still fails, the error report now says which
  step failed and why.

## [0.10.331] — 2026-09-26

- New "Record meetings automatically" switch in Settings → Meetings. When it
  is on, HQ starts recording as soon as it detects a call — Slack huddles,
  Zoom, Google Meet, Teams and Webex — instead of waiting for you to click
  Record. It is off by default. Calls a scheduled HQ bot is already recording
  are not recorded twice, and you still get the "meeting detected" alert.
- On Windows, the HQ CLI updater identifies the process holding its package
  files, waits for HQ's own processes, and retries around short-lived scanners.
  If you have the HQ CLI open in a terminal, the app leaves it running and
  checks for the update again later.

## [0.10.330] — 2026-09-26

- Releases no longer rebuild the native app when only the interface changed.
  The compiled app shell for macOS, Windows x64 and Windows arm64 is built
  once per change to the native sources, cached, and reused across releases;
  each release only builds the interface, stamps the release version into the
  bundle (macOS Info.plist, Windows exe version and installer metadata, and a
  `version.json` the app reads at runtime), then signs and packages. A release
  with a warm cache takes about 8 minutes end to end instead of roughly 30.
  Publishing fails if any bundle carries a shell that does not match the
  tagged sources. If the new pipeline ever needs to be bypassed, dispatch the
  release manually with `legacy_build: true` to use the old single-job build
  on both platforms. No visible change for users.
- The app now loads its interface from the installed bundle at runtime and
  reports the installed release's version (update checks, tray menu,
  telemetry, request headers) even when its shell was compiled for an earlier
  release. No visible change for users.

## [0.10.329] — 2026-09-25

- The project board is back. A new Projects page (Cmd+6, or the board icon in
  the title bar) shows one company's projects at a time as a board or a list.
  Opening a project shows its tasks by status, with task details, files and
  activity. Pick the company at the top of the page. It starts on the company
  of the channel you have open.
- A company's home channel now has a "Projects" tab next to Chat in the
  header. Clicking it swaps the message feed for that company's project board
  right there in the channel — the header (hero, title, gear, bell, member
  pill, and the Chat | Projects pills) stays put and nothing shifts size.
  Chat brings the feed and composer back.
- Fixed the Library header's Back button still overlapping the green
  traffic-light button on macOS — the shared gutter that keeps overlay
  headers (Library, Settings, Meetings, Notifications, Shared Files, DM
  requests) clear of the native window buttons was only 6px wider than the
  button cluster itself, thin enough to overlap on some renders. Widened it
  to a safer margin everywhere it's used, and added a test covering the DM
  requests panel, which had the shared inset already but wasn't checked here.
- Failed Windows Core updates now include a bounded rsync error class and
  translated path shape in diagnostics, without adding local paths.

## [0.10.328] — 2026-09-25

- Fixed the "Setting up…" spinner some Companies rows got stuck on: the
  company board, activity feed, and home-channel requests were missing the
  server's `/v1` URL prefix, so those requests always failed. Added a build-time
  check that fails CI if the app ever calls a server route hq-pro does not
  register, so this class of bug cannot ship again silently.
- Fixed layout shifts when opening a company's home channel — the wallpaper
  hero, the member-count and mute controls, and the message skeleton now hold
  their final size from the first frame, so nothing jumps as the company's
  real name, member count, and messages arrive.
- Fixed a bug where clicking a company in the sidebar's "Companies" section
  before it had a home channel yet showed a raw server error
  ("home-channel HTTP 404 Not Found: ...") under the row — the request was
  missing `/v1` in its URL. Clicking now quietly retries in the background
  (with a brief "Setting up…" state), and if it still can't connect, the row
  shows a plain "Tap to retry" hint instead of any error text — clicking it
  again always retries.
- Fixed the company channel header's settings gear rendering with a heavy,
  doubled outline (a malformed SVG path). Switched the mute control from a
  speaker icon to a bell (bell-slash when muted), to match the rest of the
  header icon set.

## [0.10.327] — 2026-09-25

- Simplified how the desktop app finds a company's main channel: it now opens
  the exact channel the server names (`homeChannelId`), instead of guessing
  from the channel's scope and name. This removes the old on-demand lookup,
  retry state, and spinner in the sidebar's "Companies" section — a company's
  home channel opens immediately, or the row shows "No company channel yet."

## [0.10.326] — 2026-09-25

- On Windows, HQ waits for its own command processes to finish before replacing
  the HQ CLI package and retries once if npm still reports a locked install
  directory.

## [0.10.325] — 2026-09-25

- Meeting detection now runs on the newest Recall recording engine, which officially supports Zoom and Teams meetings joined from Chrome, not only from the Zoom and Teams apps. Google Meet in a browser was already supported. Safari, Edge, and Firefox are still not supported for Zoom or Teams, so join from Chrome (or a Chromium browser like Arc or Brave) if you want HQ to notice the meeting.

- Fixed a bug where running the HQ installer after the desktop app was re-signed
  (or after any macOS keychain read error such as errSecAuthFailed) deleted the
  sign-in token file at ~/.hq/cognito-tokens.json, logging users out even though
  the desktop app and CLI had kept them signed in. The installer now treats the
  token file as a fallback when the keychain entry is missing, invalid, or
  unreadable; the file is deleted only on explicit sign-out. When both the
  keychain and the file hold valid tokens, the newer token (by expiresAt) wins.

## [0.10.324] — 2026-09-25

- Channel @mention notifications now work on installs whose local settings file does not record your person ID, and the first mention in a channel after the app starts now notifies too.
- The desktop app now asks for (and transparently decodes) compressed
  responses from the server, so the same data moves over the wire faster —
  most noticeable on the channel list for people in large companies.

## [0.10.323] — 2026-09-24

- Fixed the channel list failing to load for people in companies with a lot of
  channels. The app was giving that request the same short timeout as every
  other one, so once a company's channel roster got large enough, the response
  legitimately took longer to arrive and the request aborted partway through
  with a decode error. It now gets a longer timeout of its own.
- HQ Sync tells you to verify your email before it can show pending company invites.
- Fixed a bug where every company in the sidebar's "Companies" section showed
  "no home channel yet," even companies with a working home channel. The
  fallback check that resolves a home channel while the server catches up was
  comparing the channel's raw name (which carries a leading "#", e.g.
  "#indigo") against the bare company slug ("indigo") — they could never
  match. The "Companies" section rows are now compact (name only, single
  line) and default to your 3 most active companies by recent message
  activity; pinning any company from the header's pin menu switches the
  section to show only your pinned companies. A company whose home channel
  isn't loaded yet is now resolved on demand instead of staying stuck.
- Messages now separates people from bots. A new "Show bot messages" toggle at
  the top of Messages is off by default, so your inbox, unread badge, and
  notifications only carry messages meant for you. Agent-to-agent chatter is one
  toggle away and never counts toward unread or fires a notification. A thread
  whose recent messages are all from bots stays listed and shows how many are
  hidden; turning the toggle on reveals them with a small "agent" label.

## [0.10.322] — 2026-09-24

- Each company now has exactly one "company home" channel (settings,
  wallpaper). Other channels created inside a company are plain team
  channels. A new "Companies" section in the sidebar pins each company's
  home channel, and you can choose which companies show there.
- Company home channels show Chat only — the Office tab is hidden for
  company channels for now (the underlying calling code is unchanged).

## [0.10.321] — 2026-09-24

- Auto-sync memory alerts now include a bounded memory class and, for
  multi-process trees, the largest child's process type.
- Added internal telemetry to diagnose cases where a machine that was already set up and signed in shows the sign-in or setup screen on startup. No new information about your account is collected; the report records which setup state the app read at launch (such as whether setup markers were present), whether a token file existed and how old it was in minutes (not its contents), and which screen appeared. This data goes only to the development team and is used to find the cause if the sign-in screen returns on a configured machine.

## [0.10.320] — 2026-09-24

- HQ no longer shows the setup screen on every launch for machines that are already configured and signed in. If a previous version left the setup flag set incorrectly, the app clears it on the next start.

## [0.10.319] — 2026-09-24

- The setup finish card goes away as soon as you send the setup bot another
  message, instead of staying under the rest of the conversation.
- Files and images attached in chat upload again. Since vault storage turned on
  write protection, every attachment upload was refused, so bots and teammates
  never received the file.
- First-run setup now waits for activity from the initial personal-vault push
  before timing out. Template-install failures also record a bounded cause for
  diagnosis without sending local paths.

## [0.10.317] — 2026-09-24

- Sync and Meetings show the server's upgrade link when a plan pauses uploads or
  meeting-bot recording.

## [0.10.315] — 2026-09-24

- Switching channels or DMs in the sidebar now shows the new conversation
  right away instead of pausing first, even when leaving a long conversation.

## [0.10.314] — 2026-09-24

- Create company Cloud bots with Codex, Grok, or Claude. HQ shows the tenant price before creation and opens the Claude sign-in page after a Claude subscription bot is created.

## [0.10.313] — 2026-09-24

- When npm's metadata has not caught up to a new dependency version, HQ refreshes
  it and retries the CLI update. If needed, it tries npm's public registry.

## [0.10.311] — 2026-09-23

- Large sync-output bursts no longer build up in HQ's memory. If the app falls
  behind, the runner waits for the app to process more output.
- Mute a channel from the speaker icon in the channel header, or open the menu next to it to choose all messages, files and mentions, mentions only, or muted. Muted channels show a muted icon in the sidebar.
- Settings > Notifications can pause notifications (1 hour, 8 hours, until tomorrow 8am, or indefinitely) and turn DMs, mentions, shared files, all activity, and "added to a channel" alerts on or off. You can also let DMs through while paused. These settings follow your HQ account to every device.
- You get a notification when someone adds you to a channel. Clicking it opens the channel.

## [0.10.310] — 2026-09-23

- When sync finishes with per-file errors, events with the same exit code and
  dominant error class now share a Sentry issue. The cause and failure site stay
  attached for diagnosis.

- When someone @mentions you in a channel, HQ now shows a notification that opens that message. Mentions only count when they are structured (not just the word @YourName), and they stay quiet if you already have that channel open. Shared folders show a folder tile that opens Files instead of a file preview.

## [0.10.309] — 2026-09-23

- A private folder shared as `foo/` now appears as `foo/` in the app and its
  notification instead of looking like a file.

## [0.10.308] — 2026-09-23

- First-run setup now retries npm dependency installs after stale caches, interrupted installs, and registry metadata that has not propagated yet.

## [0.10.307] — 2026-09-23

- Core updates now report clearer failure details when rescue fails, including the failed stage, tool versions, and available disk space, without sending local paths.

## [0.10.306] — 2026-09-22

- When the onboarding window is replaced during startup, HQ no longer counts the brief screen teardown as an abandoned sign-in attempt. Longer stays still record how long the step was visible.

## [0.10.305] — 2026-09-22

- On macOS, the window buttons and the Back button in Library and Settings stay lined up when the Interface size is set to Compact or Large. Before, Compact slid the Back button under the green window button and shifted the title bar off centre.
- An open project updates when the same story changes on another device. A status change refetches that project, a work change reloads the company board, and a session that needs you or finishes updates the live marker on its card. You do not have to refresh the page. Needs the matching HQ Cloud release; with an older server the page still loads when you open it.

## [0.10.304] — 2026-09-22

- Core update failures now include consistent diagnostics, so repeated failures are grouped together and the report shows what went wrong without exposing local paths.

- Clicking a DM or file-share notification now opens the main window on that conversation, even when HQ was not running. Before, the click opened the small quick Inbox window or landed on Home. The quick Inbox window is still available from the menu bar icon.
- Links that start with hq:// (for example from an email or the HQ console) now open the right screen: a DM thread, a channel message, a file, a company, or Meetings. Existing hq-desktop:// setup and sign-in links work as before.
- When someone shares files with you, the DM thread shows a card of square file tiles (up to four, then a +N tile). Click the card for a grid of every file, and click a file to preview images, PDFs, and text right in the thread, or open anything else in Files. One share produces one notification instead of two. Needs the matching HQ Cloud release; with an older server the thread looks as before.
- Clicking a DM or file-share notification now opens the main window on that conversation, even when HQ was not running. Before, the click opened the small quick Inbox window or landed on Home. The quick Inbox window is still available from the menu bar icon.
- Links that start with hq:// (for example from an email or the HQ console) now open the right screen: a DM thread, a channel message, a file, a company, or Meetings. Existing hq-desktop:// setup and sign-in links work as before.
- When someone shares files with you, the DM thread shows a card of square file tiles (up to four, then a +N tile). Click the card for a grid of every file, and click a file to preview images, PDFs, and text right in the thread, or open anything else in Files. One share produces one notification instead of two. Needs the matching HQ Cloud release; with an older server the thread looks as before.

## [0.10.303] — 2026-09-22

- On macOS, the close, minimise and zoom buttons now line up with the toolbar. They were sitting about five pixels low.
- Back from Settings now always returns to the main Messages view, instead of whatever page you were on before you opened Settings. The titlebar arrows still walk back through your history.
- Core update failures now report their cause, and a finished update no longer runs the installer again when saving its drift baseline fails.
- Windows Core updates now install a real rsync executable before the rescue runs, and show a clear message when rsync cannot be installed.
- If a Core rescue applied the release but could not restore preserved files, automatic checks stop retrying that target and show where the preserved bytes were kept.

## [0.10.302] — 2026-09-22

- Story cards and the story detail pane now show who a story is assigned to. A person shows their photo or initials, an agent shows its mark, and a story with nobody assigned says Unassigned. The detail pane also shows who last changed the story. This uses the live project from HQ, so a name written only in the local plan does not override the assignment HQ has.

- Long status updates in a channel now read as normal wrapped text. A post over about 1,200 characters that used the round bullet for its points was being mistaken for a log dump and shown in a narrow grey code box with a sideways scrollbar and a "Show more" cut, which made it unreadable on a phone. The check now recognises that bullet as ordinary writing, so those updates wrap like any other message. Real log and JSON dumps still get the compact box.

## [0.10.301] — 2026-09-21

- Detected meetings now appear on the Meetings page with a recording destination picker, Start recording, and Stop recording. Opening the page after detection or after recording starts shows the current state, and the controls remain reachable in narrow windows.

- When the setup bot finishes, a card now appears under its last message with a button to open your HQ in Claude Code or Codex (only the ones installed on this Mac) and a button to open the HQ console. You can dismiss the card, and it stays dismissed for that bot, so it no longer follows you down the conversation after setup. Before, if the bot formatted its finishing note slightly differently, the note showed up as a block of code at the end of the chat and no card appeared; it is now recognised however the bot writes it, and never shown as text.
- A local bot's "thinking" line now stays up for the whole time it is working. It used to disappear the moment the bot posted a progress note, so a bot that was still busy looked finished and the chat went quiet. It now follows whether the bot is actually still answering, and clears when it is really done. Needs the matching hq-cli release to show the full turn; with an older CLI it behaves as before.
- The setup bot's first message tells you it is checking your Mac and that this can take a minute, so a slow first reply no longer looks stuck. The #welcome channel also offers to finish setup in Claude Code or Codex if you would rather use those, and the setup button is now called Open Setup Agent.
- The "is starting up" notice no longer flashes over a bot that is running and answering, when HQ Cloud briefly could not be asked whether it was online.
- On Windows, the HQ window no longer stays above every other app after signing in; Alt+Tab works again. The window still comes to the front once after you finish signing in, and lets other apps in front of it as soon as you switch away.
- Windows: the in-app updater no longer fails with "The requested operation requires elevation (os error 740)". The app now carries an explicit asInvoker manifest and the staged update helper no longer has "update" in its file name. Users on 0.10.246 through 0.10.299 need one manual reinstall of the current release to pick up this fix.

## [0.10.299] — 2026-09-20

- Picking several conversations at once in the sidebar now shows a checkbox next to each one, instead of the curved purple stroke down the left edge of the row. Hold Shift with the pointer over the sidebar and an empty box appears on every row so you can see what you can pick; click a box to pick that row. Shift-click to pick a range, Cmd-click to add or remove one, and Escape to clear, all as before. The boxes take up no space until you have something picked or are holding Shift, so the rows do not shift around as you move down the list.
- Developer tooling: the browser preview harness works again. It had kept pointing at five pages that were removed in an earlier cleanup, which left the preview blank; those entries are gone and a check now fails if a preview import ever stops resolving. No change for people using the app.

## [0.10.298] — 2026-09-19

- The New bot wizard now tells apart the three reasons a coding tool can't be used, instead of calling all of them “not signed in”. A tool that isn't installed says so and points at where to get it; a check that couldn't finish says so and offers to try again; only a tool that really is signed out offers Sign in. Sign in is no longer offered for a tool the app can't find, and a sign-in that doesn't open now says what went wrong instead of sitting on “Opening…”. The app also looks in more places for the tools, including Claude Code's own install folder and version-manager shims.
- Your personal bot can now be brought into a channel with other people. Add it the way you add anyone else, and everyone in that channel can tag it by name and get a reply there. It stays yours: nobody else can add it to a channel of their own, tag it into one you have not put it in, or message it directly. If someone tries, HQ says only its owner can add it and points them at you. Take it out of the channel and it disappears from everyone else's @ list again. Needs the matching server change to be live first.
- The New bot wizard no longer says Claude Code is not signed in when it is. On some Macs the check ran without the account name macOS needs to find your Claude Code sign-in, so it read an empty one and reported you as signed out — which also left Next greyed out and the Sign in button unable to fix it. It now looks under your own account, so a signed-in Claude Code is recognised. A Claude Code that really is signed out still shows as signed out.
- HQ no longer shows the first-run “Welcome to HQ” / sign-in screen to people who are already set up. On launch the app checks whether you are set up and signed in, and if that check cannot complete — which can happen for a moment right after an update installs and the app restarts — it used to assume you were a brand-new user and show the setup card. It now waits for a real answer, retries, and shows a plain loading spinner in the meantime. If your session has genuinely ended you still get the sign-in screen, and the reason is written to the app log.
- The New channel window now asks **Company or Personal** first, and only shows the company list when you pick Company. Choosing Personal and then adding someone used to switch you back to your first company and ask whether to add that person from outside it, so a personal channel with another person could not be made. Personal now stays Personal no matter who you add, and there is nothing to be outside of, so nothing asks. Company channels are unchanged: the company list still greys out companies someone is not in, and still asks before you add someone from outside the one you picked.
- You can give a new bot a real name. The name field used to refuse anything but lowercase letters, digits and hyphens, so “Dr Love” was rejected. It now takes whatever you type — spaces, capitals — and works out the handle to mention it by, shown under the field as “@dr-love”. If that handle is already taken by one of your bots, or your name has nothing to make a handle from, it says so and opens a Handle field to fix it there, instead of making you rename the bot. The bot shows its name in the sidebar, in your messages list and in Settings; bots you made before this still show the name they had.
- The New bot flow now says what “Personal” means for other people: a personal bot has no company identity, so teammates can’t find it — make it a company bot if you want to share it.
- Channel notifications now look up who sent the message and avoid repeated anonymous entries. If the sender cannot be retrieved, the feed shows one “New messages” summary for that channel. Existing anonymous summaries are consolidated, and files without a recorded author show “File added” instead of “Someone added a file”.

## [0.10.297] — 2026-09-19

- Links in channel and thread messages are easier to see. A pasted URL used to render in the same dim grey as the surrounding text, so it barely read as something you could click. It now uses the violet the app already uses for other clickable text, still underlined, and brightens when you hover it.
- The profile you get by clicking someone's name now has a Message button under their name. It opens your direct message with them — the existing one, or a new one — and closes the profile. It is not there on your own profile, and it works for people outside your company without asking to add them first.
- Meeting detection can be switched on again. HQ can only spot Zoom, Teams, and Meet calls on your Mac once you allow it Accessibility, Screen Recording, and Microphone, and the screen that asks for those had no way in since the Sessions cleanup — so on a fresh install detection was quietly off and nothing said so. Settings → Meetings now has a "Meeting detection" row that shows what is missing and a Set up button that asks for each permission and starts detection as soon as everything is allowed. The Meetings screen shows the same "Meeting detection is off" note with a Set up button.
- Clicking a "Meeting detected" alert now starts recording that meeting, and opens the Meetings screen so you can see it running. It used to open the Meetings screen and stop there.
- Creating a company now checks the handle while you type it. A moment after you stop typing it says whether that handle is free, and if it is taken it offers one that is not — click it to fill it in. A handle with the wrong shape says what to change before it asks the server at all. "Create company" stays off while it is checking and while the handle is taken or malformed. If the check itself cannot run, it says so and lets you create anyway; the server still decides. The line sits in the same place whether it has something to say or not, so nothing on the form jumps around. Needs the matching server change to be live first.

## [0.10.296] — 2026-09-19

- You can create a company straight from search. Type a name and pick "Create company <name>": the same window shows a second step with the company details and a list of people to invite by email, and "Create company" makes it. The app then switches to the new company and opens its channel. "New company" in the sidebar and the company switcher goes to that step too, instead of sending you to the setup channel. Back returns to search with what you typed still there, and if the server refuses — a name already taken, an invite it will not send — it says so in the window in its own words.

## [0.10.295] — 2026-09-19

- Hovering the grey email under a name in the sidebar no longer pops a tooltip repeating the same email. Sidebar sub-labels now show a tooltip only when the text is too wide for the rail and gets cut off, and the tooltip then shows the full value.
- You can now type `@here` in a channel or a group message to notify everyone currently in it. It appears at the top of the @ list, is picked with the keyboard like a person, and shows as a mention in the message you send. It reaches people only — a bot still needs its name typed — and anyone who can post in the conversation can use it. Someone you tag by name in the same message is notified once, not twice. Typing it as part of another word, in an address like `nowhere@here`, or inside code is just text. One-to-one messages do not offer it: there is only one other person and they are already notified.
- Switching between channels and direct messages no longer shifts the page as it loads, and no longer scrolls down a little at the end. The newest message is against the composer from the moment the conversation appears, and it stays there while avatars, images and reactions finish loading. A conversation you have already opened comes straight back with a short fade instead of a blank pane, and one you have not opened yet shows placeholder rows the same size as real messages. If you have scrolled up to read older messages, late-arriving content no longer drags you back down.
- You can @mention someone from outside your company again. Tagging a person who is not already in the channel now adds them to that one channel and delivers the mention, instead of refusing the whole message. They get read and post in that channel and nothing else — no access to your company, your files, or any other channel. Needs the matching server change to be live first.
- When two people in the @mention list share a name, the list now always shows something next to each one, so two identical entries for different people can no longer appear. It shows their company, or their email address. For someone the app knows only by name, it looks the email up and marks the row as outside your company in the meantime, and keeps that mark if the lookup comes back empty. Two bots with the same name show a short id, which is the only thing that tells them apart.
- A test or development build of HQ running alongside your installed copy no longer shuts the installed copy down when it starts. Each build now only manages the startup entry and processes that belong to its own install.
- When a reply in a thread fails to send, it now says why instead of just "Failed — tap to retry". If the message tagged someone the channel will not accept, it names the @mentions and tells you to remove the name, and it no longer offers a retry that could never work. A genuine connection problem still offers the retry.
- The @mention list in a company channel no longer offers people that channel will always refuse. Tagging someone who is not in the company rejected the whole message, and when the same person had two entries the picker showed two identical names with no way to tell which one worked.

## [0.10.294] — 2026-09-18

- Picking one person in search now opens the direct message right away, including people outside your company. The prompt about messaging someone outside the company no longer stands in the way of writing to them directly.

## [0.10.293] — 2026-09-18

- On the "HQ is ready" screen at the end of setup, the Advanced section now starts open, so the Open in Claude Code and Codex buttons are in view straight away. Its note now recommends that path if you already use Claude Code or Codex. You can still close it.
- Deleting an @mention from your draft before you send now really removes it. Previously a person you had picked from the mention list and then deleted was still mentioned when you hit send, which also invited them to the channel. Only the people still @mentioned in the message you send are mentioned and invited.
- Bots no longer fill up your sidebar the moment someone creates them. Creating an agent announces it to everyone in the company, so a day of fleet work put dozens of never-used bot rows — each with a "1" badge from the announcement — at the top of every teammate's list. A bot now gets a row only once it has actually messaged you, you have messaged it, you pinned it, or it is one of your own bots. You can still find and start a conversation with any bot from the "+" and search, and sending the first message brings its row in.
- The "… just joined" announcement no longer counts as an unread message, and no longer pops a desktop notification for every bot created. In the notifications list those announcements are hidden unless you run the company's bots, where they group into one line per company per ten minutes.
- The welcome film now plays full screen. It covers the whole display — over the menu bar and the Dock, with no window edges or rounded corners — and your own desktop blurs and darkens underneath it as the film fades in, then comes back as it fades out. It used to open as a large window inside the usable screen area, so the menu bar and the Dock stayed on top of it. Both ways in are covered: the first run of a new install, and "Replay welcome intro". Escape and Skip intro still end it at any point, and the window goes back exactly where it was.

- The folder in the welcome film is folder-shaped again. It was drawn half again wider than it was tall, so at full screen it read as a folder that had been pulled sideways. Its glow was a wide oval for the same reason, and the two dots on the line out to the file tree were slightly squashed. All three are drawn to their own proportions now, at any screen size and with reduced motion on.

- Fixed a build break that stopped the macOS app from compiling at all. Removing the menu-bar panel renamed the internal helper that brings the setup card to the front, and the setup-skip guard added in the same release was still calling it by its old name.
- Setting up Git no longer fails with "Text file busy". Right after HQ installs its own copy of Git, the check that makes sure Git works could run while the file was still being written and report a startup failure. HQ now waits briefly and retries before giving up.
- The same "Text file busy" problem is now handled everywhere HQ starts a program it may have just written. Checking which version of the HQ command line is installed, and checking whether Node is working, could both report a failure when the only thing wrong was that the file was still being written. Both now wait briefly and retry instead of reporting a false problem.
- Setup can no longer be skipped by accident. The welcome film teaches the Option+Shift+O shortcut, and pressing it during setup used to close the setup card and open the full HQ window with nothing installed underneath. Until setup finishes, that shortcut — and every other way of opening the HQ window — now brings the setup card back instead.
- The small menu-bar panel has been removed for good. It stopped opening for signed-in people in the previous release, and the code behind it is now gone. Everything it used to show lives in the main HQ window. Setting up HQ for the first time and signing back in still happen in the small window as before, and the menu-bar icon, its unread count and its right-click menu are unchanged.
- Unread dots in the small shared-file window now come from HQ's servers rather than a mark that only the menu-bar panel could update. They would otherwise have stopped changing once that panel was removed.
- You can now archive conversations in the left sidebar to get them out of the
  way. Right-click one and choose "Archive conversation", or pick several at
  once: hold cmd (or ctrl) and click to add rows, hold shift and click to take a
  whole run of them, then hit Archive in the bar at the top of the list. Press
  Esc to drop the selection. Archiving only hides a conversation — nothing is
  deleted, and anything unread stays unread.
- The filter menu has a new "Show archived" switch. Turn it on and archived
  conversations come back into the list with a small "Archived" label, so you
  can read them or unarchive them, on their own or several at a time.

### Release process

- The release check that launches the built app as a signed-in test user now gives that user a finished HQ install: an HQ folder and the `hq` command-line tool. Since setup can no longer be skipped, a sign-in alone is treated as an unfinished setup and the app correctly shows setup, which failed the v0.10.292 release. If the check sees that again, it now says so directly.

## [0.10.291] — 2026-09-18

- Messages in a channel now have a Copy button next to Reply. Hover a message and click Copy to put its text on your clipboard; the button reads "Copied" for a moment to confirm (#922).
- "Replay welcome intro" now actually plays the welcome film. Choosing it from
  the menu-bar icon did nothing at all while you were signed in: the film plays
  in HQ's compact window, and that window stays hidden behind the main HQ
  workspace, so nothing came to the front. HQ now brings the film forward, plays
  it, and puts you back in the window you were in when it ends.
- "Replay welcome intro" is also in the HQ menu at the top of the screen, right
  under "Recovery…", so you no longer have to find the menu-bar icon to watch it
  again.

### Documentation

- Company switching has integration coverage for the selected company context
  (#909).

## [0.10.290] — 2026-09-18

- HQ will no longer open as one of your automated agents. If the HQ credentials saved on this computer belong to a fleet agent rather than to a person, HQ now stops and asks you to sign in as yourself, instead of opening with the agent's name and address shown as your account. Signed in that way, HQ could not save your profile and showed none of your companies. Signing in normally is unaffected.
- HQ search no longer dies right after launch when the search tool was built for a different Node.js than the one HQ is running. HQ now notices the mismatch, rebuilds the search tool against its own Node, and does that on its own the next time the app opens.

## [0.10.289] — 2026-09-18

- The main HQ window no longer shrinks to a tiny thumbnail when the display it was on goes to sleep or is unplugged. When macOS moves the window to another screen it can leave it far smaller than the window's minimum size, and clicking the menu-bar icon brought it back at that size every time. HQ now checks the window each time it opens, and when the screen it is on changes: it is pulled fully onto the screen you are using, and a window that came back too small is restored to its normal size, centred.
- The first time you open HQ on a new computer, a short welcome film now plays before setup: four beats that say what HQ is, with a Skip button on screen the whole time. It plays once per computer — finishing it, skipping it or pressing Escape all drop you straight into the setup card, and it never comes back on an update, a relaunch or a resumed setup. If you want to watch it again, right-click the HQ icon in the menu bar and choose "Replay welcome intro". On a machine whose graphics cannot run it, HQ goes to the setup card instead of showing you a blank screen.

## [0.10.288] — 2026-09-18

- After an app update, HQ no longer re-opens the Welcome / sign-in card when HQ is already set up on this computer. A new app version can arrive before the `hq` command is upgraded; that mismatch is no longer treated as "not installed".

## [0.10.287] — 2026-09-18

- When a file changes in two places at once, HQ now names the file. The app used to be told only how many files clashed, so the Core panel could say "2 files need you" without ever listing them, and the Keep local / Keep cloud buttons had nothing to act on. Each clashing file now arrives with its path, from both a sync you start and the automatic background sync, so the list of files to sort out is the real one.
- Text you type in a message box is now the same size and spacing as the messages above it. The message box, the thread reply box and the messages themselves all read one shared setting, so typing no longer looks smaller than what you just sent.
- Notifications about channel messages now say who sent the message ("Jacob Posel sent a message"), with the channel underneath as context and the sender's initials on the avatar. They used to name the channel as the sender, hash suffix and all ("#project-fleet-bots-ga-sprint-a61db44b sent a message").
- Channel names in notifications no longer show the random id at the end, so you see "#project-fleet-bots-ga-sprint" instead of "#project-fleet-bots-ga-sprint-a61db44b".
- When someone adds a batch of files, the notifications list now shows one line per person instead of one per file — "cnueno@gmail.com added 14 files", with the shared folder underneath and the time of the most recent one. Clicking it opens what the newest file would have opened, and the unread count counts the batch once. A single file still reads "added a file".
- In the main HQ window, the Core panel's buttons for a file that changed in two places now work. Keep local, Keep cloud and Open in editor did nothing there — the resolve step only existed in the menu-bar panel. "Resolve conflicts" in the Core panel now opens Settings › Sync.

## [0.10.286] — 2026-09-17

- In a thread, the "is thinking" line for a bot now lines up with the messages above it and keeps a small gap from the reply box, instead of hugging the left edge and touching it.
- The message column in the main window now keeps a wider minimum width on a laptop screen and stays centred with growing side margins on a wide screen, instead of always giving up a fixed share of the width to margins. Nothing changes when a thread or profile pane is open.
- When HQ's servers are busy and ask the app to slow down, the app now waits the time it was asked to wait before trying again, instead of retrying straight away. Its background checks (bots, tasks, sync status, the channel list and the rest) are also spaced out slightly at random, so everyone's app no longer asks at exactly the same moment, and a check that was asked to slow down waits longer before the next one. In practice this means fewer "could not load" moments when a lot of people are using HQ at once.
- The Core panel in the main window (the "Core" button in the title bar) now tells you how sync is doing: whether everything is synced, a sync is running, or sync is paused, plus when the last sync finished and a live line while files are moving. The Core dot in the title bar turns amber when something needs you and reads as busy while a sync runs.
- The Core panel now also shows the sync problems that used to appear only in the menu-bar popover: files that changed in two places, a sync that started but needs a hand to finish, a companies list HQ could not read, and "cloud unreachable, showing local folders". Each one comes with the same Copy prompt (and, where it applies, Open in Claude Code) buttons you had before.
- When your HQ session expires, the main HQ window now says so. A notice appears at the top of the window with a Sign in button that takes you straight to signing in again. Until now sync just quietly paused, and only the menu-bar popover mentioned it.
- If a click on a message or shared-file notification does not go through, the main HQ window now shows a short notice with a Retry button that runs the action again. That recovery step used to exist only in the menu-bar popover.
- Companies on the white-label plan now see their own logo in the main HQ window's header, with the "powered by HQ" mark beneath it, the same as in the menu-bar popover. Everyone else sees exactly the header they see today.
- The small menu-bar panel no longer opens once you are signed in. Clicking the menu-bar icon, clicking the Dock icon, pressing Opt+Shift+O or launching HQ again all take you to the main HQ window, and everything the panel used to show now lives there. The menu-bar icon still changes as sync runs, still shows your unread count, and its right-click menu still works exactly as before. Setting up HQ for the first time and signing back in still happen in the small panel.
- Opening HQ from a notification, from the update banner, or from the Settings shortcut now takes you to the main HQ window instead of the small menu-bar panel. Finishing setup drops you straight into the main window too, and the notification-history link opens it on your notifications. The Opt+Shift+H shortcut that used to pop open the small panel is gone; Opt+Shift+O still opens and closes the main window.
- The main HQ window opens larger by default, about 1400 by 920 points instead of 1180 by 760, so conversations and the sidebar have more room on a laptop screen without resizing on every launch. The smallest allowed size is unchanged.
- Clicking a direct-message notification now opens that conversation in the main HQ window. It used to try to open a separate small "Messages" window; that window stopped being reachable a while ago and has now been removed, so there is one less window to keep track of and nothing else changes.
- The small floating HQ widget is gone. It sat on your desktop showing recent messages, conversations and activity. Everything it showed is in the HQ window's notification list, and a new message now arrives as the ordinary HQ notification banner again instead of being folded into the widget. The "Desktop widget" switch and the "Notifications widget" section of Settings are gone with it, as is the "Hide notifications" item in the menu-bar icon's right-click menu. If you had the widget turned off, nothing changes for you at all.

## [0.10.285] — 2026-09-17

- A Core update no longer stops because of one file it cannot back up, usually an iCloud file that has not been downloaded or a shortcut in your HQ folder that points outside it. HQ says which file it skipped, leaves it where it is, and finishes the rest of the update. That file is not backed up, so the snapshot cannot completely restore it. The update still stops if HQ cannot make a backup at all.
- Renaming or copying a company skill folder no longer stops that company's sync. Before, the renamed skill kept its old identity, the cloud refused it, and every later sync of the company stopped before uploading or downloading anything, while the app still showed the sync as complete. Now HQ gives the skill the right identity before uploading, and if anything about one skill still fails, only that skill is skipped and named; the rest of the company syncs.

## [0.10.283] — 2026-09-17

- The Back button in Settings now closes Settings and returns you to where you were before you opened it. It used to step backwards through each Settings tab you had visited first, so leaving Settings could take several clicks.
- You will not see a difference in daily use, but when a Core update fails, HQ now records whether it could not read a file for the safety backup, found a shortcut in the HQ folder that points outside it, or needs a newer version of Git for the update download. This does not fix the update by itself. It helps us see which cause happens most often, so we can fix that cause first instead of guessing.
- Conversations are easier to read: messages sit in a centered column with real side margins (they tighten when a thread or profile pane is open), the text is a little larger with more space between lines, and type renders lighter across the whole window. In the left sidebar the names are one size smaller with slightly taller rows, and unread counts are quiet grey numbers instead of white pills. Hovering a message no longer covers its timestamp with the reaction bar; the time now sits next to the author's name.
- The little widget's unread dots now come from the same place as the main notification list: a message shows as unread until you've actually read it, on any of your machines. Before this, the widget kept its own private "last looked" marker, so it could show old messages as new (or new ones as already read) with no way to fix it.

## [0.10.281] — 2026-09-17

- HQ no longer quietly stops part of what it is doing when the terminal or tool that started it goes away. If you launched HQ from a terminal or a script that was capturing its output and then closed that program, the next background task that tried to print a status line could crash on its own, so whatever you had asked for never finished. Printing a status line can no longer do that. The log at `~/.hq/logs/hq-sync.log` still records these details.

## [0.10.280] — 2026-09-17
- The little widget's unread dots now come from the same place as the main notification list: a message shows as unread until you've actually read it, on any of your machines. Before this, the widget kept its own private "last looked" marker, so it could show old messages as new (or new ones as already read) with no way to fix it.

- You can now reach every notification, not just the most recent 50. A "Load older notifications" button appears at the end of the list whenever there are more, and the ones already on screen stay put when you load more. Before this, if you had a few hundred notifications, most of them were simply unreachable in the app.
- While HQ is syncing, a small counter next to the bell shows how far along it is — "3 of 28" — so you can see a sync happening without opening anything. It disappears when the sync finishes. If sync needs your attention, the HQ Core button still shows that, as before.
- You can reply to a direct message straight from its notification, without leaving the list. Click the reply arrow on the row, type, and press Enter — or tap one of the quick emoji. If the send fails, your message stays in the box so you can try again.
- You can dismiss a notification without marking it read. The row goes away for now; the bell still counts it, so nothing you haven't dealt with quietly disappears. It comes back next time you open HQ.
- The "Reduce transparency" setting is gone. It was a stopgap: the frosted panels were being blurred twice over, and turning the glass off entirely was the only lever available at the time. That double blur is now fixed at the source, so scrolling is smooth with the frosted look left on and there is nothing to trade away. If you turned the setting on, HQ goes back to the frosted panels on its own. Turning down transparency system-wide in macOS Accessibility still works exactly as before.
- Keyboard shortcuts now work across the whole app, and pressing Cmd+/ shows the full list without leaving what you were typing. Cmd+1 through Cmd+4 jump between Notifications, Meetings, Marketplace and Library; Cmd+N starts a new chat; Cmd+F searches messages; Cmd+Shift+[ and Cmd+Shift+] step through your conversations in the order the sidebar shows them. Pressing g then a opens Atlas.
- A message you send shows up instantly and stays put. It used to be possible for your own message to appear twice for a moment when the server sent it back, or for the wrong copy to disappear if you sent the same thing twice.
- Long conversations paint faster. HQ was rebuilding the date and time on every visible row every time the list changed.
- Cloud bots can be given a Title when you create them, the same as bots that run on your Mac. The New bot Details step for a company-hosted bot now has a Title field under the name, it shows under the name in the preview, and it is saved onto the bot once the company finishes setting it up.
- HQ no longer treats a damaged or temporarily unreadable settings file as a brand-new install. If it needs to replace a corrupt file, it keeps the original copy so its settings can be recovered.
- If your Mac uses nvm for Node, HQ now updates the same `hq` command you run. Before, it could finish an update under HQ's bundled Node while your own command stayed on the old version.
- If an HQ Core update fails, recovery now keeps its safety copy usable on
  Windows, Macs, and cloud-backed folders. HQ can restore linked files and the
  rest of the saved update tree before you try again.

## [0.10.279] — 2026-09-17

- In "New bot", the option you have picked now looks picked. The Local or Cloud card you chose, the Personal or Company choice, and the runtime and memory options now carry a clear outline and a highlighted background, with the options you did not pick faded. On the default themes the chosen card used to look exactly like the others.
- Choosing who a new bot is for now happens on the same step as its name. "Who is it for?" has moved off the Local/Cloud step and onto the Details step, next to the name it affects. If you pick Company without belonging to one, the Details step says so there, where you can fix it.
- The New bot Details step now asks for a Title, and no longer suggests names or asks for an intro. The name field still starts with a suggestion you can type over, but the row of suggested-name buttons and the "Intro" box are gone. The Title you write shows under the bot's name in the preview and stays on the bot.
- An avatar you pick for a new bot now stays picked. Editing the name, closing the picker, or stepping back and forward again used to drop your choice back to the generated mark without saying anything, and the bot was created with that mark instead of the avatar you chose.

## [0.10.278] — 2026-09-17

- Scrolling long lists is smoother. Your notifications and your conversation list no longer make the app re-check every row you can't see, which is what made them feel sticky on long lists.
- New Appearance setting: Reduce transparency. It swaps the frosted panels for solid ones. The frosted look is the single biggest thing slowing scrolling down on a Mac, so if scrolling still feels heavy, turn this on and see — it takes effect immediately and you can turn it straight back off.
- Fixed: if loading older messages failed and you stayed at the top of a conversation, HQ would quietly keep retrying and the Retry button would disappear. Now a failure waits for you to click Retry.
- An HQ Core update no longer looks failed when the update finishes but HQ cannot save its tracking record. HQ still records the problem for support and tries again at the next update check.
- On Windows, updates no longer crash while finding your HQ folder or say a required part of HQ is missing when it is already there.
- On Macs, Core update can now recover safely after two interrupted updates leave unverified safety snapshots behind. It checks the restored files before retrying and keeps them if it cannot prove they are safe.
- On a Mac, Core update can now finish when the Git already on your computer cannot clone. HQ tries that Git first as before; if it finds an Xcode license prompt, a missing HTTPS piece, or an old Git that rejects the clone options, it tries once more with HQ's own Git. It never accepts an Apple license for you, and ordinary network failures still keep their original error.
- On Windows, an update no longer fails when another HQ window is finishing its setup. HQ waits for it to finish and only shows a problem if it takes too long.
- When companies you belong to have not been pulled down to this computer yet, the main window now shows a banner offering to sync them, instead of only mentioning it in the menu-bar popover.
- Starting a new message with someone no longer jumps straight into their DM. The people you pick collect in the dialog, so you can add more, name the group, and optionally write the first message before it is created. Messaging one person directly is still one click.
- Files a teammate adds to a company folder now show up in your notifications, so you can see what arrived while you were away without opening the menu-bar popover or browsing the folder. They sit in the list with your messages and shares, and clicking one takes you to your files. They do not mark the bell as unread — they are there to find, not to interrupt.

## [0.10.276] — 2026-09-16

- Bots are never taken off a computer they are running on. Opening HQ on a second Mac used to quietly bring every bot you own over to it, which stopped them on the first one — no click, and nothing said. HQ now leaves any bot that is still running elsewhere alone and only brings back the ones with nothing running them. You can still move one over whenever you want, from the banner, from Settings › Bots or from the bot's own conversation; those now say, in one line, "This bot is running on another computer. Starting it here stops it there." Bots after a reinstall or on a wiped Mac come back by themselves exactly as before.
- Setup reports no longer count a finished setup as abandoned.
- Your bots now come back by themselves. When HQ finds bots you own that aren't set up on this computer — after a reinstall, on a new Mac, or after an update wiped one — and a coding tool is signed in, it brings them back on its own, with no button to find and no click to make. One calm line says "Bringing back your bots…" while it happens and then names the ones that are back. If some can't come back, it says which and why, and the manual "Restore my bots" options are still there.
- Writing to a bot that isn't running starts it right there. Instead of "Not answered yet", the conversation now says "Starting this bot on this computer…" and brings the bot back immediately — your message waits for it and is answered as normal once it is online.
- The "this bot isn't running on this computer" notice now sits at the bottom of the conversation, just above where you type, instead of at the very top above older messages where it was easy to miss. The message it can't answer now carries the way out in the same line, so there is never a dead end.
- HQ keeps checking which bots your account owns. Before, the check could quietly stop for a whole session, so a bot that had stopped being able to run here went on showing a normal message box — for over six minutes in one test — and the only way out was restarting HQ. Each check now gives up after twenty seconds rather than blocking the next one, and a bot that disappears from this Mac prompts an immediate re-check, so the "can't run here" notice shows up within half a minute.
- Bots that run in HQ Cloud are no longer offered as something to bring back to your Mac. They cannot run here, and restoring one left a bot that failed every time your Mac started. They are no longer counted in "Restore my bots" and no longer get a "Start on this computer" button.
- A bot that stopped now gets the right explanation. A bot that runs in HQ Cloud says so, instead of telling you to check a sign-in that is already fine; the sign-in advice is kept for bots that genuinely need you to sign in again.
- Settings › Bots is now the lasting home for bringing bots back. The "Your bots are waiting" banner still appears once, but the "On another computer" section with "Restore my bots" — and a "Start on this computer" button on each bot — stays available for as long as you own a bot that isn't set up here.
- When HQ Cloud is too old to list the bots your account owns, HQ now says exactly that — "Restoring bots needs a newer HQ Cloud." — everywhere it comes up: the conversation with a bot that can't run here, the setup bot's conversation, and Settings › Bots. Before, all three said HQ Cloud "couldn't be reached" and Settings offered a "Check again" button that could never work. A cloud that genuinely can't be reached still says so, and still offers "Check again".
- Your bots stay yours when HQ Cloud can't be reached. If HQ can't look up the bots your account owns — an older HQ Cloud, no connection, or a sign-in that has lapsed — your own bots are no longer drawn as cloud bots, a bot this computer can't run still says so plainly, and a message you send it is marked unanswered instead of sitting under a spinner. Where bringing a bot back isn't possible right now, the button is replaced by one sentence saying why, and "Check again" is still there.
- Your bots come back after a reinstall. When HQ starts and finds bots you own that aren't set up on this computer — after a reinstall, or on a new Mac — it offers "Restore all" once and brings them all back with their names, their memory and your conversations intact. Turn it down and it won't ask again; you can start it any time from Settings › Bots.
- A bot that can't run on this computer now offers "Start on this computer" instead of only "Check again". One click rebuilds the part a reinstall took away and starts the bot; the conversation then carries on as normal. If it doesn't work, you get one plain sentence and a Retry — never technical text.
- Settings › Bots now lists the bots you own that live on another computer, each with a "Start on this computer" button, plus a "Restore my bots" action for all of them at once. Bots already running here are unchanged.
- Your setup bot gets the same treatment: if your account has one from an earlier install, its conversation now offers to start it on this computer rather than only telling you it lives elsewhere.
- HQ now knows which bots you own, not just which ones this computer has. That's what stops a bot's conversation sitting under a spinner while its own setup says it can't run here.
- The "Create a bot" name-and-handle card no longer appears in a company channel, and the "Add bot" button that posted it has been removed from the company header. Bots are made in one place now: "New bot" in the sidebar. An older card still sitting in a channel's history is simply not shown.
- Making a cloud bot still works, and now happens entirely inside "New bot". Choosing "Cloud" and picking a company takes you to a Details step where you name the bot and choose its @handle — the two things the company channel's card used to ask for — and then creates it and drops you straight into its conversation. The suggested name is only a starting point; nothing is created until you have seen it. If the company's plan cannot host a bot yet, you land on the plan card as before.
- If the company turns a new cloud bot down — usually because the @handle is already taken — trying again with a different handle now works. Before, the refusal could come back every time, with no way to clear it.
- Starting a bot from its own profile, or after signing a coding tool back in, now clears the "this bot is set up on another computer" notice. Before, the bot could be running while its conversation still said it could not run here, and your messages kept being marked unanswered. A routine check that finds the bot actually running on this Mac clears the notice too.
- When HQ has stopped trying to start a bot by itself, the conversation now offers "Check again" instead of nothing at all, and the setup card's "Retry" is shown as unavailable rather than looking clickable and doing nothing.
- Leaving the "Getting your HQ ready" screen and coming back now starts setup again. Before, in some cases it could come back to a screen sitting at 0% with nothing happening for several minutes.
- A setup step waiting to try again now reads "Retrying…", and keeps its progress bar and detail line visible while it waits.
- A bot's "is thinking" line now keeps moving while it works: it shows what the bot says it is doing as each update arrives, and otherwise walks through "is thinking", "is reading the context", "is working on it", "is still working". After fifteen seconds it also shows how long the bot has been going ("working for 42s"). The line still only disappears when the bot actually replies.
- The "Getting your HQ ready" setup screen now shows what it is actually doing. Under the step that is running, a line says which piece is being brought in and changes as the work moves on; after about twenty seconds it adds how long that step has been going, and the percentage keeps climbing throughout instead of parking on one number.
- Setup progress on the "Getting your HQ ready" screen now only ever moves forward. Before, if a step hit a hiccup and quietly tried again, the highlighted step could jump back to an earlier one for a moment. A step that is retrying now stays where it is, says "Retrying — attempt 2 of 3", and keeps its timer running.
- When a bot answers you in a direct message, its reply now appears right away. Before, the "is thinking" line could disappear at the same moment the reply notification arrived and leave the conversation looking like nothing had been said, until you clicked away and back.
- Run Setup now opens the setup bot you already have instead of failing. If you reinstall HQ, or set it up on a second Mac, your account already owns a setup bot even though this computer has never seen it — HQ now looks for it and opens its conversation rather than trying to make a second one. If two attempts do overlap, the one that loses simply opens the bot as well.
- A bot that is set up on another computer now says so instead of thinking forever. If your account owns a bot that this Mac has no copy of — after a reinstall, or on a second computer — its conversation says it can't run here yet and offers "Check again", rather than showing it as busy and quietly leaving your message unanswered. Anything you send it is marked as unanswered instead of sitting under a spinner.
- HQ now stops trying to start a bot that cannot start. A failure that will never resolve is tried once and then reported; a failure that might be temporary is retried a few times and then stops. Before, the same doomed start could be repeated indefinitely with nothing shown to you.
- Setup failures are now written in plain language. A message like `HQ API /v1/agents → 409: Entity with type="agent" and slug="setup-…" already exists` is never shown; the technical detail stays in the logs. The Connect step also says when a coding tool could not be installed, rather than blaming the sign-in.

## [0.10.275] — 2026-09-16

- Core update failure reports now include the signed-in user, so support can see how many people an issue affects.

## [0.10.274] — 2026-09-16

- Signing in from the setup wizard through your browser no longer stops after a second and a half. The sign-in buttons still appear right away, and finishing in the browser now completes sign-in.
- When setup fails, the report now includes the app version, the setup stage, and a clearer reason. This makes the issue easier to diagnose without asking you for logs.

## [0.10.272] — 2026-09-16

- Core update failure reports now include a redacted detail when HQ cannot start the rescue update or save its baseline, so support can diagnose the failure.
- On Windows, Core updates now make sure the rsync path shim is present before starting a rescue. The optional check gives up after 45 seconds so a slow download does not keep an update marked "Updating".

## [0.10.271] — 2026-09-16

- Core update now identifies Node/npm setup, npm cache permission, and network failures when it cannot start or save its baseline instead of reporting them as unknown.
- Core update now explains when a broken Git HTTPS setup prevents it from updating, instead of showing an unknown failure.
- On Macs, background updates and Auto-sync now configure HQ's portable Git only when it is the Git selected to run, so Core downloads work without affecting another Git installation.
- On a Mac, HQ Core updates now use the managed Git wrapper when the settings PATH names portable Git. If that Git is incomplete or cannot run, the update falls back to the Git already selected on the user's PATH.

## [0.10.270] — 2026-09-16

- Fixed HQ quitting immediately every time the main window opened on macOS 26. The window's frosted-glass backing was being set up with a command it does not accept, which stopped the app before anything appeared.
- Running an agent session inside HQ has been removed, including the Session button in the message composer. Start your work from the Launch menu instead — it opens your HQ folder in Claude Code, Codex, or Grok, where the agents already run. Chat, projects, and the work mesh are unchanged, and the mesh still shows sessions your teammates start elsewhere.
- Message history no longer re-asks the server about people it cannot reach. A contact whose account was deleted or moved out of the workspace used to be looked up again every time HQ started.

## [0.10.269] — 2026-09-16

- Clicking Session on the welcome page, or in a company that has no project yet, now starts a Claude session instead of doing nothing.
- On a Mac, clicks on the welcome page reach the buttons instead of falling through the glass background.

## [0.10.268] — 2026-09-16

- HQ now updates its command line right away at launch when it is older than 5.115.4, instead of waiting for the next scheduled check. The new bot kinds need that version; an older one showed "unknown option '--kind'" when creating a company bot.

## [0.10.267] — 2026-09-15

- Core update diagnostics now identify a missing rsync installation instead of treating the rescue failure as unknown.

## [0.10.266] — 2026-09-15

- After HQ updates itself on a Mac, it starts again through the login agent instead of as a separate app, so the window no longer jumps to the front every few seconds.

## [0.10.265] — 2026-09-15

- New bot now asks who the bot is for: "Personal — acts as you" (works under your account, stays on this Mac) or "For a company" (its own identity, pick one or more of your companies). Bot profiles and the Settings → Bots list show the kind, and only company bots offer "Promote to cloud". Setup is always a personal bot.
- When a coding tool's sign-in has expired, HQ now says so and offers a "Sign in again" button — in the bot's conversation, on its profile and in the setup Connect step — instead of setup failing with "Failed to authenticate". Signing in again restarts the bots that were waiting on it.

## [0.10.264] — 2026-09-15

- In a thread with an agent, the "is thinking" line now shows the agent's name instead of yours.
- An agent's "is thinking" line in a channel or thread now stays up for as long as the agent reports it is still working, instead of disappearing as soon as it posts a quick progress message. When the agent shares what it is doing, that status is shown.

## [0.10.263] — 2026-09-15

- Core updates now retry transient failures on the next scheduled check, while limiting repeated attempts and reporting a redacted diagnostic to support.

## [0.10.262] — 2026-09-15

- In a thread, the first message now scrolls away with the replies instead of staying pinned at the top, so a long message no longer leaves only a sliver of the conversation visible.
- After finishing setup on a new computer, clicking HQ in the menu bar or Dock opens the desktop app instead of the small status panel, without needing to restart HQ.
