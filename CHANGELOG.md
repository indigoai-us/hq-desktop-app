# Changelog

What changed in the HQ desktop app, newest first.

Write your entry under `## [Unreleased]` in the same pull request as the
change, in plain language, describing what changes for the people who use it.
The release moves it under the version it ships in.

## [Unreleased]

- After HQ updates itself on a Mac, it starts again through the login agent instead of as a separate app, so the window no longer jumps to the front every few seconds.
- In a thread with an agent, the "is thinking" line now shows the agent's name instead of yours.
- An agent's "is thinking" line in a channel or thread now stays up for as long as the agent reports it is still working, instead of disappearing as soon as it posts a quick progress message. When the agent shares what it is doing, that status is shown.
- Core updates now retry transient failures on the next scheduled check, while limiting repeated attempts and reporting a redacted diagnostic to support.

## [0.10.262] — 2026-09-15

- In a thread, the first message now scrolls away with the replies instead of staying pinned at the top, so a long message no longer leaves only a sliver of the conversation visible.
- After finishing setup on a new computer, clicking HQ in the menu bar or Dock opens the desktop app instead of the small status panel, without needing to restart HQ.
