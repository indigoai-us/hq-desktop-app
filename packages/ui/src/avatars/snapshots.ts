import { cspSafeAvatarSrc, parseAvatarPack, trimSlash } from "./parse-pack.js";
import {
  HQ_AGENT_MASCOTS_BASE_URL,
  type AvatarPack,
  type AvatarPackItem,
} from "./types.js";
import hqAgentMascots from "./packs/hq-agent-mascots.json" with { type: "json" };

const MASCOTS = parseAvatarPack(hqAgentMascots);

if (!MASCOTS.ok) {
  throw new Error(`bundled mascots snapshot is invalid: ${MASCOTS.error}`);
}

// Same Vite glob contract as agent-avatars.ts: call unconditionally, take the
// resolved module URLs (not the glob keys), never hide the call behind typeof.
//
// These files land in Vite's dist and Tauri then embeds dist in EACH slice of
// the macOS universal binary. Keep the snapshot compressed (512px JPEG). The
// v0.10.181 release failed the 120 MB binary budget after 24 uncompressed
// 512px PNGs were globbed in (~6.4 MB × 2 architectures).
const mascotModules: Record<string, unknown> =
  // @ts-ignore -- vite/client typing not loaded in @hq/ui's typecheck
  import.meta.glob("./packs/hq-agent-mascots/**/*.{png,svg,webp,jpg,jpeg}", {
    eager: true,
    query: "?url",
    import: "default",
  });

function relativeFromGlobKey(key: string): string {
  return key.replace(/^\.\/packs\/hq-agent-mascots\//, "").replace(/^\/+/, "");
}

const SNAPSHOT_EXTS = [".jpg", ".jpeg", ".png", ".webp"] as const;

/**
 * Catalog `src` values stay on the live pack's extension (usually `.png`).
 * The on-disk snapshot may be a smaller JPEG of the same stem so the
 * universal binary does not embed uncompressed PNGs twice.
 */
export function lookupBundledAsset(
  rel: string,
  assets: Readonly<Record<string, string>>,
): string | undefined {
  const direct = assets[rel];
  if (direct) return direct;
  const match = /\.(png|jpe?g|webp)$/i.exec(rel);
  if (!match) return undefined;
  const stem = rel.slice(0, -match[0].length);
  for (const ext of SNAPSHOT_EXTS) {
    const candidate = assets[stem + ext];
    if (candidate) return candidate;
  }
  return undefined;
}

/** Relative pack path → bundled Vite asset URL. */
export const bundledMascotAssets: Record<string, string> = {};
for (const [key, value] of Object.entries(mascotModules)) {
  if (typeof value !== "string" || !value) continue;
  bundledMascotAssets[relativeFromGlobKey(key)] = value;
}

function relativeItemPath(pack: AvatarPack, item: AvatarPackItem): string | null {
  const src = item.src.trim();
  if (!src) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) && !src.startsWith("//")) {
    return src.replace(/^\/+/, "");
  }
  const base = trimSlash(pack.baseUrl);
  if (base && src.startsWith(`${base}/`)) return src.slice(base.length + 1);
  const fromId = /^(v[12])-(.+)$/.exec(item.id);
  if (fromId) return `mascots/${fromId[1]}/${fromId[2]}.png`;
  return null;
}

/**
 * Swap remote/relative item srcs for bundled snapshot files when we have them.
 * The packaged CSP blocks http(s) img-src, and the live mascot host is access-gated.
 */
export function bindBundledPackSrcs(
  pack: AvatarPack,
  assets: Readonly<Record<string, string>> = bundledMascotAssets,
): AvatarPack {
  return {
    ...pack,
    items: pack.items.map((item) => {
      if (cspSafeAvatarSrc(item.src) && isResolvedLocalAsset(item.src)) {
        return item;
      }
      const rel = relativeItemPath(pack, item);
      const bundled = rel ? lookupBundledAsset(rel, assets) : undefined;
      return bundled ? { ...item, src: bundled } : item;
    }),
  };
}

function isResolvedLocalAsset(src: string): boolean {
  const value = src.trim();
  return (
    value.startsWith("/") && !value.startsWith("//")
  ) || value.startsWith("blob:") || /^data:image\//i.test(value);
}

const BY_BASE_URL: Record<string, AvatarPack> = {
  [HQ_AGENT_MASCOTS_BASE_URL]: bindBundledPackSrcs(MASCOTS.pack),
};

export function bundledSnapshotFor(baseUrl: string): AvatarPack | null {
  const key = baseUrl.trim().replace(/\/+$/, "");
  return BY_BASE_URL[key] ?? null;
}

export const HQ_AGENT_MASCOTS_SNAPSHOT: AvatarPack =
  BY_BASE_URL[HQ_AGENT_MASCOTS_BASE_URL] ?? bindBundledPackSrcs(MASCOTS.pack);
