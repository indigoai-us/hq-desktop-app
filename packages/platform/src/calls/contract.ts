/**
 * Desktop mirror of the hq-pro native Meet contract ("hq-meet/1").
 *
 * Source of truth: indigoai-us/hq-pro @ 848a966101536036cab01efec69b3439735b5ec6
 * `src/meetings/native/contract.ts` (+ `limits.ts`). That file is authored with
 * zod; `packages/platform` is dependency-free, so the schemas are re-expressed
 * here as hand-written strict validators with byte-identical regexes, limits
 * and refinements. `src/calls/golden/` holds the service's own fixture bytes
 * and `contract.test.ts` proves both sides agree field-for-field.
 *
 * Strictness mirrors `z.strictObject`: every declared key must be present and
 * valid, and any undeclared key is rejected.
 */

/** UTF-8 JSON only; binary transports require a separately versioned contract. */
export const CALLS_VERSION = "hq-meet/1" as const;

export type CallsVersion = typeof CALLS_VERSION;

export const SUPPORTED_CONTRACT_RANGE: Readonly<{
  min: CallsVersion;
  max: CallsVersion;
}> = Object.freeze({ min: CALLS_VERSION, max: CALLS_VERSION });

/** Ceilings mirrored from hq-pro `src/meetings/native/limits.ts`. */
export const CALLS_LIMITS = Object.freeze({
  bodyBytes: 1_500_000,
  signalBytes: 65_536,
  signalReplayCount: 256,
  signalReplayBytes: 1_048_576,
  signalReplayMs: 30_000,
  signalsPerMinute: 120,
  segmentBytes: 16_384,
  segmentsPerMinute: 600,
  revisionsPerMinute: 1200,
  revisionRetentionMs: 86_400_000,
  uploadChunksPerMinute: 16,
  uploadRequestMs: 30_000,
  segmentsPerSource: 100_000,
  revisionsPerSegment: 32,
  spoolBytes: 268_435_456,
  spoolMs: 86_400_000,
  chunkBytes: 1_048_576,
  chunksPerCompletion: 256,
  completionRetentionMs: 604_800_000,
  callDurationMs: 14_400_000,
  grantTtlMs: 60_000,
  renewAfterMs: 30_000,
  clockSkewMs: 5_000,
  trafficStopMs: 5_000,
  knockTtlMs: 60_000,
  knocksPerMinute: 5,
  participants: 8,
  httpRequestMs: 10_000,
});

/** Error codes the service can return; mirrored verbatim. */
export const CALLS_ERROR_CODES = [
  "INVALID_INPUT",
  "UNSUPPORTED_VERSION",
  "BODY_TOO_LARGE",
  "UNAUTHENTICATED",
  "COMPANY_ACCESS_DENIED",
  "IDENTITY_MISMATCH",
  "STALE_EPOCH",
  "GRANT_EXPIRED",
  "ACTIVE_CALL_CONFLICT",
  "CALL_SEALED",
  "CAPACITY_EXCEEDED",
  "RATE_LIMITED",
  "SIGNAL_QUEUE_EXPIRED",
  "SIGNAL_UNAVAILABLE",
  "TURN_UNAVAILABLE",
  "CONSENT_REQUIRED",
  "REVISION_CONFLICT",
  "SPOOL_FULL",
  "UPLOAD_EXPIRED",
  "DIGEST_MISMATCH",
  "NOT_FOUND",
  "INVALID_SIGNATURE",
  "SIGNAL_REPLAY",
  "INTERNAL_ERROR",
] as const;

export type CallsErrorCode = (typeof CALLS_ERROR_CODES)[number];

/** Thrown by `parseEnvelope`; carries the service's own error code. */
export class CallsContractError extends Error {
  readonly code: CallsErrorCode;

  constructor(code: CallsErrorCode) {
    super(code);
    this.name = "CallsContractError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Primitive validators (regexes identical to the service)
// ---------------------------------------------------------------------------

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const HASH_PATTERN = /^[a-f0-9]{64}$/;
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
export const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Raw Ed25519 public key, base64url, 32 bytes. */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const MAX_CHUNK_BASE64 = 1_398_104;

type Check = (value: unknown) => boolean;

const utf8 = new TextEncoder();

/** Lone surrogates are rejected exactly as `String.prototype.isWellFormed`. */
export function isWellFormedString(value: string): boolean {
  const withMethod = value as string & { isWellFormed?: () => boolean };
  if (typeof withMethod.isWellFormed === "function") {
    return withMethod.isWellFormed();
  }
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(
    value,
  );
}

const id: Check = (v) => typeof v === "string" && ID_PATTERN.test(v);
const hash: Check = (v) => typeof v === "string" && HASH_PATTERN.test(v);
const signature: Check = (v) =>
  typeof v === "string" && SIGNATURE_PATTERN.test(v);
const bool: Check = (v) => typeof v === "boolean";
const nullableId: Check = (v) => v === null || id(v);

const uint =
  (max = Number.MAX_SAFE_INTEGER, min = 0): Check =>
  (v) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

const positive = (max = Number.MAX_SAFE_INTEGER): Check => uint(max, 1);

const bytes =
  (max: number): Check =>
  (v) =>
    typeof v === "string" &&
    isWellFormedString(v) &&
    utf8.encode(v).length <= max;

const literal =
  (expected: string): Check =>
  (v) =>
    v === expected;

const enumeration =
  (...allowed: readonly string[]): Check =>
  (v) =>
    typeof v === "string" && allowed.includes(v);

const arrayOf =
  (item: Check, max: number, min = 0): Check =>
  (v) =>
    Array.isArray(v) && v.length >= min && v.length <= max && v.every(item);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

const objectOf =
  (fields: Record<string, Check>): Check =>
  (v) =>
    isPlainObject(v) && strictFields(v, fields);

function strictFields(
  value: Record<string, unknown>,
  fields: Record<string, Check>,
): boolean {
  const keys = Object.keys(value);
  const expected = Object.keys(fields);
  if (keys.length !== expected.length) return false;
  for (const key of expected) {
    // `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`: the
    // Sync app typechecks this shared source against an older lib target.
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
    if (!fields[key]!(value[key])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

export interface CallBinding {
  companyUid: string;
  roomId: string;
  callId: string;
  epoch: number;
}

interface EnvelopeBase extends CallBinding {
  version: CallsVersion;
}

interface AuthorFields {
  personUid: string;
  deviceId: string;
  peerKey: string;
}

export interface RoomEnvelope extends EnvelopeBase {
  kind: "room";
  visibility: "private" | "company";
  host: string;
  cohosts: string[];
  state: "open" | "sealed";
  rosterRevision: number;
}

export interface GrantEnvelope extends EnvelopeBase, AuthorFields {
  kind: "grant";
  role: "host" | "cohost" | "participant";
  rosterRevision: number;
  issuedAt: number;
  expiresAt: number;
  grantId: string;
}

export interface AdmissionEnvelope extends EnvelopeBase, AuthorFields {
  kind: "admission";
  requestId: string;
}

export interface KnockEnvelope extends EnvelopeBase {
  kind: "knock";
  from: string;
  target: string;
  knockId: string;
  note: string;
  state:
    | "pending"
    | "accepted"
    | "declined"
    | "deferred"
    | "cancelled"
    | "expired";
  expiresAt: number;
  idempotencyKey: string;
}

export interface SignalEnvelope extends EnvelopeBase, AuthorFields {
  kind: "signal";
  targetPersonUid: string;
  targetDeviceId: string;
  grantId: string;
  rosterRevision: number;
  sequence: number;
  type: "offer" | "answer" | "ice";
  payload: string;
  sentAt: number;
}

export interface ConsentParticipant {
  personUid: string;
  deviceId: string;
  acknowledged: boolean;
}

export interface ConsentEnvelope extends EnvelopeBase {
  kind: "consent";
  rosterRevision: number;
  consentEpoch: number;
  participants: ConsentParticipant[];
  processorId: string | null;
}

export interface SegmentEnvelope extends EnvelopeBase, AuthorFields {
  kind: "segment";
  sourceId: string;
  segmentId: string;
  consentEpoch: number;
  rosterRevision: number;
  sequence: number;
  revision: number;
  start: number;
  end: number;
  speaker: string;
  text: string;
  final: boolean;
  digest: string;
  signature: string;
}

export interface CorrectionEnvelope extends EnvelopeBase, AuthorFields {
  kind: "correction";
  sourceId: string;
  segmentId: string;
  consentEpoch: number;
  rosterRevision: number;
  previousRevision: number;
  revision: number;
  text: string;
  digest: string;
  signature: string;
}

export interface ReceiptEnvelope extends EnvelopeBase, AuthorFields {
  kind: "receipt";
  sourceId: string;
  segmentId: string;
  revision: number;
  digest: string;
  durability: "local-persisted" | "peer-durable" | "source-saved";
  persistedAt: number;
  signature: string;
}

export interface CompletionManifestSource {
  sourceId: string;
  personUid: string;
  deviceId: string;
  segmentCount: number;
  digest: string;
}

export interface CompletionManifestEnvelope extends EnvelopeBase {
  kind: "completionManifest";
  revision: number;
  finalizerEpoch: number;
  consentEpoch: number;
  rosterRevision: number;
  coverage: "complete" | "silent" | "partial" | "missing";
  processorId: string | null;
  sources: CompletionManifestSource[];
  chunks: string[];
}

export interface UploadCapabilityEnvelope extends EnvelopeBase, AuthorFields {
  kind: "uploadCapability";
  capabilityId: string;
  manifestHash: string;
  finalizerEpoch: number;
  issuedAt: number;
  expiresAt: number;
  scope: "completion-upload";
}

export interface ChunkEnvelope extends EnvelopeBase {
  kind: "chunk";
  capabilityId: string;
  manifestHash: string;
  index: number;
  digest: string;
  byteLength: number;
  data: string;
}

export interface ChunkReceiptEnvelope extends EnvelopeBase {
  kind: "chunkReceipt";
  capabilityId: string;
  manifestHash: string;
  index: number;
  digest: string;
  byteLength: number;
  storedAt: number;
}

export interface FinalizationReceiptEnvelope extends EnvelopeBase {
  kind: "finalizationReceipt";
  manifestHash: string;
  finalizerEpoch: number;
  revision: number;
  sourceRef: string;
  savedAt: number;
}

export interface CompletionEnvelope extends EnvelopeBase {
  kind: "completion";
  revision: number;
  manifestHash: string;
  finalizerEpoch: number;
  chunks: number;
  segmentCount: number;
  coverage: "complete" | "silent" | "partial" | "missing";
  sourceRef: string | null;
  processorId: string | null;
  processingState:
    | "pending-upload"
    | "source-saved"
    | "queued"
    | "processing"
    | "complete"
    | "failed";
  chunkReceipts: string[];
}

export interface EnvelopeByKind {
  room: RoomEnvelope;
  grant: GrantEnvelope;
  admission: AdmissionEnvelope;
  knock: KnockEnvelope;
  signal: SignalEnvelope;
  consent: ConsentEnvelope;
  segment: SegmentEnvelope;
  correction: CorrectionEnvelope;
  receipt: ReceiptEnvelope;
  completionManifest: CompletionManifestEnvelope;
  uploadCapability: UploadCapabilityEnvelope;
  chunk: ChunkEnvelope;
  chunkReceipt: ChunkReceiptEnvelope;
  finalizationReceipt: FinalizationReceiptEnvelope;
  completion: CompletionEnvelope;
}

export type EnvelopeKind = keyof EnvelopeByKind;

export type CallsEnvelope = EnvelopeByKind[EnvelopeKind];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

interface KindSchema {
  fields: Record<string, Check>;
  refine?: (value: Record<string, unknown>) => boolean;
}

const binding: Record<string, Check> = {
  companyUid: id,
  roomId: id,
  callId: id,
  epoch: positive(),
};

const author: Record<string, Check> = {
  personUid: id,
  deviceId: id,
  peerKey: hash,
};

const base = (kind: EnvelopeKind): Record<string, Check> => ({
  version: literal(CALLS_VERSION),
  kind: literal(kind),
  ...binding,
});

const num = (value: Record<string, unknown>, key: string): number =>
  value[key] as number;

export const CALLS_SCHEMAS: Readonly<Record<EnvelopeKind, KindSchema>> =
  Object.freeze({
    room: {
      fields: {
        ...base("room"),
        visibility: enumeration("private", "company"),
        host: id,
        cohosts: arrayOf(id, 7),
        state: enumeration("open", "sealed"),
        rosterRevision: positive(),
      },
    },
    grant: {
      fields: {
        ...base("grant"),
        ...author,
        role: enumeration("host", "cohost", "participant"),
        rosterRevision: positive(),
        issuedAt: uint(),
        expiresAt: uint(),
        grantId: id,
      },
      refine: (v) =>
        num(v, "expiresAt") > num(v, "issuedAt") &&
        num(v, "expiresAt") - num(v, "issuedAt") <= CALLS_LIMITS.grantTtlMs,
    },
    admission: {
      fields: { ...base("admission"), ...author, requestId: id },
    },
    knock: {
      fields: {
        ...base("knock"),
        from: id,
        target: id,
        knockId: id,
        note: bytes(512),
        state: enumeration(
          "pending",
          "accepted",
          "declined",
          "deferred",
          "cancelled",
          "expired",
        ),
        expiresAt: uint(),
        idempotencyKey: id,
      },
    },
    signal: {
      fields: {
        ...base("signal"),
        ...author,
        targetPersonUid: id,
        targetDeviceId: id,
        grantId: id,
        rosterRevision: positive(),
        sequence: uint(),
        type: enumeration("offer", "answer", "ice"),
        payload: bytes(CALLS_LIMITS.signalBytes),
        sentAt: uint(),
      },
    },
    consent: {
      fields: {
        ...base("consent"),
        rosterRevision: positive(),
        consentEpoch: positive(),
        participants: arrayOf(
          objectOf({ personUid: id, deviceId: id, acknowledged: bool }),
          8,
          1,
        ),
        processorId: nullableId,
      },
      refine: (v) => {
        const participants = v.participants as ConsentParticipant[];
        return (
          new Set(participants.map((p) => p.personUid)).size ===
          participants.length
        );
      },
    },
    segment: {
      fields: {
        ...base("segment"),
        ...author,
        sourceId: id,
        segmentId: id,
        consentEpoch: positive(),
        rosterRevision: positive(),
        sequence: uint(CALLS_LIMITS.segmentsPerSource - 1),
        revision: positive(CALLS_LIMITS.revisionsPerSegment),
        start: uint(CALLS_LIMITS.callDurationMs),
        end: uint(CALLS_LIMITS.callDurationMs),
        speaker: id,
        text: bytes(CALLS_LIMITS.segmentBytes),
        final: bool,
        digest: hash,
        signature,
      },
      refine: (v) => num(v, "end") >= num(v, "start"),
    },
    correction: {
      fields: {
        ...base("correction"),
        ...author,
        sourceId: id,
        segmentId: id,
        consentEpoch: positive(),
        rosterRevision: positive(),
        previousRevision: positive(31),
        revision: positive(32),
        text: bytes(CALLS_LIMITS.segmentBytes),
        digest: hash,
        signature,
      },
      refine: (v) => num(v, "revision") === num(v, "previousRevision") + 1,
    },
    receipt: {
      fields: {
        ...base("receipt"),
        ...author,
        sourceId: id,
        segmentId: id,
        revision: positive(32),
        digest: hash,
        durability: enumeration(
          "local-persisted",
          "peer-durable",
          "source-saved",
        ),
        persistedAt: uint(),
        signature,
      },
    },
    completionManifest: {
      fields: {
        ...base("completionManifest"),
        revision: positive(),
        finalizerEpoch: positive(),
        consentEpoch: positive(),
        rosterRevision: positive(),
        coverage: enumeration("complete", "silent", "partial", "missing"),
        processorId: nullableId,
        sources: arrayOf(
          objectOf({
            sourceId: id,
            personUid: id,
            deviceId: id,
            segmentCount: uint(CALLS_LIMITS.segmentsPerSource),
            digest: hash,
          }),
          8,
        ),
        chunks: arrayOf(hash, CALLS_LIMITS.chunksPerCompletion),
      },
      refine: (v) => {
        if (v.coverage !== "silent") return true;
        const sources = v.sources as CompletionManifestSource[];
        return (
          (v.chunks as string[]).length === 0 &&
          sources.every((s) => s.segmentCount === 0)
        );
      },
    },
    uploadCapability: {
      fields: {
        ...base("uploadCapability"),
        ...author,
        capabilityId: id,
        manifestHash: hash,
        finalizerEpoch: positive(),
        issuedAt: uint(),
        expiresAt: uint(),
        scope: literal("completion-upload"),
      },
      refine: (v) =>
        num(v, "expiresAt") > num(v, "issuedAt") &&
        num(v, "expiresAt") - num(v, "issuedAt") <=
          CALLS_LIMITS.completionRetentionMs,
    },
    chunk: {
      fields: {
        ...base("chunk"),
        capabilityId: id,
        manifestHash: hash,
        index: uint(255),
        digest: hash,
        byteLength: uint(CALLS_LIMITS.chunkBytes),
        data: (v) =>
          typeof v === "string" &&
          v.length <= MAX_CHUNK_BASE64 &&
          BASE64_PATTERN.test(v),
      },
      /**
       * The service also decodes `data` and checks length + sha256 here. That
       * is inherently async in WebCrypto, so the byte check lives in the async
       * `verifyChunkBytes` helper (see ./crypto.js) and callers that accept
       * chunk payloads must run it.
       */
    },
    chunkReceipt: {
      fields: {
        ...base("chunkReceipt"),
        capabilityId: id,
        manifestHash: hash,
        index: uint(255),
        digest: hash,
        byteLength: uint(CALLS_LIMITS.chunkBytes),
        storedAt: uint(),
      },
    },
    finalizationReceipt: {
      fields: {
        ...base("finalizationReceipt"),
        manifestHash: hash,
        finalizerEpoch: positive(),
        revision: positive(),
        sourceRef: id,
        savedAt: uint(),
      },
    },
    completion: {
      fields: {
        ...base("completion"),
        revision: positive(),
        manifestHash: hash,
        finalizerEpoch: positive(),
        chunks: uint(256),
        segmentCount: uint(800_000),
        coverage: enumeration("complete", "silent", "partial", "missing"),
        sourceRef: nullableId,
        processorId: nullableId,
        processingState: enumeration(
          "pending-upload",
          "source-saved",
          "queued",
          "processing",
          "complete",
          "failed",
        ),
        chunkReceipts: arrayOf(hash, 256),
      },
      refine: (v) =>
        num(v, "chunks") === (v.chunkReceipts as string[]).length &&
        (v.coverage !== "silent" ||
          (num(v, "segmentCount") === 0 && num(v, "chunks") === 0)) &&
        (v.processingState === "pending-upload" ||
          v.processingState === "failed" ||
          v.sourceRef !== null) &&
        (!["queued", "processing", "complete"].includes(
          v.processingState as string,
        ) ||
          v.processorId !== null),
    },
  });

export function isEnvelopeKind(value: unknown): value is EnvelopeKind {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(CALLS_SCHEMAS, value)
  );
}

/**
 * Company/epoch context. Mirrors the service's `parseContract` context: a
 * mismatched `companyUid` is COMPANY_ACCESS_DENIED, never a silent pass.
 */
export interface ParseContext {
  companyUid: string;
  epoch?: number;
  consentEpoch?: number;
}

/**
 * Parse and validate one envelope. Throws `CallsContractError` with the same
 * code the service would return.
 */
export function parseEnvelope(
  input: unknown,
  context?: ParseContext,
): CallsEnvelope {
  if (!isPlainObject(input)) throw new CallsContractError("INVALID_INPUT");
  if (input.version !== CALLS_VERSION) {
    throw new CallsContractError("UNSUPPORTED_VERSION");
  }
  if (!isEnvelopeKind(input.kind)) {
    throw new CallsContractError("INVALID_INPUT");
  }
  const schema = CALLS_SCHEMAS[input.kind];
  if (!strictFields(input, schema.fields)) {
    throw new CallsContractError("INVALID_INPUT");
  }
  if (schema.refine && !schema.refine(input)) {
    throw new CallsContractError("INVALID_INPUT");
  }
  const value = input as unknown as CallsEnvelope;
  if (context) {
    if (value.companyUid !== context.companyUid) {
      throw new CallsContractError("COMPANY_ACCESS_DENIED");
    }
    if (context.epoch !== undefined && value.epoch !== context.epoch) {
      throw new CallsContractError("STALE_EPOCH");
    }
    if (
      context.consentEpoch !== undefined &&
      "consentEpoch" in value &&
      value.consentEpoch !== context.consentEpoch
    ) {
      throw new CallsContractError("STALE_EPOCH");
    }
  }
  return value;
}

/** Parse, asserting the envelope kind as well. */
export function parseEnvelopeOfKind<K extends EnvelopeKind>(
  kind: K,
  input: unknown,
  context?: ParseContext,
): EnvelopeByKind[K] {
  const value = parseEnvelope(input, context);
  if (value.kind !== kind) throw new CallsContractError("INVALID_INPUT");
  return value as EnvelopeByKind[K];
}

export type ParseResult =
  | { ok: true; value: CallsEnvelope }
  | { ok: false; code: CallsErrorCode };

/** Non-throwing `parseEnvelope`, for adapter paths that map codes to results. */
export function safeParseEnvelope(
  input: unknown,
  context?: ParseContext,
): ParseResult {
  try {
    return { ok: true, value: parseEnvelope(input, context) };
  } catch (err) {
    return {
      ok: false,
      code:
        err instanceof CallsContractError ? err.code : "INVALID_INPUT",
    };
  }
}
