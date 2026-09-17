/**
 * Canonical "hq-meet/1" golden vectors, copied byte-for-byte from hq-pro
 * `test/meetings/native/fixtures` at the commit pinned in PROVENANCE.json.
 *
 * They are copies on purpose: a standalone checkout of this repo must run its
 * contract tests without a sibling clone of the service, so nothing here may
 * ever import across repositories.
 */

import provenanceRaw from "./PROVENANCE.json?raw";
import admissionRaw from "./admission.json?raw";
import chunkRaw from "./chunk.json?raw";
import chunkBytesRaw from "./chunk-bytes.json?raw";
import chunkReceiptRaw from "./chunkReceipt.json?raw";
import completionRaw from "./completion.json?raw";
import completionManifestRaw from "./completionManifest.json?raw";
import consentRaw from "./consent.json?raw";
import correctionRaw from "./correction.json?raw";
import cryptoVectorsRaw from "./crypto-vectors.json?raw";
import finalizationReceiptRaw from "./finalizationReceipt.json?raw";
import grantRaw from "./grant.json?raw";
import identitiesRaw from "./identities.json?raw";
import knockRaw from "./knock.json?raw";
import manifestRaw from "./manifest.json?raw";
import receiptRaw from "./receipt.json?raw";
import roomRaw from "./room.json?raw";
import segmentRaw from "./segment.json?raw";
import signalRaw from "./signal.json?raw";
import uploadCapabilityRaw from "./uploadCapability.json?raw";

/** file name -> exact file bytes as UTF-8 text. */
export const GOLDEN_RAW: Readonly<Record<string, string>> = Object.freeze({
  "admission.json": admissionRaw,
  "chunk-bytes.json": chunkBytesRaw,
  "chunk.json": chunkRaw,
  "chunkReceipt.json": chunkReceiptRaw,
  "completion.json": completionRaw,
  "completionManifest.json": completionManifestRaw,
  "consent.json": consentRaw,
  "correction.json": correctionRaw,
  "crypto-vectors.json": cryptoVectorsRaw,
  "finalizationReceipt.json": finalizationReceiptRaw,
  "grant.json": grantRaw,
  "identities.json": identitiesRaw,
  "knock.json": knockRaw,
  "manifest.json": manifestRaw,
  "receipt.json": receiptRaw,
  "room.json": roomRaw,
  "segment.json": segmentRaw,
  "signal.json": signalRaw,
  "uploadCapability.json": uploadCapabilityRaw,
});

export interface GoldenProvenance {
  serviceRepo: string;
  serviceCommit: string;
  sourcePath: string;
  contractHash: string;
  files: Record<string, string>;
}

export const GOLDEN_PROVENANCE: GoldenProvenance = JSON.parse(
  provenanceRaw,
) as GoldenProvenance;

/** Parsed copy of one vector. Each call returns a fresh object. */
export function goldenJson(name: keyof typeof GOLDEN_RAW | string): unknown {
  const raw = GOLDEN_RAW[name];
  if (raw === undefined) throw new Error(`unknown golden vector: ${name}`);
  return JSON.parse(raw) as unknown;
}

/** One entry of crypto-vectors.json. */
export interface CryptoVector {
  kind: string;
  peerKey: string;
  publicKey: string;
  publicKeyHex: string;
  digest: string;
  signature: string;
  signatureHex: string;
  signedHex: string;
}

export const CRYPTO_VECTORS = JSON.parse(cryptoVectorsRaw) as CryptoVector[];
