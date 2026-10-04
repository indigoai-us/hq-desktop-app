/**
 * Which companies get the full-window New Bot flow.
 *
 * The server runs the flow's chat-first setup order only for a company that
 * has the `agents.desktop-agent-creation` flag, so the app offers the flow
 * only for such a company. Every other company keeps the "+" modal's own
 * create, unchanged.
 *
 * The flag is a COMPANY flag: one read per company, each naming the company.
 * This module owns how often that read happens. It is the only cache.
 *
 *   - One read per company per `NEW_BOT_FLAG_TTL_MS`, whatever the answer.
 *   - Two asks for the same company while its read is out share that read.
 *   - A read that fails counts as off, and is not asked again until its
 *     five minutes are up. A failing server is not asked in a loop.
 *   - `clear()` forgets everything, and an answer to a read that was out
 *     when it was called is thrown away: it was for another account.
 *
 * In memory only. Nothing here is written to disk.
 */

/** How long one company's answer is used before it is read again. */
export const NEW_BOT_FLAG_TTL_MS = 300_000;

export interface NewBotCompanyFlags {
  /**
   * The companies, of those given, whose last answer was on. Reads nothing:
   * an answer older than five minutes still counts here, so the flow does not
   * drop away while its answer is being read again. A company never read is
   * not in the list.
   */
  peek(companyUids: readonly string[]): string[];
  /**
   * Read every given company that has no answer from the last five minutes,
   * then return the ones that are on, in the order given. Never rejects.
   * Resolves `null` when `clear()` was called while it waited: the answer
   * belongs to an account that is gone.
   */
  resolve(companyUids: readonly string[]): Promise<string[] | null>;
  /** Forget every answer and disown every read still out. */
  clear(): void;
}

export interface NewBotCompanyFlagsOptions {
  ttlMs?: number;
  /** Clock. Tests pass a fake so five minutes can pass without waiting. */
  now?: () => number;
}

function uniqueUids(companyUids: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of companyUids) {
    const uid = raw.trim();
    if (uid) seen.add(uid);
  }
  return [...seen];
}

/**
 * `read` asks the server for one company. Anything but a resolved `true` is
 * off: `false`, a rejection, or a value that is not a boolean.
 */
export function createNewBotCompanyFlags(
  read: (companyUid: string) => Promise<boolean>,
  options: NewBotCompanyFlagsOptions = {},
): NewBotCompanyFlags {
  const ttlMs = options.ttlMs ?? NEW_BOT_FLAG_TTL_MS;
  const now = options.now ?? Date.now;
  let answers = new Map<string, { enabled: boolean; at: number }>();
  let inFlight = new Map<string, Promise<void>>();
  /** Bumped by `clear()`. A read started under an older value is disowned. */
  let epoch = 0;

  function refresh(uid: string): Promise<void> {
    const known = answers.get(uid);
    if (known && now() - known.at < ttlMs) return Promise.resolve();
    const out = inFlight.get(uid);
    if (out) return out;
    const startedIn = epoch;
    let asked: Promise<boolean>;
    try {
      asked = Promise.resolve(read(uid));
    } catch {
      asked = Promise.resolve(false);
    }
    const pending = asked
      .then(
        (value) => value === true,
        () => false,
      )
      .then((enabled) => {
        if (startedIn !== epoch) return;
        answers.set(uid, { enabled, at: now() });
        inFlight.delete(uid);
      });
    inFlight.set(uid, pending);
    return pending;
  }

  function peek(companyUids: readonly string[]): string[] {
    return uniqueUids(companyUids).filter(
      (uid) => answers.get(uid)?.enabled === true,
    );
  }

  return {
    peek,
    async resolve(companyUids) {
      const uids = uniqueUids(companyUids);
      const startedIn = epoch;
      await Promise.all(uids.map((uid) => refresh(uid)));
      if (startedIn !== epoch) return null;
      return peek(uids);
    },
    clear() {
      epoch += 1;
      answers = new Map();
      inFlight = new Map();
    },
  };
}
