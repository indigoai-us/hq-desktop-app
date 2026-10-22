/**
 * The first-launch heads-up (install-flow-rethink US-002).
 *
 * A small window shown before the welcome flow takes the whole screen. It says
 * what is about to happen and offers three ways on: start now, do it later
 * (a reminder, app stays in the tray), or set HQ up by hand (opens the manual
 * setup doc, app stays in the tray). The native session scan starts while the
 * window is open, before sign-in, so its result is ready by the time the flow
 * needs it.
 *
 * Copy and behaviour live here so they can be tested without mounting the
 * window. `HeadsUpWindow.svelte` renders the copy; `Onboarding.svelte` wires
 * the actions.
 */

/** The screen id in the `[first-run] kind=screen` timing lines. */
export const HEADS_UP_SCREEN_ID = 'heads-up';

/** Size of the `main` window while the heads-up is on screen. */
export const HEADS_UP_WINDOW_SIZE = { width: 440, height: 380 } as const;

/** The manual setup guide opened by "Manual setup". */
export const MANUAL_SETUP_URL = 'https://hq.computer/docs/manual-setup';

/** How long "Do it later" waits before reminding. */
export const HEADS_UP_REMINDER_DELAY_MS = 2 * 60 * 60 * 1000;

/** Where the reminder time is kept, so a relaunch can tell one is pending. */
export const HEADS_UP_REMIND_AT_KEY = 'hq.firstRun.headsUpRemindAt';

export const HEADS_UP_COPY = {
  title: 'You are about to set up HQ',
  /** US-023: the title when this Mac remembers a returning account. */
  returningTitle: 'Welcome back. Setting HQ up on this Mac.',
  points: [
    'Setup takes a few minutes. HQ installs the tools it needs and gets your workspace ready.',
    'You will sign in with a Google or Microsoft account. If you were invited, sign in with the email the invite was sent to.',
  ],
  startNow: 'Start now',
  later: 'Do it later',
  manual: 'Manual setup',
  laterHint: 'HQ stays in your menu bar and reminds you later.',
  reminderTitle: 'Ready to set up HQ?',
  reminderBody: 'Setup takes a few minutes. Open HQ from the menu bar to start.',
} as const;

/**
 * Whether this Mac remembers a returning account from an earlier setup
 * (US-023). The heads-up shows before sign-in, so this is the only signal it
 * has: a first-ever launch has nothing remembered and keeps today's title.
 * Any failure counts as not remembered.
 */
export async function remembersReturningAccount(invoke: Invoke | undefined): Promise<boolean> {
  if (typeof invoke !== 'function') return false;
  try {
    return (await invoke<unknown>('get_account_kind')) === 'returning';
  } catch (error) {
    console.warn('heads-up: could not read the remembered account kind', error);
    return false;
  }
}

export type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

function isMissingCommand(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /not found|unknown command|no such command/i.test(text);
}

/**
 * Start the native scan of local agent sessions. Resolves with the parsed
 * JSON, or `null` when the command is not in this build (a warning, since the
 * flow works without it) or failed (an error).
 */
export async function startSessionScan(invoke: Invoke | undefined): Promise<unknown | null> {
  if (typeof invoke !== 'function') return null;
  try {
    const raw = await invoke<unknown>('scan_local_sessions');
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch (error) {
        console.error('heads-up: session scan returned unreadable JSON', error);
        return null;
      }
    }
    return raw ?? null;
  } catch (error) {
    if (isMissingCommand(error)) {
      console.warn('heads-up: scan_local_sessions is not available in this build; skipping the scan', error);
    } else {
      console.error('heads-up: session scan failed', error);
    }
    return null;
  }
}

export interface ReminderDeps {
  notify: (title: string, body: string) => Promise<void>;
  bringToFront: () => Promise<void>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
}

/**
 * Remember when to remind and arm a timer for it. When it fires, a system
 * notification goes out and the window comes back with the heads-up on it.
 * Returns the time the reminder is due.
 */
export function scheduleSetupReminder(deps: ReminderDeps, delayMs = HEADS_UP_REMINDER_DELAY_MS): number {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const remindAt = now() + delayMs;
  try {
    deps.storage?.setItem(HEADS_UP_REMIND_AT_KEY, String(remindAt));
  } catch (error) {
    console.error('heads-up: could not save the reminder time', error);
  }
  setTimer(() => {
    void fireReminder(deps);
  }, delayMs);
  return remindAt;
}

async function fireReminder(deps: ReminderDeps): Promise<void> {
  try {
    deps.storage?.removeItem(HEADS_UP_REMIND_AT_KEY);
  } catch (error) {
    console.error('heads-up: could not clear the reminder time', error);
  }
  try {
    await deps.notify(HEADS_UP_COPY.reminderTitle, HEADS_UP_COPY.reminderBody);
  } catch (error) {
    console.error('heads-up: reminder notification failed', error);
  }
  try {
    await deps.bringToFront();
  } catch (error) {
    console.error('heads-up: could not bring HQ back for the reminder', error);
  }
}

export interface HeadsUpActionDeps extends ReminderDeps {
  /** Hide the window; the app keeps running in the tray. */
  hideToTray: () => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  /** Close the heads-up and open the existing welcome flow. */
  startFlow: () => void | Promise<void>;
}

export type HeadsUpAction = 'start' | 'later' | 'manual';

async function hide(deps: HeadsUpActionDeps): Promise<void> {
  try {
    await deps.hideToTray();
  } catch (error) {
    console.error('heads-up: could not hide to the tray', error);
  }
}

/** Run one of the three heads-up actions. */
export async function runHeadsUpAction(action: HeadsUpAction, deps: HeadsUpActionDeps): Promise<void> {
  switch (action) {
    case 'start':
      await deps.startFlow();
      return;
    case 'later':
      scheduleSetupReminder(deps);
      await hide(deps);
      return;
    case 'manual':
      try {
        await deps.openUrl(MANUAL_SETUP_URL);
      } catch (error) {
        console.error('heads-up: could not open the manual setup guide', error);
      }
      await hide(deps);
      return;
  }
}
