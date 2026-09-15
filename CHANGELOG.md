# Changelog

What changed in the HQ desktop app, newest first.

Write your entry under `## [Unreleased]` in the same pull request as the
change, in plain language, describing what changes for the people who use it.
The release moves it under the version it ships in.

## [Unreleased]

- The "Create a bot" name-and-handle card no longer appears in a company channel, and the "Add bot" button that posted it has been removed from the company header. Bots are made in one place now: "New bot" in the sidebar. An older card still sitting in a channel's history is simply not shown.
- A bot's "is thinking" line now keeps moving while it works: it shows what the bot says it is doing as each update arrives, and otherwise walks through "is thinking", "is reading the context", "is working on it", "is still working". After fifteen seconds it also shows how long the bot has been going ("working for 42s"). The line still only disappears when the bot actually replies.
- The "Getting your HQ ready" setup screen now shows what it is actually doing. Under the step that is running, a line says which piece is being brought in and changes as the work moves on; after about twenty seconds it adds how long that step has been going, and the percentage keeps climbing throughout instead of parking on one number.

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
