/**
 * The `calls` capability group implementation.
 *
 * One implementation serves every host that can reach hq-pro, parameterised by
 * a `CallsTransport` — the host's existing authenticated JSON seam (Rust
 * `hq_pro_fetch` on the Tauri/Sync hosts). Production paths never touch
 * `window.fetch`: the bearer stays in the native host.
 *
 * Every method is gated on a recorded, passing `preflight()`. Until then the
 * group answers `unavailable` with `CALLS_PREFLIGHT_REQUIRED`, so a Desktop
 * build cannot drive calling against an unverified backend by accident. The
 * gate is per adapter instance and lives only in memory — there is no
 * environment or flag override.
 */

import {
  failure,
  ok,
  unavailable,
  type AdapterFailure,
  type AdapterPromise,
  type AdapterResult,
  type CallsApi,
  type CompletionOperation,
  type Json,
  type KnockAction,
  type KnockCreateInput,
  type OfficeConnectivityInput,
  type OfficeDiscoverOptions,
  type OfficePreferenceInput,
  type CreateRoomInput,
  type RoomLifecycleAction,
  type SignalingOperation,
} from "../adapter.js";
import { CALLS_VERSION } from "./contract.js";
import {
  validateServiceEvidence,
  type EvidenceOptions,
  type ServiceEvidence,
} from "./evidence.js";

/** hq-pro native Meet routes (US-001). All JSON, all bearer-authenticated. */
export const CALLS_PATHS = {
  office: "/v1/meet-native/office",
  officePreference: "/v1/meet-native/office/preference",
  officeConnectivity: "/v1/meet-native/office/connectivity",
  rooms: "/v1/meet-native/rooms",
  room: (roomId: string) =>
    `/v1/meet-native/rooms/${encodeURIComponent(roomId)}`,
  roomAction: (roomId: string, action: string) =>
    `/v1/meet-native/rooms/${encodeURIComponent(roomId)}/${action}`,
  knocks: "/v1/meet-native/knocks",
  knock: (knockId: string) =>
    `/v1/meet-native/knocks/${encodeURIComponent(knockId)}`,
  knockAction: (knockId: string, action: string) =>
    `/v1/meet-native/knocks/${encodeURIComponent(knockId)}/${action}`,
  signaling: (operation: string) => `/v1/meet-native/signaling/${operation}`,
  iceConfig: "/v1/meet-native/ice-config",
  completionConsent: "/v1/meet-native/completion/consent",
  completion: (operation: string) => `/v1/meet-native/completion/${operation}`,
} as const;

/** Host JSON seam: an already-authenticated hq-pro request. */
export type CallsTransport = <T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => AdapterPromise<T>;

/** Refusal when preflight has not recorded passing service evidence. */
export const CALLS_PREFLIGHT_REQUIRED = "CALLS_PREFLIGHT_REQUIRED";
/** Refusal on hosts with no native calling at all (browsers). */
export const CALLS_UNSUPPORTED_HOST = "CALLS_UNSUPPORTED_HOST";

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

function requireId(value: unknown, field: string): AdapterFailure | null {
  return typeof value === "string" && value.trim().length > 0
    ? null
    : failure("INVALID_INPUT", `${field} is required.`);
}

/**
 * A `calls` group for a host that cannot place native calls. Every method is
 * explicit about it — nothing silently resolves `ok`, and no working native
 * control is exposed.
 */
export function createUnsupportedCallsApi(
  code: string = CALLS_UNSUPPORTED_HOST,
  message = "Native calling is not available on this host.",
): CallsApi {
  const refuse = <T>(): AdapterPromise<T> =>
    Promise.resolve(unavailable(code, message) as AdapterResult<T>);
  return {
    contractVersion: CALLS_VERSION,
    preflight: () => refuse(),
    preflightStatus: () => unavailable(code, message),
    discoverOffice: () => refuse(),
    setOfficePreference: () => refuse(),
    setOfficeConnectivity: () => refuse(),
    createRoom: () => refuse(),
    getRoom: () => refuse(),
    joinRoom: () => refuse(),
    roomLifecycle: () => refuse(),
    createKnock: () => refuse(),
    listKnocks: () => refuse(),
    getKnock: () => refuse(),
    respondToKnock: () => refuse(),
    signalingControl: () => refuse(),
    sendSignal: () => refuse(),
    iceConfig: () => refuse(),
    completionConsent: () => refuse(),
    completion: () => refuse(),
  };
}

/**
 * Build the native `calls` group over a host transport.
 *
 * Non-2xx responses are already mapped to `AdapterFailure` by the transport,
 * which preserves the backend `code` (COMPANY_ACCESS_DENIED, STALE_EPOCH,
 * RATE_LIMITED, ...) so callers branch on the contract's own vocabulary.
 */
export function createCallsApi(transport: CallsTransport): CallsApi {
  let evidence: ServiceEvidence | null = null;

  const blocked = <T>(): AdapterResult<T> =>
    unavailable(
      CALLS_PREFLIGHT_REQUIRED,
      "Calling requires a passing service evidence preflight on this adapter.",
    ) as AdapterResult<T>;

  async function guarded<T>(
    run: () => AdapterPromise<T>,
  ): AdapterPromise<T> {
    if (!evidence) return blocked<T>();
    return run();
  }

  function guardedInvalid<T>(
    invalid: AdapterFailure | null,
    run: () => AdapterPromise<T>,
  ): AdapterPromise<T> {
    if (!evidence) return Promise.resolve(blocked<T>());
    if (invalid) return Promise.resolve(invalid);
    return run();
  }

  /**
   * Stamp the pinned contract version on a request body.
   *
   * The body is spread FIRST so a caller-supplied `version` can never override
   * `CALLS_VERSION`: this adapter mirrors exactly one contract, and shipping a
   * different version string would be a silent lie to the backend. Sending an
   * unsupported version is the backend's job to reject (UNSUPPORTED_VERSION);
   * our job is to never send one.
   */
  const versioned = (body: Json): Json => ({ ...body, version: CALLS_VERSION });

  return {
    contractVersion: CALLS_VERSION,

    preflight: async (receipt, options?: EvidenceOptions) => {
      const result = validateServiceEvidence(receipt, options);
      if (!result.ok) {
        evidence = null;
        return result;
      }
      evidence = result.value;
      return ok(result.value);
    },

    preflightStatus: () =>
      evidence ? ok(evidence) : blocked<ServiceEvidence>(),

    discoverOffice: (companyUid, options?: OfficeDiscoverOptions) =>
      guardedInvalid(requireId(companyUid, "companyUid"), () =>
        transport<Json>(
          "GET",
          `${CALLS_PATHS.office}${query({
            companyUid,
            limit: options?.limit,
            cursor: options?.cursor,
          })}`,
        ),
      ),

    setOfficePreference: (input: OfficePreferenceInput) =>
      guardedInvalid(requireId(input?.companyUid, "companyUid"), () =>
        transport<Json>(
          "POST",
          CALLS_PATHS.officePreference,
          versioned({ ...input }),
        ),
      ),

    setOfficeConnectivity: (input: OfficeConnectivityInput) =>
      guardedInvalid(requireId(input?.companyUid, "companyUid"), () =>
        transport<Json>(
          "POST",
          CALLS_PATHS.officeConnectivity,
          versioned({ ...input }),
        ),
      ),

    createRoom: (input: CreateRoomInput) =>
      guardedInvalid(requireId(input?.companyUid, "companyUid"), () =>
        transport<Json>(
          "POST",
          CALLS_PATHS.rooms,
          versioned({
            companyUid: input.companyUid,
            visibility: input.visibility,
            cohosts: input.cohosts ?? [],
          }),
        ),
      ),

    getRoom: (roomId, companyUid) =>
      guardedInvalid(
        requireId(roomId, "roomId") ?? requireId(companyUid, "companyUid"),
        () =>
          transport<Json>(
            "GET",
            `${CALLS_PATHS.room(roomId)}${query({ companyUid })}`,
          ),
      ),

    joinRoom: (roomId, admission) =>
      guardedInvalid(requireId(roomId, "roomId"), () =>
        transport<Json>(
          "POST",
          CALLS_PATHS.roomAction(roomId, "join"),
          versioned({ ...admission }),
        ),
      ),

    roomLifecycle: (roomId, action: RoomLifecycleAction, body) =>
      guardedInvalid(requireId(roomId, "roomId"), () =>
        transport<Json>(
          "POST",
          CALLS_PATHS.roomAction(roomId, action),
          versioned({ ...body }),
        ),
      ),

    createKnock: (input: KnockCreateInput) =>
      guardedInvalid(requireId(input?.companyUid, "companyUid"), () =>
        transport<Json>("POST", CALLS_PATHS.knocks, versioned({ ...input })),
      ),

    listKnocks: (companyUid, limit) =>
      guardedInvalid(requireId(companyUid, "companyUid"), () =>
        transport<Json>(
          "GET",
          `${CALLS_PATHS.knocks}${query({ companyUid, limit })}`,
        ),
      ),

    getKnock: (knockId, companyUid) =>
      guardedInvalid(
        requireId(knockId, "knockId") ?? requireId(companyUid, "companyUid"),
        () =>
          transport<Json>(
            "GET",
            `${CALLS_PATHS.knock(knockId)}${query({ companyUid })}`,
          ),
      ),

    respondToKnock: (knockId, action: KnockAction, companyUid) =>
      guardedInvalid(
        requireId(knockId, "knockId") ?? requireId(companyUid, "companyUid"),
        () =>
          transport<Json>(
            "POST",
            CALLS_PATHS.knockAction(knockId, action),
            versioned({ companyUid }),
          ),
      ),

    signalingControl: (operation: SignalingOperation, control) =>
      guarded(() =>
        transport<Json>(
          "POST",
          CALLS_PATHS.signaling(operation),
          versioned({ ...control }),
        ),
      ),

    sendSignal: (request) =>
      guarded(() =>
        transport<Json>(
          "POST",
          CALLS_PATHS.signaling("send"),
          { signal: request.signal, signature: request.signature },
        ),
      ),

    iceConfig: (request) =>
      guarded(() =>
        transport<Json>(
          "POST",
          CALLS_PATHS.iceConfig,
          versioned({ ...request }),
        ),
      ),

    completionConsent: (control) =>
      guarded(() =>
        transport<Json>(
          "POST",
          CALLS_PATHS.completionConsent,
          versioned({ ...control }),
        ),
      ),

    completion: (operation: CompletionOperation, control) =>
      guarded(() =>
        transport<Json>(
          "POST",
          CALLS_PATHS.completion(operation),
          versioned({ ...control }),
        ),
      ),
  };
}
