/**
 * Dev-only build switches for the visual first run, read from Vite's
 * `import.meta.env` at BUILD time. A build made without them (every release
 * build: `scripts/dev-switches-contract.test.ts` pins that the workflows
 * never set them) has both off, and nothing at run time can turn them on.
 * Docs: `docs/dev-switches.md`.
 *
 *   VITE_HQ_DEV_FIRST_RUN_FORCE=1  `desktop.visual-first-run` counts as on
 *       for this build (the flag service is not read or changed), and the
 *       takeover opens on every launch, even after setup ran or the takeover
 *       was finished. The walk is real: it creates (or adopts and renames)
 *       the setup bot under the name given, joins or creates the company
 *       picked, and connects the apps picked.
 *   VITE_HQ_DEV_FIRST_RUN_DRY=1    the walk is side-effect free: nothing is
 *       created, renamed, joined, connected or sent, Done and Continue in
 *       chat only close the takeover, and the "finished" marker is not
 *       written. On its own it changes nothing until the takeover opens; set
 *       it with FORCE for a dry walk you can repeat.
 */

export interface FirstRunDevSwitches {
  force: boolean;
  dry: boolean;
}

export const FIRST_RUN_DEV_OFF: FirstRunDevSwitches = Object.freeze({ force: false, dry: false });

function on(value: unknown): boolean {
  return typeof value === "string" && ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

/** The switches from an env object (Vite's `import.meta.env`, or a test's). */
export function readFirstRunDevSwitches(env: Record<string, unknown> | null | undefined): FirstRunDevSwitches {
  if (!env) return FIRST_RUN_DEV_OFF;
  return { force: on(env.VITE_HQ_DEV_FIRST_RUN_FORCE), dry: on(env.VITE_HQ_DEV_FIRST_RUN_DRY) };
}

function buildEnv(): Record<string, unknown> | null {
  try {
    // Written out in full so Vite replaces each name with its build-time
    // value (or undefined) in the bundle.
    return {
      // @ts-ignore -- vite/client typing not loaded in @hq/ui's typecheck
      VITE_HQ_DEV_FIRST_RUN_FORCE: import.meta.env.VITE_HQ_DEV_FIRST_RUN_FORCE,
      // @ts-ignore -- vite/client typing not loaded in @hq/ui's typecheck
      VITE_HQ_DEV_FIRST_RUN_DRY: import.meta.env.VITE_HQ_DEV_FIRST_RUN_DRY,
    };
  } catch {
    return null;
  }
}

/** This build's switches. Off unless the build set them. */
export const FIRST_RUN_DEV_SWITCHES: FirstRunDevSwitches = readFirstRunDevSwitches(buildEnv());

/** How long a dry walk's pretend actions take, so their pending states show. */
export const FIRST_RUN_DRY_DELAY_MS = 800;
