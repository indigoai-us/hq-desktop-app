// What a hook notice, or an operator's slash turn, MEANS to the session.
//
// Tiny and pure on purpose: the transcript fold asks these questions and this
// module is the one place their wording lives. The banners it recognises are
// printed by HQ's own hooks — `.claude/hooks/context-warning-50.sh` (the
// once-per-session 50% warning) and `auto-checkpoint-precompact.sh` (the
// pre-compaction backup) — and both open with the same line:
//
//   AUTO-CHECKPOINT REQUIRED — context ~50%
//   AUTO-CHECKPOINT REQUIRED — precompact backup

/**
 * What the strip's "Hand off" button can do right now: `hidden` with no
 * session, `ready` on a live idle session, `disabled` while the agent is busy
 * or the session is gone, `running` while the `/handoff` turn itself executes.
 */
export type HandoffState = 'hidden' | 'ready' | 'disabled' | 'running';

/** The slash command that writes the session handoff. */
export const HANDOFF_COMMAND = '/handoff';
/** The slash command that checkpoints the session in place. */
export const CHECKPOINT_COMMAND = '/checkpoint';

/** The exact phrase both checkpoint banners open with. */
const CHECKPOINT_BANNER = 'AUTO-CHECKPOINT REQUIRED';

/**
 * Did this hook text ask for a checkpoint? Matches the banner verbatim, and —
 * as a hedge against the banner being reworded — any text that talks about
 * context at 50%.
 */
export function isCheckpointDirective(text: string): boolean {
  if (text.includes(CHECKPOINT_BANNER)) return true;
  return /context/i.test(text) && text.includes('50%');
}

/** Does a user turn START with the given slash command (as a whole word)? */
function startsWithCommand(text: string, command: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(command)) return false;
  const next = trimmed.charAt(command.length);
  return next === '' || /\s/.test(next);
}

/** The operator sent `/handoff` (optionally with arguments). */
export function isHandoffTurn(text: string): boolean {
  return startsWithCommand(text, HANDOFF_COMMAND);
}

/** The operator sent `/checkpoint` (optionally with arguments). */
export function isCheckpointTurn(text: string): boolean {
  return startsWithCommand(text, CHECKPOINT_COMMAND);
}
