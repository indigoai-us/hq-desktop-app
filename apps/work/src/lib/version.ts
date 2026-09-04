import { versionFromTag } from "@hq/core";

/** Resolve the app version from a release tag, defaulting to dev. */
export function displayVersion(tag: string | undefined): string {
  if (!tag) return "dev";
  return versionFromTag(tag);
}
