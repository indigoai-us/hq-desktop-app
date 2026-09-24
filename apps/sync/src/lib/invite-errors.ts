/**
 * Classify a `meetings_invite_bot` failure as the benign "already scheduled"
 * case.
 *
 * A bot-invite call can fail with HTTP 409 when a bot is already scheduled —
 * or in the middle of being scheduled — for the same meeting. This happens
 * when a separate hq-sync instance, the auto-schedule cron, or a double-submit
 * got there first. It is benign: the bot exists, so the UI should treat it as
 * success (clear the input, show a friendly toast, refresh the list) rather
 * than surfacing a scary failure.
 *
 * The server signals this with HTTP 409 and one of two codes — see hq-pro
 * `bot.controller.ts` `handleInvite`:
 *   - `bot-already-scheduled`  — a pre-existing sibling bot / Recall dedup
 *   - `bot-already-scheduling` — the atomic dedup-lock race (two Lambdas in
 *                                the same millisecond)
 * Both share the `bot-already-schedu` prefix. The error reaches the frontend
 * as a flattened Tauri command-error string (`bot/invite HTTP 409: {…}`), so
 * we match the shared code prefix and fall back to the bare `409` status.
 */
export function isAlreadyScheduledError(err: unknown): boolean {
  const msg = String(err ?? '');
  return msg.includes('409') || msg.includes('bot-already-schedu');
}

/**
 * Classify a bot invite/join failure as requiring the Meetings Team plan.
 *
 * The server rejects recording-bot scheduling with HTTP 402 when the company
 * is not on the required Team plan. See hq-pro `bot.controller.ts`, which
 * returns 402 with `requiredPlan: "agents-500"`. The error reaches the
 * frontend as a flattened Tauri command-error string (`bot/invite HTTP 402:
 * {…}`), so match the status and the body sentinels rather than a structured
 * error object.
 */
export function isPlanRequiredError(err: unknown): boolean {
  const msg = String(err ?? '');
  return (
    msg.includes('402') ||
    msg.includes('requiredPlan') ||
    msg.includes('agents-500') ||
    msg.includes('MEETING_PLAN_REQUIRED')
  );
}

export type PlanRequiredUpgradeLink =
  | { kind: 'not-plan-error' }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'available'; url: string };

/** Extract only a credential-free HTTPS URL returned in a plan refusal. */
export function planRequiredUpgradeUrl(err: unknown): PlanRequiredUpgradeLink {
  if (!isPlanRequiredError(err)) return { kind: 'not-plan-error' };

  const raw = String(err ?? '');
  const jsonStart = raw.indexOf('{');
  if (jsonStart < 0) return { kind: 'missing' };

  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(jsonStart));
  } catch {
    return { kind: 'invalid' };
  }
  if (!payload || typeof payload !== 'object') return { kind: 'invalid' };

  const upgradeUrl = (payload as Record<string, unknown>).upgradeUrl;
  if (upgradeUrl === undefined || upgradeUrl === null || upgradeUrl === '') {
    return { kind: 'missing' };
  }
  if (typeof upgradeUrl !== 'string' || upgradeUrl.trim() !== upgradeUrl) {
    return { kind: 'invalid' };
  }
  try {
    const url = new URL(upgradeUrl);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return { kind: 'invalid' };
    }
  } catch {
    return { kind: 'invalid' };
  }
  return { kind: 'available', url: upgradeUrl };
}
