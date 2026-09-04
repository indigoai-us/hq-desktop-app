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
import { ok, type AdapterPromise } from "./adapter.js";

/** Caller-visible names that may consult the registry. */
export const LEGACY_TO_REGISTRY: Readonly<Record<string, string>> = {
  meetings: "desktop.meetings",
};

export const MEETINGS_LEGACY_FLAG = "meetings";
export const MEETINGS_REGISTRY_KEY = "desktop.meetings";

export type FlagInvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type FeatureFlagFallback = () => AdapterPromise<boolean>;

export interface FeatureFlagGate {
  resolve(flag: string, fallback: FeatureFlagFallback): AdapterPromise<boolean>;
}

export interface FeatureFlagGateOptions {
  /** hq-pro base URL. Empty when fetch already talks through `hq_pro_fetch`. */
  endpoint: string;
  /** Existing adapter token plumbing. Never read tokens from disk here. */
  getToken: () => string | Promise<string>;
  fetch?: typeof fetch;
  /**
   * Test seam. Production uses `createFlagClient`. Injected clients must still
   * honour the snapshot-null / unconfigured / configured contract.
   */
  createClient?: (options: FlagClientOptions) => FlagClient;
  onError?: (error: unknown) => void;
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

  function getClient(): FlagClient {
    if (!client) {
      const create = options.createClient ?? createFlagClient;
      client = create({
        endpoint: options.endpoint,
        getToken: options.getToken,
        fetch: options.fetch,
        // hasFeature is pull-based. Do not leave a webview interval behind;
        // the next call reuses the held snapshot from ready().
        refreshIntervalMs: 0,
        onError: options.onError ?? (() => {}),
      });
    }
    return client;
  }

  return {
    async resolve(flag, fallback) {
      const key = registryKeyFor(flag);
      if (!key) return fallback();

      let configuredValue: boolean | null = null;
      try {
        const flagClient = getClient();
        await flagClient.ready();
        const snapshot = flagClient.snapshot();
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
}
