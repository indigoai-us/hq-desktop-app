/**
 * Indigo-only gates for console-rail surfaces that are not finished yet
 * (RELEASE-001). One place decides whether a gated surface shows its full
 * version or its finished fallback.
 *
 * The gate is keyed to the OPEN company, not to the person's memberships: an
 * Indigo member who opens another company sees that company's fallback. The
 * personal scope (no open company) also gets the fallback.
 *
 * Each key is also a row in the hq-flags registry (`packages/platform/src/
 * flags.ts`). A configured `true` opens the surface to every company without
 * a release; `false` keeps it Indigo-only. Until the registry answers, each
 * key uses `RAIL_GATE_EVERYONE_DEFAULT` (closed for all but Atlas).
 *
 * Every key is listed in docs/design-standard-console-rail.md with what it
 * hides and the follow-up that removes it; a test keeps the two in step.
 */
import {
  RAIL_ATLAS_FLAG,
  RAIL_DEPLOYMENTS_ACTIONS_FLAG,
  RAIL_GATE_EVERYONE_DEFAULT,
  RAIL_OUTPOST_FLAG,
  RAIL_SHORTCUT_EDITING_FLAG,
  RAIL_TELEMETRY_FLAG,
  RAIL_WORKFORCE_LIMITS_FLAG,
} from "@hq/platform";

export const INDIGO_ONLY_GATE_KEYS = [
  RAIL_TELEMETRY_FLAG,
  RAIL_OUTPOST_FLAG,
  RAIL_DEPLOYMENTS_ACTIONS_FLAG,
  RAIL_SHORTCUT_EDITING_FLAG,
  RAIL_WORKFORCE_LIMITS_FLAG,
  RAIL_ATLAS_FLAG,
] as const;

export type IndigoOnlyGateKey = (typeof INDIGO_ONLY_GATE_KEYS)[number];

export {
  RAIL_ATLAS_FLAG,
  RAIL_DEPLOYMENTS_ACTIONS_FLAG,
  RAIL_OUTPOST_FLAG,
  RAIL_SHORTCUT_EDITING_FLAG,
  RAIL_TELEMETRY_FLAG,
  RAIL_WORKFORCE_LIMITS_FLAG,
};

/** The company that makes HQ. Company slugs are unique across hq-pro. */
export const INDIGO_COMPANY_SLUG = "indigo";

/** The open company, as the rail knows it. `null` is the personal scope. */
export interface GateCompany {
  slug?: string | null;
  uid?: string | null;
}

/** Registry answers per key; a missing key means "not loaded / unconfigured". */
export type GateRegistryValues = Partial<Record<IndigoOnlyGateKey, boolean>>;

export function isIndigoCompany(company: GateCompany | null | undefined): boolean {
  return (company?.slug ?? "").trim().toLowerCase() === INDIGO_COMPANY_SLUG;
}

/**
 * True when `key`'s full surface should show for the open company. Indigo
 * always sees it. Every other company, and the personal scope, see it only
 * when the registry opened it to everyone (or, with no registry answer, when
 * the key's everyone-default is on).
 */
export function isIndigoOnlySurface(
  key: IndigoOnlyGateKey,
  activeCompany: GateCompany | null | undefined,
  registry: GateRegistryValues = {},
): boolean {
  if (isIndigoCompany(activeCompany)) return true;
  const configured = registry[key];
  if (typeof configured === "boolean") return configured;
  return RAIL_GATE_EVERYONE_DEFAULT[key] === true;
}

/** One plain sentence for a gated page's "Coming soon" fallback. */
export const COMING_SOON_COPY: Readonly<Record<string, string>> = {
  [RAIL_TELEMETRY_FLAG]: "Usage and session telemetry is on its way to your company.",
};

type FeatureReader = {
  hasFeature?: (flag: string) => Promise<{ ok: boolean; value?: unknown }>;
  subscribeFeature?: (
    flag: string,
    onChange: (result: { ok: boolean; value?: unknown }) => void,
  ) => () => void;
};

/**
 * Read every gate key from the registry and keep the values current. Calls
 * `onChange` with the full map after each answer. A failed read leaves the
 * key unset, so it keeps its everyone-default. Returns a stop function.
 */
export function watchIndigoOnlyGates(
  identity: FeatureReader | null | undefined,
  onChange: (values: GateRegistryValues) => void,
): () => void {
  if (!identity || typeof identity.hasFeature !== "function") return () => {};
  let live = true;
  const values: GateRegistryValues = {};
  const apply = (key: IndigoOnlyGateKey, result: { ok: boolean; value?: unknown }): void => {
    if (!live) return;
    if (result.ok && typeof result.value === "boolean") values[key] = result.value;
    else delete values[key];
    onChange({ ...values });
  };
  const stops: Array<() => void> = [];
  for (const key of INDIGO_ONLY_GATE_KEYS) {
    void identity.hasFeature(key).then(
      (result) => apply(key, result),
      (err: unknown) => {
        console.warn(`[hq-desktop] gate ${key} lookup failed:`, err);
      },
    );
    if (typeof identity.subscribeFeature === "function") {
      stops.push(identity.subscribeFeature(key, (result) => apply(key, result)));
    }
  }
  return () => {
    live = false;
    for (const stop of stops) stop();
  };
}
