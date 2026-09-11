import { describe, expect, it } from "vitest";

import {
  CALLS_VERSION,
  CallsContractError,
  SUPPORTED_CONTRACT_RANGE,
  parseEnvelope,
  parseEnvelopeOfKind,
  safeParseEnvelope,
  type EnvelopeKind,
} from "./contract.js";
import {
  canonical,
  contentDigest,
  keyId,
  sha256,
  signedBytes,
  toBase64Url,
  toHex,
  verifyChunkBytes,
  verifyEnvelope,
} from "./crypto.js";
import {
  CRYPTO_VECTORS,
  GOLDEN_PROVENANCE,
  GOLDEN_RAW,
  goldenJson,
} from "./golden/index.js";

/** Every golden vector that is a contract envelope, by kind. */
const ENVELOPE_VECTORS: ReadonlyArray<[EnvelopeKind, string]> = [
  ["room", "room.json"],
  ["grant", "grant.json"],
  ["admission", "admission.json"],
  ["knock", "knock.json"],
  ["signal", "signal.json"],
  ["consent", "consent.json"],
  ["segment", "segment.json"],
  ["correction", "correction.json"],
  ["receipt", "receipt.json"],
  ["completionManifest", "completionManifest.json"],
  ["uploadCapability", "uploadCapability.json"],
  ["chunk", "chunk.json"],
  ["chunkReceipt", "chunkReceipt.json"],
  ["finalizationReceipt", "finalizationReceipt.json"],
  ["completion", "completion.json"],
];

const COMPANY = "company_a";

function record(name: string): Record<string, unknown> {
  return goldenJson(name) as Record<string, unknown>;
}

describe("golden vector provenance", () => {
  it("pins the service repo, commit and contract hash", () => {
    expect(GOLDEN_PROVENANCE.serviceRepo).toBe("indigoai-us/hq-pro");
    expect(GOLDEN_PROVENANCE.serviceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(GOLDEN_PROVENANCE.contractHash).toBe(
      "6480e4a0c45e1dc40903152357c5f58ee06c36b1b6c31a62afdd7b2745740e76",
    );
  });

  it("carries the exact bytes PROVENANCE.json records", async () => {
    for (const [name, expected] of Object.entries(GOLDEN_PROVENANCE.files)) {
      const raw = GOLDEN_RAW[name];
      expect(raw, `${name} is missing from the golden set`).toBeDefined();
      expect(await sha256(raw!), name).toBe(expected);
    }
  });

  it("matches the service's own fixture manifest byte-for-byte", () => {
    // manifest.json is hq-pro's own sha256 index of the fixtures, copied here
    // unchanged. Agreeing with it proves the copy never drifted.
    const serviceManifest = record("manifest.json") as Record<string, string>;
    for (const [name, digest] of Object.entries(serviceManifest)) {
      expect(GOLDEN_PROVENANCE.files[name], name).toBe(digest);
    }
  });
});

describe("parseEnvelope", () => {
  it("declares the frozen contract version", () => {
    expect(CALLS_VERSION).toBe("hq-meet/1");
    expect(SUPPORTED_CONTRACT_RANGE).toEqual({
      min: "hq-meet/1",
      max: "hq-meet/1",
    });
  });

  for (const [kind, file] of ENVELOPE_VECTORS) {
    it(`parses the ${kind} vector preserving every field`, () => {
      const input = record(file);
      const parsed = parseEnvelope(input, { companyUid: COMPANY });
      expect(parsed.kind).toBe(kind);
      // Field-for-field identity: nothing dropped, renamed or defaulted.
      expect(parsed).toEqual(input);
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(input).sort());
      expect(parseEnvelopeOfKind(kind, input)).toEqual(input);
    });
  }

  it("rejects a foreign contract version with UNSUPPORTED_VERSION", () => {
    for (const [, file] of ENVELOPE_VECTORS) {
      const input = { ...record(file), version: "hq-meet/2" };
      expect(safeParseEnvelope(input)).toEqual({
        ok: false,
        code: "UNSUPPORTED_VERSION",
      });
    }
  });

  it("rejects another company's envelope with COMPANY_ACCESS_DENIED", () => {
    for (const [, file] of ENVELOPE_VECTORS) {
      const input = record(file);
      expect(
        safeParseEnvelope(input, { companyUid: "company_b" }),
      ).toEqual({ ok: false, code: "COMPANY_ACCESS_DENIED" });
    }
  });

  it("rejects a stale epoch", () => {
    expect(
      safeParseEnvelope(record("room.json"), {
        companyUid: COMPANY,
        epoch: 2,
      }),
    ).toEqual({ ok: false, code: "STALE_EPOCH" });
  });

  it("rejects a stale consent epoch", () => {
    expect(
      safeParseEnvelope(record("consent.json"), {
        companyUid: COMPANY,
        consentEpoch: 9,
      }),
    ).toEqual({ ok: false, code: "STALE_EPOCH" });
  });

  it("rejects unknown keys, missing keys and unknown kinds", () => {
    const room = record("room.json");
    expect(safeParseEnvelope({ ...room, extra: 1 })).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    const { host: _host, ...missing } = room;
    expect(safeParseEnvelope(missing)).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(safeParseEnvelope({ ...room, kind: "not-a-kind" })).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(safeParseEnvelope(null)).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
    expect(safeParseEnvelope([room])).toEqual({
      ok: false,
      code: "INVALID_INPUT",
    });
  });

  it("enforces the service's refinements", () => {
    // grant: expiresAt must be within grantTtlMs of issuedAt.
    const grant = record("grant.json");
    expect(
      safeParseEnvelope({ ...grant, expiresAt: 60_001 }).ok,
    ).toBe(false);
    // correction: revision must be previousRevision + 1.
    const correction = record("correction.json");
    expect(safeParseEnvelope({ ...correction, revision: 3 }).ok).toBe(false);
    // completion: chunk receipts must match the chunk count.
    const completion = record("completion.json");
    expect(safeParseEnvelope({ ...completion, chunks: 1 }).ok).toBe(false);
    // room: ids obey the shared id regex.
    const room = record("room.json");
    expect(safeParseEnvelope({ ...room, roomId: "room a" }).ok).toBe(false);
    // signal: payload must be a well-formed string within the byte ceiling.
    const signal = record("signal.json");
    expect(
      safeParseEnvelope({ ...signal, payload: "x".repeat(65_537) }).ok,
    ).toBe(false);
  });

  it("throws a typed error carrying the service error code", () => {
    try {
      parseEnvelope({ ...record("room.json"), version: "hq-meet/0" });
      expect.unreachable("expected a contract error");
    } catch (err) {
      expect(err).toBeInstanceOf(CallsContractError);
      expect((err as CallsContractError).code).toBe("UNSUPPORTED_VERSION");
    }
  });

  it("rejects an envelope whose kind does not match the requested kind", () => {
    expect(() => parseEnvelopeOfKind("grant", record("room.json"))).toThrow(
      CallsContractError,
    );
  });
});

describe("canonical JSON, digests and signatures", () => {
  const byKind: Record<string, string> = {
    segment: "segment.json",
    correction: "correction.json",
    receipt: "receipt.json",
  };

  it("reproduces the service's canonical signing bytes", () => {
    for (const vector of CRYPTO_VECTORS) {
      const envelope = record(byKind[vector.kind]!);
      expect(toHex(signedBytes(envelope)), vector.kind).toBe(vector.signedHex);
    }
  });

  it("derives the same keyId the envelopes carry as peerKey", async () => {
    for (const vector of CRYPTO_VECTORS) {
      expect(await keyId(vector.publicKey)).toBe(vector.peerKey);
      expect(await sha256(vector.publicKeyHex)).not.toBe(vector.peerKey);
    }
  });

  it("reproduces content digests for transcript envelopes", async () => {
    for (const kind of ["segment", "correction"] as const) {
      const envelope = record(byKind[kind]!);
      expect(await contentDigest(envelope), kind).toBe(envelope.digest);
    }
  });

  it("verifies every golden signature", async () => {
    for (const vector of CRYPTO_VECTORS) {
      const envelope = record(byKind[vector.kind]!);
      expect(envelope.signature).toBe(vector.signature);
      await expect(
        verifyEnvelope(envelope, vector.publicKey),
      ).resolves.toBeUndefined();
    }
  });

  it("rejects a tampered envelope, signature or key", async () => {
    const vector = CRYPTO_VECTORS.find((v) => v.kind === "receipt")!;
    const envelope = record(byKind.receipt!);
    await expect(
      verifyEnvelope({ ...envelope, persistedAt: 1 }, vector.publicKey),
    ).rejects.toThrow(CallsContractError);
    const other = CRYPTO_VECTORS[0]!;
    await expect(
      verifyEnvelope(
        { ...envelope, signature: `${other.signature.slice(0, 85)}A` },
        vector.publicKey,
      ),
    ).rejects.toThrow(CallsContractError);
    await expect(
      verifyEnvelope({ ...envelope, peerKey: "0".repeat(64) }, vector.publicKey),
    ).rejects.toThrow(CallsContractError);
  });

  it("covers the digest with the signature, so tampering fails as INVALID_SIGNATURE", async () => {
    // `signedBytes` excludes only `signature`, so `digest` is inside the signed
    // pre-image: rewriting it on a golden envelope breaks the signature before
    // the digest is ever compared. DIGEST_MISMATCH is therefore unreachable by
    // tampering alone — it needs a body signed *with* a wrong digest (below).
    const vector = CRYPTO_VECTORS.find((v) => v.kind === "segment")!;
    const envelope = record("segment.json");
    await expect(
      verifyEnvelope({ ...envelope, digest: "0".repeat(64) }, vector.publicKey),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it("reaches DIGEST_MISMATCH for a validly signed body whose digest is wrong", async () => {
    // The case the backend catches: a signer that computed `digest` over other
    // content and then signed the envelope honestly. The golden vectors carry
    // no private key, so the signature is produced here with a throwaway
    // Ed25519 pair over the golden segment's own field shape.
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const rawKey = toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    );

    const base = {
      ...record("segment.json"),
      peerKey: await keyId(rawKey),
      digest: "0".repeat(64),
    };
    delete (base as Record<string, unknown>).signature;
    expect(base.digest).not.toBe(await contentDigest(base));

    const message = signedBytes(base);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        pair.privateKey,
        message.buffer as ArrayBuffer,
      ),
    );
    const envelope = { ...base, signature: toBase64Url(signature) };

    await expect(verifyEnvelope(envelope, rawKey)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
    });

    // Same envelope with the honest digest verifies, so the failure above is
    // the digest check and not a signing mistake in this test.
    const honest = { ...base, digest: await contentDigest(base) };
    const honestSignature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        pair.privateKey,
        signedBytes(honest).buffer as ArrayBuffer,
      ),
    );
    await expect(
      verifyEnvelope(
        { ...honest, signature: toBase64Url(honestSignature) },
        rawKey,
      ),
    ).resolves.toBeUndefined();
  });

  it("canonicalizes objects by sorted key, rejecting lone surrogates", () => {
    expect(canonical({ b: 1, a: [true, null, "x"] })).toBe(
      '{"a":[true,null,"x"],"b":1}',
    );
    expect(() => canonical("\uD800")).toThrow(CallsContractError);
  });

  it("verifies chunk bytes against byteLength and digest", async () => {
    const chunk = record("chunk.json") as unknown as {
      data: string;
      byteLength: number;
      digest: string;
    };
    const bytes = record("chunk-bytes.json");
    expect(bytes.data).toBe(chunk.data);
    await expect(verifyChunkBytes(chunk)).resolves.toBeUndefined();
    await expect(
      verifyChunkBytes({ ...chunk, digest: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    await expect(
      verifyChunkBytes({ ...chunk, byteLength: 4 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
