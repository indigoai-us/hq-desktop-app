/**
 * Shared helpers + primitives ported from desktop-alt (lib/ + components/).
 * Other areas import from "../common/<name>" — keep filenames identical to
 * the desktop-alt source.
 */

export * from "./markdown";
export * from "./external-links";
export { default as LinkContextMenu } from "./LinkContextMenu.svelte";
export * from "./latest-request";
export * from "./activity-request";
export * from "./progressive-collection";
export {
  createResourceCache,
  type ResourceCacheEntry,
  type ResourceCacheOptions,
} from "./resource-cache.svelte";
export * from "./provenance";
export * from "./local-image-src";
export * from "./hq-console";
export * from "./platform";
export * from "./cloud-connection";
export * from "./sync-model";
export * from "./progressLabel";
export * from "./settings-write";
export * from "./active-meeting";

export { default as StatTile } from "./StatTile.svelte";
export { default as Sparkline } from "./Sparkline.svelte";
export { default as LabelChip } from "./LabelChip.svelte";
export { default as ProvenanceLine } from "./ProvenanceLine.svelte";
export { default as LiveNowCard } from "./LiveNowCard.svelte";
export { default as CommandPalette } from "./CommandPalette.svelte";
export type { CommandPaletteItem } from "./CommandPalette.svelte";
export { default as OverviewActivityDigest } from "./OverviewActivityDigest.svelte";
export type { CompanyActivityStore } from "./OverviewActivityDigest.svelte";
export { default as UnavailableNote } from "./UnavailableNote.svelte";
export { default as EmptyState } from "./EmptyState.svelte";
