/**
 * The shell's handle on the direct cloud create, without loading it.
 *
 * `cloud-create.ts` and `@hq/agents` are about 8 KB of JS that only the New
 * bot flow uses. The shell builds this seam at startup; the real module loads
 * through `import()` the first time the flow asks for the flag, an
 * availability, or a create, which happens when the New bot modal opens. Only
 * type imports from the real module are allowed here: the perf-budget
 * contract fails if `@hq/agents` or `cloud-create.ts` joins the shell's
 * static import graph.
 */
import type { CreateAvailability } from "@hq/agents";
import type {
  DirectCloudCreate,
  DirectCloudCreateAdapter,
  DirectCloudCreateResult,
  DirectCloudDraft,
} from "./cloud-create.js";

/** What the New bot flow reads: the flag across companies, and per-company availability. */
export type DirectCloudFlowSeam = Pick<DirectCloudCreate, "anyEnabled" | "availability">;

export interface DirectCloudSeam extends DirectCloudFlowSeam {
  isEnabled(companyUid: string | null): Promise<boolean>;
  /** POST /v1/agents for this company, after reading the flag for this company. */
  create(
    companyUid: string,
    draft: DirectCloudDraft,
    context?: { companyLabel?: string },
  ): Promise<DirectCloudCreateResult>;
}

/** Null when the adapter has no REST transport; callers keep the older path. */
export function lazyDirectCloudCreate(adapter: DirectCloudCreateAdapter): DirectCloudSeam | null {
  if (typeof adapter.agents?.fetch !== "function") return null;
  let loading: Promise<{
    mod: typeof import("./cloud-create.js");
    seam: DirectCloudCreate | null;
  }> | null = null;
  const load = () =>
    (loading ??= import("./cloud-create.js").then(
      (mod) => ({ mod, seam: mod.createDirectCloudCreate(adapter) }),
      (error: unknown) => {
        // A failed chunk load is retried on the next call rather than cached.
        loading = null;
        throw error;
      },
    ));
  return {
    async isEnabled(companyUid) {
      try {
        const { seam } = await load();
        return seam ? seam.isEnabled(companyUid) : false;
      } catch (error) {
        console.warn("[hq-desktop] cloud bot create module failed to load", error);
        return false;
      }
    },
    async anyEnabled(companyUids) {
      try {
        const { seam } = await load();
        return seam ? seam.anyEnabled(companyUids) : false;
      } catch (error) {
        console.warn("[hq-desktop] cloud bot create module failed to load", error);
        return false;
      }
    },
    async availability(companyUid): Promise<CreateAvailability> {
      const { seam } = await load();
      if (!seam) throw new Error("cloud bot create is unavailable without a REST transport");
      return seam.availability(companyUid);
    },
    async create(companyUid, draft, context = {}) {
      const { mod, seam } = await load();
      if (!seam) {
        return { ok: false, reason: "Adding bots isn't available in this build", blocked: false, fix: null };
      }
      return mod.runCompanyDirectCloudCreate(seam, companyUid, draft, context);
    },
  };
}
