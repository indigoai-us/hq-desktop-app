/**
 * Origin chips: which product an item is about and which company it belongs
 * to, said plainly ("Desktop app", not "indigoai-us/hq-desktop-app").
 */

/** Repo short name to the product people call it. Unknown repos keep their short name. */
/** Same map as the writer's `PRODUCT_NAMES` in personal/skills/daily-brief/scripts/brief_rank.py; change both together. */
const PRODUCTS: Record<string, string> = {
  "hq-desktop-app": "Desktop app",
  "hq-desktop": "Desktop app",
  "hq-cloud": "HQ Cloud",
  "hq-sync": "HQ Sync",
  "hq-core-staging": "HQ core",
  "hq-core": "HQ core",
  "hq-pro": "HQ Pro",
  "hq-pro-core": "HQ Pro",
  "hq-finance": "Finance dashboard",
  "cfo-dashboard": "Finance dashboard",
  "hq-pro-agents": "Fleet",
  "hq-agents-v2": "Fleet",
  "hq-fleet-runtime": "Fleet",
  "hq-cli": "HQ command line",
  "hq-deploy": "Sharing and deploys",
  "hq-packages": "Skill packs",
  "hq-console": "HQ Console",
  "hq-shepherd": "HQ Shepherd",
  "hq-native-mobile": "HQ Mobile",
  "hq-status": "Status page",
  "indigo-marketing": "Marketing site",
  "indigo-docs": "Docs site",
};

/** "indigoai-us/hq-core" -> "hq-core". */
export function repoShort(repo: string | null | undefined): string {
  const r = (repo ?? "").trim();
  return r.includes("/") ? r.split("/").slice(1).join("/") : r;
}

/** The product an item is about: the writer's `product` when given, else from the repo. */
export function productName(repo: string | null | undefined, product?: string | null): string {
  if (product?.trim()) return product.trim();
  const short = repoShort(repo);
  return PRODUCTS[short.toLowerCase()] ?? short;
}

/** A readable company name from a label or a raw uid: "cmp_live_recover" -> "live recover". */
export function companyDisplayName(nameOrUid: string): string {
  return nameOrUid.trim().replace(/^cmp_/i, "").replace(/[_-]+/g, " ").trim();
}

/** Two letters for a monogram tile: "Indigo" -> "IN", "Live Recover" -> "LR", "cmp_indigo" -> "IN". */
export function monogram(name: string): string {
  const parts = companyDisplayName(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

/** A stable hue for a name's monogram tile. */
export function monogramHue(name: string): number {
  let h = 0;
  for (const ch of companyDisplayName(name).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
