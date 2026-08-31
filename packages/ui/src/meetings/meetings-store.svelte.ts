import type {
  AdapterResult,
  FeedbackApi,
  Json,
  MeetingsApi,
  SettingsApi,
} from "@hq/platform";
import { loadMeetingsCache, saveMeetingsCache } from "./meetings-cache";
import { isAlreadyScheduledError, isPlanRequiredError } from "./invite-errors";
import { isRecordingCompanyMembership } from "./recording-membership";
import {
  buildRefreshProblemReport,
  botForEvent,
  calendarEventIdsForBotLookup,
  eventMeetingUrl,
  friendlyError,
  isPlausibleMeetingUrl,
  MEETINGS_STALE_NOTICE_FAILURES,
  meetingsRefreshGate,
  mergeScheduledBotLookups,
  mergeScheduledBots,
  optimisticAlreadyInvitedBot,
  recurringSeriesId,
  resolveInviteCompanyId,
  urlInviteDestinationLabel,
} from "./meetings-model";
import { takeAgendaWindow } from "./meetings-view-model";
import type {
  CompanyMembership,
  GoogleAccount,
  GoogleCalendar,
  MeetingEvent,
  ScheduledBot,
} from "./meetings-model";

// ---------------------------------------------------------------------------
// Platform seam (US-002/US-007 port). Every former former `meetings_*` /
// `submit_bug_report` desktop command call now goes through the injected
// PlatformAdapter slices. Adapter methods resolve AdapterResult — `unwrap`
// converts failures back into thrown errors whose message carries the
// machine code (e.g. "http-409"), so the existing error classifiers
// (isAlreadyScheduledError / isPlanRequiredError / friendlyError) keep
// working unchanged.
// ---------------------------------------------------------------------------

export interface MeetingsStoreApi {
  /** Stable authenticated account identity; cache and completions are scoped to it. */
  accountId?: string | null;
  meetings: MeetingsApi;
  feedback: FeedbackApi;
  /** Native settings are injected by the desktop shell. */
  settings?: Pick<SettingsApi, "getSettings">;
}

let api: MeetingsStoreApi | null = null;
let activeAccountId: string | null = null;
let accountGeneration = 0;

/** Inject the platform backend before startMeetingsStore(). */
export function configureMeetingsApi(next: MeetingsStoreApi | null): void {
  if (!next) {
    if (activeAccountId !== null || api !== null) {
      accountGeneration += 1;
      activeAccountId = null;
      resetAccountState();
    }
    api = null;
    return;
  }
  const requestedAccount = next.accountId?.trim() || activeAccountId;
  if (requestedAccount !== activeAccountId) {
    accountGeneration += 1;
    activeAccountId = requestedAccount ?? null;
    resetAccountState();
    // Account B may have a warm snapshot, but it must never inherit A's.
    // Hydrate only after switching the scoped key and clearing every A field.
    hydrateFromCache();
  }
  api = { ...next, accountId: activeAccountId };
}

function requireApi(): MeetingsStoreApi {
  if (!api) throw new Error("meetings-store: no platform api configured");
  return api;
}

function unwrap<T>(res: AdapterResult<T>): T {
  if (res.ok) return res.value;
  const parts = [res.code ?? res.reason, res.message].filter(Boolean);
  throw new Error(parts.join(": ") || res.reason);
}

/** Outcome of a bot row-action, returned to the page so it can render the
 *  toast. Keeping the copy here — next to the call that produces it — lets
 *  the store own the network + lifecycle while the page owns only presentation.
 *  `null` from a method means "nothing to surface" (a no-op dedupe or a missing
 *  bot), so the page simply skips the toast. */
export interface ToastDescriptor {
  kind: "info" | "warn";
  text: string;
}

const PLAN_REQUIRED_TOAST: ToastDescriptor = {
  kind: "warn",
  text: "Meetings need the $500/mo Team plan—upgrade in HQ Console to record.",
};

/** Per-account calendar list plus the user's enabled selection. The adapter's
 *  `listCalendars` is typed loosely (`Json[]`), so `parseAccountCalendars`
 *  accepts either the structured desktop shape or a bare calendar array. */
interface AccountCalendars {
  calendars: GoogleCalendar[];
  selectedCalendarIds: string[];
}

function parseAccountCalendars(raw: unknown): AccountCalendars {
  if (Array.isArray(raw)) {
    const calendars = raw as GoogleCalendar[];
    return {
      calendars,
      selectedCalendarIds: calendars.map((c) => c.id),
    };
  }
  const obj = (raw ?? {}) as Partial<AccountCalendars>;
  return {
    calendars: obj.calendars ?? [],
    selectedCalendarIds: obj.selectedCalendarIds ?? [],
  };
}

interface CancelBotResult {
  scope?: string | null;
  cancelledCount?: number | null;
  failedCount?: number | null;
  recurringMeeting?: boolean;
}

interface CalendarSnapshot {
  calendarsByAccount: Map<string, GoogleCalendar[]>;
  enabledCalIdsByAccount: Map<string, Set<string>>;
  calendarSummaryByKey: Map<string, string>;
}

// Poll cadence for the background refresh. Long enough to be cheap, short
// enough that an agenda opened minutes later is already current.
const POLL_INTERVAL_MS = 120_000;
const MEETINGS_REFRESH_MIN_MS = 60_000;

// ---------------------------------------------------------------------------
// Module-level singleton state (see the desktop-alt original for the preload
// rationale: data lives at module scope, loaded once at app start and kept
// warm by a 30s poll, so page remounts paint instantly from the warm store).
// ---------------------------------------------------------------------------

let events = $state<MeetingEvent[]>([]);
let accounts = $state<GoogleAccount[]>([]);
let calendarsByAccount = $state<Map<string, GoogleCalendar[]>>(new Map());
let enabledCalIdsByAccount = $state<Map<string, Set<string>>>(new Map());
let botsByEventId = $state<Map<string, ScheduledBot>>(new Map());
let allBots = $state<ScheduledBot[]>([]);
let companyNamesByUid = $state<Map<string, string>>(new Map());
let accountEmailById = $state<Map<string, string>>(new Map());
let calendarSummaryByKey = $state<Map<string, string>>(new Map());
let memberships = $state<CompanyMembership[]>([]);
let membershipsError = $state("");
let fetchError = $state("");
let refreshBlocked = $state(false);
let refreshFailureCount = 0;
let lastRefreshErrorRaw = "";
let loading = $state(false);
// US-010: first-paint provenance. The page shows a skeleton only while we have
// neither a cache snapshot nor a settled first network refresh — after either,
// an empty list is a real answer, not "still loading".
let hydratedFromCache = $state(false);
let firstRefreshSettled = $state(false);
// True once at least one network refresh has fully succeeded — the only state
// in which "no accounts, no meetings" is trustworthy enough to lead with the
// connect-a-calendar empty state (a failed first fetch must not).
let hasLiveSnapshot = $state(false);
let refreshInFlight: Promise<void> | null = null;
let forceTrailingRefresh = false;
let mutationRevision = 0;
export type MeetingBotAction = "invite" | "uninvite" | "join-now";
let rowPending = $state<Map<string, MeetingBotAction>>(new Map());

let started = false;
let viewActive = false;
let lastRefreshAt = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Synchronously blank every account-owned surface before a new account paints. */
function resetAccountState(): void {
  events = [];
  accounts = [];
  calendarsByAccount = new Map();
  enabledCalIdsByAccount = new Map();
  botsByEventId = new Map();
  allBots = [];
  companyNamesByUid = new Map();
  accountEmailById = new Map();
  calendarSummaryByKey = new Map();
  memberships = [];
  membershipsError = "";
  fetchError = "";
  refreshBlocked = false;
  refreshFailureCount = 0;
  lastRefreshErrorRaw = "";
  loading = false;
  hydratedFromCache = false;
  firstRefreshSettled = false;
  hasLiveSnapshot = false;
  refreshInFlight = null;
  forceTrailingRefresh = false;
  mutationRevision += 1;
  rowPending = new Map();
  lastRefreshAt = 0;
  // These mutations own account-specific optimistic state too. Stop/clear
  // them before account B paints so no A completion can mutate B's surface.
  finishCalendarConnect(null);
  disconnectPendingByAccountId = new Set();
}

// In-app Google calendar OAuth: pending flag + bounded post-consent account
// watch (focus + interval, hard-stopped at CONNECT_POLL_MAX_MS).
let connectPending = $state(false);
let connectNotice = $state<ToastDescriptor | null>(null);
let connectBaselineIds = new Set<string>();
/** Bumped when a connect watch starts or finishes so in-flight polls cannot
 *  complete against a cleared/replaced baseline. */
let connectWatchGeneration = 0;
let connectWatchAccountGeneration = 0;
let connectPollTimer: ReturnType<typeof setInterval> | null = null;
let connectDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
let connectFocusHandler: (() => void) | null = null;

const CONNECT_POLL_INTERVAL_MS = 3_000;
const CONNECT_POLL_MAX_MS = 120_000;

function hydrateFromCache() {
  if (!activeAccountId) return;
  const snapshot = loadMeetingsCache<
    MeetingEvent,
    ScheduledBot,
    GoogleAccount,
    GoogleCalendar
  >(activeAccountId);
  if (!snapshot) return;
  hydratedFromCache = true;
  events = snapshot.events ?? [];
  botsByEventId = new Map(snapshot.botsByEventId ?? []);
  allBots =
    snapshot.scheduledBots ??
    (snapshot.botsByEventId ?? []).map(([, bot]) => bot);
  companyNamesByUid = new Map(snapshot.companyNamesByUid ?? []);
  accounts = snapshot.accounts ?? [];
  accountEmailById = new Map(snapshot.accountEmailById ?? []);
  calendarsByAccount = new Map(snapshot.calendarsByAccount ?? []);
  calendarSummaryByKey = new Map(snapshot.calendarSummaryByKey ?? []);
  enabledCalIdsByAccount = new Map(
    (snapshot.enabledCalIdsByAccount ?? []).map(([accountId, ids]) => [
      accountId,
      new Set(ids),
    ]),
  );
}

/**
 * Live fetch — see the desktop-alt original. Fetches events + memberships +
 * connected accounts, then the scheduled-bot list, then fans out to per-account
 * calendars before populating the model and persisting the snapshot.
 *
 * Errors are NOT swallowed to a blank state: on failure we keep whatever the
 * cache already painted, log the error, and surface a message instead of
 * faking "0 meetings".
 */
function refresh(forceAfterMutation = false): Promise<void> {
  if (refreshInFlight) {
    if (forceAfterMutation) forceTrailingRefresh = true;
    return refreshInFlight;
  }

  const run = async (): Promise<void> => {
    const generation = accountGeneration;
    loading = true;
    try {
      do {
        forceTrailingRefresh = false;
        const refreshRevision = mutationRevision;
        await refreshOnce(refreshRevision, generation);
      } while (forceTrailingRefresh);
    } finally {
      if (generation === accountGeneration) {
        loading = false;
        firstRefreshSettled = true;
      }
    }
  };

  const operation = run().finally(() => {
    if (refreshInFlight === operation) refreshInFlight = null;
  });
  refreshInFlight = operation;
  return operation;
}

async function refreshOnce(
  refreshRevision: number,
  generation: number,
): Promise<void> {
  const { meetings } = requireApi();
  let nextMembershipsError = "";
  try {
    const [evts, members, accts] = await Promise.all([
      meetings
        .listUpcoming()
        .then((r) => unwrap(r) as unknown as MeetingEvent[]),
      meetings
        .listMemberships()
        .then((r) => unwrap(r) as unknown as CompanyMembership[])
        .catch((err) => {
          console.error("meetings listMemberships failed:", err);
          nextMembershipsError = "Could not load calendar routing.";
          return [] as CompanyMembership[];
        }),
      meetings
        .listAccounts()
        .then((r) => unwrap(r) as unknown as GoogleAccount[])
        .catch(() => [] as GoogleAccount[]),
    ]);
    const botEventIds = calendarEventIdsForBotLookup(evts ?? []);
    // The adapter exposes a single full-list bot lookup (no per-event filter
    // arg on the wire). Fetch once, then derive the per-event slice locally so
    // mergeScheduledBotLookups keeps its original semantics.
    let fullBotsErr: unknown = null;
    const fullBots = await meetings
      .listScheduledBots()
      .then((r) => unwrap(r) as unknown as ScheduledBot[])
      .catch((err) => {
        fullBotsErr = err;
        console.error("meetings listScheduledBots failed:", err);
        return null as ScheduledBot[] | null;
      });
    const eventBots =
      fullBots === null
        ? null
        : fullBots.filter(
            (b) => b.calendarEventId && botEventIds.includes(b.calendarEventId),
          );
    const bots = mergeScheduledBotLookups(botEventIds, eventBots, fullBots);

    // Calendar fan-out is part of the same snapshot. Holding these values
    // locally prevents a pre-mutation poll from partially repainting the UI.
    const calendarSnapshot = await loadCalendarsForAccounts(accts ?? [], meetings);

    // A mutation committed while this pass was in flight. Its forced trailing
    // pass owns the next paint; never apply this pre-mutation snapshot.
    if (refreshRevision !== mutationRevision || generation !== accountGeneration) return;

    const resetGate = meetingsRefreshGate(refreshFailureCount, null);
    refreshFailureCount = resetGate.consecutiveFailures;
    let nextFetchError = resetGate.notice;
    let nextRefreshBlocked = resetGate.refreshBlocked;
    let nextLastRefreshErrorRaw = "";
    if (fullBots === null) {
      nextFetchError = friendlyError(
        fullBotsErr,
        "Could not refresh meeting bot status.",
      );
      nextRefreshBlocked = false;
      nextLastRefreshErrorRaw = String(fullBotsErr ?? "");
    }

    events = takeAgendaWindow(evts ?? []);
    if (bots !== null) {
      botsByEventId = buildBotMap(bots);
      allBots = bots;
    }
    memberships = members ?? [];
    companyNamesByUid = buildCompanyNameMap(members ?? []);
    accounts = accts ?? [];
    accountEmailById = new Map(
      (accts ?? []).map((a) => [a.accountId, a.email ?? ""]),
    );
    calendarsByAccount = calendarSnapshot.calendarsByAccount;
    enabledCalIdsByAccount = calendarSnapshot.enabledCalIdsByAccount;
    calendarSummaryByKey = calendarSnapshot.calendarSummaryByKey;
    membershipsError = nextMembershipsError;
    fetchError = nextFetchError;
    refreshBlocked = nextRefreshBlocked;
    lastRefreshErrorRaw = nextLastRefreshErrorRaw;

    // Persist AFTER everything (events + calendars) so the next paint
    // hydrates a complete view.
    persistSnapshot(generation);
    lastRefreshAt = Date.now();
    hasLiveSnapshot = true;
  } catch (err) {
    if (refreshRevision !== mutationRevision || generation !== accountGeneration) return;
    // Keep the cached paint; surface the failure rather than blanking out.
    console.error("meetings refresh failed:", err);
    lastRefreshErrorRaw = String(err ?? "");
    const gate = meetingsRefreshGate(
      refreshFailureCount,
      err,
      MEETINGS_STALE_NOTICE_FAILURES,
    );
    refreshFailureCount = gate.consecutiveFailures;
    fetchError = gate.notice;
    refreshBlocked = gate.refreshBlocked;
  }
}

/**
 * File a bug report for a stuck meetings refresh via the canonical `hq
 * feedback` pathway, attaching the raw error and current cache context.
 */
async function reportRefreshProblem(): Promise<ToastDescriptor> {
  const { title, body } = buildRefreshProblemReport({
    notice: fetchError,
    rawError: lastRefreshErrorRaw,
    meetingsShown: events.length,
    connectedAccounts: accounts.length,
  });
  try {
    unwrap(await requireApi().feedback.submitBugReport(title, body));
    return { kind: "info", text: "Thanks — bug report filed." };
  } catch (err) {
    return {
      kind: "warn",
      text: friendlyError(err, "Could not file the report — try /hq-bug."),
    };
  }
}

async function loadCalendarsForAccounts(
  accts: GoogleAccount[],
  meetingsApi = requireApi().meetings,
): Promise<CalendarSnapshot> {
  const nextByAccount = new Map<string, GoogleCalendar[]>();
  const nextEnabled = new Map<string, Set<string>>();
  const nextSummaries = new Map<string, string>();
  await Promise.all(
    accts.map(async (a) => {
      try {
        const resp = parseAccountCalendars(
          unwrap(await meetingsApi.listCalendars(a.accountId)),
        );
        nextByAccount.set(a.accountId, resp.calendars ?? []);
        nextEnabled.set(a.accountId, new Set(resp.selectedCalendarIds ?? []));
        for (const c of resp.calendars ?? []) {
          nextSummaries.set(`${a.accountId}|${c.id}`, c.summary);
        }
      } catch (err) {
        console.error(`meetings listCalendars failed for ${a.accountId}:`, err);
        nextByAccount.set(a.accountId, []);
        nextEnabled.set(a.accountId, new Set());
      }
    }),
  );
  return {
    calendarsByAccount: nextByAccount,
    enabledCalIdsByAccount: nextEnabled,
    calendarSummaryByKey: nextSummaries,
  };
}

function persistSnapshot(generation: number): void {
  if (!activeAccountId || generation !== accountGeneration) return;
  saveMeetingsCache<MeetingEvent, ScheduledBot, GoogleAccount, GoogleCalendar>(activeAccountId, {
    events,
    scheduledBots: allBots,
    botsByEventId: Array.from(botsByEventId.entries()),
    companyNamesByUid: Array.from(companyNamesByUid.entries()),
    accounts,
    accountEmailById: Array.from(accountEmailById.entries()),
    calendarsByAccount: Array.from(calendarsByAccount.entries()),
    enabledCalIdsByAccount: Array.from(enabledCalIdsByAccount.entries()).map(
      ([acct, ids]) => [acct, Array.from(ids)],
    ),
    calendarSummaryByKey: Array.from(calendarSummaryByKey.entries()),
  });
}

function buildBotMap(bots: ScheduledBot[]): Map<string, ScheduledBot> {
  const m = new Map<string, ScheduledBot>();
  for (const b of bots) {
    if (b.calendarEventId && isActiveStatus(b.status)) {
      m.set(b.calendarEventId, b);
    }
  }
  return m;
}

function buildCompanyNameMap(rows: CompanyMembership[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const row of rows) {
    if (row.companyName) m.set(row.companyUid, row.companyName);
  }
  return m;
}

function isActiveStatus(s: string): boolean {
  return (
    s === "scheduled" ||
    s === "joining" ||
    s === "recording" ||
    s === "processing" ||
    s === "completed"
  );
}

// ---------------------------------------------------------------------------
// Bot row-actions (invite / cancel / join-now). These own the adapter call +
// the per-row pending lock + the post-action refresh, and return a
// ToastDescriptor for the page to render. MeetingsAgenda stays backend-free.
// ---------------------------------------------------------------------------

function lockRow(key: string, action: MeetingBotAction): boolean {
  if (rowPending.has(key)) return false;
  rowPending = new Map(rowPending).set(key, action);
  return true;
}

function unlockRow(key: string, generation = accountGeneration): void {
  // A completion from account A must not release the same event-id lock that
  // account B acquired after an account rotation.
  if (generation !== accountGeneration) return;
  const next = new Map(rowPending);
  next.delete(key);
  rowPending = next;
}

function markMutationCommitted(generation = accountGeneration): boolean {
  if (generation !== accountGeneration) return false;
  mutationRevision += 1;
  return true;
}

const accountChangedToast: ToastDescriptor = {
  kind: "warn",
  text: "Your account changed. Retry this action.",
};

/** True when `uid` is one of the user's current memberships (cached names or live rows). */
function isOwnMembershipUid(uid: string): boolean {
  return memberships.some(
    (row) =>
      row.companyUid === uid &&
      isRecordingCompanyMembership(row),
  );
}

type RecordingDestination =
  | { kind: "personal" }
  | { kind: "company"; companyUid: string }
  | { kind: "unavailable" };

async function defaultRecordingDestination(
  settings: Pick<SettingsApi, "getSettings"> | null | undefined,
): Promise<RecordingDestination> {
  // A missing or unreadable host settings seam must never fall back to stale
  // browser storage and silently attribute a recording to another company.
  if (!settings) return { kind: "unavailable" };
  const result = await settings.getSettings();
  if (!result.ok) return { kind: "unavailable" };
  const value = result.value.defaultRecordingCompanyUid;
  return typeof value === "string" && value.trim()
    ? { kind: "company", companyUid: value.trim() }
    : { kind: "personal" };
}

async function invitePayload(
  meetingUrl: string,
  evt: MeetingEvent | null,
  settings: Pick<SettingsApi, "getSettings"> | null | undefined = requireApi().settings,
): Promise<Json> {
  // Event company wins; settings default fills only when the event has none.
  // Cross-company guard: a stored default must be an active own membership.
  const destination = evt?.sourceCompanyUid
    ? { kind: "personal" as const }
    : await defaultRecordingDestination(settings);
  if (destination.kind === "unavailable") {
    throw new Error("Recording destination settings are unavailable. Retry.");
  }
  const companyId = resolveInviteCompanyId(
    evt?.sourceCompanyUid,
    destination.kind === "company" ? destination.companyUid : null,
    { has: isOwnMembershipUid },
  );
  return {
    meetingUrl,
    calendarEventId: evt?.id ?? null,
    calendarSeriesId: evt ? recurringSeriesId(evt) : null,
    companyId,
  };
}

/**
 * Schedule a recording bot for the event's meeting. Mirrors the desktop
 * onInvite, including the benign-409 path (auto-schedule cron / another
 * instance got there first).
 *
 * US-005: HTTP 409 immediately seeds an already-invited row state and kicks a
 * *background* refresh — no error toast/banner. The row flips to Invited
 * before the network round-trip returns.
 */
async function inviteBot(evt: MeetingEvent): Promise<ToastDescriptor | null> {
  const url = eventMeetingUrl(evt);
  if (!url) return { kind: "warn", text: "No meeting URL on this event." };
  const key = evt.id;
  if (!lockRow(key, "invite")) return null;
  const generation = accountGeneration;
  const actionApi = requireApi();
  try {
    const payload = await invitePayload(url, evt, actionApi.settings ?? null);
    if (generation !== accountGeneration) return accountChangedToast;
    unwrap(await actionApi.meetings.inviteBot(payload));
    if (!markMutationCommitted(generation)) return accountChangedToast;
    await refresh(true);
    if (generation !== accountGeneration) return accountChangedToast;
    return { kind: "info", text: "Bot invited." };
  } catch (err) {
    if (generation !== accountGeneration) return accountChangedToast;
    if (isAlreadyScheduledError(err)) {
      markMutationCommitted(generation);
      seedAlreadyInvited(evt, url);
      // Background refresh — do not block the already-invited paint, and do
      // not surface a fetch-error banner for a successful conflict recovery.
      void refresh(true);
      return { kind: "info", text: "Already invited — refreshing." };
    }
    if (isPlanRequiredError(err)) return PLAN_REQUIRED_TOAST;
    return {
      kind: "warn",
      text: friendlyError(err, "Couldn't invite the bot."),
    };
  } finally {
    unlockRow(key, generation);
  }
}

/** Immediate local state for a 409 invite conflict so the agenda paints
 *  "Invited" without waiting on the refresh. */
function seedAlreadyInvited(evt: MeetingEvent, meetingUrl: string): void {
  if (botForEvent(evt, botsByEventId, allBots)) return;
  const seeded = optimisticAlreadyInvitedBot(evt, meetingUrl);
  const nextMap = new Map(botsByEventId);
  nextMap.set(evt.id, seeded);
  botsByEventId = nextMap;
  allBots = mergeScheduledBots([seeded], allBots);
}

/** Cancel the event's scheduled bot. No-op (returns null) when there's no bot
 *  on the row. No 409 special-case — a cancel conflict is a real failure. */
async function cancelBot(evt: MeetingEvent): Promise<ToastDescriptor | null> {
  const bot = botForEvent(evt, botsByEventId, allBots);
  if (!bot) return null;
  const key = evt.id;
  if (!lockRow(key, "uninvite")) return null;
  const generation = accountGeneration;
  const actionApi = requireApi();
  try {
    // The adapter's cancelBot resolves void; the richer CancelBotResult
    // (series scope / counts) is not on the wire, so the series-scoped toast
    // falls back to the bot row's own recurring flag.
    unwrap(await actionApi.meetings.cancelBot(bot.botId));
    if (generation !== accountGeneration) return accountChangedToast;
    const result: CancelBotResult = { recurringMeeting: bot.recurringMeeting };
    markMutationCommitted(generation);
    await refresh(true);
    if (generation !== accountGeneration) return accountChangedToast;
    if (
      result.scope === "series" ||
      result.recurringMeeting ||
      (result.cancelledCount ?? 0) > 1
    ) {
      return { kind: "info", text: "Bot uninvited from series." };
    }
    return { kind: "info", text: "Bot uninvited." };
  } catch (err) {
    if (generation !== accountGeneration) return accountChangedToast;
    return {
      kind: "warn",
      text: friendlyError(err, "Couldn't remove the bot."),
    };
  } finally {
    unlockRow(key, generation);
  }
}

/** Force the bot to join NOW — same payload as V1 `meetings_join_bot_now`
 *  (`POST /v1/bot/join-now`). hq-pro decides whether to bump an existing
 *  scheduled bot or create a fresh one. */
async function joinBotNow(evt: MeetingEvent): Promise<ToastDescriptor | null> {
  const url = eventMeetingUrl(evt);
  if (!url) return { kind: "warn", text: "No meeting URL on this event." };
  const key = evt.id;
  if (!lockRow(key, "join-now")) return null;
  const generation = accountGeneration;
  const actionApi = requireApi();
  try {
    const payload = await invitePayload(url, evt, actionApi.settings ?? null);
    if (generation !== accountGeneration) return accountChangedToast;
    unwrap(await actionApi.meetings.joinBotNow(payload));
    if (!markMutationCommitted(generation)) return accountChangedToast;
    await refresh(true);
    if (generation !== accountGeneration) return accountChangedToast;
    return { kind: "info", text: "Bot's on the way." };
  } catch (err) {
    if (generation !== accountGeneration) return accountChangedToast;
    if (isAlreadyScheduledError(err)) {
      markMutationCommitted(generation);
      seedAlreadyInvited(evt, url);
      void refresh(true);
      return { kind: "info", text: "Already invited — joining." };
    }
    if (isPlanRequiredError(err)) return PLAN_REQUIRED_TOAST;
    return {
      kind: "warn",
      text: friendlyError(err, "Couldn't tell the bot to join."),
    };
  } finally {
    unlockRow(key, generation);
  }
}

/**
 * Ad-hoc "paste a meeting URL" invite — schedules a recording bot for a link
 * the user pastes, with NO calendar event behind it. Mirrors the desktop
 * original, including its benign-409 path. The page owns the in-flight guard,
 * so this method has no per-row lock of its own.
 */
async function inviteBotByUrl(
  meetingUrl: string,
  companyId: string | null,
): Promise<ToastDescriptor | null> {
  const url = meetingUrl.trim();
  if (!isPlausibleMeetingUrl(url)) return null;
  const generation = accountGeneration;
  const actionApi = requireApi();
  try {
    unwrap(
      await actionApi.meetings.inviteBot({
        meetingUrl: url,
        calendarEventId: null,
        calendarSeriesId: null,
        companyId,
      }),
    );
    if (!markMutationCommitted(generation)) return accountChangedToast;
    await refresh(true);
    if (generation !== accountGeneration) return accountChangedToast;
    const dest = urlInviteDestinationLabel(companyId, companyNamesByUid);
    return {
      kind: "info",
      text: `Bot invited — meeting will save to ${dest}.`,
    };
  } catch (err) {
    if (generation !== accountGeneration) return accountChangedToast;
    // URL invites have no calendar row to seed; still treat 409 as success +
    // background refresh (no warn toast / error banner).
    if (isAlreadyScheduledError(err)) {
      markMutationCommitted(generation);
      void refresh(true);
      return { kind: "info", text: "Already invited — refreshing." };
    }
    if (isPlanRequiredError(err)) return PLAN_REQUIRED_TOAST;
    return {
      kind: "warn",
      text: friendlyError(err, "Couldn't invite the bot."),
    };
  }
}

// ---------------------------------------------------------------------------
// In-app Google calendar connect (US-002). POST /v1/google/connect → open the
// returned consent URL in the system browser, then poll listAccounts on focus
// + a short interval until a new account appears or CONNECT_POLL_MAX_MS elapses.
// ---------------------------------------------------------------------------

export interface BeginCalendarConnectResult {
  /** Consent URL for the page to open via openExternal; null on failure. */
  url: string | null;
  toast: ToastDescriptor | null;
}

function clearConnectNotice(): void {
  connectNotice = null;
}

function stopCalendarConnectWatch(): void {
  if (connectPollTimer !== null) {
    clearInterval(connectPollTimer);
    connectPollTimer = null;
  }
  if (connectDeadlineTimer !== null) {
    clearTimeout(connectDeadlineTimer);
    connectDeadlineTimer = null;
  }
  if (connectFocusHandler && typeof window !== "undefined") {
    window.removeEventListener("focus", connectFocusHandler);
    connectFocusHandler = null;
  }
}

function finishCalendarConnect(notice: ToastDescriptor | null): void {
  stopCalendarConnectWatch();
  connectPending = false;
  connectBaselineIds = new Set();
  connectWatchGeneration += 1;
  if (notice) connectNotice = notice;
}

async function pollForConnectedAccount(): Promise<void> {
  if (!connectPending) return;
  const watchGeneration = connectWatchGeneration;
  const generation = connectWatchAccountGeneration;
  const actionApi = requireApi();
  try {
    const accts = (await actionApi
      .meetings.listAccounts()
      .then((r) => unwrap(r))) as unknown as GoogleAccount[];
    // Discard polls that finished after this watch ended or was replaced.
    if (
      !connectPending ||
      watchGeneration !== connectWatchGeneration ||
      generation !== accountGeneration
    )
      return;
    const hasNew = (accts ?? []).some(
      (a) => a.accountId && !connectBaselineIds.has(a.accountId),
    );
    if (!hasNew) return;
    finishCalendarConnect({
      kind: "info",
      text: "Calendar connected.",
    });
    markMutationCommitted();
    void refresh(true);
  } catch (err) {
    console.error("meetings connect poll listAccounts failed:", err);
  }
}

function startCalendarConnectWatch(
  baseline: Iterable<string>,
  generation = accountGeneration,
): void {
  stopCalendarConnectWatch();
  connectWatchGeneration += 1;
  connectWatchAccountGeneration = generation;
  connectBaselineIds = new Set(baseline);
  connectPending = true;
  connectNotice = null;

  connectPollTimer = setInterval(() => {
    void pollForConnectedAccount();
  }, CONNECT_POLL_INTERVAL_MS);

  connectDeadlineTimer = setTimeout(() => {
    if (!connectPending) return;
    finishCalendarConnect({
      kind: "warn",
      text: "No new calendar connected — try again if you cancelled.",
    });
  }, CONNECT_POLL_MAX_MS);

  if (typeof window !== "undefined") {
    connectFocusHandler = () => {
      void pollForConnectedAccount();
    };
    window.addEventListener("focus", connectFocusHandler);
  }
}

/**
 * Start Google calendar OAuth. On success returns the consent `url` for the
 * page to open externally and begins a bounded account watch. On failure
 * returns a warn toast and leaves the UI re-connectable.
 */
async function beginCalendarConnect(): Promise<BeginCalendarConnectResult> {
  if (connectPending) {
    return { url: null, toast: null };
  }
  const generation = accountGeneration;
  const actionApi = requireApi();
  try {
    const raw = unwrap(await actionApi.meetings.connectCalendar()) as {
      url?: unknown;
    };
    if (generation !== accountGeneration) {
      return { url: null, toast: accountChangedToast };
    }
    const url = typeof raw?.url === "string" ? raw.url.trim() : "";
    if (!url) {
      return {
        url: null,
        toast: {
          kind: "warn",
          text: "Couldn't start calendar connect.",
        },
      };
    }
    // Baseline must reflect LIVE accounts at watch-start. Settings can kick
    // off connect before Meetings has hydrated `accounts`, and an empty
    // baseline would treat a pre-existing account as "new".
    let baselineIds = accounts.map((a) => a.accountId).filter(Boolean);
    try {
      const live = (await actionApi
        .meetings.listAccounts()
        .then((r) => unwrap(r))) as unknown as GoogleAccount[];
      if (generation !== accountGeneration) {
        return { url: null, toast: accountChangedToast };
      }
      baselineIds = (live ?? [])
        .map((a) => a.accountId)
        .filter((id): id is string => Boolean(id));
    } catch (err) {
      console.error("meetings connect baseline listAccounts failed:", err);
    }
    if (generation !== accountGeneration) {
      return { url: null, toast: accountChangedToast };
    }
    startCalendarConnectWatch(baselineIds, generation);
    return {
      url,
      toast: {
        kind: "info",
        text: "Finish connecting in your browser…",
      },
    };
  } catch (err) {
    return {
      url: null,
      toast: {
        kind: "warn",
        text: friendlyError(err, "Couldn't start calendar connect."),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// In-app per-account calendar disconnect (US-003). Optimistic remove of the
// account (+ calendar maps), DELETE via adapter, then refresh(true). On
// failure restore the exact prior snapshot and return a warn toast.
// Confirm lives in the page — this action assumes the user already confirmed.
// ---------------------------------------------------------------------------

let disconnectPendingByAccountId = $state<Set<string>>(new Set());

/** Per-account slice for surgical rollback on disconnect failure. */
interface AccountSlice {
  account: GoogleAccount | undefined;
  calendars: GoogleCalendar[] | undefined;
  enabledIds: Set<string> | undefined;
  email: string | undefined;
  summaryEntries: Array<[string, string]>;
}

function snapshotAccountSlice(accountId: string): AccountSlice {
  const prefix = `${accountId}|`;
  const summaryEntries: Array<[string, string]> = [];
  for (const [key, summary] of calendarSummaryByKey) {
    if (key.startsWith(prefix)) summaryEntries.push([key, summary]);
  }
  return {
    account: accounts.find((a) => a.accountId === accountId),
    calendars: calendarsByAccount.get(accountId),
    enabledIds: enabledCalIdsByAccount.get(accountId),
    email: accountEmailById.get(accountId),
    summaryEntries,
  };
}

/** Re-merge only the failed account into CURRENT state — never clobber peers. */
function restoreAccountSlice(accountId: string, slice: AccountSlice): void {
  if (slice.account && !accounts.some((a) => a.accountId === accountId)) {
    accounts = [...accounts, slice.account];
  }
  if (slice.calendars !== undefined && !calendarsByAccount.has(accountId)) {
    const next = new Map(calendarsByAccount);
    next.set(accountId, slice.calendars);
    calendarsByAccount = next;
  }
  if (
    slice.enabledIds !== undefined &&
    !enabledCalIdsByAccount.has(accountId)
  ) {
    const next = new Map(enabledCalIdsByAccount);
    next.set(accountId, slice.enabledIds);
    enabledCalIdsByAccount = next;
  }
  if (slice.email !== undefined && !accountEmailById.has(accountId)) {
    const next = new Map(accountEmailById);
    next.set(accountId, slice.email);
    accountEmailById = next;
  }
  if (slice.summaryEntries.length > 0) {
    const next = new Map(calendarSummaryByKey);
    let changed = false;
    for (const [key, summary] of slice.summaryEntries) {
      if (!next.has(key)) {
        next.set(key, summary);
        changed = true;
      }
    }
    if (changed) calendarSummaryByKey = next;
  }
}

/** Optimistically drop one account and its calendar map entries. */
function removeAccountLocally(accountId: string): void {
  accounts = accounts.filter((a) => a.accountId !== accountId);
  const nextByAccount = new Map(calendarsByAccount);
  nextByAccount.delete(accountId);
  calendarsByAccount = nextByAccount;
  const nextEnabled = new Map(enabledCalIdsByAccount);
  nextEnabled.delete(accountId);
  enabledCalIdsByAccount = nextEnabled;
  const nextEmails = new Map(accountEmailById);
  nextEmails.delete(accountId);
  accountEmailById = nextEmails;
  const prefix = `${accountId}|`;
  const nextSummaries = new Map(calendarSummaryByKey);
  for (const key of [...nextSummaries.keys()]) {
    if (key.startsWith(prefix)) nextSummaries.delete(key);
  }
  calendarSummaryByKey = nextSummaries;
}

/**
 * Revoke a connected Google calendar account. Callers own the confirm dialog.
 * Returns a toast for the page; `null` when a disconnect for this account is
 * already in flight.
 */
async function disconnectCalendar(
  accountId: string,
): Promise<ToastDescriptor | null> {
  const id = accountId.trim();
  if (!id) return null;
  if (disconnectPendingByAccountId.has(id)) return null;

  disconnectPendingByAccountId = new Set(disconnectPendingByAccountId).add(id);
  const removed = snapshotAccountSlice(id);
  removeAccountLocally(id);
  const generation = accountGeneration;
  const actionApi = requireApi();

  try {
    unwrap(await actionApi.meetings.disconnectCalendar(id));
    if (!markMutationCommitted(generation)) return accountChangedToast;
    await refresh(true);
    if (generation !== accountGeneration) return accountChangedToast;
    return { kind: "info", text: "Calendar disconnected." };
  } catch (err) {
    if (generation !== accountGeneration) return accountChangedToast;
    restoreAccountSlice(id, removed);
    return {
      kind: "warn",
      text: friendlyError(err, "Couldn't disconnect calendar."),
    };
  } finally {
    if (generation === accountGeneration) {
      const next = new Set(disconnectPendingByAccountId);
      next.delete(id);
      disconnectPendingByAccountId = next;
    }
  }
}

/**
 * Start the singleton once for the app's lifetime. Idempotent via `started`.
 *
 * Flow: cache-first synchronous paint -> one immediate network refresh -> 30s
 * poll to stay current -> re-hydrate + refresh on window focus, and re-hydrate
 * on cross-window storage writes. (Live meeting detection listeners from the
 * desktop original are host-owned now — see active-meetings.ts.)
 */
export function startMeetingsStore(): void {
  if (started) return;
  started = true;

  hydrateFromCache();

  pollTimer = setInterval(() => {
    if (viewActive) void refresh();
  }, POLL_INTERVAL_MS);

  if (typeof window !== "undefined") {
    const onFocus = () => {
      if (!viewActive) return;
      hydrateFromCache();
      if (Date.now() - lastRefreshAt > MEETINGS_REFRESH_MIN_MS) void refresh();
    };
    const onStorage = () => hydrateFromCache();
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
  }
}

/**
 * Tear down the poll. Not used in the app (the store is meant to live for the
 * whole session) but exported so tests can reset between runs.
 */
export function stopMeetingsStore(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  finishCalendarConnect(null);
  started = false;
  viewActive = false;
  hydratedFromCache = false;
  firstRefreshSettled = false;
  hasLiveSnapshot = false;
  lastRefreshAt = 0;
}

/**
 * US-010: launch-time warmup. The shell calls this right after
 * startMeetingsStore() so meetings data is already in state before the user
 * first opens the Meetings view. Skips the network when a recent refresh
 * already ran; shares the store's in-flight dedupe otherwise.
 */
export function prefetchMeetings(): Promise<void> {
  if (Date.now() - lastRefreshAt <= MEETINGS_REFRESH_MIN_MS) {
    return refreshInFlight ?? Promise.resolve();
  }
  return refresh();
}

/** Poll and focus-refresh only while the meetings pane is on screen. */
export function setMeetingsViewActive(active: boolean): void {
  viewActive = active;
  if (active && Date.now() - lastRefreshAt > MEETINGS_REFRESH_MIN_MS) {
    void refresh();
  }
}

// Reactive read surface. Consumers read these getters inside their own
// $derived / template, which subscribes them to the underlying $state so a
// poll-driven refresh repaints every open view automatically.
export const meetingsStore = {
  get events() {
    return events;
  },
  get accounts() {
    return accounts;
  },
  get calendarsByAccount() {
    return calendarsByAccount;
  },
  get enabledCalIdsByAccount() {
    return enabledCalIdsByAccount;
  },
  get botsByEventId() {
    return botsByEventId;
  },
  get scheduledBots() {
    return allBots;
  },
  get companyNamesByUid() {
    return companyNamesByUid;
  },
  get accountEmailById() {
    return accountEmailById;
  },
  get calendarSummaryByKey() {
    return calendarSummaryByKey;
  },
  get memberships() {
    return memberships;
  },
  get membershipsError() {
    return membershipsError;
  },
  get fetchError() {
    return fetchError;
  },
  get refreshBlocked() {
    return refreshBlocked;
  },
  get loading() {
    return loading;
  },
  /** US-010: true only before the first cache paint or settled refresh. */
  get initialLoadPending() {
    return !hydratedFromCache && !firstRefreshSettled;
  },
  /** US-010: a network refresh has fully succeeded at least once. */
  get hasLiveSnapshot() {
    return hasLiveSnapshot;
  },
  get pendingActionsByEventId() {
    return rowPending;
  },
  get connectPending() {
    return connectPending;
  },
  get connectNotice() {
    return connectNotice;
  },
  get disconnectPendingByAccountId() {
    return disconnectPendingByAccountId;
  },
  refresh,
  inviteBot,
  inviteBotByUrl,
  cancelBot,
  joinBotNow,
  reportRefreshProblem,
  beginCalendarConnect,
  disconnectCalendar,
  clearConnectNotice,
  /** Test/helper: stop the bounded connect watch without a notice. */
  stopCalendarConnectWatch: () => finishCalendarConnect(null),
};
