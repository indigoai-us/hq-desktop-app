import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey } from "node:crypto";

export type NativeReleaseChannel = "stable" | "beta" | "alpha";

export type NativeRelease = {
  tag: string;
  version: string;
  channel: NativeReleaseChannel;
};

export const SPARKLE_VERSION = "2.9.2";
export const SPARKLE_VALIDATION_PUBLIC_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
export const NATIVE_RELEASE_REPOSITORY =
  "indigoai-us/hq-desktop-app";
export const SPARKLE_FEED_TAG_PREFIX = "sparkle-";

const strictVersion =
  "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const releaseTagPattern = new RegExp(
  `^v(${strictVersion})(?:-(beta|alpha)\\.([1-9]\\d*))?$`,
);

export function classifyNativeReleaseTag(tag: string): NativeRelease {
  const match = releaseTagPattern.exec(tag);
  if (!match) {
    throw new Error(`Unsupported release tag: ${tag}`);
  }

  const baseVersion = match[1];
  const prereleaseChannel = match[2] as "beta" | "alpha" | undefined;
  const prereleaseNumber = match[3];
  const channel: NativeReleaseChannel = prereleaseChannel ?? "stable";
  const version = prereleaseChannel
    ? `${baseVersion}-${prereleaseChannel}.${prereleaseNumber}`
    : baseVersion;

  return { tag, version, channel };
}

export function channelsReceivingRelease(
  channel: NativeReleaseChannel,
): NativeReleaseChannel[] {
  switch (channel) {
    case "stable":
      return ["stable", "beta", "alpha"];
    case "beta":
      return ["beta", "alpha"];
    case "alpha":
      return ["alpha"];
  }
}

export function archiveNameForRelease(version: string): string {
  const release = classifyNativeReleaseTag(`v${version}`);
  return `HQ_${release.version}_aarch64.app.tar.gz`;
}

export function sparkleFeedTag(
  channel: NativeReleaseChannel,
): string {
  return `${SPARKLE_FEED_TAG_PREFIX}${channel}`;
}

export function sparkleFeedURL(
  channel: NativeReleaseChannel,
  repository = NATIVE_RELEASE_REPOSITORY,
): string {
  assertRepository(repository);
  const encodedRepository = repository
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `https://github.com/${encodedRepository}/releases/download/`
    + `${sparkleFeedTag(channel)}/appcast.xml`;
}

export type LegacyLatestManifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    "darwin-aarch64": {
      signature: string;
      url: string;
    };
  };
};

export function createLegacyLatestManifest(input: {
  tag: string;
  archiveURL: string;
  legacySignature: string;
  publicationDate: Date;
  notesURL: string;
}): LegacyLatestManifest {
  const release = classifyNativeReleaseTag(input.tag);
  assertHTTPSURL(input.archiveURL, "archive URL");
  assertHTTPSURL(input.notesURL, "release notes URL");
  const legacySignature = input.legacySignature.trim();
  if (!legacySignature) {
    throw new Error("Legacy minisign signature is required");
  }

  return {
    version: release.version,
    notes: `See ${input.notesURL}`,
    pub_date: iso8601WithoutMilliseconds(input.publicationDate),
    platforms: {
      "darwin-aarch64": {
        signature: legacySignature,
        url: input.archiveURL,
      },
    },
  };
}

export function parseSparkleSigningOutput(output: string): {
  signature: string;
  length: number;
} {
  const signatureMatch = /sparkle:edSignature="([^"]+)"/.exec(output);
  const lengthMatch = /\blength="(\d+)"/.exec(output);
  const signature = signatureMatch?.[1] ?? "";
  const length = Number(lengthMatch?.[1] ?? 0);

  if (!isBase64OfByteLength(signature, 64)
      || !Number.isSafeInteger(length)
      || length < 1) {
    throw new Error("Invalid Sparkle sign_update output");
  }

  return { signature, length };
}

export function sparklePublicKeyFromPrivateSeed(privateKey: string): string {
  const privateSeed = privateKey.trim();
  if (!isBase64OfByteLength(privateSeed, 32)) {
    throw new Error(
      "The Sparkle private key must be a canonical base64-encoded 32-byte Ed25519 seed",
    );
  }

  const seed = Buffer.from(privateSeed, "base64");
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  try {
    const key = createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });
    const spki = Buffer.from(
      createPublicKey(key).export({ format: "der", type: "spki" }),
    );
    const prefix = Buffer.from("302a300506032b6570032100", "hex");
    if (spki.length !== prefix.length + 32
        || !spki.subarray(0, prefix.length).equals(prefix)) {
      throw new Error("Sparkle Ed25519 public-key derivation failed");
    }
    return spki.subarray(prefix.length).toString("base64");
  } finally {
    seed.fill(0);
    pkcs8.fill(0);
  }
}

export function renderSparkleAppcast(input: {
  channel: NativeReleaseChannel;
  release: NativeRelease;
  repository?: string;
  buildVersion: string;
  archiveURL: string;
  archiveLength: number;
  sparkleSignature: string;
  publicationDate: Date;
  releaseNotesURL: string;
}): string {
  if (!channelsReceivingRelease(input.release.channel).includes(input.channel)) {
    throw new Error(
      `${input.release.channel} releases cannot be published to the ${input.channel} feed`,
    );
  }
  if (!/^[1-9]\d*$/.test(input.buildVersion)) {
    throw new Error("Sparkle build version must be a positive integer");
  }
  if (!Number.isSafeInteger(input.archiveLength) || input.archiveLength < 1) {
    throw new Error("Sparkle archive length must be a positive integer");
  }
  if (!isBase64OfByteLength(input.sparkleSignature, 64)) {
    throw new Error("Sparkle EdDSA signature must encode exactly 64 bytes");
  }
  assertHTTPSURL(input.archiveURL, "archive URL");
  assertHTTPSURL(input.releaseNotesURL, "release notes URL");

  const feedURL = sparkleFeedURL(input.channel, input.repository);
  const channelTitle = input.channel[0].toUpperCase() + input.channel.slice(1);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">',
    "  <channel>",
    `    <title>HQ ${channelTitle} Updates</title>`,
    `    <link>${escapeXMLText(feedURL)}</link>`,
    `    <description>HQ ${escapeXMLText(input.channel)} release updates.</description>`,
    "    <language>en</language>",
    "    <item>",
    `      <title>HQ ${escapeXMLText(input.release.version)}</title>`,
    `      <pubDate>${sparklePublicationDate(input.publicationDate)}</pubDate>`,
    `      <sparkle:releaseNotesLink>${escapeXMLText(input.releaseNotesURL)}</sparkle:releaseNotesLink>`,
    "      <enclosure",
    `        url="${escapeXMLAttribute(input.archiveURL)}"`,
    `        length="${input.archiveLength}"`,
    '        type="application/octet-stream"',
    `        sparkle:version="${escapeXMLAttribute(input.buildVersion)}"`,
    `        sparkle:shortVersionString="${escapeXMLAttribute(input.release.version)}"`,
    `        sparkle:edSignature="${escapeXMLAttribute(input.sparkleSignature)}"`,
    "      />",
    "    </item>",
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

export type PublishableNativeBundle = {
  appName: string;
  bundleIdentifier: string;
  shortVersion: string;
  buildVersion: string;
  feedURL: string;
  publicKey: string;
  validationOnly: boolean;
  appArchitectures: readonly string[];
  sidecarArchitectures: readonly string[];
  recallHelperArchitectures: readonly string[];
  recallRuntimeMachOCount: number;
  recallRuntimeSigned: boolean;
  recallRuntimeEntitlementsValid: boolean;
  sparkleRuntimeMachOCount: number;
  sparkleRuntimeArm64Only: boolean;
  sparkleRuntimeSigned: boolean;
  hostEntitlementsEmpty: boolean;
  sidecarEntitlementsEmpty: boolean;
  signedWithDeveloperID: boolean;
  notarizationStapled: boolean;
  containsTauriRuntime: boolean;
  containsNodeRuntime: boolean;
  containsBundledWebAssets: boolean;
  hostLinksWebKit: boolean;
  sidecarLinksWebKit: boolean;
  recallRuntimeLinksWebKit: boolean;
  sparkleVersion: string;
};

export function assertPublishableNativeBundle(
  bundle: PublishableNativeBundle,
): void {
  if (bundle.validationOnly) {
    throw new Error("A validation-only bundle can never be published");
  }
  if (bundle.publicKey === SPARKLE_VALIDATION_PUBLIC_KEY) {
    throw new Error("The validation-only Sparkle key can never be published");
  }
  if (!isBase64OfByteLength(bundle.publicKey, 32)) {
    throw new Error("The production Sparkle public key must encode exactly 32 bytes");
  }
  if (bundle.appName !== "HQ.app") {
    throw new Error("The shipping product must be HQ.app");
  }
  if (bundle.bundleIdentifier !== "ai.indigo.hq-sync-menubar") {
    throw new Error("The native updater bundle identity does not match the legacy app");
  }
  if (!classifyNativeReleaseTag(`v${bundle.shortVersion}`)) {
    throw new Error("The bundle short version is invalid");
  }
  if (!/^[1-9]\d*$/.test(bundle.buildVersion)) {
    throw new Error("The bundle build version must be a positive integer");
  }
  if (bundle.feedURL !== sparkleFeedURL("stable")) {
    throw new Error("The shipping bundle must default to the stable HTTPS appcast");
  }
  assertExactlyArm64(bundle.appArchitectures, "HQ executable");
  assertExactlyArm64(bundle.sidecarArchitectures, "HQ engine sidecar");
  assertExactlyArm64(
    bundle.recallHelperArchitectures,
    "HQ Recall runtime helper",
  );
  if (bundle.recallRuntimeMachOCount < 4) {
    throw new Error(
      "The native bundle must contain the complete Recall runtime",
    );
  }
  if (!bundle.recallRuntimeSigned) {
    throw new Error(
      "Every Recall runtime Mach-O must have a Developer ID hardened-runtime signature",
    );
  }
  if (!bundle.recallRuntimeEntitlementsValid) {
    throw new Error(
      "The Recall helper must carry only its hardened-runtime capture entitlements",
    );
  }
  if (bundle.sparkleRuntimeMachOCount < 5
      || !bundle.sparkleRuntimeArm64Only) {
    throw new Error(
      "The pinned Sparkle runtime must contain its complete arm64-only native helper set",
    );
  }
  if (!bundle.sparkleRuntimeSigned) {
    throw new Error(
      "Every Sparkle runtime Mach-O must have a Developer ID hardened-runtime signature",
    );
  }
  if (!bundle.hostEntitlementsEmpty) {
    throw new Error(
      "The HQ host must not inherit Recall, debug, or sandbox escape entitlements",
    );
  }
  if (!bundle.sidecarEntitlementsEmpty) {
    throw new Error(
      "The HQ engine sidecar must not carry host or Recall entitlements",
    );
  }
  if (!bundle.signedWithDeveloperID) {
    throw new Error("The native bundle must have a Developer ID signature");
  }
  if (!bundle.notarizationStapled) {
    throw new Error("The native bundle must have a stapled notarization ticket");
  }
  if (bundle.containsTauriRuntime) {
    throw new Error("The native bundle must not contain a Tauri runtime");
  }
  if (bundle.containsNodeRuntime) {
    throw new Error("The native bundle must not contain a Node.js runtime");
  }
  if (bundle.containsBundledWebAssets) {
    throw new Error("The native bundle must not contain bundled web assets");
  }
  if (bundle.hostLinksWebKit) {
    throw new Error("The HQ executable must not link WebKit");
  }
  if (bundle.sidecarLinksWebKit) {
    throw new Error("The HQ engine sidecar must not link WebKit");
  }
  if (bundle.recallRuntimeLinksWebKit) {
    throw new Error("The HQ Recall runtime must not link WebKit");
  }
  if (bundle.sparkleVersion !== SPARKLE_VERSION) {
    throw new Error(`The native bundle must contain Sparkle ${SPARKLE_VERSION}`);
  }
}

function assertExactlyArm64(
  architectures: readonly string[],
  component: string,
): void {
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(`${component} must be exactly arm64`);
  }
}

function assertHTTPSURL(value: string, description: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${description}: ${value}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${description} must use HTTPS`);
  }
}

function assertRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Release repository must use owner/name format");
  }
}

function isBase64OfByteLength(value: string, byteLength: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === byteLength
    && decoded.toString("base64") === value;
}

function iso8601WithoutMilliseconds(date: Date): string {
  assertValidDate(date);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sparklePublicationDate(date: Date): string {
  assertValidDate(date);
  return date.toUTCString().replace("GMT", "+0000");
}

function assertValidDate(date: Date): void {
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Publication date is invalid");
  }
}

function escapeXMLText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXMLAttribute(value: string): string {
  return escapeXMLText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
