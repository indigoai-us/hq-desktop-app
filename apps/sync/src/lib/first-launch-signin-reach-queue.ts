type QueueStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES = [
  'reached-signin',
  'existing-session-skip',
  'setup-resume-skip',
  'missing-root-recovery-skip',
  'consent-only-skip',
  'update-gate',
  'startup-error',
  'window-closed',
  'quit',
] as const;

export type FirstLaunchSignInReachOutcome =
  (typeof FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES)[number];

const OUTCOME_SET: ReadonlySet<string> = new Set(FIRST_LAUNCH_SIGNIN_REACH_OUTCOMES);
const INSTALL_ATTEMPT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const FIRST_LAUNCH_SIGNIN_REACH_QUEUE_KEY = 'hq:first-launch-signin-reach:v1';
export const FIRST_LAUNCH_SIGNIN_REACH_QUEUE_MAX_ENTRIES = 32;
export const FIRST_LAUNCH_SIGNIN_REACH_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface QueueEntry {
  installAttemptId: string;
  outcome: FirstLaunchSignInReachOutcome;
  recordedAt: number;
  sentAt?: number;
}

interface PersistedQueue {
  version: 1;
  entries: QueueEntry[];
}

export interface FirstLaunchSignInReachQueueOptions {
  storage?: QueueStorage | null;
  send: (entry: QueueEntry) => Promise<boolean>;
  now?: () => number;
  maxEntries?: number;
  maxAgeMs?: number;
  warn?: (message: string, error?: unknown) => void;
}

export function normalizeFirstLaunchSignInReachOutcome(
  value: unknown,
): FirstLaunchSignInReachOutcome | undefined {
  return typeof value === 'string' && OUTCOME_SET.has(value)
    ? (value as FirstLaunchSignInReachOutcome)
    : undefined;
}

function safeStorage(): QueueStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseQueue(raw: string | null): QueueEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('entries' in parsed) ||
      !Array.isArray(parsed.entries)
    ) return [];
    const entries: QueueEntry[] = [];
    for (const candidate of parsed.entries) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const row = candidate as Record<string, unknown>;
      const outcome = normalizeFirstLaunchSignInReachOutcome(row.outcome);
      if (
        typeof row.installAttemptId !== 'string' ||
        !INSTALL_ATTEMPT_ID_RE.test(row.installAttemptId) ||
        !outcome ||
        typeof row.recordedAt !== 'number' ||
        !Number.isFinite(row.recordedAt) ||
        ('sentAt' in row && (typeof row.sentAt !== 'number' || !Number.isFinite(row.sentAt)))
      ) continue;
      entries.push({
        installAttemptId: row.installAttemptId,
        outcome,
        recordedAt: row.recordedAt,
        ...(typeof row.sentAt === 'number' ? { sentAt: row.sentAt } : {}),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

export function createFirstLaunchSignInReachQueue(options: FirstLaunchSignInReachQueueOptions) {
  const storage = options.storage === undefined ? safeStorage() : options.storage;
  const now = options.now ?? Date.now;
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? FIRST_LAUNCH_SIGNIN_REACH_QUEUE_MAX_ENTRIES, 32));
  const maxAgeMs = Math.max(1, Math.min(options.maxAgeMs ?? FIRST_LAUNCH_SIGNIN_REACH_QUEUE_MAX_AGE_MS, FIRST_LAUNCH_SIGNIN_REACH_QUEUE_MAX_AGE_MS));
  let flushPromise: Promise<void> | null = null;
  let entries: QueueEntry[] = [];

  function prune(rows: QueueEntry[]): QueueEntry[] {
    const cutoff = now() - maxAgeMs;
    return rows
      .filter((entry) => entry.recordedAt >= cutoff && entry.recordedAt <= now())
      .slice(-maxEntries);
  }

  function persist(): void {
    if (!storage) return;
    try {
      storage.setItem(FIRST_LAUNCH_SIGNIN_REACH_QUEUE_KEY, JSON.stringify({ version: 1, entries } satisfies PersistedQueue));
    } catch (error) {
      options.warn?.('first-launch reach queue could not be persisted', error);
    }
  }

  try {
    entries = prune(parseQueue(storage?.getItem(FIRST_LAUNCH_SIGNIN_REACH_QUEUE_KEY) ?? null));
  } catch (error) {
    options.warn?.('first-launch reach queue could not be read', error);
  }
  persist();

  async function flush(): Promise<void> {
    if (flushPromise) return flushPromise;
    const pending = (async () => {
      for (const entry of entries) {
        if (entry.sentAt !== undefined) continue;
        try {
          if (!await options.send(entry)) continue;
          entries = entries.map((candidate) =>
            candidate.installAttemptId === entry.installAttemptId
              ? { ...candidate, sentAt: now() }
              : candidate,
          );
          persist();
        } catch (error) {
          options.warn?.('first-launch reach queue delivery failed', error);
        }
      }
    })();
    flushPromise = pending.finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  async function enqueue(installAttemptId: string, value: unknown): Promise<void> {
    const outcome = normalizeFirstLaunchSignInReachOutcome(value);
    if (!INSTALL_ATTEMPT_ID_RE.test(installAttemptId) || !outcome) return;
    entries = prune(entries);
    if (entries.some((entry) => entry.installAttemptId === installAttemptId)) return;
    entries = prune([...entries, { installAttemptId, outcome, recordedAt: now() }]);
    persist();
    await flush();
  }

  return {
    enqueue,
    flush,
    get entries(): readonly QueueEntry[] {
      return entries;
    },
  };
}
