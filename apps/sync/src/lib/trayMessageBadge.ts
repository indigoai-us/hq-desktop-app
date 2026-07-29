export type TrayMessageBadgeWriter = (count: number) => Promise<void>;
export type TrayMessageBadgeRetryDelay = (attempt: number) => Promise<void>;

const MAX_NATIVE_BADGE_COUNT = 0xffff_ffff;
const MAX_WRITE_ATTEMPTS = 3;

function defaultRetryDelay(attempt: number): Promise<void> {
  const delayMs = Math.min(200, 25 * 2 ** Math.max(0, attempt - 1));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function normalizeTrayMessageBadgeCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.min(MAX_NATIVE_BADGE_COUNT, Math.max(0, Math.floor(count)));
}

/**
 * Serializes app → native badge snapshots and coalesces rapid unread changes.
 *
 * Tauri invokes are asynchronous. Letting multiple writes race can leave the
 * native helper showing an older count after a newer write finishes first.
 * One drain owns the bridge at a time; changes that land while it is awaiting
 * a write collapse into the latest desired snapshot.
 */
export class TrayMessageBadgePublisher {
  private desired = 0;
  private published: number | null = null;
  private drain: Promise<void> | null = null;
  private exhaustedDesired: number | null = null;

  constructor(
    private readonly writer: TrayMessageBadgeWriter,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly retryDelay: TrayMessageBadgeRetryDelay = defaultRetryDelay,
  ) {}

  async publish(count: number): Promise<void> {
    const requested = normalizeTrayMessageBadgeCount(count);
    this.desired = requested;
    // A later explicit publish is a fresh opportunity to recover after the
    // prior bounded attempt set was exhausted.
    if (this.exhaustedDesired === requested) this.exhaustedDesired = null;
    this.ensureDrain();

    const active = this.drain;
    if (active) await active;

    // Cover the narrow settle race where a newer desired value arrives after
    // run() observes idle but before its finally callback clears `drain`.
    if (
      this.desired === requested &&
      this.published !== requested &&
      this.exhaustedDesired !== requested
    ) {
      this.ensureDrain();
      if (this.drain) await this.drain;
    }
  }

  private ensureDrain(): void {
    if (
      this.drain !== null ||
      this.published === this.desired ||
      this.exhaustedDesired === this.desired
    ) {
      return;
    }

    const running = this.run().finally(() => {
      if (this.drain === running) {
        this.drain = null;
        // If a desired value changed during the settle edge, start its drain.
        this.ensureDrain();
      }
    });
    this.drain = running;
  }

  private async run(): Promise<void> {
    let failedSnapshot: number | null = null;
    let attempts = 0;

    while (this.published !== this.desired) {
      const snapshot = this.desired;
      if (failedSnapshot !== snapshot) {
        failedSnapshot = snapshot;
        attempts = 0;
      }

      try {
        await this.writer(snapshot);
        this.published = snapshot;
        this.exhaustedDesired = null;
        failedSnapshot = null;
        attempts = 0;
      } catch (error) {
        this.onError(error);

        // A newer snapshot supersedes the failed write. Do not spend retry
        // budget on stale state; immediately continue to the latest count.
        if (this.desired !== snapshot) {
          failedSnapshot = null;
          attempts = 0;
          continue;
        }

        attempts += 1;
        if (attempts >= MAX_WRITE_ATTEMPTS) {
          this.exhaustedDesired = snapshot;
          return;
        }
        await this.retryDelay(attempts);
      }
    }
  }
}
