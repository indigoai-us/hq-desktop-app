/**
 * Registry-first feature gates for PlatformAdapter.hasFeature.
 *
 * Mirrors hq-pro's RegistryIntegrationMcpFlagResolver: the flag registry is
 * consulted first, and the existing adapter path remains the compatibility
 * path for an unregistered key or a registry outage. The fallback owns the
 * legacy truth table. A discovered-but-unconfigured row has no value and is
 * omitted from GET /v1/flags/resolve — treat that as unregistered so this
 * path keeps falling through to the legacy behaviour.
 *
 * Legacy `hasFeature` truth table (the fallback this module must not invert)
 * -------------------------------------------------------------------------
 *
 * Caller-visible flag `meetings` (registry key `desktop.meetings`):
 *
 *   Sync adapter — invoke `meetings_feature_enabled`
 *     → Rust `desktop_features_enabled()` (GA):
 *       signed-in (non-empty email claim)     → true
 *       signed-out / missing / malformed token → false
 *
 *   Tauri adapter — invoke `has_feature` { flag: "meetings" }
 *     byte-for-byte unchanged. This repo does not implement that command,
 *     so a miss stays an AdapterResult error, not a boolean.
 *
 *   Web adapter — GET /v1/identity/features/meetings
 *     that route does not exist on hq-pro (404). The Settings UI already
 *     treats `!ok` as false (`meetingsEnabled = res.ok ? res.value : false`).
 *     The web fallback is therefore a deliberate `ok(false)`: same
 *     user-visible answer, no 404 AdapterResult, no unhandled rejection.
 *
 * Caller-visible flag `is_indigo_user`:
 *   NOT mapped. Email-domain predicate (`email` ends in `@getindigo.ai`) is
 *   not expressible in the registry (person/company overrides only). Sync
 *   keeps `is_indigo_user`; Tauri keeps `has_feature`. Do not route it here.
 *
 * Any other flag: unmapped → existing path unchanged.
 *
 * Registry-first rule (must agree with the table on every input)
 * --------------------------------------------------------------
 *   snapshot === null (never loaded: offline, auth failure, service down)
 *     → legacy. Matches today when the registry is unreachable.
 *     The first resolve consumes `ready()` (one load). A later resolve
 *     with a still-null snapshot attempts one coalesced `refresh()` so a
 *     pre-auth / offline first load can self-heal; recovery is
 *     rate-limited to once per FLAG_REFRESH_INTERVAL_MS. Throws and
 *     timeouts still fall through.
 *   snapshot loaded but `flags[key]` is not a boolean (key omitted)
 *     → legacy. Matches auto-discovery: an unconfigured row must not
 *       evaluate as false, which would invert meetings GA (true when
 *       signed in) fleet-wide until an operator sets defaultValue.
 *   snapshot.flags[key] is a boolean
 *     → `client.isEnabled(key)`. Operator-configured override.
 *   any throw from the registry client
 *     → legacy, and no rejection escapes (`hasFeature` stays total).
 *
 * Proof the new path does not invert the table:
 *   Registry blip / 401 / timeout     → snapshot null → same as today
 *   Auto-discovered unconfigured row  → key absent     → same as today
 *   Operator sets defaultValue: true  → isEnabled true  (matches GA signed-in)
 *   Operator sets defaultValue: false → isEnabled false (intentional override)
 *   `is_indigo_user`                  → never consults the registry
 *
 * Do not call `isEnabled` unless the snapshot contains a configured value.
 * `isEnabled` is total and would return its own fallback (default false)
 * for a missing key — the inverse of meetings GA.
 */

import {
  createFlagClient,
  type FlagClient,
  type FlagClientOptions,
  type FlagSnapshot,
} from "@indigoai-us/hq-flags-client";
import {
  ok,
  type AdapterPromise,
  type AdapterResult,
  type HqProFetch,
} from "./adapter.js";

export const FIRST_FOLDER_SYNC_STEP_FLAG =
  "desktop.first-folder-sync-step-v1";
export const COMPANY_ROUTE_LOOKUP_RETRY_FLAG =
  "desktop.company-route-lookup-retry-v1";
export const PERSONAL_WORKSPACE_BOARD_FLAG =
  "desktop.personal-workspace-board-v1";
export const LOGIN_RECEIPT_DURABILITY_FLAG =
  "desktop.login-receipt-durable-before-return-v1";
export const POST_READY_ACTION_TELEMETRY_FLAG =
  "desktop.post-ready-action-telemetry-v1";
export const READY_FIRST_ACTION_FLAG = "desktop.ready-first-action-v1";
export const DESKTOP_LIMIT_STATUS_PUSH_FLAG = "desktop.limit-status-push";
export const SETUP_DEPS_TIMEOUT_RETRY_FLAG =
  "desktop.setup-deps-timeout-retry-v1";
export const HUMAN_ONLY_CONVERSATIONS_FLAG =
  "desktop.human-only-conversations";
export const PERSONAL_TRANSCRIPTS_FLAG =
  "desktop.meetings-personal-transcripts";
/**
 * New bot → Cloud creates through POST /v1/agents (desktop-agent-creation).
 * Targeted to one company, so it must be read with that company's uid:
 * `hasFeature(DESKTOP_AGENT_CREATION_FLAG, { companyUid })`. A person-only
 * read never sees a company override. Absent or unreadable means off.
 */
export const DESKTOP_AGENT_CREATION_FLAG = "agents.desktop-agent-creation";
/**
 * Desktop value for `desktop.human-only-conversations`. The desktop (Tauri)
 * adapters answer this flag with this constant and do not consult the
 * registry, so a missing, stale, or `false` registry value cannot turn the
 * filter off. Set to `false` in a later release to turn it back off.
 */
export const HUMAN_ONLY_CONVERSATIONS_DESKTOP_DEFAULT = true;

/**
 * Console-rail surfaces that are Indigo-only until they land (RELEASE-001).
 * The UI reads them through `isIndigoOnlySurface` in
 * `packages/ui/src/shell/indigo-only-gates.ts`, keyed to the open company.
 * A configured registry value of `true` opens a surface to every company;
 * `false` keeps it Indigo-only. See docs/design-standard-console-rail.md.
 */
export const RAIL_TELEMETRY_FLAG = "desktop.rail-telemetry-v1";
export const RAIL_OUTPOST_FLAG = "desktop.rail-outpost-v1";
export const RAIL_DEPLOYMENTS_ACTIONS_FLAG =
  "desktop.rail-deployments-actions-v1";
export const RAIL_SHORTCUT_EDITING_FLAG = "desktop.rail-shortcut-editing-v1";
export const RAIL_WORKFORCE_LIMITS_FLAG = "desktop.rail-workforce-limits-v1";
export const RAIL_ATLAS_FLAG = "desktop.rail-atlas-v1";

/**
 * Value each rail gate takes for non-Indigo companies when the registry has
 * no configured row, is unreachable, or has not loaded yet. Atlas is open to
 * everyone (owner call); the rest stay closed.
 */
export const RAIL_GATE_EVERYONE_DEFAULT: Readonly<Record<string, boolean>> = {
  [RAIL_TELEMETRY_FLAG]: false,
  [RAIL_OUTPOST_FLAG]: false,
  [RAIL_DEPLOYMENTS_ACTIONS_FLAG]: false,
  [RAIL_SHORTCUT_EDITING_FLAG]: false,
  [RAIL_WORKFORCE_LIMITS_FLAG]: false,
  [RAIL_ATLAS_FLAG]: true,
};

/** Caller-visible names that may consult the registry. */
export const LEGACY_TO_REGISTRY: Readonly<Record<string, string>> = {
  meetings: "desktop.meetings",
  "agents.claude-provider": "agents.claude-provider",
  [FIRST_FOLDER_SYNC_STEP_FLAG]: FIRST_FOLDER_SYNC_STEP_FLAG,
  [COMPANY_ROUTE_LOOKUP_RETRY_FLAG]: COMPANY_ROUTE_LOOKUP_RETRY_FLAG,
  [PERSONAL_WORKSPACE_BOARD_FLAG]: PERSONAL_WORKSPACE_BOARD_FLAG,
  [LOGIN_RECEIPT_DURABILITY_FLAG]: LOGIN_RECEIPT_DURABILITY_FLAG,
  [POST_READY_ACTION_TELEMETRY_FLAG]: POST_READY_ACTION_TELEMETRY_FLAG,
  [READY_FIRST_ACTION_FLAG]: READY_FIRST_ACTION_FLAG,
  [DESKTOP_LIMIT_STATUS_PUSH_FLAG]: DESKTOP_LIMIT_STATUS_PUSH_FLAG,
  [SETUP_DEPS_TIMEOUT_RETRY_FLAG]: SETUP_DEPS_TIMEOUT_RETRY_FLAG,
  [HUMAN_ONLY_CONVERSATIONS_FLAG]: HUMAN_ONLY_CONVERSATIONS_FLAG,
  [DESKTOP_AGENT_CREATION_FLAG]: DESKTOP_AGENT_CREATION_FLAG,
  [PERSONAL_TRANSCRIPTS_FLAG]: PERSONAL_TRANSCRIPTS_FLAG,
  "desktop.mirror-quarantine-move-not-deletion":
    "desktop.mirror-quarantine-move-not-deletion",
  [RAIL_TELEMETRY_FLAG]: RAIL_TELEMETRY_FLAG,
  [RAIL_OUTPOST_FLAG]: RAIL_OUTPOST_FLAG,
  [RAIL_DEPLOYMENTS_ACTIONS_FLAG]: RAIL_DEPLOYMENTS_ACTIONS_FLAG,
  [RAIL_SHORTCUT_EDITING_FLAG]: RAIL_SHORTCUT_EDITING_FLAG,
  [RAIL_WORKFORCE_LIMITS_FLAG]: RAIL_WORKFORCE_LIMITS_FLAG,
  [RAIL_ATLAS_FLAG]: RAIL_ATLAS_FLAG,
};

export const MEETINGS_LEGACY_FLAG = "meetings";
export const MEETINGS_REGISTRY_KEY = "desktop.meetings";
export const CLAUDE_PROVIDER_FLAG = "agents.claude-provider";
export const MIRROR_QUARANTINE_MOVE_NOT_DELETION_FLAG =
  "desktop.mirror-quarantine-move-not-deletion";

/**
 * FlagClient revalidation cadence for the desktop/web adapters.
 *
 * The client default is 10 seconds (`DEFAULT_REFRESH_INTERVAL_MS`), which is
 * far too chatty for a long-lived desktop process — the app stays open for
 * days. Five minutes is the staleness window an operator flipping
 * `desktop.meetings` can live with, without polling `/v1/flags/resolve` on a
 * tight loop. A failed first load (pre-auth, offline) also self-heals at most
 * once per this interval so a signed-out renderer cannot hammer the endpoint.
 */
export const FLAG_REFRESH_INTERVAL_MS = 300_000;

export type FlagInvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type FeatureFlagFallback = () => AdapterPromise<boolean>;

export interface FeatureFlagGate {
  resolve(flag: string, fallback: FeatureFlagFallback): AdapterPromise<boolean>;
  /** Notify when the registry client publishes a refreshed snapshot. */
  subscribe(
    flag: string,
    fallback: FeatureFlagFallback,
    onChange: (result: AdapterResult<boolean>) => void,
  ): () => void;
}

export interface FeatureFlagGateOptions {
  /** hq-pro base URL. Empty when fetch already talks through `hq_pro_fetch`. */
  endpoint: string;
  /**
   * Evaluate in this company's context (`/v1/flags/resolve?companyUid=`).
   * Omit for a person-only evaluation, which ignores company overrides.
   */
  companyUid?: string;
  /** Existing adapter token plumbing. Never read tokens from disk here. */
  getToken: () => string | Promise<string>;
  fetch?: typeof fetch;
  /**
   * Test seam. Production uses `createFlagClient`. Injected clients must still
   * honour the snapshot-null / unconfigured / configured contract.
   */
  createClient?: (options: FlagClientOptions) => FlagClient;
  onError?: (error: unknown) => void;
  /**
   * Clock for recovery rate-limiting. Production uses `Date.now`. Tests inject
   * a fake so the five-minute window can be crossed without waiting.
   */
  now?: () => number;
}

/**
 * Wrap `hq_pro_fetch` as a Fetch API so FlagClient can use the desktop host's
 * existing authenticated transport. The webview never holds the bearer.
 *
 * `endpoint` is the empty string on this path: FlagClient concatenates
 * `${endpoint}/v1/flags/resolve` → `/v1/flags/resolve`, which is the path
 * Rust prefixes with the real hq-pro base URL.
 */
export function createHqProFlagFetch(invoke: FlagInvokeFn): typeof fetch {
  return async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let path = url;
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url);
      path = `${parsed.pathname}${parsed.search}`;
    }
    const raw = await invoke("hq_pro_fetch", {
      url: path,
      method: "GET",
      body: null,
    });
    const rec =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { status?: unknown; body?: unknown })
        : null;
    if (rec && typeof rec.status === "number") {
      const body = typeof rec.body === "string" ? rec.body : "";
      return new Response(body, { status: rec.status });
    }
    return new Response(JSON.stringify(raw ?? null), { status: 200 });
  };
}

/**
 * {@link HqProFetch} over the desktop host's `hq_pro_fetch` command. Unlike
 * the flag transport above it forwards the method and body. The webview never
 * holds the bearer: Rust adds it and prefixes the hq-pro base URL.
 */
export function createHqProRestFetch(invoke: FlagInvokeFn): HqProFetch {
  return async (path, init) => {
    const raw = await invoke("hq_pro_fetch", {
      url: path,
      method: init.method,
      body: init.body ?? null,
    });
    const rec =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { status?: unknown; body?: unknown })
        : null;
    if (rec && typeof rec.status === "number") {
      const body = typeof rec.body === "string" ? rec.body : "";
      return { status: rec.status, text: async () => body };
    }
    // The host always answers `{ status, body }`. Anything else is a broken
    // bridge, never a success: report it as a bad gateway.
    console.warn("[hq-desktop] hq_pro_fetch returned no status", { url: path, method: init.method });
    const body = JSON.stringify({ error: "hq_pro_fetch returned no status" });
    return { status: 502, text: async () => body };
  };
}

export function bearerTokenFromHeaders(
  headers: Readonly<Record<string, string>>,
): string {
  const raw = headers.Authorization ?? headers.authorization ?? "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

export function registryKeyFor(flag: string): string | undefined {
  return LEGACY_TO_REGISTRY[flag];
}

function snapshotHasConfiguredValue(
  snapshot: FlagSnapshot | null,
  key: string,
): boolean {
  return snapshot != null && typeof snapshot.flags[key] === "boolean";
}

export function createFeatureFlagGate(
  options: FeatureFlagGateOptions,
): FeatureFlagGate {
  let client: FlagClient | null = null;
  /** True once the first `ready()` attempt has settled for this gate. */
  let initialReadySettled = false;
  let lastRecoveryAtMs: number | null = null;
  let inFlightRecovery: Promise<void> | null = null;
  const now = options.now ?? Date.now;

  function getClient(): FlagClient {
    if (!client) {
      const create = options.createClient ?? createFlagClient;
      client = create({
        endpoint: options.endpoint,
        ...(options.companyUid ? { companyUid: options.companyUid } : {}),
        getToken: options.getToken,
        fetch: options.fetch,
        refreshIntervalMs: FLAG_REFRESH_INTERVAL_MS,
        onError: options.onError ?? (() => {}),
      });
    }
    return client;
  }

  /**
   * One in-flight `refresh()` at a time, at most once per refresh interval.
   * Always total: a throw or timeout is swallowed so `resolve` can fall back.
   */
  function recoverNullSnapshot(flagClient: FlagClient): Promise<void> {
    if (inFlightRecovery) return inFlightRecovery;
    const t = now();
    if (
      lastRecoveryAtMs !== null &&
      t - lastRecoveryAtMs < FLAG_REFRESH_INTERVAL_MS
    ) {
      return Promise.resolve();
    }
    lastRecoveryAtMs = t;
    let refreshResult: Promise<unknown>;
    try {
      refreshResult = Promise.resolve(flagClient.refresh());
    } catch {
      return Promise.resolve();
    }
    const pending = refreshResult.then(
      () => undefined,
      () => undefined,
    );
    inFlightRecovery = pending;
    void pending.finally(() => {
      if (inFlightRecovery === pending) inFlightRecovery = null;
    });
    return pending;
  }

  const gate: FeatureFlagGate = {
    subscribe(flag, fallback, onChange) {
      const key = registryKeyFor(flag);
      if (!key) return () => {};
      const flagClient = getClient();
      let active = true;
      const unsubscribe = flagClient.onSnapshotChange(() => {
        void gate.resolve(flag, fallback).then((result) => {
          if (active) onChange(result);
        });
      });
      return () => {
        active = false;
        unsubscribe();
      };
    },
    async resolve(flag, fallback) {
      const key = registryKeyFor(flag);
      if (!key) return fallback();

      let configuredValue: boolean | null = null;
      try {
        const flagClient = getClient();
        await flagClient.ready();
        let snapshot = flagClient.snapshot();
        // ready() already attempted the first load. A second request on this
        // same resolve would double-hit a still-unauthenticated endpoint.
        // A later resolve with a still-null snapshot self-heals via refresh().
        const shouldRecover = snapshot == null && initialReadySettled;
        initialReadySettled = true;
        if (shouldRecover) {
          await recoverNullSnapshot(flagClient);
          snapshot = flagClient.snapshot();
        }
        if (snapshotHasConfiguredValue(snapshot, key)) {
          configuredValue = flagClient.isEnabled(key);
        }
      } catch {
        configuredValue = null;
      }

      if (configuredValue !== null) return ok(configuredValue);
      return fallback();
    },
  };
  return gate;
}

/** A person-scoped gate plus one gate per company, created on first use. */
export type ScopedFeatureFlagGates = (
  companyUid?: string | null,
) => FeatureFlagGate;

/**
 * `createFeatureFlagGate` per evaluation scope. The person-only gate is the
 * one adapters have always used; a company uid gets its own gate (and its own
 * snapshot) because hq-flags resolves company overrides only when the request
 * names the company.
 */
export function createScopedFeatureFlagGates(
  options: Omit<FeatureFlagGateOptions, "companyUid">,
): ScopedFeatureFlagGates {
  const personGate = createFeatureFlagGate(options);
  const companyGates = new Map<string, FeatureFlagGate>();
  return (companyUid) => {
    const uid = companyUid?.trim() ?? "";
    if (!uid) return personGate;
    let gate = companyGates.get(uid);
    if (!gate) {
      gate = createFeatureFlagGate({ ...options, companyUid: uid });
      companyGates.set(uid, gate);
    }
    return gate;
  };
}
