# Changelog

What changed in the HQ desktop app, newest first.

Write your entry under `## [Unreleased]` in the same pull request as the
change, in plain language, describing what changes for the people who use it.
The release moves it under the version it ships in.

## [Unreleased]

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
