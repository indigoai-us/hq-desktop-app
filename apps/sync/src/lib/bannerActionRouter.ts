import { safeUnlisten } from './listener-registry';
import { routeForNotificationPayload } from './notificationRoutes';

export type NotificationActionKind =
  | 'dm'
  | 'share'
  | 'update'
  | 'meeting'
  | 'session';

/**
 * Inbox route for a banner body-click / open action. DM and share banners
 * resolve the same way native notification clicks do; other kinds do not
 * navigate the inbox.
 */
export function bannerOpenRoute(
  kind: NotificationActionKind,
  data: unknown,
): string | null {
  if (kind === 'dm' || kind === 'share') {
    return routeForNotificationPayload(data);
  }
  return null;
}

/** True when a share payload already has a DM, so a share banner is a duplicate. */
export function shouldSuppressShareNotification(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const id = (data as { dmEventId?: unknown }).dmEventId;
  return typeof id === 'string' && id.trim().length > 0;
}

export interface BannerActionEvent {
  requestId: string;
  kind: NotificationActionKind;
  action: string;
  data: unknown;
}

type Unlisten = () => void;
type Listen = (
  event: string,
  handler: (event: { payload: BannerActionEvent }) => void | Promise<void>,
) => Promise<Unlisten>;
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

interface BannerActionRouterOptions {
  listen: Listen;
  invoke: Invoke;
  execute: (event: BannerActionEvent) => Promise<void>;
  retryDelay?: (attempt: number) => Promise<void>;
  onError?: (message: string, error: unknown) => void;
}

const EVENT_BANNER_ACTION = 'notification:banner-action';
const RETRY_DELAYS_MS = [100, 500, 1_500, 3_000] as const;

function defaultRetryDelay(attempt: number): Promise<void> {
  const delay =
    RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Installs the banner ACK route independently of the rest of App's listener
 * bundle. Readiness is reported only after listen succeeds; either half of
 * setup is retried so one transient registration failure cannot permanently
 * strand banner actions.
 */
export class BannerActionRouter {
  private readonly listen: Listen;
  private readonly invoke: Invoke;
  private readonly execute: (event: BannerActionEvent) => Promise<void>;
  private readonly retryDelay: (attempt: number) => Promise<void>;
  private readonly onError: (message: string, error: unknown) => void;
  private stopped = false;
  private unlisten: Unlisten | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(options: BannerActionRouterOptions) {
    this.listen = options.listen;
    this.invoke = options.invoke;
    this.execute = options.execute;
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
    this.onError =
      options.onError ??
      ((message, error) => {
        console.error(message, error);
      });
  }

  start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.installUntilReady();
    }
    return this.startPromise;
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    const unlisten = this.unlisten;
    this.unlisten = null;
    if (!unlisten) return;

    try {
      await this.invoke('banner_action_router_not_ready');
    } catch (error) {
      this.onError('banner action router cleanup failed', error);
    } finally {
      unlisten();
    }
  }

  private readonly handle = async (event: {
    payload: BannerActionEvent;
  }): Promise<void> => {
    const payload = event.payload;
    let success = false;
    try {
      await this.execute(payload);
      success = true;
    } catch (error) {
      this.onError(
        `banner action failed (${payload.kind}/${payload.action})`,
        error,
      );
    }

    try {
      await this.invoke('banner_action_result', {
        requestId: payload.requestId,
        success,
      });
    } catch (error) {
      this.onError('banner action acknowledgement failed', error);
    }
  };

  private async installUntilReady(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      let candidate: Unlisten | null = null;
      try {
        candidate = safeUnlisten(
          await this.listen(EVENT_BANNER_ACTION, this.handle),
        );
        if (this.stopped) {
          candidate();
          return;
        }

        await this.invoke('banner_action_router_ready');
        if (this.stopped) {
          try {
            await this.invoke('banner_action_router_not_ready');
          } finally {
            candidate();
          }
          return;
        }

        this.unlisten = candidate;
        return;
      } catch (error) {
        candidate?.();
        if (this.stopped) return;
        this.onError('banner action router setup failed', error);
        await this.retryDelay(attempt);
        attempt += 1;
      }
    }
  }
}
