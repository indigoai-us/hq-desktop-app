# Changelog

What changed in the HQ desktop app, newest first.

Write your entry under `## [Unreleased]` in the same pull request as the
change, in plain language, describing what changes for the people who use it.
The release moves it under the version it ships in.

## [Unreleased]

- Your bots come back after a reinstall. When HQ starts and finds bots you own that aren't set up on this computer — after a reinstall, or on a new Mac — it offers "Restore all" once and brings them all back with their names, their memory and your conversations intact. Turn it down and it won't ask again; you can start it any time from Settings › Bots.
- A bot that can't run on this computer now offers "Start on this computer" instead of only "Check again". One click rebuilds the part a reinstall took away and starts the bot; the conversation then carries on as normal. If it doesn't work, you get one plain sentence and a Retry — never technical text.
- Settings › Bots now lists the bots you own that live on another computer, each with a "Start here" button, plus a "Restore my bots" action for all of them at once. Bots already running here are unchanged.
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
