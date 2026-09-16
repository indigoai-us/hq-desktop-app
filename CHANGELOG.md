# Changelog

What changed in the HQ desktop app, newest first.

Write your entry under `## [Unreleased]` in the same pull request as the
change, in plain language, describing what changes for the people who use it.
The release moves it under the version it ships in.

## [Unreleased]

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
