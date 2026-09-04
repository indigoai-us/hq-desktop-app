export type WorkItemStatus = "todo" | "in_progress" | "blocked" | "done";

export interface WorkItem {
  id: string;
  title: string;
  status: WorkItemStatus;
  updatedAt: string;
}

/** Parse a semver-ish release tag (vX.Y.Z or vX.Y.Z-alpha.N) into its version. */
export function versionFromTag(tag: string): string {
  const match = /^v(\d+\.\d+\.\d+(?:-(?:alpha|beta)\.\d+)?)$/.exec(tag);
  if (!match) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  return match[1];
}

/** Classify a release tag into its channel. */
export function channelFromTag(tag: string): "stable" | "alpha" | "beta" {
  const version = versionFromTag(tag);
  if (version.includes("-alpha.")) return "alpha";
  if (version.includes("-beta.")) return "beta";
  return "stable";
}

// Mesh realtime core (US-005): shared MQTT wake-to-REST-reconcile client.
export * from "./mesh/presign.js";
export * from "./mesh/credentials.js";
export * from "./mesh/reconcile.js";
export * from "./mesh/presence-store.js";
export * from "./mesh/client.js";
export {
  type ChannelWakeHint,
  type DmDeliveredWake,
  isTargetedMeshWake,
  mqttPayloadToText,
  channelWakeFromPayload,
  parseDmDeliveredWake,
  parseReplyThreadWake,
} from "./mesh/channel-wake.js";

// Local / REST work-mesh PROJECT_VIEW + channel cache (shared mapper).
export * from "./work-mesh/index.js";
