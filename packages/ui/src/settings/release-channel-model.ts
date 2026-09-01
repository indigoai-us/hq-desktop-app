/**
 * Release-channel selector model (Settings → Updates).
 *
 * The native side already owns channel semantics end to end:
 * `crates/hq-desktop-core/src/release_channel.rs` parses tags, resolves the
 * effective channel from the stored `releaseChannel` pref in
 * ~/.hq/menubar.json (`effective_channel`), and picks the endpoint. This
 * module is only the UI's pure view of that contract — which options to show,
 * which is selected, and the downgrade guard copy — so the selector feeds the
 * SAME orchestration and the same persisted pref rather than a parallel path.
 */

export const RELEASE_CHANNELS = ["stable", "beta", "alpha"] as const;
export type ReleaseChannelId = (typeof RELEASE_CHANNELS)[number];

export interface ReleaseChannelOption {
  id: ReleaseChannelId;
  label: string;
  /** Short helper line under the control. */
  hint: string;
}

const OPTION_COPY: Record<ReleaseChannelId, { label: string; hint: string }> = {
  stable: { label: "Stable", hint: "Released builds only." },
  beta: { label: "Beta", hint: "Pre-release builds, checked more often." },
  alpha: { label: "Alpha", hint: "Earliest builds, checked more often." },
};

/** Normalize an arbitrary stored/served value onto a known channel. */
export function normalizeChannel(value: unknown): ReleaseChannelId | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (RELEASE_CHANNELS as readonly string[]).includes(lower)
    ? (lower as ReleaseChannelId)
    : null;
}

/**
 * Options to render. `available` comes from the native `available_channels`
 * command, which gates prerelease channels to eligible users; an empty or
 * unreadable list falls back to Stable only, matching the native coercion.
 */
export function channelOptions(available: unknown): ReleaseChannelOption[] {
  const ids = Array.isArray(available)
    ? available
        .map(normalizeChannel)
        .filter((id): id is ReleaseChannelId => id !== null)
    : [];
  const unique = RELEASE_CHANNELS.filter((id) => ids.includes(id));
  const shown = unique.length > 0 ? unique : (["stable"] as ReleaseChannelId[]);
  return shown.map((id) => ({ id, ...OPTION_COPY[id] }));
}

/**
 * Which option is selected. `null` stored pref means "never chosen" — the
 * native side derives a default (indigo users start on Beta), so reflect the
 * channel the host reports as effective rather than forcing Stable in the UI.
 */
export function selectedChannel(
  storedPref: unknown,
  effective: unknown,
): ReleaseChannelId {
  return normalizeChannel(storedPref) ?? normalizeChannel(effective) ?? "stable";
}

/** Parsed release identity: numeric core plus optional prerelease ordinal. */
interface ParsedVersion {
  core: [number, number, number];
  /** 0 = stable (sorts above any prerelease of the same core version). */
  preRank: number;
  preNum: number;
}

function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta)\.(\d+))?$/i.exec(
    raw.trim(),
  );
  if (!match) return null;
  const pre = match[4]?.toLowerCase();
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    preRank: pre === "alpha" ? 1 : pre === "beta" ? 2 : 3,
    preNum: match[5] ? Number(match[5]) : 0,
  };
}

/** Semver-ish compare: negative when `a` is older than `b`. */
export function compareVersions(a: unknown, b: unknown): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  if (pa.preRank !== pb.preRank) return pa.preRank - pb.preRank;
  return pa.preNum - pb.preNum;
}

export interface ChannelDowngradeNotice {
  /** True when the selected channel's newest release is older than installed. */
  isDowngrade: boolean;
  /** User-facing explanation, or null when there is nothing to explain. */
  message: string | null;
}

/**
 * Downgrade guard. Selecting a more conservative channel must never silently
 * install an older build: on 0.10.173-beta.2 with Stable at 0.10.172 the pane
 * explains the wait instead of offering an install.
 */
export function channelDowngradeNotice(
  installedVersion: unknown,
  channel: ReleaseChannelId,
  channelLatestVersion: unknown,
): ChannelDowngradeNotice {
  const latest = parseVersion(channelLatestVersion);
  const installed = parseVersion(installedVersion);
  if (!latest || !installed) return { isDowngrade: false, message: null };
  if (compareVersions(channelLatestVersion, installedVersion) >= 0) {
    return { isDowngrade: false, message: null };
  }
  const label = OPTION_COPY[channel].label;
  return {
    isDowngrade: true,
    message: `You’re on a newer build than ${label}; you’ll move to ${label} at the next ${label.toLowerCase()} release.`,
  };
}
