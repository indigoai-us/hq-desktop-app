/**
 * How often the app tries again to send a bot a hidden notice (a tool was
 * connected, the bot is in Slack now) after a send failed.
 *
 * A notice that had not been sent was tried again every time the bot's cards
 * were worked out: every 5 s while a card waits, and on every window focus.
 * A send the server refuses for good (a 4xx) was repeated for ever. This
 * keeps, per notice and for this session, how many sends failed and when the
 * next one may go: a refusal is not repeated, anything else is retried a few
 * times, further apart each time, and then left alone.
 */

/** Sends per notice before the app stops trying in this session. */
export const NOTICE_MAX_ATTEMPTS = 4;
/** The wait after the first failed send; it doubles after each further one. */
export const NOTICE_RETRY_BASE_MS = 30_000;

export interface NoticeAttempts {
  /** Sends that failed. */
  attempts: number;
  /** The earliest time the next send may go (ms), or null: no more sends. */
  nextAt: number | null;
}

/** Notice key (bot and what it is about) to what has failed so far. */
export type NoticeLedger = Map<string, NoticeAttempts>;

/**
 * Whether a failed send is one the server will refuse again however often it
 * is asked: a 4xx, other than a timeout (408) or a rate limit (429). A send
 * that threw, or failed with no HTTP status, may work next time.
 */
export function noticeFailurePermanent(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const rec = result as Record<string, unknown>;
  if (rec.ok !== false) return false;
  let status = typeof rec.status === "number" ? rec.status : Number.NaN;
  if (!Number.isFinite(status)) {
    const match = /^http-(\d{3})$/.exec(typeof rec.code === "string" ? rec.code.trim().toLowerCase() : "");
    status = match ? Number(match[1]) : Number.NaN;
  }
  if (!Number.isFinite(status)) return false;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Whether the notice may be sent now: never failed, or its wait is over. */
export function noticeMaySend(ledger: NoticeLedger, key: string, now: number): boolean {
  const entry = ledger.get(key);
  if (!entry) return true;
  return entry.nextAt !== null && now >= entry.nextAt;
}

/**
 * Record a failed send. A permanent failure, or the last allowed attempt,
 * ends the tries. Otherwise the next one waits 30 s, then 60 s, then 120 s.
 */
export function noteNoticeFailure(ledger: NoticeLedger, key: string, now: number, permanent: boolean): NoticeAttempts {
  const attempts = (ledger.get(key)?.attempts ?? 0) + 1;
  const done = permanent || attempts >= NOTICE_MAX_ATTEMPTS;
  const entry: NoticeAttempts = { attempts, nextAt: done ? null : now + NOTICE_RETRY_BASE_MS * 2 ** (attempts - 1) };
  ledger.set(key, entry);
  return entry;
}

/** The notice went out: nothing more to keep. */
export function noteNoticeSent(ledger: NoticeLedger, key: string): void {
  ledger.delete(key);
}
