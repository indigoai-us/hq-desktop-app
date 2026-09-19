# Changelog

What changed in the HQ desktop app, newest first.

Write your entry under `## [Unreleased]` in the same pull request as the
change, in plain language, describing what changes for the people who use it.
The release moves it under the version it ships in.

## [Unreleased]

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
